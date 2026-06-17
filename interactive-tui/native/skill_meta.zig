//! skill_meta — SKILL.md frontmatter parser (native kernel).
//!
//! The codex CLI parses skill frontmatter in Rust (`codex-rs/core/src/skills.rs`);
//! this is our Zig analog. It is a byte/line parser — exactly the "keep Zig
//! narrow: parsers, byte scanning" class — while the filesystem discovery and
//! orchestration stay in the TypeScript host (`skillsEngine.ts`). The pure-TS
//! `parseFrontmatter` fallback in that file must stay byte-for-byte in lockstep
//! with `parseMeta` here (the dylib is absent under ts-jest/node).
//!
//! Contract (mirrors the TS reader exactly):
//!   - tolerate a leading UTF-8 BOM;
//!   - the doc must open with `---`; the block runs from the first newline to the
//!     next `\n---`;
//!   - within the block: skip blank lines, `#` comments, and indented (nested /
//!     list) lines; take top-level `key: value` scalars only;
//!   - a key with an empty value (e.g. `triggers:` introducing a list) is skipped;
//!   - one leading and one trailing quote (`"` or `'`) are stripped from a value;
//!   - `name` is required and non-empty; `description` is optional;
//!   - optional preflight scalar metadata is preserved for the TypeScript host.

const std = @import("std");

pub const Meta = struct {
    /// Slices borrow from the input content; valid for its lifetime.
    name: []const u8,
    description: []const u8,
    preflight: []const u8,
    preflight_query: []const u8,
    preflight_max_chars: []const u8,
};

const BOM = "\xEF\xBB\xBF";

fn isKeyChar(c: u8) bool {
    return (c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9') or c == '_' or c == '-';
}

/// The leading `---` frontmatter block (between the first newline and the next
/// `\n---`), or null when the doc has no frontmatter. Mirrors `frontmatterBlock`.
fn frontmatterBlock(raw: []const u8) ?[]const u8 {
    var s = raw;
    if (std.mem.startsWith(u8, s, BOM)) s = s[BOM.len..];
    if (!std.mem.startsWith(u8, s, "---")) return null;
    const first_nl = std.mem.indexOfScalar(u8, s, '\n') orelse return null;
    // `indexOf("\n---", 3)` — the closing fence at or after the opening line.
    const end_rel = std.mem.indexOf(u8, s[3..], "\n---") orelse return null;
    const end = 3 + end_rel;
    if (end < first_nl + 1) return s[0..0];
    return s[first_nl + 1 .. end];
}

fn stripQuotes(v: []const u8) []const u8 {
    var out = v;
    if (out.len > 0 and (out[0] == '"' or out[0] == '\'')) out = out[1..];
    if (out.len > 0 and (out[out.len - 1] == '"' or out[out.len - 1] == '\'')) out = out[0 .. out.len - 1];
    return out;
}

/// Parse scalar metadata from SKILL.md content. Returns null when there is
/// no frontmatter or no non-empty `name` — the same "not a skill" signal the
/// host treats as "skip this file".
pub fn parseMeta(raw: []const u8) ?Meta {
    const block = frontmatterBlock(raw) orelse return null;
    var name: []const u8 = "";
    var description: []const u8 = "";
    var preflight: []const u8 = "";
    var preflight_query: []const u8 = "";
    var preflight_max_chars: []const u8 = "";

    var lines = std.mem.splitScalar(u8, block, '\n');
    while (lines.next()) |raw_line| {
        // Drop a trailing CR so CRLF files parse identically to LF.
        const line = if (raw_line.len > 0 and raw_line[raw_line.len - 1] == '\r')
            raw_line[0 .. raw_line.len - 1]
        else
            raw_line;

        if (std.mem.trim(u8, line, " \t").len == 0) continue; // blank
        if (line.len > 0 and line[0] == '#') continue; // comment
        if (line.len > 0 and (line[0] == ' ' or line[0] == '\t')) continue; // nested / list item

        var i: usize = 0;
        while (i < line.len and isKeyChar(line[i])) i += 1;
        if (i == 0 or i >= line.len or line[i] != ':') continue; // not a `key:` line

        const key = line[0..i];
        const value = stripQuotes(std.mem.trim(u8, line[i + 1 ..], " \t"));
        if (value.len == 0) continue; // a key introducing a block (e.g. `triggers:`)

        if (std.mem.eql(u8, key, "name")) {
            name = value;
        } else if (std.mem.eql(u8, key, "description")) {
            description = value;
        } else if (std.mem.eql(u8, key, "preflight")) {
            preflight = value;
        } else if (std.mem.eql(u8, key, "preflight_query")) {
            preflight_query = value;
        } else if (std.mem.eql(u8, key, "preflight_max_chars")) {
            preflight_max_chars = value;
        }
    }

    const trimmed_name = std.mem.trim(u8, name, " \t");
    if (trimmed_name.len == 0) return null;
    return .{
        .name = trimmed_name,
        .description = std.mem.trim(u8, description, " \t"),
        .preflight = std.mem.trim(u8, preflight, " \t"),
        .preflight_query = std.mem.trim(u8, preflight_query, " \t"),
        .preflight_max_chars = std.mem.trim(u8, preflight_max_chars, " \t"),
    };
}

// ---------------------------------------------------------------------------
// C-ABI export — writes scalar metadata JSON into a caller buffer.
// Status: 0 ok · 1 not-a-skill (no frontmatter / no name) · 2 output too small.
// ---------------------------------------------------------------------------

const STATUS_OK: u32 = 0;
const STATUS_NOT_FOUND: u32 = 1;
const STATUS_OUTPUT_TOO_SMALL: u32 = 2;

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
                        else => {
                            var scratch: [8]u8 = undefined;
                            const hex = std.fmt.bufPrint(&scratch, "\\u{x:0>4}", .{b}) catch "";
                            self.append(hex);
                        },
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

pub export fn sift_skill_parse(
    content_ptr: [*]const u8,
    content_len: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const content = content_ptr[0..content_len];
    const meta = parseMeta(content) orelse {
        written_out.* = 0;
        needed_out.* = 0;
        return STATUS_NOT_FOUND;
    };
    var w: Writer = .{ .buf = out_ptr[0..out_cap] };
    w.append("{\"name\":");
    w.appendJsonString(meta.name);
    w.append(",\"description\":");
    w.appendJsonString(meta.description);
    w.append(",\"preflight\":");
    w.appendJsonString(meta.preflight);
    w.append(",\"preflightQuery\":");
    w.appendJsonString(meta.preflight_query);
    w.append(",\"preflightMaxChars\":");
    w.appendJsonString(meta.preflight_max_chars);
    w.appendByte('}');
    needed_out.* = @intCast(w.needed);
    if (w.overflow) {
        written_out.* = 0;
        return STATUS_OUTPUT_TOO_SMALL;
    }
    written_out.* = @intCast(w.len);
    return STATUS_OK;
}

// ---------------------------------------------------------------------------
// Tests — the parser's behavior IS the contract; the TS fallback mirrors these.
// ---------------------------------------------------------------------------

const testing = std.testing;

test "parses name and description" {
    const meta = parseMeta("---\nname: demo\ndescription: A demo skill.\n---\n\n# Body\n").?;
    try testing.expectEqualStrings("demo", meta.name);
    try testing.expectEqualStrings("A demo skill.", meta.description);
}

test "ignores body and nested / list keys, keeps top-level scalars" {
    const src =
        "---\n" ++
        "name: branches\n" ++
        "description: Fan work out across branches.\n" ++
        "triggers:\n" ++
        "  - split this\n" ++
        "  - fan out\n" ++
        "allowed-tools:\n" ++
        "  - list_branches\n" ++
        "metadata:\n" ++
        "  author: siftable\n" ++
        "---\n" ++
        "name: not-this\n"; // a `name:` in the BODY must be ignored
    const meta = parseMeta(src).?;
    try testing.expectEqualStrings("branches", meta.name);
    try testing.expectEqualStrings("Fan work out across branches.", meta.description);
}

test "missing frontmatter is not a skill" {
    try testing.expect(parseMeta("# Just a heading\n\nNo frontmatter here.\n") == null);
}

test "no closing fence is not a skill" {
    try testing.expect(parseMeta("---\nname: demo\nstill going\n") == null);
}

test "missing or empty name is not a skill" {
    try testing.expect(parseMeta("---\ndescription: only a description\n---\n") == null);
    try testing.expect(parseMeta("---\nname:\ndescription: d\n---\n") == null);
    try testing.expect(parseMeta("---\nname: \"\"\ndescription: d\n---\n") == null);
}

test "description is optional" {
    const meta = parseMeta("---\nname: solo\n---\n").?;
    try testing.expectEqualStrings("solo", meta.name);
    try testing.expectEqualStrings("", meta.description);
}

test "preserves optional preflight scalar metadata" {
    const meta = parseMeta(
        "---\n" ++
            "name: zig\n" ++
            "description: native work\n" ++
            "preflight: git_status,repo_map,code_search_hints\n" ++
            "preflight_query: zig native tui ffi\n" ++
            "preflight_max_chars: 5000\n" ++
            "---\n",
    ).?;
    try testing.expectEqualStrings("zig", meta.name);
    try testing.expectEqualStrings("git_status,repo_map,code_search_hints", meta.preflight);
    try testing.expectEqualStrings("zig native tui ffi", meta.preflight_query);
    try testing.expectEqualStrings("5000", meta.preflight_max_chars);
}

test "tolerates a leading BOM" {
    const meta = parseMeta(BOM ++ "---\nname: bom\ndescription: d\n---\n").?;
    try testing.expectEqualStrings("bom", meta.name);
}

test "strips one layer of surrounding quotes" {
    const meta = parseMeta("---\nname: \"quoted name\"\ndescription: 'single quoted'\n---\n").?;
    try testing.expectEqualStrings("quoted name", meta.name);
    try testing.expectEqualStrings("single quoted", meta.description);
}

test "parses CRLF line endings identically" {
    const meta = parseMeta("---\r\nname: crlf\r\ndescription: windows\r\n---\r\n").?;
    try testing.expectEqualStrings("crlf", meta.name);
    try testing.expectEqualStrings("windows", meta.description);
}

test "skips comments and blank lines in the block" {
    const meta = parseMeta("---\n# a comment\n\nname: demo\n\ndescription: d\n---\n").?;
    try testing.expectEqualStrings("demo", meta.name);
    try testing.expectEqualStrings("d", meta.description);
}

test "export writes escaped JSON and reports status" {
    var out: [256]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    const src = "---\nname: demo\ndescription: has \"quotes\" + \\ slash\n---\n";
    const status = sift_skill_parse(src.ptr, @intCast(src.len), &out, out.len, &written, &needed);
    try testing.expectEqual(STATUS_OK, status);
    try testing.expectEqualStrings(
        "{\"name\":\"demo\",\"description\":\"has \\\"quotes\\\" + \\\\ slash\",\"preflight\":\"\",\"preflightQuery\":\"\",\"preflightMaxChars\":\"\"}",
        out[0..written],
    );
}

test "export reports not-found for a non-skill" {
    var out: [64]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    const src = "no frontmatter";
    try testing.expectEqual(
        STATUS_NOT_FOUND,
        sift_skill_parse(src.ptr, @intCast(src.len), &out, out.len, &written, &needed),
    );
    try testing.expectEqual(@as(u32, 0), written);
}

test "export reports output-too-small with needed bytes" {
    var out: [8]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    const src = "---\nname: a-fairly-long-skill-name\ndescription: and a description too\n---\n";
    const status = sift_skill_parse(src.ptr, @intCast(src.len), &out, out.len, &written, &needed);
    try testing.expectEqual(STATUS_OUTPUT_TOO_SMALL, status);
    try testing.expectEqual(@as(u32, 0), written);
    try testing.expect(needed > out.len);
}
