const std = @import("std");

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_UNSUPPORTED: u32 = 2;
const STATUS_TOO_LARGE: u32 = 3;
const STATUS_MALFORMED: u32 = 4;
const STATUS_OUTPUT_TOO_SMALL: u32 = 5;

const MIME_PNG: u32 = 1;
const MIME_JPEG: u32 = 2;
const MIME_GIF: u32 = 3;
const MIME_WEBP: u32 = 4;
const MIME_BMP: u32 = 5;

pub const ImageInfo = extern struct {
    mime_code: u32,
    width: u32,
    height: u32,
    bytes: u32,
};

pub const ImageRenderOptions = extern struct {
    width: u32,
    height: u32,
    stride: u32,
    columns: u32,
    rows: u32,
    flags: u32,
};

const RENDER_FLAG_INVERT: u32 = 0x1;
const MAX_RENDER_CELLS: u32 = 1_000_000;
const density_ramp = " .:-=+*#%@";

const Writer = struct {
    buf: []u8,
    len: usize = 0,
    needed: usize = 0,
    overflow: bool = false,

    fn appendByte(self: *Writer, byte: u8) void {
        self.needed += 1;
        if (self.len + 1 > self.buf.len) {
            self.overflow = true;
            return;
        }
        self.buf[self.len] = byte;
        self.len += 1;
    }
};

fn bytes(ptr: [*]const u8, len: u32) []const u8 {
    return ptr[0..@intCast(len)];
}

fn outputSlice(ptr: [*]u8, cap: u32) []u8 {
    return ptr[0..@intCast(cap)];
}

fn be16(input: []const u8, at: usize) u32 {
    return (@as(u32, input[at]) << 8) | @as(u32, input[at + 1]);
}

fn be32(input: []const u8, at: usize) u32 {
    return (@as(u32, input[at]) << 24) |
        (@as(u32, input[at + 1]) << 16) |
        (@as(u32, input[at + 2]) << 8) |
        @as(u32, input[at + 3]);
}

fn le16(input: []const u8, at: usize) u32 {
    return @as(u32, input[at]) | (@as(u32, input[at + 1]) << 8);
}

fn le24(input: []const u8, at: usize) u32 {
    return @as(u32, input[at]) | (@as(u32, input[at + 1]) << 8) | (@as(u32, input[at + 2]) << 16);
}

fn le32(input: []const u8, at: usize) u32 {
    return @as(u32, input[at]) |
        (@as(u32, input[at + 1]) << 8) |
        (@as(u32, input[at + 2]) << 16) |
        (@as(u32, input[at + 3]) << 24);
}

fn startsWith(input: []const u8, prefix: []const u8) bool {
    return input.len >= prefix.len and std.mem.eql(u8, input[0..prefix.len], prefix);
}

fn parsePng(input: []const u8) ?ImageInfo {
    const sig = "\x89PNG\r\n\x1a\n";
    if (!startsWith(input, sig) or input.len < 24) return null;
    if (!std.mem.eql(u8, input[12..16], "IHDR")) return null;
    return .{ .mime_code = MIME_PNG, .width = be32(input, 16), .height = be32(input, 20), .bytes = @intCast(input.len) };
}

fn isSof(marker: u8) bool {
    return switch (marker) {
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf => true,
        else => false,
    };
}

fn parseJpeg(input: []const u8) ?ImageInfo {
    if (input.len < 4 or input[0] != 0xff or input[1] != 0xd8) return null;
    var i: usize = 2;
    while (i + 3 < input.len) {
        while (i < input.len and input[i] != 0xff) i += 1;
        while (i < input.len and input[i] == 0xff) i += 1;
        if (i >= input.len) return null;
        const marker = input[i];
        i += 1;
        if (marker == 0xd8 or marker == 0xd9) continue;
        if (marker >= 0xd0 and marker <= 0xd7) continue;
        if (i + 2 > input.len) return null;
        const segment_len = be16(input, i);
        if (segment_len < 2 or i + segment_len > input.len) return null;
        if (isSof(marker)) {
            if (segment_len < 7) return null;
            return .{
                .mime_code = MIME_JPEG,
                .width = be16(input, i + 5),
                .height = be16(input, i + 3),
                .bytes = @intCast(input.len),
            };
        }
        i += segment_len;
    }
    return null;
}

fn parseGif(input: []const u8) ?ImageInfo {
    if (input.len < 10) return null;
    if (!startsWith(input, "GIF87a") and !startsWith(input, "GIF89a")) return null;
    return .{ .mime_code = MIME_GIF, .width = le16(input, 6), .height = le16(input, 8), .bytes = @intCast(input.len) };
}

fn parseBmp(input: []const u8) ?ImageInfo {
    if (input.len < 26 or !startsWith(input, "BM")) return null;
    return .{ .mime_code = MIME_BMP, .width = le32(input, 18), .height = le32(input, 22), .bytes = @intCast(input.len) };
}

fn parseWebp(input: []const u8) ?ImageInfo {
    if (input.len < 30 or !startsWith(input, "RIFF") or !std.mem.eql(u8, input[8..12], "WEBP")) return null;
    var i: usize = 12;
    while (i + 8 <= input.len) {
        const chunk = input[i .. i + 4];
        const size = le32(input, i + 4);
        const data = i + 8;
        if (data + size > input.len) return null;
        if (std.mem.eql(u8, chunk, "VP8X") and size >= 10) {
            return .{
                .mime_code = MIME_WEBP,
                .width = le24(input, data + 4) + 1,
                .height = le24(input, data + 7) + 1,
                .bytes = @intCast(input.len),
            };
        }
        if (std.mem.eql(u8, chunk, "VP8 ") and size >= 10 and std.mem.eql(u8, input[data + 3 .. data + 6], "\x9d\x01\x2a")) {
            return .{
                .mime_code = MIME_WEBP,
                .width = le16(input, data + 6) & 0x3fff,
                .height = le16(input, data + 8) & 0x3fff,
                .bytes = @intCast(input.len),
            };
        }
        if (std.mem.eql(u8, chunk, "VP8L") and size >= 5 and input[data] == 0x2f) {
            const b0 = @as(u32, input[data + 1]);
            const b1 = @as(u32, input[data + 2]);
            const b2 = @as(u32, input[data + 3]);
            const b3 = @as(u32, input[data + 4]);
            const width = 1 + (((b1 & 0x3f) << 8) | b0);
            const height = 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 6));
            return .{ .mime_code = MIME_WEBP, .width = width, .height = height, .bytes = @intCast(input.len) };
        }
        i = data + size + (size & 1);
    }
    return null;
}

fn parseImage(input: []const u8) ?ImageInfo {
    return parsePng(input) orelse
        parseJpeg(input) orelse
        parseGif(input) orelse
        parseWebp(input) orelse
        parseBmp(input);
}

pub export fn sift_image_probe(
    ptr: [*]const u8,
    len: u32,
    max_bytes: u32,
    max_pixels: u32,
    out: *ImageInfo,
) u32 {
    if (len == 0) return STATUS_INVALID_ARGS;
    if (max_bytes > 0 and len > max_bytes) return STATUS_TOO_LARGE;
    const input = bytes(ptr, len);
    const info = parseImage(input) orelse return STATUS_UNSUPPORTED;
    if (info.width == 0 or info.height == 0) return STATUS_MALFORMED;
    if (max_pixels > 0 and @as(u64, info.width) * @as(u64, info.height) > @as(u64, max_pixels)) return STATUS_TOO_LARGE;
    out.* = info;
    return STATUS_OK;
}

fn validateRenderInput(input_len: u32, options: ImageRenderOptions) u32 {
    if (input_len == 0) return STATUS_INVALID_ARGS;
    if (options.width == 0 or options.height == 0 or options.columns == 0 or options.rows == 0) return STATUS_INVALID_ARGS;
    if (options.columns > MAX_RENDER_CELLS / options.rows) return STATUS_TOO_LARGE;

    const min_stride = @as(u64, options.width) * 4;
    if (@as(u64, options.stride) < min_stride) return STATUS_INVALID_ARGS;

    const last_row = @as(u64, options.height - 1) * @as(u64, options.stride);
    const required = last_row + min_stride;
    if (required > @as(u64, input_len)) return STATUS_INVALID_ARGS;

    return STATUS_OK;
}

fn averageCellLuma(input: []const u8, options: ImageRenderOptions, col: u32, row: u32) u32 {
    var x0 = (@as(u64, col) * @as(u64, options.width)) / @as(u64, options.columns);
    var x1 = (@as(u64, col + 1) * @as(u64, options.width)) / @as(u64, options.columns);
    var y0 = (@as(u64, row) * @as(u64, options.height)) / @as(u64, options.rows);
    var y1 = (@as(u64, row + 1) * @as(u64, options.height)) / @as(u64, options.rows);

    if (x1 <= x0) x1 = @min(@as(u64, options.width), x0 + 1);
    if (y1 <= y0) y1 = @min(@as(u64, options.height), y0 + 1);
    x0 = @min(x0, options.width - 1);
    y0 = @min(y0, options.height - 1);

    var total: u64 = 0;
    var count: u64 = 0;
    var y = y0;
    while (y < y1) : (y += 1) {
        var x = x0;
        while (x < x1) : (x += 1) {
            const offset = y * @as(u64, options.stride) + x * 4;
            const r = @as(u32, input[@intCast(offset)]);
            const g = @as(u32, input[@intCast(offset + 1)]);
            const b = @as(u32, input[@intCast(offset + 2)]);
            const a = @as(u32, input[@intCast(offset + 3)]);
            const luma = (299 * r + 587 * g + 114 * b) / 1000;
            total += (luma * a) / 255;
            count += 1;
        }
    }

    if (count == 0) return 0;
    return @intCast(total / count);
}

fn densityGlyph(luma: u32, invert: bool) u8 {
    const tone = if (invert) 255 - @min(luma, 255) else @min(luma, 255);
    const idx = (tone * (density_ramp.len - 1) + 127) / 255;
    return density_ramp[idx];
}

pub export fn sift_image_render_density_ansi(
    ptr: [*]const u8,
    len: u32,
    options_ptr: *const ImageRenderOptions,
    out_ptr: [*]u8,
    out_cap: u32,
    written: *u32,
    needed: *u32,
) u32 {
    written.* = 0;
    needed.* = 0;

    const options = options_ptr.*;
    const validation = validateRenderInput(len, options);
    if (validation != STATUS_OK) return validation;

    const input = bytes(ptr, len);
    var w = Writer{ .buf = outputSlice(out_ptr, out_cap) };
    const invert = (options.flags & RENDER_FLAG_INVERT) != 0;

    var row: u32 = 0;
    while (row < options.rows) : (row += 1) {
        var col: u32 = 0;
        while (col < options.columns) : (col += 1) {
            w.appendByte(densityGlyph(averageCellLuma(input, options, col, row), invert));
        }
        w.appendByte('\n');
    }

    needed.* = @intCast(w.needed);
    written.* = @intCast(w.len);
    if (w.overflow) return STATUS_OUTPUT_TOO_SMALL;
    return STATUS_OK;
}

test "probe png dimensions" {
    const png = "\x89PNG\r\n\x1a\n" ++ "\x00\x00\x00\x0dIHDR" ++ "\x00\x00\x00\x02" ++ "\x00\x00\x00\x03" ++ "\x08\x02\x00\x00\x00";
    var info: ImageInfo = .{ .mime_code = 0, .width = 0, .height = 0, .bytes = 0 };
    try std.testing.expectEqual(STATUS_OK, sift_image_probe(png.ptr, png.len, 1024, 100, &info));
    try std.testing.expectEqual(MIME_PNG, info.mime_code);
    try std.testing.expectEqual(@as(u32, 2), info.width);
    try std.testing.expectEqual(@as(u32, 3), info.height);
}

test "reject oversized bytes" {
    const gif = "GIF89a" ++ "\x02\x00\x03\x00";
    var info: ImageInfo = .{ .mime_code = 0, .width = 0, .height = 0, .bytes = 0 };
    try std.testing.expectEqual(STATUS_TOO_LARGE, sift_image_probe(gif.ptr, gif.len, 4, 100, &info));
}

test "render raw rgba density ansi" {
    const rgba = [_]u8{
        0,   0,   0,   255,
        255, 255, 255, 255,
    };
    const options = ImageRenderOptions{
        .width = 2,
        .height = 1,
        .stride = 8,
        .columns = 2,
        .rows = 1,
        .flags = 0,
    };
    var out: [8]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;

    try std.testing.expectEqual(
        STATUS_OK,
        sift_image_render_density_ansi(rgba[0..].ptr, rgba.len, &options, &out, out.len, &written, &needed),
    );
    try std.testing.expectEqual(@as(u32, 3), written);
    try std.testing.expectEqual(@as(u32, 3), needed);
    try std.testing.expectEqualStrings(" @\n", out[0..written]);
}

test "render raw rgba reports output size" {
    const rgba = [_]u8{
        0,   0,   0,   255,
        255, 255, 255, 255,
    };
    const options = ImageRenderOptions{
        .width = 2,
        .height = 1,
        .stride = 8,
        .columns = 2,
        .rows = 1,
        .flags = 0,
    };
    var out: [2]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;

    try std.testing.expectEqual(
        STATUS_OUTPUT_TOO_SMALL,
        sift_image_render_density_ansi(rgba[0..].ptr, rgba.len, &options, &out, out.len, &written, &needed),
    );
    try std.testing.expectEqual(@as(u32, 3), needed);
}
