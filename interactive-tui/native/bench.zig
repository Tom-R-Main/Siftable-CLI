const std = @import("std");

const composer = @import("composer_policy.zig");
const fs_engine = @import("fs_engine.zig");
const image_engine = @import("image_engine.zig");

const Io = std.Io;
const Dir = std.Io.Dir;

const STATUS_OK: u32 = 0;
const WRITE_FLAG_MAKE_PATH: u32 = 0x2;
const SEARCH_DETAIL_SHIFT: u5 = 24;
const SEARCH_DETAIL_PATHS: u32 = 0x1 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_LOCATIONS: u32 = 0x2 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_FULL: u32 = 0x3 << SEARCH_DETAIL_SHIFT;
const BENCH_DIR = ".zig-cache/sift-native-bench";

var sink: u32 = 0;

fn io() Io {
    return Io.Threaded.global_single_threaded.io();
}

fn expectOk(status: u32) u32 {
    if (status != STATUS_OK) std.debug.panic("native benchmark call failed with status {}", .{status});
    return status;
}

fn writeFixture(path: []const u8, data: []const u8) void {
    const root = "";
    var out: [256]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    _ = expectOk(fs_engine.sift_fs_write_text(
        root.ptr,
        root.len,
        path.ptr,
        @intCast(path.len),
        data.ptr,
        @intCast(data.len),
        WRITE_FLAG_MAKE_PATH,
        &out,
        out.len,
        &written,
        &needed,
    ));
}

fn expectBytes(path: []const u8, expected: []const u8) void {
    const allocator = std.heap.smp_allocator;
    const data = Dir.cwd().readFileAlloc(io(), path, allocator, .limited(expected.len + 1)) catch |err| {
        std.debug.panic("failed to verify {s}: {}", .{ path, err });
    };
    defer allocator.free(data);
    if (!std.mem.eql(u8, data, expected)) {
        std.debug.panic("verification mismatch for {s}: expected {} bytes, got {} bytes", .{ path, expected.len, data.len });
    }
}

fn expectFirstMatchOffset(path: []const u8, query: []const u8, expected: ?usize) !void {
    const allocator = std.heap.smp_allocator;
    const data = Dir.cwd().readFileAlloc(io(), path, allocator, .limited(2 * 1024 * 1024)) catch |err| {
        std.debug.panic("failed to inspect {s}: {}", .{ path, err });
    };
    defer allocator.free(data);
    try std.testing.expectEqual(expected, std.mem.indexOf(u8, data, query));
}

const StepFn = *const fn (*anyopaque) u32;

fn runBenchWithWarmup(name: []const u8, iterations: u32, bytes_per_op: usize, ctx: *anyopaque, stepFn: StepFn, warmup: u32) !void {
    for (0..warmup) |_| sink ^= stepFn(ctx);

    var samples: [7]u64 = undefined;
    for (&samples) |*sample| {
        const start = std.Io.Clock.awake.now(io()).nanoseconds;
        for (0..iterations) |_| sink ^= stepFn(ctx);
        const end = std.Io.Clock.awake.now(io()).nanoseconds;
        sample.* = @intCast(end - start);
    }

    sortU64(&samples);
    const median_ns = samples[samples.len / 2];
    const ops_per_sec = if (median_ns == 0)
        0
    else
        (@as(u128, iterations) * std.time.ns_per_s) / median_ns;
    const ns_per_op = if (iterations == 0) 0 else median_ns / iterations;

    std.debug.print("{s}: {d} ops/s, {d} ns/op", .{ name, ops_per_sec, ns_per_op });
    if (bytes_per_op > 0 and median_ns > 0) {
        const mib_per_sec_x10 = (@as(u128, bytes_per_op) * iterations * 10 * std.time.ns_per_s) /
            (1024 * 1024 * median_ns);
        std.debug.print(", {d}.{d} MiB/s", .{ mib_per_sec_x10 / 10, mib_per_sec_x10 % 10 });
    }
    std.debug.print(" (median {d} ns for {d})\n", .{ median_ns, iterations });
}

fn runBench(name: []const u8, iterations: u32, bytes_per_op: usize, ctx: *anyopaque, stepFn: StepFn) !void {
    const warmup = @min(@max(iterations / 10, 100), 10_000);
    try runBenchWithWarmup(name, iterations, bytes_per_op, ctx, stepFn, warmup);
}

fn sortU64(values: []u64) void {
    var i: usize = 1;
    while (i < values.len) : (i += 1) {
        const value = values[i];
        var j = i;
        while (j > 0 and values[j - 1] > value) : (j -= 1) {
            values[j] = values[j - 1];
        }
        values[j] = value;
    }
}

const ComposerCtx = struct {
    input: []const u8,

    fn decision(ptr: *anyopaque) u32 {
        const self: *ComposerCtx = @ptrCast(@alignCast(ptr));
        return composer.sift_should_chip_paste(self.input.ptr, @intCast(self.input.len));
    }

    fn full(ptr: *anyopaque) u32 {
        const self: *ComposerCtx = @ptrCast(@alignCast(ptr));
        return composer.sift_should_chip_paste(self.input.ptr, @intCast(self.input.len)) ^
            composer.sift_paste_char_count(self.input.ptr, @intCast(self.input.len)) ^
            composer.sift_paste_line_count(self.input.ptr, @intCast(self.input.len)) ^
            @intFromBool(composer.sift_paste_looks_structured(self.input.ptr, @intCast(self.input.len)));
    }
};

const ImageCtx = struct {
    input: []const u8,
    out: image_engine.ImageInfo = .{ .mime_code = 0, .width = 0, .height = 0, .bytes = 0 },

    fn probe(ptr: *anyopaque) u32 {
        const self: *ImageCtx = @ptrCast(@alignCast(ptr));
        return expectOk(image_engine.sift_image_probe(
            self.input.ptr,
            @intCast(self.input.len),
            0,
            0,
            &self.out,
        )) ^ self.out.width ^ self.out.height;
    }
};

const ReadCtx = struct {
    path: []const u8,
    out: []u8,
    written: u32 = 0,
    needed: u32 = 0,

    fn read(ptr: *anyopaque) u32 {
        const self: *ReadCtx = @ptrCast(@alignCast(ptr));
        return expectOk(fs_engine.sift_fs_read_text(
            self.path.ptr,
            @intCast(self.path.len),
            64 * 1024,
            self.out.ptr,
            @intCast(self.out.len),
            &self.written,
            &self.needed,
        )) ^ self.written;
    }
};

const SearchCtx = struct {
    root: []const u8,
    query: []const u8,
    caps: fs_engine.SearchCaps,
    out: []u8,
    written: u32 = 0,
    needed: u32 = 0,
    stats: fs_engine.SearchStats = .{
        .searched_files = 0,
        .skipped_files = 0,
        .matched_files = 0,
        .matches = 0,
        .truncated = 0,
    },

    fn search(ptr: *anyopaque) u32 {
        const self: *SearchCtx = @ptrCast(@alignCast(ptr));
        return expectOk(fs_engine.sift_fs_search_literal(
            self.root.ptr,
            @intCast(self.root.len),
            self.query.ptr,
            @intCast(self.query.len),
            &self.caps,
            self.out.ptr,
            @intCast(self.out.len),
            &self.written,
            &self.needed,
            &self.stats,
        )) ^ self.stats.matches;
    }
};

const WalkCtx = struct {
    root: []const u8,

    fn walk(ptr: *anyopaque) u32 {
        const self: *WalkCtx = @ptrCast(@alignCast(ptr));
        const allocator = std.heap.smp_allocator;
        var root_dir = Dir.cwd().openDir(io(), self.root, .{ .iterate = true, .follow_symlinks = false }) catch |err| {
            std.debug.panic("walk benchmark open failed: {}", .{err});
        };
        defer root_dir.close(io());

        var walker = root_dir.walk(allocator) catch |err| {
            std.debug.panic("walk benchmark init failed: {}", .{err});
        };
        defer walker.deinit();

        var files: u32 = 0;
        while (walker.next(io()) catch |err| std.debug.panic("walk benchmark next failed: {}", .{err})) |entry| {
            if (entry.kind == .file) files += 1;
        }
        return files;
    }
};

const RawScanCtx = struct {
    root: []const u8,
    query: []const u8,
    file_count: usize,
    max_matches: u32,

    fn scan(ptr: *anyopaque) u32 {
        const self: *RawScanCtx = @ptrCast(@alignCast(ptr));
        const allocator = std.heap.smp_allocator;
        var path_buf: [160]u8 = undefined;
        var matches: u32 = 0;
        for (0..self.file_count) |i| {
            if (matches >= self.max_matches) break;
            const path = std.fmt.bufPrint(&path_buf, "{s}/file-{d:0>3}.txt", .{ self.root, i }) catch {
                std.debug.panic("raw scan path buffer too small", .{});
            };
            const data = Dir.cwd().readFileAlloc(io(), path, allocator, .limited(1024 * 1024 + 1)) catch |err| {
                std.debug.panic("raw scan read failed for {s}: {}", .{ path, err });
            };

            var offset: usize = 0;
            while (offset < data.len) {
                if (matches >= self.max_matches) break;
                const found_rel = std.mem.indexOf(u8, data[offset..], self.query) orelse break;
                offset += found_rel + self.query.len;
                matches += 1;
            }
            allocator.free(data);
        }
        return matches;
    }
};

fn jsonU64(json: []const u8, comptime key: []const u8) u64 {
    const marker = "\"" ++ key ++ "\":";
    const found = std.mem.indexOf(u8, json, marker) orelse return 0;
    var i = found + marker.len;
    var value: u64 = 0;
    while (i < json.len and json[i] >= '0' and json[i] <= '9') : (i += 1) {
        value = value * 10 + json[i] - '0';
    }
    return value;
}

fn jsonBool(json: []const u8, comptime key: []const u8) bool {
    const marker = "\"" ++ key ++ "\":";
    const found = std.mem.indexOf(u8, json, marker) orelse return false;
    const i = found + marker.len;
    return std.mem.startsWith(u8, json[i..], "true");
}

fn jsonCapReason(json: []const u8) []const u8 {
    const marker = "\"capReason\":";
    const found = std.mem.indexOf(u8, json, marker) orelse return "missing";
    var i = found + marker.len;
    if (std.mem.startsWith(u8, json[i..], "null")) return "null";
    if (i >= json.len or json[i] != '"') return "invalid";
    i += 1;
    const start = i;
    while (i < json.len and json[i] != '"') : (i += 1) {}
    return json[start..i];
}

fn reportSearch(label: []const u8, ctx: *SearchCtx) void {
    _ = SearchCtx.search(ctx);
    const json = ctx.out[0..ctx.written];
    std.debug.print(
        "{s} diagnostics: searched={}, skipped={}, matchedFiles={}, matches={}, truncated={}, capped={}, capReason={s}, jsonBytes={}, bytesScanned={}, skippedByReason={{hidden:{}, vendor:{}, buildOutput:{}, binary:{}, tooLarge:{}, invalidUtf8:{}, ioError:{}, depth:{}, nonFile:{}, other:{}}}\n",
        .{
            label,
            ctx.stats.searched_files,
            ctx.stats.skipped_files,
            ctx.stats.matched_files,
            ctx.stats.matches,
            ctx.stats.truncated,
            jsonBool(json, "capped"),
            jsonCapReason(json),
            ctx.written,
            jsonU64(json, "bytesScanned"),
            jsonU64(json, "hidden"),
            jsonU64(json, "vendor"),
            jsonU64(json, "buildOutput"),
            jsonU64(json, "binary"),
            jsonU64(json, "tooLarge"),
            jsonU64(json, "invalidUtf8"),
            jsonU64(json, "ioError"),
            jsonU64(json, "depth"),
            jsonU64(json, "nonFile"),
            jsonU64(json, "other"),
        },
    );
}

fn runRealRepoBenches(real_root: []const u8, out: []u8) !void {
    std.debug.print("\nreal repo fixture: {s}\n", .{real_root});
    const absent_query = "__sift_" ++ "no_match_" ++ "benchmark_" ++ "token__";
    var search_real_absent_paths_ctx: SearchCtx = .{
        .root = real_root,
        .query = absent_query,
        .caps = .{ .max_files = 5000, .max_matches = 100, .max_depth = 10, .max_file_bytes = 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = out,
    };
    var search_real_target_paths_ctx: SearchCtx = .{
        .root = real_root,
        .query = "SearchCaps",
        .caps = .{ .max_files = 5000, .max_matches = 100, .max_depth = 10, .max_file_bytes = 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = out,
    };
    var search_real_target_locations_ctx: SearchCtx = .{
        .root = real_root,
        .query = "SearchCaps",
        .caps = .{ .max_files = 5000, .max_matches = 100, .max_depth = 10, .max_file_bytes = 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_LOCATIONS },
        .out = out,
    };
    var search_real_target_snippets_ctx: SearchCtx = .{
        .root = real_root,
        .query = "SearchCaps",
        .caps = .{ .max_files = 5000, .max_matches = 100, .max_depth = 10, .max_file_bytes = 1024 * 1024, .preview_bytes = 240, .flags = 0 },
        .out = out,
    };
    var search_real_common_locations_ctx: SearchCtx = .{
        .root = real_root,
        .query = "const",
        .caps = .{ .max_files = 5000, .max_matches = 100, .max_depth = 10, .max_file_bytes = 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_LOCATIONS },
        .out = out,
    };

    reportSearch("real search paths absent", &search_real_absent_paths_ctx);
    reportSearch("real search paths SearchCaps", &search_real_target_paths_ctx);
    reportSearch("real search locations SearchCaps", &search_real_target_locations_ctx);
    reportSearch("real search snippets SearchCaps", &search_real_target_snippets_ctx);
    reportSearch("real search locations const cap 100", &search_real_common_locations_ctx);

    try runBenchWithWarmup("real search paths absent", 5, 0, &search_real_absent_paths_ctx, SearchCtx.search, 1);
    try runBenchWithWarmup("real search paths SearchCaps", 5, 0, &search_real_target_paths_ctx, SearchCtx.search, 1);
    try runBenchWithWarmup("real search locations SearchCaps", 5, 0, &search_real_target_locations_ctx, SearchCtx.search, 1);
    try runBenchWithWarmup("real search snippets SearchCaps", 5, 0, &search_real_target_snippets_ctx, SearchCtx.search, 1);
    try runBenchWithWarmup("real search locations const cap 100", 20, 0, &search_real_common_locations_ctx, SearchCtx.search, 2);
}

const WriteCtx = struct {
    root: []const u8,
    path: []const u8,
    content: []const u8,
    out: []u8,
    written: u32 = 0,
    needed: u32 = 0,

    fn write(ptr: *anyopaque) u32 {
        const self: *WriteCtx = @ptrCast(@alignCast(ptr));
        return expectOk(fs_engine.sift_fs_write_text(
            self.root.ptr,
            @intCast(self.root.len),
            self.path.ptr,
            @intCast(self.path.len),
            self.content.ptr,
            @intCast(self.content.len),
            0,
            self.out.ptr,
            @intCast(self.out.len),
            &self.written,
            &self.needed,
        )) ^ self.written;
    }
};

const DirectWriteCtx = struct {
    path: []const u8,
    content: []const u8,

    fn write(ptr: *anyopaque) u32 {
        const self: *DirectWriteCtx = @ptrCast(@alignCast(ptr));
        Dir.cwd().writeFile(io(), .{
            .sub_path = self.path,
            .data = self.content,
        }) catch |err| std.debug.panic("direct write benchmark failed: {}", .{err});
        return @intCast(self.content.len);
    }
};

const EditCtx = struct {
    root: []const u8,
    path: []const u8,
    old_bytes: []const u8,
    new_bytes: []const u8,
    params: fs_engine.EditParams,
    out: []u8,
    written: u32 = 0,
    needed: u32 = 0,

    fn edit(ptr: *anyopaque) u32 {
        const self: *EditCtx = @ptrCast(@alignCast(ptr));
        const first = expectOk(fs_engine.sift_fs_edit_text(
            self.root.ptr,
            @intCast(self.root.len),
            self.path.ptr,
            @intCast(self.path.len),
            self.old_bytes.ptr,
            self.new_bytes.ptr,
            &self.params,
            self.out.ptr,
            @intCast(self.out.len),
            &self.written,
            &self.needed,
        ));
        const second = expectOk(fs_engine.sift_fs_edit_text(
            self.root.ptr,
            @intCast(self.root.len),
            self.path.ptr,
            @intCast(self.path.len),
            self.new_bytes.ptr,
            self.old_bytes.ptr,
            &self.params,
            self.out.ptr,
            @intCast(self.out.len),
            &self.written,
            &self.needed,
        ));
        return first ^ second ^ self.written;
    }
};

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.smp_allocator;
    var args = try init.minimal.args.iterateAllocator(allocator);
    defer args.deinit();
    _ = args.skip();
    const first_arg = args.next();
    const real_only = if (first_arg) |arg| std.mem.eql(u8, arg, "--real-only") else false;
    const real_root = if (real_only) args.next() else first_arg;
    if (real_only) {
        var real_out: [512 * 1024]u8 = undefined;
        if (real_root) |root| try runRealRepoBenches(root, &real_out);
        std.debug.print("sink={}\n", .{sink});
        return;
    }

    var paste: [16 * 1024]u8 = undefined;
    for (&paste, 0..) |*byte, i| {
        byte.* = switch (i % 64) {
            0 => '-',
            1 => ' ',
            2 => 'x',
            3 => '\n',
            else => 'a',
        };
    }

    const png = "\x89PNG\r\n\x1a\n" ++ "\x00\x00\x00\x0dIHDR" ++
        "\x00\x00\x07\x80" ++ "\x00\x00\x04\x38" ++ "\x08\x02\x00\x00\x00";

    var read_content: [64 * 1024]u8 = undefined;
    @memset(&read_content, 'r');
    for (0..read_content.len) |i| {
        if (i % 97 == 0) read_content[i] = '\n';
    }

    var file_body: [4096]u8 = undefined;
    @memset(&file_body, 's');
    @memcpy(file_body[2048..2054], "needle");
    file_body[file_body.len - 1] = '\n';

    var common_body: [4096]u8 = undefined;
    @memset(&common_body, 'x');
    for (0..common_body.len) |i| {
        if (i % 31 == 0) common_body[i] = '\n';
        if (i % 7 == 0) common_body[i] = 'a';
    }

    const large_no_match = try allocator.alloc(u8, 1024 * 1024);
    defer allocator.free(large_no_match);
    @memset(large_no_match, 'l');
    for (0..large_no_match.len) |i| {
        if (i % 257 == 0) large_no_match[i] = '\n';
    }

    const large_near_end = try allocator.dupe(u8, large_no_match);
    defer allocator.free(large_near_end);
    @memcpy(large_near_end[large_near_end.len - 8 .. large_near_end.len - 2], "needle");

    const matcher_absent_first = try allocator.alloc(u8, 1024 * 1024);
    defer allocator.free(matcher_absent_first);
    @memset(matcher_absent_first, 'a');

    const matcher_common_first = try allocator.alloc(u8, 1024 * 1024);
    defer allocator.free(matcher_common_first);
    @memset(matcher_common_first, 'a');
    for (0..matcher_common_first.len) |i| {
        if (i % 64 == 0) matcher_common_first[i] = 'n';
    }

    const matcher_prefix_collision = try allocator.alloc(u8, 1024 * 1024);
    defer allocator.free(matcher_prefix_collision);
    @memset(matcher_prefix_collision, 'a');

    const matcher_match_begin = try allocator.dupe(u8, matcher_absent_first);
    defer allocator.free(matcher_match_begin);
    @memcpy(matcher_match_begin[0..6], "needle");

    const matcher_match_middle = try allocator.dupe(u8, matcher_absent_first);
    defer allocator.free(matcher_match_middle);
    @memcpy(matcher_match_middle[matcher_match_middle.len / 2 .. matcher_match_middle.len / 2 + 6], "needle");

    const matcher_common_token = try allocator.alloc(u8, 1024 * 1024);
    defer allocator.free(matcher_common_token);
    @memset(matcher_common_token, 'x');
    for (0..matcher_common_token.len) |i| {
        if (i % 5 == 0) matcher_common_token[i] = 'a';
        if (i % 97 == 0) matcher_common_token[i] = '\n';
    }

    var binary_body: [4096]u8 = undefined;
    @memset(&binary_body, 'b');
    binary_body[7] = 0;

    Dir.cwd().deleteTree(io(), BENCH_DIR) catch {};
    defer Dir.cwd().deleteTree(io(), BENCH_DIR) catch {};

    const read_path = BENCH_DIR ++ "/read.txt";
    writeFixture(read_path, &read_content);

    var path_buf: [128]u8 = undefined;
    for (0..200) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search/file-{d:0>3}.txt", .{i});
        writeFixture(path, &file_body);
    }
    for (0..20) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-common/file-{d:0>3}.txt", .{i});
        writeFixture(path, &common_body);
    }
    for (0..20) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-filter/src/file-{d:0>3}.txt", .{i});
        writeFixture(path, &file_body);
    }
    for (0..200) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-filter/node_modules/file-{d:0>3}.txt", .{i});
        writeFixture(path, &file_body);
    }
    writeFixture(BENCH_DIR ++ "/search-large-no-match/file-000.txt", large_no_match);
    writeFixture(BENCH_DIR ++ "/search-large-near-end/file-000.txt", large_near_end);
    writeFixture(BENCH_DIR ++ "/matcher-absent-first/file-000.txt", matcher_absent_first);
    writeFixture(BENCH_DIR ++ "/matcher-common-first/file-000.txt", matcher_common_first);
    writeFixture(BENCH_DIR ++ "/matcher-prefix-collision/file-000.txt", matcher_prefix_collision);
    writeFixture(BENCH_DIR ++ "/matcher-match-begin/file-000.txt", matcher_match_begin);
    writeFixture(BENCH_DIR ++ "/matcher-match-middle/file-000.txt", matcher_match_middle);
    writeFixture(BENCH_DIR ++ "/matcher-common-token/file-000.txt", matcher_common_token);
    for (0..20) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-large-guard/file-{d:0>3}.txt", .{i});
        writeFixture(path, large_no_match[0 .. 128 * 1024]);
    }
    for (0..20) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-pathology/src/file-{d:0>3}.txt", .{i});
        writeFixture(path, &file_body);
    }
    for (0..120) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-pathology/node_modules/file-{d:0>3}.txt", .{i});
        writeFixture(path, &file_body);
    }
    for (0..80) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-pathology/dist/file-{d:0>3}.txt", .{i});
        writeFixture(path, &file_body);
    }
    for (0..80) |i| {
        const path = try std.fmt.bufPrint(&path_buf, BENCH_DIR ++ "/search-pathology/binary/file-{d:0>3}.bin", .{i});
        writeFixture(path, &binary_body);
    }

    const edit_path = BENCH_DIR ++ "/edit.txt";
    var edit_content: [16 * 1024]u8 = undefined;
    @memset(&edit_content, 'e');
    @memcpy(edit_content[0..3], "OLD");
    writeFixture(edit_path, &edit_content);

    var read_out: [256 * 1024]u8 = undefined;
    var search_out: [512 * 1024]u8 = undefined;

    var composer_ctx: ComposerCtx = .{ .input = &paste };
    var image_ctx: ImageCtx = .{ .input = png };
    var read_ctx: ReadCtx = .{ .path = read_path, .out = &read_out };
    var search_rare_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search",
        .query = "needle",
        .caps = .{
            .max_files = 5000,
            .max_matches = 500,
            .max_depth = 8,
            .max_file_bytes = 1024 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_no_match_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search",
        .query = "absent",
        .caps = .{
            .max_files = 5000,
            .max_matches = 500,
            .max_depth = 8,
            .max_file_bytes = 1024 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_common_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-common",
        .query = "a",
        .caps = .{
            .max_files = 5000,
            .max_matches = 500,
            .max_depth = 8,
            .max_file_bytes = 1024 * 1024,
            .preview_bytes = 80,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_filter_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-filter",
        .query = "needle",
        .caps = .{
            .max_files = 5000,
            .max_matches = 500,
            .max_depth = 8,
            .max_file_bytes = 1024 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_large_no_match_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-no-match",
        .query = "absent",
        .caps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 2 * 1024 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_large_near_end_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-near-end",
        .query = "needle",
        .caps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 2 * 1024 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_large_near_end_paths_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-near-end",
        .query = "needle",
        .caps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 2 * 1024 * 1024,
            .preview_bytes = 240,
            .flags = SEARCH_DETAIL_PATHS,
        },
        .out = &search_out,
    };
    var search_large_near_end_locations_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-near-end",
        .query = "needle",
        .caps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 2 * 1024 * 1024,
            .preview_bytes = 240,
            .flags = SEARCH_DETAIL_LOCATIONS,
        },
        .out = &search_out,
    };
    var search_large_near_end_full_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-near-end",
        .query = "needle",
        .caps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 2 * 1024 * 1024,
            .preview_bytes = 240,
            .flags = SEARCH_DETAIL_FULL,
        },
        .out = &search_out,
    };
    var search_matcher_absent_first_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/matcher-absent-first",
        .query = "needle",
        .caps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = &search_out,
    };
    var search_matcher_common_first_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/matcher-common-first",
        .query = "needle",
        .caps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = &search_out,
    };
    var search_matcher_prefix_collision_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/matcher-prefix-collision",
        .query = "aaaaab",
        .caps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = &search_out,
    };
    var search_matcher_begin_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/matcher-match-begin",
        .query = "needle",
        .caps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = &search_out,
    };
    var search_matcher_middle_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/matcher-match-middle",
        .query = "needle",
        .caps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = &search_out,
    };
    var search_matcher_eof_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-near-end",
        .query = "needle",
        .caps = .{ .max_files = 100, .max_matches = 100, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_PATHS },
        .out = &search_out,
    };
    var search_matcher_common_token_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/matcher-common-token",
        .query = "a",
        .caps = .{ .max_files = 100, .max_matches = 500, .max_depth = 8, .max_file_bytes = 2 * 1024 * 1024, .preview_bytes = 80, .flags = SEARCH_DETAIL_LOCATIONS },
        .out = &search_out,
    };
    var search_large_guard_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-large-guard",
        .query = "needle",
        .caps = .{
            .max_files = 100,
            .max_matches = 100,
            .max_depth = 8,
            .max_file_bytes = 64 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var search_pathology_ctx: SearchCtx = .{
        .root = BENCH_DIR ++ "/search-pathology",
        .query = "needle",
        .caps = .{
            .max_files = 5000,
            .max_matches = 500,
            .max_depth = 8,
            .max_file_bytes = 1024 * 1024,
            .preview_bytes = 240,
            .flags = 0,
        },
        .out = &search_out,
    };
    var walk_search_ctx: WalkCtx = .{ .root = BENCH_DIR ++ "/search" };
    var walk_filter_ctx: WalkCtx = .{ .root = BENCH_DIR ++ "/search-filter" };
    var walk_pathology_ctx: WalkCtx = .{ .root = BENCH_DIR ++ "/search-pathology" };
    var raw_rare_ctx: RawScanCtx = .{
        .root = BENCH_DIR ++ "/search",
        .query = "needle",
        .file_count = 200,
        .max_matches = 500,
    };
    var raw_no_match_ctx: RawScanCtx = .{
        .root = BENCH_DIR ++ "/search",
        .query = "absent",
        .file_count = 200,
        .max_matches = 500,
    };
    var raw_common_ctx: RawScanCtx = .{
        .root = BENCH_DIR ++ "/search-common",
        .query = "a",
        .file_count = 20,
        .max_matches = 500,
    };
    var raw_large_no_match_ctx: RawScanCtx = .{
        .root = BENCH_DIR ++ "/search-large-no-match",
        .query = "absent",
        .file_count = 1,
        .max_matches = 100,
    };
    var raw_large_near_end_ctx: RawScanCtx = .{
        .root = BENCH_DIR ++ "/search-large-near-end",
        .query = "needle",
        .file_count = 1,
        .max_matches = 100,
    };
    var raw_matcher_absent_first_ctx: RawScanCtx = .{ .root = BENCH_DIR ++ "/matcher-absent-first", .query = "needle", .file_count = 1, .max_matches = 100 };
    var raw_matcher_common_first_ctx: RawScanCtx = .{ .root = BENCH_DIR ++ "/matcher-common-first", .query = "needle", .file_count = 1, .max_matches = 100 };
    var raw_matcher_prefix_collision_ctx: RawScanCtx = .{ .root = BENCH_DIR ++ "/matcher-prefix-collision", .query = "aaaaab", .file_count = 1, .max_matches = 100 };
    var raw_matcher_begin_ctx: RawScanCtx = .{ .root = BENCH_DIR ++ "/matcher-match-begin", .query = "needle", .file_count = 1, .max_matches = 100 };
    var raw_matcher_middle_ctx: RawScanCtx = .{ .root = BENCH_DIR ++ "/matcher-match-middle", .query = "needle", .file_count = 1, .max_matches = 100 };
    var raw_matcher_common_token_ctx: RawScanCtx = .{ .root = BENCH_DIR ++ "/matcher-common-token", .query = "a", .file_count = 1, .max_matches = 500 };
    var write_ctx: WriteCtx = .{
        .root = "",
        .path = BENCH_DIR ++ "/write.txt",
        .content = read_content[0..4096],
        .out = &read_out,
    };
    var direct_write_ctx: DirectWriteCtx = .{
        .path = BENCH_DIR ++ "/direct-write.txt",
        .content = read_content[0..4096],
    };
    var edit_ctx: EditCtx = .{
        .root = "",
        .path = edit_path,
        .old_bytes = "OLD",
        .new_bytes = "NEW",
        .params = .{
            .old_len = 3,
            .new_len = 3,
            .expected_hash = 0,
            .flags = 1,
        },
        .out = &read_out,
    };

    std.debug.print("fixture dir: {s}\n", .{BENCH_DIR});
    _ = ReadCtx.read(&read_ctx);
    try std.testing.expect(read_ctx.written > read_content.len);
    _ = WriteCtx.write(&write_ctx);
    expectBytes(write_ctx.path, write_ctx.content);
    _ = DirectWriteCtx.write(&direct_write_ctx);
    expectBytes(direct_write_ctx.path, direct_write_ctx.content);
    _ = EditCtx.edit(&edit_ctx);
    expectBytes(edit_ctx.path, &edit_content);
    _ = SearchCtx.search(&search_rare_ctx);
    try std.testing.expectEqual(@as(u32, 200), search_rare_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 200), search_rare_ctx.stats.matched_files);
    _ = SearchCtx.search(&search_no_match_ctx);
    try std.testing.expectEqual(@as(u32, 0), search_no_match_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 200), search_no_match_ctx.stats.searched_files);
    _ = SearchCtx.search(&search_common_ctx);
    try std.testing.expectEqual(@as(u32, 500), search_common_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 1), search_common_ctx.stats.truncated);
    try std.testing.expectEqual(@as(u32, 1), search_common_ctx.stats.searched_files);
    _ = SearchCtx.search(&search_filter_ctx);
    try std.testing.expectEqual(@as(u32, 20), search_filter_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 20), search_filter_ctx.stats.searched_files);
    try std.testing.expect(WalkCtx.walk(&walk_filter_ctx) > search_filter_ctx.stats.searched_files);
    _ = SearchCtx.search(&search_large_no_match_ctx);
    try std.testing.expectEqual(@as(u32, 0), search_large_no_match_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 1), search_large_no_match_ctx.stats.searched_files);
    _ = SearchCtx.search(&search_large_near_end_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_large_near_end_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 1), search_large_near_end_ctx.stats.searched_files);
    _ = SearchCtx.search(&search_large_near_end_paths_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_large_near_end_paths_ctx.stats.matches);
    _ = SearchCtx.search(&search_large_near_end_locations_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_large_near_end_locations_ctx.stats.matches);
    _ = SearchCtx.search(&search_large_near_end_full_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_large_near_end_full_ctx.stats.matches);
    _ = SearchCtx.search(&search_large_guard_ctx);
    try std.testing.expectEqual(@as(u32, 0), search_large_guard_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 0), search_large_guard_ctx.stats.searched_files);
    try std.testing.expectEqual(@as(u32, 20), search_large_guard_ctx.stats.skipped_files);
    _ = SearchCtx.search(&search_pathology_ctx);
    try std.testing.expectEqual(@as(u32, 20), search_pathology_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 20), search_pathology_ctx.stats.searched_files);
    try std.testing.expect(search_pathology_ctx.stats.skipped_files >= 82);
    try std.testing.expectEqual(@as(u32, 200), RawScanCtx.scan(&raw_rare_ctx));
    try std.testing.expectEqual(@as(u32, 0), RawScanCtx.scan(&raw_no_match_ctx));
    try std.testing.expectEqual(@as(u32, 500), RawScanCtx.scan(&raw_common_ctx));
    try std.testing.expectEqual(@as(u32, 0), RawScanCtx.scan(&raw_large_no_match_ctx));
    try std.testing.expectEqual(@as(u32, 1), RawScanCtx.scan(&raw_large_near_end_ctx));
    try std.testing.expectEqual(@as(u32, 0), RawScanCtx.scan(&raw_matcher_absent_first_ctx));
    try std.testing.expectEqual(@as(u32, 0), RawScanCtx.scan(&raw_matcher_common_first_ctx));
    try std.testing.expectEqual(@as(u32, 0), RawScanCtx.scan(&raw_matcher_prefix_collision_ctx));
    try std.testing.expectEqual(@as(u32, 1), RawScanCtx.scan(&raw_matcher_begin_ctx));
    try std.testing.expectEqual(@as(u32, 1), RawScanCtx.scan(&raw_matcher_middle_ctx));
    try std.testing.expectEqual(@as(u32, 500), RawScanCtx.scan(&raw_matcher_common_token_ctx));
    try expectFirstMatchOffset(BENCH_DIR ++ "/matcher-absent-first/file-000.txt", "needle", null);
    try expectFirstMatchOffset(BENCH_DIR ++ "/matcher-common-first/file-000.txt", "needle", null);
    try expectFirstMatchOffset(BENCH_DIR ++ "/matcher-prefix-collision/file-000.txt", "aaaaab", null);
    try expectFirstMatchOffset(BENCH_DIR ++ "/matcher-match-begin/file-000.txt", "needle", 0);
    try expectFirstMatchOffset(BENCH_DIR ++ "/matcher-match-middle/file-000.txt", "needle", matcher_match_middle.len / 2);
    try expectFirstMatchOffset(BENCH_DIR ++ "/search-large-near-end/file-000.txt", "needle", large_near_end.len - 8);
    _ = SearchCtx.search(&search_matcher_absent_first_ctx);
    try std.testing.expectEqual(@as(u32, 0), search_matcher_absent_first_ctx.stats.matches);
    _ = SearchCtx.search(&search_matcher_common_first_ctx);
    try std.testing.expectEqual(@as(u32, 0), search_matcher_common_first_ctx.stats.matches);
    _ = SearchCtx.search(&search_matcher_prefix_collision_ctx);
    try std.testing.expectEqual(@as(u32, 0), search_matcher_prefix_collision_ctx.stats.matches);
    _ = SearchCtx.search(&search_matcher_begin_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_matcher_begin_ctx.stats.matches);
    _ = SearchCtx.search(&search_matcher_middle_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_matcher_middle_ctx.stats.matches);
    _ = SearchCtx.search(&search_matcher_eof_ctx);
    try std.testing.expectEqual(@as(u32, 1), search_matcher_eof_ctx.stats.matches);
    _ = SearchCtx.search(&search_matcher_common_token_ctx);
    try std.testing.expectEqual(@as(u32, 500), search_matcher_common_token_ctx.stats.matches);

    try runBench("composer decision only, 16 KiB paste", 100_000, paste.len, &composer_ctx, ComposerCtx.decision);
    try runBench("composer full analysis, 16 KiB paste", 50_000, paste.len, &composer_ctx, ComposerCtx.full);
    try runBench("image probe PNG header", 1_000_000, png.len, &image_ctx, ImageCtx.probe);
    try runBench("fs read_text 64 KiB cached file", 5_000, read_content.len, &read_ctx, ReadCtx.read);
    try runBench("fs search walk only 200 files", 1_000, 0, &walk_search_ctx, WalkCtx.walk);
    try runBench("fs search raw read+scan rare 200 files / 0.8 MiB", 200, file_body.len * 200, &raw_rare_ctx, RawScanCtx.scan);
    try runBench("fs search raw read+scan no-match 200 files / 0.8 MiB", 200, file_body.len * 200, &raw_no_match_ctx, RawScanCtx.scan);
    try runBench("fs search raw read+scan common cap 500", 1_000, common_body.len, &raw_common_ctx, RawScanCtx.scan);
    try runBench("fs search raw read+scan large no-match 1 MiB", 200, large_no_match.len, &raw_large_no_match_ctx, RawScanCtx.scan);
    try runBench("fs search raw read+scan large match near EOF 1 MiB", 200, large_near_end.len, &raw_large_near_end_ctx, RawScanCtx.scan);
    try runBench("fs matcher raw no-match first byte absent 1 MiB", 500, matcher_absent_first.len, &raw_matcher_absent_first_ctx, RawScanCtx.scan);
    try runBench("fs matcher raw no-match first byte common 1 MiB", 200, matcher_common_first.len, &raw_matcher_common_first_ctx, RawScanCtx.scan);
    try runBench("fs matcher raw no-match long prefix collision 1 MiB", 50, matcher_prefix_collision.len, &raw_matcher_prefix_collision_ctx, RawScanCtx.scan);
    try runBench("fs matcher raw match at beginning 1 MiB", 1_000, matcher_match_begin.len, &raw_matcher_begin_ctx, RawScanCtx.scan);
    try runBench("fs matcher raw match near middle 1 MiB", 500, matcher_match_middle.len, &raw_matcher_middle_ctx, RawScanCtx.scan);
    try runBench("fs matcher raw common token cap 500 1 MiB", 1_000, matcher_common_token.len, &raw_matcher_common_token_ctx, RawScanCtx.scan);
    try runBench("fs search_literal rare query 200 files / 0.8 MiB", 200, file_body.len * 200, &search_rare_ctx, SearchCtx.search);
    try runBench("fs search_literal no-match 200 files / 0.8 MiB", 200, file_body.len * 200, &search_no_match_ctx, SearchCtx.search);
    try runBench("fs search_literal common query 500-result cap", 500, common_body.len, &search_common_ctx, SearchCtx.search);
    try runBench("fs search walk only noisy fixture 220 files", 1_000, 0, &walk_filter_ctx, WalkCtx.walk);
    try runBench("fs search_literal noisy fixture filtered to 20 files", 200, file_body.len * 20, &search_filter_ctx, SearchCtx.search);
    try runBench("fs search_literal large no-match 1 MiB", 200, large_no_match.len, &search_large_no_match_ctx, SearchCtx.search);
    try runBench("fs search_literal large match near EOF paths", 200, large_near_end.len, &search_large_near_end_paths_ctx, SearchCtx.search);
    try runBench("fs search_literal large match near EOF locations", 200, large_near_end.len, &search_large_near_end_locations_ctx, SearchCtx.search);
    try runBench("fs search_literal large match near EOF 1 MiB", 200, large_near_end.len, &search_large_near_end_ctx, SearchCtx.search);
    try runBench("fs search_literal large match near EOF full", 200, large_near_end.len, &search_large_near_end_full_ctx, SearchCtx.search);
    try runBench("fs search_literal paths no-match first byte absent 1 MiB", 500, matcher_absent_first.len, &search_matcher_absent_first_ctx, SearchCtx.search);
    try runBench("fs search_literal paths no-match first byte common 1 MiB", 200, matcher_common_first.len, &search_matcher_common_first_ctx, SearchCtx.search);
    try runBench("fs search_literal paths no-match long prefix collision 1 MiB", 50, matcher_prefix_collision.len, &search_matcher_prefix_collision_ctx, SearchCtx.search);
    try runBench("fs search_literal paths match at beginning 1 MiB", 1_000, matcher_match_begin.len, &search_matcher_begin_ctx, SearchCtx.search);
    try runBench("fs search_literal paths match near middle 1 MiB", 500, matcher_match_middle.len, &search_matcher_middle_ctx, SearchCtx.search);
    try runBench("fs search_literal paths match near EOF 1 MiB", 200, large_near_end.len, &search_matcher_eof_ctx, SearchCtx.search);
    try runBench("fs search_literal locations common token cap 500 1 MiB", 1_000, matcher_common_token.len, &search_matcher_common_token_ctx, SearchCtx.search);
    try runBench("fs search_literal large-file guard skips 20 x 128 KiB", 1_000, 0, &search_large_guard_ctx, SearchCtx.search);
    try runBench("fs search walk only pathological repo 300 files", 1_000, 0, &walk_pathology_ctx, WalkCtx.walk);
    try runBench("fs search_literal pathological repo filtered+binary guarded", 200, file_body.len * 20, &search_pathology_ctx, SearchCtx.search);
    try runBench("fs write_text atomic 4 KiB", 1_000, write_ctx.content.len, &write_ctx, WriteCtx.write);
    try runBench("fs writeFile direct 4 KiB upper bound", 1_000, direct_write_ctx.content.len, &direct_write_ctx, DirectWriteCtx.write);
    try runBench("fs edit_text atomic 16 KiB", 1_000, edit_content.len, &edit_ctx, EditCtx.edit);
    if (real_root) |root| try runRealRepoBenches(root, &search_out);
    expectBytes(write_ctx.path, write_ctx.content);
    expectBytes(direct_write_ctx.path, direct_write_ctx.content);
    expectBytes(edit_ctx.path, &edit_content);
    try std.testing.expectEqual(@as(u32, 200), search_rare_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 0), search_no_match_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 500), search_common_ctx.stats.matches);
    try std.testing.expectEqual(@as(u32, 20), search_filter_ctx.stats.searched_files);
    std.debug.print("sink={d}\n", .{sink});
}
