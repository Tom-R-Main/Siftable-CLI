const std = @import("std");

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_UNSUPPORTED: u32 = 2;
const STATUS_TOO_LARGE: u32 = 3;
const STATUS_MALFORMED: u32 = 4;

const MIME_PNG: u32 = 1;
const MIME_JPEG: u32 = 2;
const MIME_GIF: u32 = 3;
const MIME_WEBP: u32 = 4;
const MIME_BMP: u32 = 5;

const ImageInfo = extern struct {
    mime_code: u32,
    width: u32,
    height: u32,
    bytes: u32,
};

fn bytes(ptr: [*]const u8, len: u32) []const u8 {
    return ptr[0..@intCast(len)];
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

export fn sift_image_probe(
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
