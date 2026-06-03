const std = @import("std");

const Decision = enum(u32) {
    inline_text = 0,
    chip = 1,
    force_chip = 2,
};

const PASTE_CHIP_CHAR_THRESHOLD: u32 = 1500;
const PASTE_CHIP_LINE_THRESHOLD: u32 = 12;
const FORCE_CHIP_CHAR_THRESHOLD: u32 = 4000;
const FORCE_CHIP_LINE_THRESHOLD: u32 = 40;
const STRUCTURED_CHAR_THRESHOLD: u32 = 1000;
const STRUCTURED_LINE_THRESHOLD: u32 = 6;

fn isContinuationByte(byte: u8) bool {
    return (byte & 0b1100_0000) == 0b1000_0000;
}

fn isAsciiWhitespace(byte: u8) bool {
    return byte == ' ' or byte == '\t' or byte == '\n' or byte == '\r';
}

fn bytes(ptr: [*]const u8, len: u32) []const u8 {
    return ptr[0..@intCast(len)];
}

fn countCodepoints(input: []const u8) u32 {
    var count: u32 = 0;
    for (input) |byte| {
        if (!isContinuationByte(byte)) count += 1;
    }
    return count;
}

fn countLines(input: []const u8) u32 {
    if (input.len == 0) return 0;

    var count: u32 = 1;
    var i: usize = 0;
    while (i < input.len) : (i += 1) {
        if (input[i] == '\r') {
            count += 1;
            if (i + 1 < input.len and input[i + 1] == '\n') i += 1;
        } else if (input[i] == '\n') {
            count += 1;
        }
    }
    return count;
}

fn contains(input: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, input, needle) != null;
}

fn lineStartsWith(input: []const u8, marker: []const u8) bool {
    var at_line_start = true;
    var i: usize = 0;
    while (i + marker.len <= input.len) : (i += 1) {
        if (at_line_start and std.mem.eql(u8, input[i .. i + marker.len], marker)) return true;
        at_line_start = input[i] == '\n' or input[i] == '\r';
        if (input[i] == '\r' and i + 1 < input.len and input[i + 1] == '\n') i += 1;
    }
    return false;
}

fn hasIndentedCodeLine(input: []const u8) bool {
    var line_start: usize = 0;
    while (line_start < input.len) {
        var line_end = line_start;
        while (line_end < input.len and input[line_end] != '\n' and input[line_end] != '\r') : (line_end += 1) {}

        const line = input[line_start..line_end];
        var spaces: usize = 0;
        while (spaces < line.len and line[spaces] == ' ') : (spaces += 1) {}
        if (spaces >= 4 and spaces < line.len and !isAsciiWhitespace(line[spaces])) return true;

        if (line_end >= input.len) break;
        line_start = line_end + 1;
        if (input[line_end] == '\r' and line_start < input.len and input[line_start] == '\n') line_start += 1;
    }
    return false;
}

fn looksStructured(input: []const u8) bool {
    return contains(input, "```") or
        contains(input, "Error:") or
        contains(input, "Traceback ") or
        contains(input, "Exception") or
        contains(input, "    at ") or
        contains(input, "http://") or
        contains(input, "https://") or
        contains(input, "\t") or
        contains(input, "{\n") or
        contains(input, "[\n") or
        lineStartsWith(input, "- ") or
        lineStartsWith(input, "* ") or
        lineStartsWith(input, "# ") or
        hasIndentedCodeLine(input);
}

pub export fn sift_paste_char_count(ptr: [*]const u8, len: u32) u32 {
    return countCodepoints(bytes(ptr, len));
}

pub export fn sift_paste_line_count(ptr: [*]const u8, len: u32) u32 {
    return countLines(bytes(ptr, len));
}

pub export fn sift_paste_looks_structured(ptr: [*]const u8, len: u32) bool {
    return looksStructured(bytes(ptr, len));
}

pub export fn sift_should_chip_paste(ptr: [*]const u8, len: u32) u32 {
    const input = bytes(ptr, len);
    const chars = countCodepoints(input);
    const lines = countLines(input);

    if (chars >= FORCE_CHIP_CHAR_THRESHOLD or lines >= FORCE_CHIP_LINE_THRESHOLD) {
        return @intFromEnum(Decision.force_chip);
    }

    if (chars >= PASTE_CHIP_CHAR_THRESHOLD or lines >= PASTE_CHIP_LINE_THRESHOLD) {
        return @intFromEnum(Decision.chip);
    }

    if (chars >= STRUCTURED_CHAR_THRESHOLD and lines >= STRUCTURED_LINE_THRESHOLD and looksStructured(input)) {
        return @intFromEnum(Decision.chip);
    }

    return @intFromEnum(Decision.inline_text);
}

test "counts empty and single-line paste" {
    try std.testing.expectEqual(@as(u32, 0), sift_paste_line_count("".ptr, 0));
    try std.testing.expectEqual(@as(u32, 1), sift_paste_line_count("hello".ptr, 5));
    try std.testing.expectEqual(@as(u32, 5), sift_paste_char_count("hello".ptr, 5));
}

test "normalizes CRLF line counts" {
    const text = "a\r\nb\r\nc";
    try std.testing.expectEqual(@as(u32, 3), sift_paste_line_count(text.ptr, text.len));
}

test "chips at locked thresholds" {
    var force_lines: [40]u8 = undefined;
    @memset(&force_lines, '\n');
    try std.testing.expectEqual(@as(u32, @intFromEnum(Decision.force_chip)), sift_should_chip_paste(force_lines[0..].ptr, force_lines.len));

    var chip_chars: [1500]u8 = undefined;
    @memset(&chip_chars, 'a');
    try std.testing.expectEqual(@as(u32, @intFromEnum(Decision.chip)), sift_should_chip_paste(chip_chars[0..].ptr, chip_chars.len));
}

test "chips obvious structured blocks earlier" {
    var text: [1030]u8 = undefined;
    @memset(&text, 'a');
    text[0] = '-';
    text[1] = ' ';
    text[2] = 'x';
    text[3] = '\n';
    text[4] = '-';
    text[5] = ' ';
    text[6] = 'y';
    text[7] = '\n';
    text[8] = '-';
    text[9] = ' ';
    text[10] = 'z';
    text[11] = '\n';
    text[12] = '-';
    text[13] = ' ';
    text[14] = 'q';
    text[15] = '\n';
    text[16] = '-';
    text[17] = ' ';
    text[18] = 'r';
    text[19] = '\n';
    try std.testing.expectEqual(@as(u32, @intFromEnum(Decision.chip)), sift_should_chip_paste(text[0..].ptr, text.len));
}
