const std = @import("std");
const repo_scan = @import("repo_scan.zig");

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;
const Stat = Dir.Stat;

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
// Write/edit statuses (A1). 10–15 are distinct from the read/search set above.
const STATUS_ALREADY_EXISTS: u32 = 10;
const STATUS_NO_MATCH: u32 = 11;
const STATUS_AMBIGUOUS_MATCH: u32 = 12;
const STATUS_IO_ERROR: u32 = 13;
const STATUS_STALE: u32 = 14;
const STATUS_OUTSIDE_ROOT: u32 = 15;

// Edits read the whole file into memory; cap it so a runaway target can't OOM.
const DEFAULT_EDIT_MAX_BYTES: usize = 4 * 1024 * 1024;

// Edit flag bits (passed from the TS wrapper).
const EDIT_FLAG_REQUIRE_UNIQUE: u32 = 0x1;
const EDIT_FLAG_CHECK_FRESHNESS: u32 = 0x2;

// Write flag bits.
const WRITE_FLAG_CREATE_ONLY: u32 = 0x1;
const WRITE_FLAG_MAKE_PATH: u32 = 0x2;

const DEFAULT_READ_BYTES: u32 = 64 * 1024;
const DEFAULT_SEARCH_MAX_FILES: u32 = 5000;
const DEFAULT_SEARCH_MAX_MATCHES: u32 = 100;
const DEFAULT_SEARCH_MAX_DEPTH: u32 = 8;
const DEFAULT_SEARCH_MAX_FILE_BYTES: u32 = 1024 * 1024;
const DEFAULT_PREVIEW_BYTES: u32 = 240;

const SEARCH_FLAG_INCLUDE_HIDDEN: u32 = 0x1;
const SEARCH_FLAG_INCLUDE_VENDOR: u32 = 0x8;
const SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS: u32 = 0x10;
const SEARCH_FLAG_IGNORE_GITIGNORE: u32 = 0x20;
const SEARCH_DETAIL_SHIFT: u5 = 24;
const SEARCH_DETAIL_MASK: u32 = 0x3 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_PATHS: u32 = 0x1 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_LOCATIONS: u32 = 0x2 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_FULL: u32 = 0x3 << SEARCH_DETAIL_SHIFT;

pub const RepoScanCaps = repo_scan.RepoScanCaps;
pub const RepoScanStats = repo_scan.RepoScanStats;

const VENDOR_DIRS = [_][]const u8{
    "node_modules",
    "vendor",
};

const BUILD_OUTPUT_DIRS = [_][]const u8{
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    "tmp",
    "target",
    "zig-cache",
    ".zig-cache",
    "zig-out",
};

pub const SearchCaps = extern struct {
    max_files: u32,
    max_matches: u32,
    max_depth: u32,
    max_file_bytes: u32,
    preview_bytes: u32,
    flags: u32,
};

pub const SearchStats = extern struct {
    searched_files: u32,
    skipped_files: u32,
    matched_files: u32,
    matches: u32,
    truncated: u32,
};

const SearchSkippedByReason = struct {
    hidden: u32 = 0,
    vendor: u32 = 0,
    build_output: u32 = 0,
    binary: u32 = 0,
    too_large: u32 = 0,
    invalid_utf8: u32 = 0,
    io_error: u32 = 0,
    gitignore: u32 = 0,
    depth: u32 = 0,
    non_file: u32 = 0,
    other: u32 = 0,
};

const SearchDiagnostics = struct {
    bytes_scanned: u64 = 0,
    cap_reason: ?SearchCapReason = null,
    skipped_by_reason: SearchSkippedByReason = .{},
};

const SearchSkipReason = enum {
    hidden,
    vendor,
    build_output,
    binary,
    too_large,
    invalid_utf8,
    io_error,
    gitignore,
    depth,
    non_file,
    other,
};

const SearchCapReason = enum {
    max_matches,
    max_files,
    max_bytes,
    max_depth,
};

const SearchDetail = enum {
    paths,
    locations,
    snippets,
    full,
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
        var scratch: [1024]u8 = undefined;
        const rendered = std.fmt.bufPrint(&scratch, fmt, args) catch {
            self.overflow = true;
            self.needed += scratch.len;
            return;
        };
        self.append(rendered);
    }

    fn appendJsonString(self: *Writer, s: []const u8) void {
        self.appendByte('"');
        var start: usize = 0;
        for (s, 0..) |b, i| {
            switch (b) {
                '"', '\\', 0x00...0x1f => {
                    self.append(s[start..i]);
                    switch (b) {
                        '"' => self.append("\\\""),
                        '\\' => self.append("\\\\"),
                        0x0a => self.append("\\n"),
                        0x0d => self.append("\\r"),
                        0x09 => self.append("\\t"),
                        else => self.appendFmt("\\u{x:0>4}", .{b}),
                    }
                    start = i + 1;
                },
                else => {},
            }
        }
        self.append(s[start..]);
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

/// FNV-1a 32-bit. Mirrored byte-for-byte in fsEngine.ts so the TS layer can
/// hand back a freshness token the Zig edit path validates before writing.
fn fnv1a32(bytes: []const u8) u32 {
    var h: u32 = 2166136261;
    for (bytes) |b| {
        h ^= b;
        h *%= 16777619;
    }
    return h;
}

/// True if any path component is exactly "..". Used to reject traversal even
/// after a prefix match, so a writable root can't be escaped.
fn pathHasDotDot(path: []const u8) bool {
    var start: usize = 0;
    while (true) {
        var end = start;
        while (end < path.len and path[end] != '/' and path[end] != '\\') : (end += 1) {}
        if (std.mem.eql(u8, path[start..end], "..")) return true;
        if (end >= path.len) break;
        start = end + 1;
    }
    return false;
}

/// Writable-root enforcement (real, not advisory). An empty root disables the
/// jail (caller opted out). Otherwise the target must be an absolute path that
/// sits at or beneath `root` on a component boundary, with no ".." escape.
fn withinRoot(root: []const u8, path: []const u8) bool {
    if (pathLooksUnsafe(path) or pathHasDotDot(path)) return false;
    if (root.len == 0) return true;
    if (!Dir.path.isAbsolute(path)) return false;
    if (!std.mem.startsWith(u8, path, root)) return false;
    if (path.len == root.len) return true;
    const c = path[root.len];
    return c == '/' or c == '\\';
}

/// Count non-overlapping occurrences of `needle` in `haystack`.
fn countOccurrences(haystack: []const u8, needle: []const u8) usize {
    if (needle.len == 0 or needle.len > haystack.len) return 0;
    var count: usize = 0;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) {
        if (std.mem.eql(u8, haystack[i .. i + needle.len], needle)) {
            count += 1;
            i += needle.len;
        } else {
            i += 1;
        }
    }
    return count;
}

/// Atomic full-file write: write to an unnamed temp via createFileAtomic, then
/// rename over the target. A partial/failed write never leaves a half-written
/// file in place (the gap in opencode/codex/t3 — all of which write directly).
fn atomicWriteFile(path: []const u8, content: []const u8, perms: File.Permissions, make_path: bool) u32 {
    var af = Dir.cwd().createFileAtomic(io(), path, .{
        .permissions = perms,
        .make_path = make_path,
        .replace = true,
    }) catch |err| return statusFromFileError(err);
    defer af.deinit(io());
    af.file.writeStreamingAll(io(), content) catch |err| return statusFromFileError(err);
    af.replace(io()) catch |err| return statusFromFileError(err);
    return STATUS_OK;
}

fn nameInList(name: []const u8, list: []const []const u8) bool {
    for (list) |blocked| {
        if (std.mem.eql(u8, name, blocked)) return true;
    }
    return false;
}

fn searchExcludeReason(name: []const u8, flags: u32) ?SearchSkipReason {
    if (std.mem.eql(u8, name, ".git")) return .other;
    if ((flags & SEARCH_FLAG_INCLUDE_VENDOR) == 0 and nameInList(name, &VENDOR_DIRS)) return .vendor;
    if ((flags & SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS) == 0 and nameInList(name, &BUILD_OUTPUT_DIRS)) return .build_output;
    return null;
}

fn searchExcludedDir(name: []const u8, flags: u32) bool {
    return searchExcludeReason(name, flags) != null;
}

fn searchDetail(flags: u32) SearchDetail {
    return switch (flags & SEARCH_DETAIL_MASK) {
        SEARCH_DETAIL_PATHS => .paths,
        SEARCH_DETAIL_LOCATIONS => .locations,
        SEARCH_DETAIL_FULL => .full,
        else => .snippets,
    };
}

fn respectGitignore(flags: u32) bool {
    return (flags & SEARCH_FLAG_IGNORE_GITIGNORE) == 0;
}

fn rootHasGitDir(root_dir: Dir) bool {
    var git_dir = root_dir.openDir(io(), ".git", .{}) catch return false;
    git_dir.close(io());
    return true;
}

fn trimGitignoreLine(line: []const u8) []const u8 {
    return std.mem.trim(u8, line, " \t\r");
}

fn basename(path: []const u8) []const u8 {
    var i = path.len;
    while (i > 0) : (i -= 1) {
        if (path[i - 1] == '/' or path[i - 1] == '\\') return path[i..];
    }
    return path;
}

fn segmentMatches(pattern: []const u8, value: []const u8) bool {
    if (std.mem.eql(u8, pattern, "*")) return true;
    const star = std.mem.indexOfScalar(u8, pattern, '*') orelse return std.mem.eql(u8, pattern, value);
    const prefix = pattern[0..star];
    const suffix = pattern[star + 1 ..];
    return value.len >= prefix.len + suffix.len and
        std.mem.startsWith(u8, value, prefix) and
        std.mem.endsWith(u8, value, suffix);
}

fn pathRuleMatches(pattern: []const u8, path: []const u8, is_dir: bool, directory_only: bool) bool {
    if (directory_only and !is_dir) return false;
    if (std.mem.endsWith(u8, pattern, "/*")) {
        const prefix = pattern[0 .. pattern.len - 1];
        if (!std.mem.startsWith(u8, path, prefix)) return false;
        return std.mem.indexOfScalar(u8, path[prefix.len..], '/') == null;
    }
    if (std.mem.indexOfScalar(u8, pattern, '/') != null) {
        return segmentMatches(pattern, path);
    }
    var start: usize = 0;
    while (start <= path.len) {
        var end = start;
        while (end < path.len and path[end] != '/' and path[end] != '\\') : (end += 1) {}
        if (segmentMatches(pattern, path[start..end])) return true;
        if (end >= path.len) break;
        start = end + 1;
    }
    return false;
}

fn gitignoreDecision(rules: []const u8, path: []const u8, is_dir: bool) bool {
    var ignored = false;
    var lines = std.mem.splitScalar(u8, rules, '\n');
    while (lines.next()) |raw| {
        var line = trimGitignoreLine(raw);
        if (line.len == 0 or line[0] == '#') continue;
        var negated = false;
        if (line[0] == '!') {
            negated = true;
            line = trimGitignoreLine(line[1..]);
            if (line.len == 0) continue;
        }
        while (line.len > 0 and line[0] == '/') line = line[1..];
        const directory_only = line.len > 0 and line[line.len - 1] == '/';
        while (line.len > 0 and line[line.len - 1] == '/') line = line[0 .. line.len - 1];
        if (line.len == 0) continue;
        if (pathRuleMatches(line, path, is_dir, directory_only)) ignored = !negated;
    }
    return ignored;
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

const LineCursor = struct {
    offset: usize = 0,
    line: u32 = 1,
    line_start: usize = 0,

    fn advanceTo(self: *LineCursor, input: []const u8, byte_index: usize) void {
        while (self.offset < byte_index and self.offset < input.len) : (self.offset += 1) {
            if (input[self.offset] == '\n') {
                self.line += 1;
                self.line_start = self.offset + 1;
            }
        }
    }

    fn columnFor(self: *const LineCursor, byte_index: usize) u32 {
        return @intCast(byte_index - self.line_start + 1);
    }
};

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

pub export fn sift_fs_read_text(
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

fn recordSearchSkip(stats: *SearchStats, diagnostics: *SearchDiagnostics, reason: SearchSkipReason) void {
    stats.skipped_files += 1;
    switch (reason) {
        .hidden => diagnostics.skipped_by_reason.hidden += 1,
        .vendor => diagnostics.skipped_by_reason.vendor += 1,
        .build_output => diagnostics.skipped_by_reason.build_output += 1,
        .binary => diagnostics.skipped_by_reason.binary += 1,
        .too_large => diagnostics.skipped_by_reason.too_large += 1,
        .invalid_utf8 => diagnostics.skipped_by_reason.invalid_utf8 += 1,
        .io_error => diagnostics.skipped_by_reason.io_error += 1,
        .gitignore => diagnostics.skipped_by_reason.gitignore += 1,
        .depth => diagnostics.skipped_by_reason.depth += 1,
        .non_file => diagnostics.skipped_by_reason.non_file += 1,
        .other => diagnostics.skipped_by_reason.other += 1,
    }
}

fn recordSearchCap(stats: *SearchStats, diagnostics: *SearchDiagnostics, reason: SearchCapReason) void {
    stats.truncated = 1;
    if (diagnostics.cap_reason == null) diagnostics.cap_reason = reason;
}

fn capReasonString(reason: ?SearchCapReason) []const u8 {
    return switch (reason orelse return "null") {
        .max_matches => "\"maxMatches\"",
        .max_files => "\"maxFiles\"",
        .max_bytes => "\"maxBytes\"",
        .max_depth => "\"maxDepth\"",
    };
}

fn writeSearchStats(w: *Writer, stats: *const SearchStats, diagnostics: *const SearchDiagnostics) void {
    const skipped = diagnostics.skipped_by_reason;
    w.appendFmt(
        "],\"stats\":{{\"searchedFiles\":{},\"skippedFiles\":{},\"matchedFiles\":{},\"matches\":{},\"truncated\":{},\"capped\":{},\"capReason\":{s},\"bytesScanned\":{},\"skippedByReason\":{{\"hidden\":{},\"vendor\":{},\"buildOutput\":{},\"binary\":{},\"tooLarge\":{},\"invalidUtf8\":{},\"ioError\":{},\"gitignore\":{},\"depth\":{},\"nonFile\":{},\"other\":{}}}}}}}",
        .{
            stats.searched_files,
            stats.skipped_files,
            stats.matched_files,
            stats.matches,
            stats.truncated,
            diagnostics.cap_reason != null,
            capReasonString(diagnostics.cap_reason),
            diagnostics.bytes_scanned,
            skipped.hidden,
            skipped.vendor,
            skipped.build_output,
            skipped.binary,
            skipped.too_large,
            skipped.invalid_utf8,
            skipped.io_error,
            skipped.gitignore,
            skipped.depth,
            skipped.non_file,
            skipped.other,
        },
    );
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

pub export fn sift_fs_search_literal(
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
    const include_hidden = (caps.flags & SEARCH_FLAG_INCLUDE_HIDDEN) != 0;
    const detail = searchDetail(caps.flags);
    const use_gitignore = respectGitignore(caps.flags);

    var stats: SearchStats = .{
        .searched_files = 0,
        .skipped_files = 0,
        .matched_files = 0,
        .matches = 0,
        .truncated = 0,
    };
    var diagnostics: SearchDiagnostics = .{};

    const allocator = std.heap.smp_allocator;
    var root_dir = if (Dir.path.isAbsolute(root))
        Dir.openDirAbsolute(io(), root, .{ .iterate = true, .follow_symlinks = false }) catch |err| return statusFromDirError(err)
    else
        Dir.cwd().openDir(io(), root, .{ .iterate = true, .follow_symlinks = false }) catch |err| return statusFromDirError(err);
    defer root_dir.close(io());

    const gitignore_rules: ?[]u8 = if (use_gitignore and rootHasGitDir(root_dir))
        root_dir.readFileAlloc(io(), ".gitignore", allocator, .limited(64 * 1024)) catch null
    else
        null;
    defer if (gitignore_rules) |rules| allocator.free(rules);

    var walker = root_dir.walk(allocator) catch return STATUS_IO_ERROR;
    defer walker.deinit();

    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    writeSearchHeader(&w);
    var first = true;

    while (true) {
        const maybe_entry = walker.next(io()) catch {
            stats_out.* = stats;
            return STATUS_IO_ERROR;
        };
        const entry = maybe_entry orelse break;

        if (entry.depth() > max_depth) {
            if (entry.kind == .directory) walker.leave(io());
            recordSearchCap(&stats, &diagnostics, .max_depth);
            recordSearchSkip(&stats, &diagnostics, .depth);
            continue;
        }

        if (entry.kind == .directory) {
            if (!include_hidden and hiddenPath(entry.path)) {
                walker.leave(io());
                recordSearchSkip(&stats, &diagnostics, .hidden);
                continue;
            }
            if (searchExcludeReason(entry.basename, caps.flags)) |reason| {
                walker.leave(io());
                recordSearchSkip(&stats, &diagnostics, reason);
                continue;
            }
            if (gitignore_rules) |rules| {
                if (gitignoreDecision(rules, entry.path, true)) {
                    walker.leave(io());
                    recordSearchSkip(&stats, &diagnostics, .gitignore);
                    continue;
                }
            }
            continue;
        }

        if (entry.kind != .file) {
            recordSearchSkip(&stats, &diagnostics, .non_file);
            continue;
        }

        if (!include_hidden and hiddenPath(entry.path)) {
            recordSearchSkip(&stats, &diagnostics, .hidden);
            continue;
        }
        if (gitignore_rules) |rules| {
            if (gitignoreDecision(rules, entry.path, false)) {
                recordSearchSkip(&stats, &diagnostics, .gitignore);
                continue;
            }
        }

        if (stats.searched_files >= max_files or stats.matches >= max_matches) {
            recordSearchCap(&stats, &diagnostics, if (stats.searched_files >= max_files) .max_files else .max_matches);
            break;
        }

        const file_stat = entry.dir.statFile(io(), entry.basename, .{}) catch {
            recordSearchSkip(&stats, &diagnostics, .io_error);
            continue;
        };
        if (file_stat.size > max_file_bytes) {
            recordSearchSkip(&stats, &diagnostics, .too_large);
            continue;
        }

        const file_data = entry.dir.readFileAlloc(io(), entry.basename, allocator, .limited(@intCast(max_file_bytes))) catch {
            recordSearchSkip(&stats, &diagnostics, .io_error);
            continue;
        };
        defer allocator.free(file_data);

        if (file_data.len > max_file_bytes) {
            recordSearchSkip(&stats, &diagnostics, .too_large);
            continue;
        }
        if (isBinary(file_data)) {
            recordSearchSkip(&stats, &diagnostics, .binary);
            continue;
        }
        if (!std.unicode.utf8ValidateSlice(file_data)) {
            recordSearchSkip(&stats, &diagnostics, .invalid_utf8);
            continue;
        }

        stats.searched_files += 1;
        if (stats.searched_files >= max_files) recordSearchCap(&stats, &diagnostics, .max_files);
        diagnostics.bytes_scanned += file_data.len;
        var matched_this_file = false;
        var offset: usize = 0;
        var line_cursor: LineCursor = .{};
        while (offset < file_data.len) {
            const found_rel = std.mem.indexOf(u8, file_data[offset..], query) orelse break;
            const start = offset + found_rel;
            const end = start + query.len;
            if (detail == .paths) {
                writeMatch(&w, &first, entry.path, "", 0, 0, 0, 0);
            } else {
                line_cursor.advanceTo(file_data, start);
                const preview = if (detail == .locations)
                    ""
                else blk: {
                    const bounds = previewBounds(file_data, start, end, preview_bytes);
                    break :blk file_data[bounds.start..bounds.end];
                };
                writeMatch(&w, &first, entry.path, preview, line_cursor.line, line_cursor.columnFor(start), start, end);
            }
            stats.matches += 1;
            matched_this_file = true;
            if (stats.matches >= max_matches) {
                recordSearchCap(&stats, &diagnostics, .max_matches);
                break;
            }
            if (detail == .paths) break;
            offset = end;
        }
        if (matched_this_file) stats.matched_files += 1;
        if (stats.matches >= max_matches) break;
    }

    writeSearchStats(&w, &stats, &diagnostics);
    stats_out.* = stats;
    return finish(&w, written_out, needed_out);
}

pub export fn sift_repo_scan_manifest(
    root_ptr: [*]const u8,
    root_len: u32,
    caps_ptr: *const RepoScanCaps,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
    stats_out: *RepoScanStats,
) u32 {
    return repo_scan.scanManifest(
        root_ptr,
        root_len,
        caps_ptr,
        out_ptr,
        out_cap,
        written_out,
        needed_out,
        stats_out,
    );
}

/// Atomic full-file write. Enforces the writable root, optionally refuses to
/// clobber an existing file (create-only), preserves the existing file's mode
/// on overwrite, and reports whether the file was newly created.
pub export fn sift_fs_write_text(
    root_ptr: [*]const u8,
    root_len: u32,
    path_ptr: [*]const u8,
    path_len: u32,
    content_ptr: [*]const u8,
    content_len: u32,
    flags: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const root = inputSlice(root_ptr, root_len);
    const path = inputSlice(path_ptr, path_len);
    const content = inputSlice(content_ptr, content_len);
    if (pathLooksUnsafe(path)) return STATUS_INVALID_ARGS;
    if (!withinRoot(root, path)) return STATUS_OUTSIDE_ROOT;

    const create_only = (flags & WRITE_FLAG_CREATE_ONLY) != 0;
    const make_path = (flags & WRITE_FLAG_MAKE_PATH) != 0;

    const existing: ?Stat = Dir.cwd().statFile(io(), path, .{}) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return statusFromFileError(err),
    };
    const created = existing == null;
    if (create_only and !created) return STATUS_ALREADY_EXISTS;
    const perms = if (existing) |st| st.permissions else File.Permissions.default_file;

    const status = atomicWriteFile(path, content, perms, make_path);
    if (status != STATUS_OK) return status;

    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    w.append("{\"path\":");
    w.appendJsonString(path);
    w.appendFmt(",\"bytesWritten\":{},\"created\":{}}}", .{ content.len, created });
    return finish(&w, written_out, needed_out);
}

/// In-place edit by exact string replacement. Enforces the writable root,
/// optionally requires the match be unique (rejects ambiguous edits), and
/// optionally checks a caller-supplied FNV-1a freshness token to refuse a write
/// against a file that changed since it was read. Writes atomically and
/// preserves the existing file mode. Returns the new content's hash so the
/// caller can refresh its token.
// Small scalars are bundled into a struct pointer (mirroring SearchCaps) so the
// FFI arg count stays at 11 — Bun's dlopen marshalling is unreliable past that.
pub const EditParams = extern struct {
    old_len: u32,
    new_len: u32,
    expected_hash: u32,
    flags: u32,
};

pub export fn sift_fs_edit_text(
    root_ptr: [*]const u8,
    root_len: u32,
    path_ptr: [*]const u8,
    path_len: u32,
    old_ptr: [*]const u8,
    new_ptr: [*]const u8,
    params_ptr: *const EditParams,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const params = params_ptr.*;
    const root = inputSlice(root_ptr, root_len);
    const path = inputSlice(path_ptr, path_len);
    const old = inputSlice(old_ptr, params.old_len);
    const new = inputSlice(new_ptr, params.new_len);
    if (pathLooksUnsafe(path) or old.len == 0) return STATUS_INVALID_ARGS;
    if (!withinRoot(root, path)) return STATUS_OUTSIDE_ROOT;

    const require_unique = (params.flags & EDIT_FLAG_REQUIRE_UNIQUE) != 0;
    const check_freshness = (params.flags & EDIT_FLAG_CHECK_FRESHNESS) != 0;

    const allocator = std.heap.smp_allocator;
    const data = Dir.cwd().readFileAlloc(io(), path, allocator, .limited(DEFAULT_EDIT_MAX_BYTES + 1)) catch |err| {
        return statusFromFileError(err);
    };
    defer allocator.free(data);
    if (data.len > DEFAULT_EDIT_MAX_BYTES) return STATUS_TOO_LARGE;
    if (check_freshness and fnv1a32(data) != params.expected_hash) return STATUS_STALE;

    const occ = countOccurrences(data, old);
    if (occ == 0) return STATUS_NO_MATCH;
    if (require_unique and occ > 1) return STATUS_AMBIGUOUS_MATCH;

    const new_size = data.len - occ * old.len + occ * new.len;
    const out_buf = allocator.alloc(u8, new_size) catch return STATUS_IO_ERROR;
    defer allocator.free(out_buf);

    var ri: usize = 0;
    var wi: usize = 0;
    while (ri < data.len) {
        if (ri + old.len <= data.len and std.mem.eql(u8, data[ri .. ri + old.len], old)) {
            @memcpy(out_buf[wi .. wi + new.len], new);
            wi += new.len;
            ri += old.len;
        } else {
            out_buf[wi] = data[ri];
            wi += 1;
            ri += 1;
        }
    }

    const existing: ?Stat = Dir.cwd().statFile(io(), path, .{}) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return statusFromFileError(err),
    };
    const perms = if (existing) |st| st.permissions else File.Permissions.default_file;
    const status = atomicWriteFile(path, out_buf[0..wi], perms, false);
    if (status != STATUS_OK) return status;

    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    w.append("{\"path\":");
    w.appendJsonString(path);
    w.appendFmt(",\"bytesWritten\":{},\"replacements\":{},\"newHash\":{}}}", .{ wi, occ, fnv1a32(out_buf[0..wi]) });
    return finish(&w, written_out, needed_out);
}

test "native write then edit roundtrip (real IO)" {
    var out: [1024]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;

    const dir = ".zig-cache/sift-fs-it";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    const root: []const u8 = "";
    const path: []const u8 = ".zig-cache/sift-fs-it/n.txt";
    const content: []const u8 = "hello world\n";

    var st = sift_fs_write_text(
        root.ptr,
        @intCast(root.len),
        path.ptr,
        @intCast(path.len),
        content.ptr,
        @intCast(content.len),
        WRITE_FLAG_MAKE_PATH,
        &out,
        out.len,
        &written,
        &needed,
    );
    try std.testing.expectEqual(STATUS_OK, st);

    const old_s: []const u8 = "world";
    const new_s: []const u8 = "there";
    const ep: EditParams = .{
        .old_len = @intCast(old_s.len),
        .new_len = @intCast(new_s.len),
        .expected_hash = 0,
        .flags = EDIT_FLAG_REQUIRE_UNIQUE,
    };
    st = sift_fs_edit_text(
        root.ptr,
        @intCast(root.len),
        path.ptr,
        @intCast(path.len),
        old_s.ptr,
        new_s.ptr,
        &ep,
        &out,
        out.len,
        &written,
        &needed,
    );
    try std.testing.expectEqual(STATUS_OK, st);

    const data = try Dir.cwd().readFileAlloc(io(), path, std.testing.allocator, .limited(1024));
    defer std.testing.allocator.free(data);
    try std.testing.expectEqualStrings("hello there\n", data);
}

test "read text returns escaped JSON content" {
    const dir = ".zig-cache/sift-fs-read-json";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    const path: []const u8 = ".zig-cache/sift-fs-read-json/read.txt";
    const content: []const u8 = "a\n\"b\\c";

    var out: [256]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    const root: []const u8 = "";
    const write_status = sift_fs_write_text(
        root.ptr,
        @intCast(root.len),
        path.ptr,
        @intCast(path.len),
        content.ptr,
        @intCast(content.len),
        WRITE_FLAG_MAKE_PATH,
        &out,
        out.len,
        &written,
        &needed,
    );
    try std.testing.expectEqual(STATUS_OK, write_status);

    const status = sift_fs_read_text(path.ptr, @intCast(path.len), 1024, &out, out.len, &written, &needed);

    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqualStrings(
        "{\"path\":\".zig-cache/sift-fs-read-json/read.txt\",\"content\":\"a\\n\\\"b\\\\c\",\"truncated\":false,\"bytes\":6}",
        out[0..written],
    );
}

test "fnv1a32 matches known vectors" {
    try std.testing.expectEqual(@as(u32, 2166136261), fnv1a32(""));
    try std.testing.expectEqual(@as(u32, 0xe40c292c), fnv1a32("a"));
    try std.testing.expectEqual(@as(u32, 0xbf9cf968), fnv1a32("foobar"));
}

test "withinRoot enforces boundary and rejects traversal" {
    try std.testing.expect(withinRoot("/a/b", "/a/b/c.txt"));
    try std.testing.expect(withinRoot("/a/b", "/a/b"));
    try std.testing.expect(!withinRoot("/a/b", "/a/bc/x")); // prefix but not on a boundary
    try std.testing.expect(!withinRoot("/a/b", "/a")); // parent is not within
    try std.testing.expect(!withinRoot("/a/b", "relative/x")); // must be absolute
    try std.testing.expect(!withinRoot("/a", "/a/../etc/passwd")); // traversal escape
    try std.testing.expect(withinRoot("", "/anywhere")); // empty root disables the jail
}

test "countOccurrences is non-overlapping" {
    try std.testing.expectEqual(@as(usize, 2), countOccurrences("aXbXc", "X"));
    try std.testing.expectEqual(@as(usize, 0), countOccurrences("abc", "z"));
    try std.testing.expectEqual(@as(usize, 1), countOccurrences("aaa", "aa"));
    try std.testing.expectEqual(@as(usize, 0), countOccurrences("ab", "abc"));
}

test "json string writer escapes while bulk-copying spans" {
    var out: [64]u8 = undefined;
    var w: Writer = .{ .buf = &out };
    w.appendJsonString("a\n\"b\\c\x01");
    try std.testing.expect(!w.overflow);
    try std.testing.expectEqualStrings("\"a\\n\\\"b\\\\c\\u0001\"", out[0..w.len]);
}

test "binary sniff detects nul bytes" {
    try std.testing.expect(isBinary("a\x00b"));
    try std.testing.expect(!isBinary("hello"));
}

test "hidden path and noisy directory defaults" {
    try std.testing.expect(hiddenPath(".git/config"));
    try std.testing.expect(hiddenPath("src/.cache/file"));
    try std.testing.expect(searchExcludedDir("node_modules", 0));
    try std.testing.expect(searchExcludedDir(".turbo", 0));
    try std.testing.expect(searchExcludedDir("target", 0));
    try std.testing.expect(searchExcludedDir("zig-cache", 0));
    try std.testing.expect(!searchExcludedDir("src", 0));
    try std.testing.expect(!searchExcludedDir("node_modules", SEARCH_FLAG_INCLUDE_VENDOR));
    try std.testing.expect(searchExcludedDir("target", SEARCH_FLAG_INCLUDE_VENDOR));
    try std.testing.expect(!searchExcludedDir("target", SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS));
    try std.testing.expect(searchExcludedDir(".git", SEARCH_FLAG_INCLUDE_HIDDEN | SEARCH_FLAG_INCLUDE_VENDOR | SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS));
}

test "search policy flag combinations select expected files" {
    const dir = ".zig-cache/sift-fs-policy";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    const root: []const u8 = "";
    const content: []const u8 = "needle\n";
    const files = [_][]const u8{
        ".zig-cache/sift-fs-policy/src/a.txt",
        ".zig-cache/sift-fs-policy/.hidden/a.txt",
        ".zig-cache/sift-fs-policy/node_modules/a.txt",
        ".zig-cache/sift-fs-policy/vendor/a.txt",
        ".zig-cache/sift-fs-policy/dist/a.txt",
        ".zig-cache/sift-fs-policy/target/a.txt",
        ".zig-cache/sift-fs-policy/.git/config",
    };

    var out: [1024 * 1024]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    for (files) |path| {
        const status = sift_fs_write_text(
            root.ptr,
            @intCast(root.len),
            path.ptr,
            @intCast(path.len),
            content.ptr,
            @intCast(content.len),
            WRITE_FLAG_MAKE_PATH,
            &out,
            out.len,
            &written,
            &needed,
        );
        try std.testing.expectEqual(STATUS_OK, status);
    }

    const cases = [_]struct { flags: u32, expected: u32 }{
        .{ .flags = 0, .expected = 1 },
        .{ .flags = SEARCH_FLAG_INCLUDE_HIDDEN, .expected = 2 },
        .{ .flags = SEARCH_FLAG_INCLUDE_VENDOR, .expected = 3 },
        .{ .flags = SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS, .expected = 3 },
        .{ .flags = SEARCH_FLAG_INCLUDE_HIDDEN | SEARCH_FLAG_INCLUDE_VENDOR, .expected = 4 },
        .{ .flags = SEARCH_FLAG_INCLUDE_HIDDEN | SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS, .expected = 4 },
        .{ .flags = SEARCH_FLAG_INCLUDE_VENDOR | SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS, .expected = 5 },
        .{ .flags = SEARCH_FLAG_INCLUDE_HIDDEN | SEARCH_FLAG_INCLUDE_VENDOR | SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS, .expected = 6 },
    };

    const search_root: []const u8 = ".zig-cache/sift-fs-policy";
    const query: []const u8 = "needle";
    for (cases) |case| {
        var stats: SearchStats = .{
            .searched_files = 0,
            .skipped_files = 0,
            .matched_files = 0,
            .matches = 0,
            .truncated = 0,
        };
        const caps: SearchCaps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 1024,
            .preview_bytes = 80,
            .flags = case.flags,
        };
        const status = sift_fs_search_literal(
            search_root.ptr,
            @intCast(search_root.len),
            query.ptr,
            @intCast(query.len),
            &caps,
            &out,
            out.len,
            &written,
            &needed,
            &stats,
        );
        try std.testing.expectEqual(STATUS_OK, status);
        try std.testing.expectEqual(case.expected, stats.matches);
        try std.testing.expectEqual(case.expected, stats.matched_files);
    }
}

test "search gitignore policy requires git context and can be disabled" {
    const dir = ".zig-cache/sift-fs-gitignore";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    const root: []const u8 = "";
    var out: [1024 * 1024]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;

    const parent_ignore: []const u8 = ".zig-cache/sift-fs-gitignore/home/.gitignore";
    const parent_ignore_data: []const u8 = "*\n";
    var status = sift_fs_write_text(root.ptr, @intCast(root.len), parent_ignore.ptr, @intCast(parent_ignore.len), parent_ignore_data.ptr, @intCast(parent_ignore_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);
    const plain_file: []const u8 = ".zig-cache/sift-fs-gitignore/home/repo/src/visible.txt";
    const plain_data: []const u8 = "plain context needle\n";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), plain_file.ptr, @intCast(plain_file.len), plain_data.ptr, @intCast(plain_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    var stats: SearchStats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    const caps: SearchCaps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 1024, .preview_bytes = 80, .flags = 0 };
    const plain_root: []const u8 = ".zig-cache/sift-fs-gitignore/home/repo";
    const plain_query: []const u8 = "plain context";
    status = sift_fs_search_literal(plain_root.ptr, @intCast(plain_root.len), plain_query.ptr, @intCast(plain_query.len), &caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 1), stats.matches);

    const git_config: []const u8 = ".zig-cache/sift-fs-gitignore/repo/.git/config";
    const git_config_data: []const u8 = "[core]\n";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), git_config.ptr, @intCast(git_config.len), git_config_data.ptr, @intCast(git_config_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);
    const ignore_path: []const u8 = ".zig-cache/sift-fs-gitignore/repo/.gitignore";
    const ignore_data: []const u8 = "ignored.txt\n.vscode/*\n!.vscode/settings.json\n";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), ignore_path.ptr, @intCast(ignore_path.len), ignore_data.ptr, @intCast(ignore_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);
    const ignored_path: []const u8 = ".zig-cache/sift-fs-gitignore/repo/ignored.txt";
    const ignored_data: []const u8 = "git ignored needle\n";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), ignored_path.ptr, @intCast(ignored_path.len), ignored_data.ptr, @intCast(ignored_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);
    const settings_path: []const u8 = ".zig-cache/sift-fs-gitignore/repo/.vscode/settings.json";
    const settings_data: []const u8 = "whitelisted hidden needle\n";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), settings_path.ptr, @intCast(settings_path.len), settings_data.ptr, @intCast(settings_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);
    const extensions_path: []const u8 = ".zig-cache/sift-fs-gitignore/repo/.vscode/extensions.json";
    const extensions_data: []const u8 = "ignored hidden needle\n";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), extensions_path.ptr, @intCast(extensions_path.len), extensions_data.ptr, @intCast(extensions_data.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    const git_root: []const u8 = ".zig-cache/sift-fs-gitignore/repo";
    const git_query: []const u8 = "git ignored";
    stats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    status = sift_fs_search_literal(git_root.ptr, @intCast(git_root.len), git_query.ptr, @intCast(git_query.len), &caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 0), stats.matches);
    var json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"gitignore\":") != null);

    var override_caps = caps;
    override_caps.flags = SEARCH_FLAG_IGNORE_GITIGNORE;
    stats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    status = sift_fs_search_literal(git_root.ptr, @intCast(git_root.len), git_query.ptr, @intCast(git_query.len), &override_caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 1), stats.matches);

    var hidden_caps = caps;
    hidden_caps.flags = SEARCH_FLAG_INCLUDE_HIDDEN;
    const hidden_query: []const u8 = "hidden needle";
    stats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    status = sift_fs_search_literal(git_root.ptr, @intCast(git_root.len), hidden_query.ptr, @intCast(hidden_query.len), &hidden_caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 1), stats.matches);
    json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, ".vscode/settings.json") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, ".vscode/extensions.json") == null);
}

test "search diagnostics classify binary invalid UTF-8 and too-large files" {
    const dir = ".zig-cache/sift-fs-diagnostics";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    const root: []const u8 = "";
    const small_path: []const u8 = ".zig-cache/sift-fs-diagnostics/small.txt";
    const small: []const u8 = "needle\n";
    var out: [1024 * 1024]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    var status = sift_fs_write_text(root.ptr, @intCast(root.len), small_path.ptr, @intCast(small_path.len), small.ptr, @intCast(small.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    const large_path: []const u8 = ".zig-cache/sift-fs-diagnostics/large.txt";
    const large: []const u8 = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    status = sift_fs_write_text(root.ptr, @intCast(root.len), large_path.ptr, @intCast(large_path.len), large.ptr, @intCast(large.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    const binary_path: []const u8 = ".zig-cache/sift-fs-diagnostics/binary.bin";
    const binary = [_]u8{ 'n', 'e', 'e', 'd', 'l', 'e', 0 };
    status = sift_fs_write_text(root.ptr, @intCast(root.len), binary_path.ptr, @intCast(binary_path.len), &binary, binary.len, WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    const invalid_path: []const u8 = ".zig-cache/sift-fs-diagnostics/invalid.txt";
    const invalid = [_]u8{ 0xff, 0xfe, 0xfd };
    status = sift_fs_write_text(root.ptr, @intCast(root.len), invalid_path.ptr, @intCast(invalid_path.len), &invalid, invalid.len, WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    var stats: SearchStats = .{
        .searched_files = 0,
        .skipped_files = 0,
        .matched_files = 0,
        .matches = 0,
        .truncated = 0,
    };
    const caps: SearchCaps = .{
        .max_files = 100,
        .max_matches = 100,
        .max_depth = 8,
        .max_file_bytes = 16,
        .preview_bytes = 80,
        .flags = 0,
    };
    const search_root: []const u8 = ".zig-cache/sift-fs-diagnostics";
    const query: []const u8 = "needle";
    status = sift_fs_search_literal(search_root.ptr, @intCast(search_root.len), query.ptr, @intCast(query.len), &caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 1), stats.matches);
    try std.testing.expectEqual(@as(u32, 3), stats.skipped_files);
    const json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"binary\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"tooLarge\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"invalidUtf8\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"capped\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"capReason\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"bytesScanned\":7") != null);
}

test "search detail levels reduce result metadata" {
    const dir = ".zig-cache/sift-fs-detail";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    const root: []const u8 = "";
    const path: []const u8 = ".zig-cache/sift-fs-detail/src/positions.txt";
    const content: []const u8 = "a\npin pin\nzz pin\n";
    var out: [65536]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    var status = sift_fs_write_text(root.ptr, @intCast(root.len), path.ptr, @intCast(path.len), content.ptr, @intCast(content.len), WRITE_FLAG_MAKE_PATH, &out, out.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OK, status);

    const search_root: []const u8 = ".zig-cache/sift-fs-detail";
    const query: []const u8 = "pin";
    var stats: SearchStats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    var caps: SearchCaps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS };
    status = sift_fs_search_literal(search_root.ptr, @intCast(search_root.len), query.ptr, @intCast(query.len), &caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 1), stats.matches);
    var json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"line\":0") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"preview\":\"\"") != null);

    stats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    caps.flags = SEARCH_DETAIL_LOCATIONS;
    status = sift_fs_search_literal(search_root.ptr, @intCast(search_root.len), query.ptr, @intCast(query.len), &caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    try std.testing.expectEqual(@as(u32, 3), stats.matches);
    json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"line\":2") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"column\":5") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"preview\":\"\"") != null);

    stats = .{ .searched_files = 0, .skipped_files = 0, .matched_files = 0, .matches = 0, .truncated = 0 };
    caps.flags = 0;
    status = sift_fs_search_literal(search_root.ptr, @intCast(search_root.len), query.ptr, @intCast(query.len), &caps, &out, out.len, &written, &needed, &stats);
    try std.testing.expectEqual(STATUS_OK, status);
    json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"preview\":\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "pin pin") != null);
}

test "line and column mapping" {
    const text = "one\ntwo\nthree";
    try std.testing.expectEqual(@as(u32, 2), lineForByte(text, 5));
    try std.testing.expectEqual(@as(u32, 2), colForByte(text, 5));
}

test "line cursor matches standalone line and column helpers" {
    const text = "one\ntwo\nthree\nfour";
    var cursor: LineCursor = .{};
    const positions = [_]usize{ 0, 3, 4, 5, 8, 10, 14 };
    for (positions) |position| {
        cursor.advanceTo(text, position);
        try std.testing.expectEqual(lineForByte(text, position), cursor.line);
        try std.testing.expectEqual(colForByte(text, position), cursor.columnFor(position));
    }
}
