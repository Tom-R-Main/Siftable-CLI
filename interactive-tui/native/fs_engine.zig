const std = @import("std");

const Io = std.Io;
const Dir = std.Io.Dir;

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_NOT_FOUND: u32 = 2;
const STATUS_NOT_FILE: u32 = 3;
const STATUS_NOT_DIR: u32 = 4;
const STATUS_PERMISSION_DENIED: u32 = 5;
const STATUS_BINARY_FILE: u32 = 6;
const STATUS_TOO_LARGE: u32 = 7;
const STATUS_INVALID_UTF8: u32 = 8;
const STATUS_OUTPUT_TOO_SMALL: u32 = 9;
const STATUS_IO_ERROR: u32 = 13;

const DEFAULT_READ_BYTES: u32 = 64 * 1024;
const DEFAULT_SEARCH_MAX_FILES: u32 = 5000;
const DEFAULT_SEARCH_MAX_MATCHES: u32 = 100;
const DEFAULT_SEARCH_MAX_DEPTH: u32 = 8;
const DEFAULT_SEARCH_MAX_FILE_BYTES: u32 = 1024 * 1024;
const DEFAULT_PREVIEW_BYTES: u32 = 240;

const NOISY_DIRS = [_][]const u8{
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "coverage",
    "tmp",
    ".zig-cache",
    "zig-out",
};

const SearchCaps = extern struct {
    max_files: u32,
    max_matches: u32,
    max_depth: u32,
    max_file_bytes: u32,
    preview_bytes: u32,
    flags: u32,
};

const SearchStats = extern struct {
    searched_files: u32,
    skipped_files: u32,
    matched_files: u32,
    matches: u32,
    truncated: u32,
};

const Writer = struct {
    buf: []u8,
    len: usize = 0,
    needed: usize = 0,
    overflow: bool = false,

    fn append(self: *Writer, s: []const u8) void {
        self.needed += s.len;
        if (self.len + s.len > self.buf.len) {
            self.overflow = true;
            return;
        }
        @memcpy(self.buf[self.len .. self.len + s.len], s);
        self.len += s.len;
    }

    fn appendByte(self: *Writer, b: u8) void {
        self.needed += 1;
        if (self.len + 1 > self.buf.len) {
            self.overflow = true;
            return;
        }
        self.buf[self.len] = b;
        self.len += 1;
    }

    fn appendFmt(self: *Writer, comptime fmt: []const u8, args: anytype) void {
        var scratch: [128]u8 = undefined;
        const rendered = std.fmt.bufPrint(&scratch, fmt, args) catch {
            self.overflow = true;
            self.needed += 128;
            return;
        };
        self.append(rendered);
    }

    fn appendJsonString(self: *Writer, s: []const u8) void {
        self.appendByte('"');
        for (s) |b| {
            switch (b) {
                '"' => self.append("\\\""),
                '\\' => self.append("\\\\"),
                0x0a => self.append("\\n"),
                0x0d => self.append("\\r"),
                0x09 => self.append("\\t"),
                0x00...0x08, 0x0b...0x0c, 0x0e...0x1f => self.appendFmt("\\u{x:0>4}", .{b}),
                else => self.appendByte(b),
            }
        }
        self.appendByte('"');
    }
};

fn io() Io {
    return Io.Threaded.global_single_threaded.io();
}

fn inputSlice(ptr: [*]const u8, len: u32) []const u8 {
    return ptr[0..@intCast(len)];
}

fn outputSlice(ptr: [*]u8, cap: u32) []u8 {
    return ptr[0..@intCast(cap)];
}

fn finish(w: *const Writer, written_out: *u32, needed_out: *u32) u32 {
    written_out.* = @intCast(@min(w.len, std.math.maxInt(u32)));
    needed_out.* = @intCast(@min(w.needed, std.math.maxInt(u32)));
    return if (w.overflow) STATUS_OUTPUT_TOO_SMALL else STATUS_OK;
}

fn isBinary(input: []const u8) bool {
    const sniff_len = @min(input.len, 8192);
    return std.mem.indexOfScalar(u8, input[0..sniff_len], 0) != null;
}

fn pathLooksUnsafe(path: []const u8) bool {
    return path.len == 0 or std.mem.indexOf(u8, path, "\x00") != null;
}

fn statusFromFileError(err: anyerror) u32 {
    return switch (err) {
        error.FileNotFound => STATUS_NOT_FOUND,
        error.IsDir => STATUS_NOT_FILE,
        error.AccessDenied, error.PermissionDenied => STATUS_PERMISSION_DENIED,
        error.StreamTooLong => STATUS_TOO_LARGE,
        else => STATUS_IO_ERROR,
    };
}

fn statusFromDirError(err: anyerror) u32 {
    return switch (err) {
        error.FileNotFound => STATUS_NOT_FOUND,
        error.NotDir => STATUS_NOT_DIR,
        error.AccessDenied, error.PermissionDenied => STATUS_PERMISSION_DENIED,
        else => STATUS_IO_ERROR,
    };
}

fn noisyDir(name: []const u8) bool {
    for (NOISY_DIRS) |blocked| {
        if (std.mem.eql(u8, name, blocked)) return true;
    }
    return false;
}

fn hiddenPath(path: []const u8) bool {
    var start: usize = 0;
    while (start < path.len) {
        var end = start;
        while (end < path.len and path[end] != '/' and path[end] != '\\') : (end += 1) {}
        const component = path[start..end];
        if (component.len > 0 and component[0] == '.') return true;
        start = end + 1;
    }
    return false;
}

fn lineForByte(input: []const u8, byte_index: usize) u32 {
    var line: u32 = 1;
    var i: usize = 0;
    while (i < byte_index and i < input.len) : (i += 1) {
        if (input[i] == '\n') line += 1;
    }
    return line;
}

fn colForByte(input: []const u8, byte_index: usize) u32 {
    var col: u32 = 1;
    var i = byte_index;
    while (i > 0) {
        if (input[i - 1] == '\n') break;
        col += 1;
        i -= 1;
    }
    return col;
}

fn previewBounds(input: []const u8, match_start: usize, match_end: usize, preview_bytes: u32) struct { start: usize, end: usize } {
    const half = @as(usize, @intCast(preview_bytes / 2));
    var start = if (match_start > half) match_start - half else 0;
    var end = @min(input.len, match_end + half);

    while (start > 0 and input[start - 1] != '\n') start -= 1;
    while (end < input.len and input[end] != '\n' and end - start < preview_bytes) end += 1;

    return .{ .start = start, .end = end };
}

fn writeReadJson(w: *Writer, path: []const u8, content: []const u8, bytes: usize, truncated: bool) void {
    w.append("{\"path\":");
    w.appendJsonString(path);
    w.append(",\"content\":");
    w.appendJsonString(content);
    w.appendFmt(",\"truncated\":{},\"bytes\":{}}}", .{ truncated, bytes });
}

export fn sift_fs_read_text(
    path_ptr: [*]const u8,
    path_len: u32,
    max_bytes_in: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const path = inputSlice(path_ptr, path_len);
    if (pathLooksUnsafe(path)) return STATUS_INVALID_ARGS;

    const allocator = std.heap.smp_allocator;
    const limit = if (max_bytes_in == 0) DEFAULT_READ_BYTES else max_bytes_in;
    const read_limit: usize = @intCast(limit + 1);
    const data = Dir.cwd().readFileAlloc(io(), path, allocator, .limited(read_limit)) catch |err| {
        return statusFromFileError(err);
    };
    defer allocator.free(data);

    if (isBinary(data)) return STATUS_BINARY_FILE;
    if (!std.unicode.utf8ValidateSlice(data[0..@min(data.len, @as(usize, @intCast(limit)))])) {
        return STATUS_INVALID_UTF8;
    }

    const content_len = @min(data.len, @as(usize, @intCast(limit)));
    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    writeReadJson(&w, path, data[0..content_len], data.len, data.len > limit);
    return finish(&w, written_out, needed_out);
}

fn writeSearchHeader(w: *Writer) void {
    w.append("{\"matches\":[");
}

fn writeSearchStats(w: *Writer, stats: *const SearchStats) void {
    w.appendFmt("],\"stats\":{{\"searchedFiles\":{},\"skippedFiles\":{},\"matchedFiles\":{},\"matches\":{},\"truncated\":{}}}}}", .{
        stats.searched_files,
        stats.skipped_files,
        stats.matched_files,
        stats.matches,
        stats.truncated,
    });
}

fn writeMatch(w: *Writer, first: *bool, path: []const u8, preview: []const u8, line: u32, col: u32, start: usize, end: usize) void {
    if (!first.*) w.append(",");
    first.* = false;
    w.append("{\"path\":");
    w.appendJsonString(path);
    w.append(",\"line\":");
    w.appendFmt("{}", .{line});
    w.append(",\"column\":");
    w.appendFmt("{}", .{col});
    w.append(",\"byteStart\":");
    w.appendFmt("{}", .{start});
    w.append(",\"byteEnd\":");
    w.appendFmt("{}", .{end});
    w.append(",\"preview\":");
    w.appendJsonString(preview);
    w.append("}");
}

export fn sift_fs_search_literal(
    root_ptr: [*]const u8,
    root_len: u32,
    query_ptr: [*]const u8,
    query_len: u32,
    caps_ptr: *const SearchCaps,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
    stats_out: *SearchStats,
) u32 {
    const root = inputSlice(root_ptr, root_len);
    const query = inputSlice(query_ptr, query_len);
    if (pathLooksUnsafe(root) or query.len == 0 or std.mem.indexOf(u8, query, "\x00") != null) {
        return STATUS_INVALID_ARGS;
    }

    const caps = caps_ptr.*;
    const max_files = if (caps.max_files == 0) DEFAULT_SEARCH_MAX_FILES else caps.max_files;
    const max_matches = if (caps.max_matches == 0) DEFAULT_SEARCH_MAX_MATCHES else caps.max_matches;
    const max_depth = if (caps.max_depth == 0) DEFAULT_SEARCH_MAX_DEPTH else caps.max_depth;
    const max_file_bytes = if (caps.max_file_bytes == 0) DEFAULT_SEARCH_MAX_FILE_BYTES else caps.max_file_bytes;
    const preview_bytes = if (caps.preview_bytes == 0) DEFAULT_PREVIEW_BYTES else caps.preview_bytes;
    const include_hidden = (caps.flags & 0x1) != 0;

    var stats: SearchStats = .{
        .searched_files = 0,
        .skipped_files = 0,
        .matched_files = 0,
        .matches = 0,
        .truncated = 0,
    };

    const allocator = std.heap.smp_allocator;
    var root_dir = if (Dir.path.isAbsolute(root))
        Dir.openDirAbsolute(io(), root, .{ .iterate = true, .follow_symlinks = false }) catch |err| return statusFromDirError(err)
    else
        Dir.cwd().openDir(io(), root, .{ .iterate = true, .follow_symlinks = false }) catch |err| return statusFromDirError(err);
    defer root_dir.close(io());

    var walker = root_dir.walk(allocator) catch return STATUS_IO_ERROR;
    defer walker.deinit();

    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    writeSearchHeader(&w);
    var first = true;

    while (walker.next(io()) catch null) |entry| {
        if (entry.depth() > max_depth) {
            if (entry.kind == .directory) walker.leave(io());
            stats.skipped_files += 1;
            continue;
        }

        if (entry.kind == .directory) {
            if (noisyDir(entry.basename) or (!include_hidden and hiddenPath(entry.path))) {
                walker.leave(io());
                stats.skipped_files += 1;
            }
            continue;
        }

        if (entry.kind != .file) {
            stats.skipped_files += 1;
            continue;
        }

        if (!include_hidden and hiddenPath(entry.path)) {
            stats.skipped_files += 1;
            continue;
        }

        if (stats.searched_files >= max_files or stats.matches >= max_matches) {
            stats.truncated = 1;
            break;
        }

        const file_data = entry.dir.readFileAlloc(io(), entry.basename, allocator, .limited(@as(usize, @intCast(max_file_bytes)) + 1)) catch {
            stats.skipped_files += 1;
            continue;
        };
        defer allocator.free(file_data);

        if (file_data.len > max_file_bytes or isBinary(file_data) or !std.unicode.utf8ValidateSlice(file_data)) {
            stats.skipped_files += 1;
            continue;
        }

        stats.searched_files += 1;
        var matched_this_file = false;
        var offset: usize = 0;
        while (offset < file_data.len) {
            const found_rel = std.mem.indexOf(u8, file_data[offset..], query) orelse break;
            const start = offset + found_rel;
            const end = start + query.len;
            const bounds = previewBounds(file_data, start, end, preview_bytes);
            writeMatch(&w, &first, entry.path, file_data[bounds.start..bounds.end], lineForByte(file_data, start), colForByte(file_data, start), start, end);
            stats.matches += 1;
            matched_this_file = true;
            if (stats.matches >= max_matches) {
                stats.truncated = 1;
                break;
            }
            offset = end;
        }
        if (matched_this_file) stats.matched_files += 1;
    }

    writeSearchStats(&w, &stats);
    stats_out.* = stats;
    return finish(&w, written_out, needed_out);
}

test "binary sniff detects nul bytes" {
    try std.testing.expect(isBinary("a\x00b"));
    try std.testing.expect(!isBinary("hello"));
}

test "hidden path and noisy directory defaults" {
    try std.testing.expect(hiddenPath(".git/config"));
    try std.testing.expect(hiddenPath("src/.cache/file"));
    try std.testing.expect(noisyDir("node_modules"));
    try std.testing.expect(!noisyDir("src"));
}

test "line and column mapping" {
    const text = "one\ntwo\nthree";
    try std.testing.expectEqual(@as(u32, 2), lineForByte(text, 5));
    try std.testing.expectEqual(@as(u32, 2), colForByte(text, 5));
}
