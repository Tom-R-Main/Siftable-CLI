const std = @import("std");

const Io = std.Io;
const Dir = std.Io.Dir;

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_NOT_DIR: u32 = 4;
const STATUS_PERMISSION_DENIED: u32 = 5;
const STATUS_OUTPUT_TOO_SMALL: u32 = 9;
const STATUS_IO_ERROR: u32 = 13;

const DEFAULT_SCAN_MAX_FILES: u32 = 5000;
const DEFAULT_SCAN_MAX_DEPTH: u32 = 8;
const DEFAULT_SCAN_MAX_FILE_BYTES: u32 = 1024 * 1024;

pub const SCAN_FLAG_INCLUDE_HIDDEN: u32 = 0x1;
pub const SCAN_FLAG_SOURCE_ONLY: u32 = 0x2;
pub const SCAN_FLAG_INCLUDE_VENDOR: u32 = 0x8;
pub const SCAN_FLAG_INCLUDE_BUILD_OUTPUTS: u32 = 0x10;
pub const SCAN_FLAG_IGNORE_GITIGNORE: u32 = 0x20;

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

const SOURCE_EXTENSIONS = [_][]const u8{
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".zig",
    ".rs",
    ".go",
    ".py",
    ".swift",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".css",
    ".scss",
    ".html",
    ".json",
    ".md",
    ".toml",
    ".yaml",
    ".yml",
};

pub const RepoScanCaps = extern struct {
    max_files: u32,
    max_depth: u32,
    max_file_bytes: u32,
    flags: u32,
};

pub const RepoScanStats = extern struct {
    scanned_files: u32,
    skipped_files: u32,
    truncated: u32,
    bytes_scanned: u64,
};

const SkippedByReason = struct {
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

const ScanDiagnostics = struct {
    cap_reason: ?CapReason = null,
    skipped_by_reason: SkippedByReason = .{},
};

const SkipReason = enum {
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

const CapReason = enum {
    max_files,
    max_depth,
};

const ScanFile = struct {
    path: []u8,
    bytes: u64,
    depth: u32,
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

fn statusFromDirError(err: anyerror) u32 {
    return switch (err) {
        error.FileNotFound, error.NotDir => STATUS_NOT_DIR,
        error.AccessDenied, error.PermissionDenied => STATUS_PERMISSION_DENIED,
        else => STATUS_IO_ERROR,
    };
}

fn pathLooksUnsafe(path: []const u8) bool {
    return path.len == 0 or std.mem.indexOf(u8, path, "\x00") != null;
}

fn isBinary(input: []const u8) bool {
    const sniff_len = @min(input.len, 8192);
    return std.mem.indexOfScalar(u8, input[0..sniff_len], 0) != null;
}

fn nameInList(name: []const u8, list: []const []const u8) bool {
    for (list) |blocked| {
        if (std.mem.eql(u8, name, blocked)) return true;
    }
    return false;
}

fn scanExcludeReason(name: []const u8, flags: u32) ?SkipReason {
    if (std.mem.eql(u8, name, ".git")) return .other;
    if ((flags & SCAN_FLAG_INCLUDE_VENDOR) == 0 and nameInList(name, &VENDOR_DIRS)) return .vendor;
    if ((flags & SCAN_FLAG_INCLUDE_BUILD_OUTPUTS) == 0 and nameInList(name, &BUILD_OUTPUT_DIRS)) return .build_output;
    return null;
}

fn rootHasGitDir(root_dir: Dir) bool {
    var git_dir = root_dir.openDir(io(), ".git", .{}) catch return false;
    git_dir.close(io());
    return true;
}

fn trimGitignoreLine(line: []const u8) []const u8 {
    return std.mem.trim(u8, line, " \t\r");
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

fn basename(path: []const u8) []const u8 {
    var i = path.len;
    while (i > 0) : (i -= 1) {
        if (path[i - 1] == '/' or path[i - 1] == '\\') return path[i..];
    }
    return path;
}

fn extname(path: []const u8) []const u8 {
    const name = basename(path);
    var i = name.len;
    while (i > 0) : (i -= 1) {
        if (name[i - 1] == '.') return name[i - 1 ..];
    }
    return "";
}

fn asciiLower(b: u8) u8 {
    return if (b >= 'A' and b <= 'Z') b + 32 else b;
}

fn eqlIgnoreCase(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |aa, bb| {
        if (asciiLower(aa) != asciiLower(bb)) return false;
    }
    return true;
}

fn containsIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    if (needle.len > haystack.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (eqlIgnoreCase(haystack[i .. i + needle.len], needle)) return true;
    }
    return false;
}

fn isLikelySource(path: []const u8) bool {
    const ext = extname(path);
    for (SOURCE_EXTENSIONS) |candidate| {
        if (eqlIgnoreCase(ext, candidate)) return true;
    }
    const name = basename(path);
    return std.mem.startsWith(u8, name, "Dockerfile") or
        std.mem.eql(u8, name, "Makefile") or
        containsIgnoreCase(name, "README") or
        containsIgnoreCase(name, "CHANGELOG") or
        containsIgnoreCase(name, "AGENTS") or
        containsIgnoreCase(name, "CLAUDE") or
        std.mem.startsWith(u8, name, "package.") or
        std.mem.startsWith(u8, name, "tsconfig.") or
        std.mem.startsWith(u8, name, "bunfig.");
}

fn recordSkip(stats: *RepoScanStats, diagnostics: *ScanDiagnostics, reason: SkipReason) void {
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

fn recordCap(stats: *RepoScanStats, diagnostics: *ScanDiagnostics, reason: CapReason) void {
    stats.truncated = 1;
    if (diagnostics.cap_reason == null) diagnostics.cap_reason = reason;
}

fn capReasonString(reason: ?CapReason) []const u8 {
    return switch (reason orelse return "null") {
        .max_files => "\"maxFiles\"",
        .max_depth => "\"maxDepth\"",
    };
}

fn scanFileLessThan(_: void, a: ScanFile, b: ScanFile) bool {
    return std.mem.order(u8, a.path, b.path) == .lt;
}

fn writeManifest(w: *Writer, files: []const ScanFile, stats: *const RepoScanStats, diagnostics: *const ScanDiagnostics) void {
    w.append("{\"files\":[");
    for (files, 0..) |file, i| {
        if (i > 0) w.append(",");
        w.append("{\"path\":");
        w.appendJsonString(file.path);
        w.appendFmt(",\"bytes\":{},\"depth\":{}}}", .{ file.bytes, file.depth });
    }
    const skipped = diagnostics.skipped_by_reason;
    w.appendFmt(
        "],\"stats\":{{\"scannedFiles\":{},\"skippedFiles\":{},\"truncated\":{},\"capped\":{},\"capReason\":{s},\"bytesScanned\":{},\"skippedByReason\":{{\"hidden\":{},\"vendor\":{},\"buildOutput\":{},\"binary\":{},\"tooLarge\":{},\"invalidUtf8\":{},\"ioError\":{},\"gitignore\":{},\"depth\":{},\"nonFile\":{},\"other\":{}}}}}}}",
        .{
            stats.scanned_files,
            stats.skipped_files,
            stats.truncated,
            diagnostics.cap_reason != null,
            capReasonString(diagnostics.cap_reason),
            stats.bytes_scanned,
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

pub fn scanManifest(
    root_ptr: [*]const u8,
    root_len: u32,
    caps_ptr: *const RepoScanCaps,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
    stats_out: *RepoScanStats,
) u32 {
    const root = inputSlice(root_ptr, root_len);
    if (pathLooksUnsafe(root)) return STATUS_INVALID_ARGS;

    const caps = caps_ptr.*;
    const max_files = if (caps.max_files == 0) DEFAULT_SCAN_MAX_FILES else caps.max_files;
    const max_depth = if (caps.max_depth == 0) DEFAULT_SCAN_MAX_DEPTH else caps.max_depth;
    const max_file_bytes = if (caps.max_file_bytes == 0) DEFAULT_SCAN_MAX_FILE_BYTES else caps.max_file_bytes;
    const include_hidden = (caps.flags & SCAN_FLAG_INCLUDE_HIDDEN) != 0;
    const source_only = (caps.flags & SCAN_FLAG_SOURCE_ONLY) != 0;
    const use_gitignore = (caps.flags & SCAN_FLAG_IGNORE_GITIGNORE) == 0;

    var stats: RepoScanStats = .{
        .scanned_files = 0,
        .skipped_files = 0,
        .truncated = 0,
        .bytes_scanned = 0,
    };
    var diagnostics: ScanDiagnostics = .{};

    const allocator = std.heap.smp_allocator;
    var files: std.ArrayList(ScanFile) = .empty;
    defer {
        for (files.items) |file| allocator.free(file.path);
        files.deinit(allocator);
    }

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

    while (true) {
        const maybe_entry = walker.next(io()) catch {
            stats_out.* = stats;
            return STATUS_IO_ERROR;
        };
        const entry = maybe_entry orelse break;

        if (entry.depth() > max_depth) {
            if (entry.kind == .directory) walker.leave(io());
            recordCap(&stats, &diagnostics, .max_depth);
            recordSkip(&stats, &diagnostics, .depth);
            continue;
        }

        if (entry.kind == .directory) {
            if (!include_hidden and hiddenPath(entry.path)) {
                walker.leave(io());
                recordSkip(&stats, &diagnostics, .hidden);
                continue;
            }
            if (scanExcludeReason(entry.basename, caps.flags)) |reason| {
                walker.leave(io());
                recordSkip(&stats, &diagnostics, reason);
                continue;
            }
            if (gitignore_rules) |rules| {
                if (gitignoreDecision(rules, entry.path, true)) {
                    walker.leave(io());
                    recordSkip(&stats, &diagnostics, .gitignore);
                    continue;
                }
            }
            continue;
        }

        if (entry.kind != .file) {
            recordSkip(&stats, &diagnostics, .non_file);
            continue;
        }
        if (files.items.len >= max_files) {
            recordCap(&stats, &diagnostics, .max_files);
            break;
        }
        if (!include_hidden and hiddenPath(entry.path)) {
            recordSkip(&stats, &diagnostics, .hidden);
            continue;
        }
        if (gitignore_rules) |rules| {
            if (gitignoreDecision(rules, entry.path, false)) {
                recordSkip(&stats, &diagnostics, .gitignore);
                continue;
            }
        }
        if (source_only and !isLikelySource(entry.path)) {
            recordSkip(&stats, &diagnostics, .other);
            continue;
        }

        const file_stat = entry.dir.statFile(io(), entry.basename, .{}) catch {
            recordSkip(&stats, &diagnostics, .io_error);
            continue;
        };
        if (file_stat.size > max_file_bytes) {
            recordSkip(&stats, &diagnostics, .too_large);
            continue;
        }

        const file_data = entry.dir.readFileAlloc(io(), entry.basename, allocator, .limited(@intCast(max_file_bytes))) catch {
            recordSkip(&stats, &diagnostics, .io_error);
            continue;
        };
        defer allocator.free(file_data);
        if (isBinary(file_data)) {
            recordSkip(&stats, &diagnostics, .binary);
            continue;
        }
        if (!std.unicode.utf8ValidateSlice(file_data)) {
            recordSkip(&stats, &diagnostics, .invalid_utf8);
            continue;
        }

        const owned_path = allocator.dupe(u8, entry.path) catch return STATUS_IO_ERROR;
        files.append(allocator, .{
            .path = owned_path,
            .bytes = file_data.len,
            .depth = @intCast(entry.depth()),
        }) catch {
            allocator.free(owned_path);
            return STATUS_IO_ERROR;
        };
        stats.scanned_files += 1;
        stats.bytes_scanned += file_data.len;
    }

    std.mem.sort(ScanFile, files.items, {}, scanFileLessThan);

    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    writeManifest(&w, files.items, &stats, &diagnostics);
    stats_out.* = stats;
    return finish(&w, written_out, needed_out);
}

test "repo scan manifest is sorted and policy aware" {
    const dir = ".zig-cache/sift-repo-scan";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    try Dir.cwd().createDirPath(io(), dir ++ "/src");
    try Dir.cwd().createDirPath(io(), dir ++ "/node_modules/pkg");
    try Dir.cwd().createDirPath(io(), dir ++ "/.hidden");
    try Dir.cwd().writeFile(io(), .{ .sub_path = dir ++ "/src/b.ts", .data = "export const b = 1;\n" });
    try Dir.cwd().writeFile(io(), .{ .sub_path = dir ++ "/src/a.ts", .data = "export const a = 1;\n" });
    try Dir.cwd().writeFile(io(), .{ .sub_path = dir ++ "/src/blob.bin", .data = "bin\x00ary" });
    try Dir.cwd().writeFile(io(), .{ .sub_path = dir ++ "/node_modules/pkg/dep.ts", .data = "export const dep = 1;\n" });
    try Dir.cwd().writeFile(io(), .{ .sub_path = dir ++ "/.hidden/secret.ts", .data = "export const secret = 1;\n" });

    const caps: RepoScanCaps = .{
        .max_files = 100,
        .max_depth = 8,
        .max_file_bytes = 1024,
        .flags = SCAN_FLAG_SOURCE_ONLY,
    };
    var out: [4096]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    var stats: RepoScanStats = .{ .scanned_files = 0, .skipped_files = 0, .truncated = 0, .bytes_scanned = 0 };

    const status = scanManifest(
        dir.ptr,
        @intCast(dir.len),
        &caps,
        &out,
        out.len,
        &written,
        &needed,
        &stats,
    );
    try std.testing.expectEqual(STATUS_OK, status);
    const json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"path\":\"src/a.ts\"").? < std.mem.indexOf(u8, json, "\"path\":\"src/b.ts\"").?);
    try std.testing.expect(std.mem.indexOf(u8, json, "node_modules") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, ".hidden") == null);
    try std.testing.expectEqual(@as(u32, 2), stats.scanned_files);
}
