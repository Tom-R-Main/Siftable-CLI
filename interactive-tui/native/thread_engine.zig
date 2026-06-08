const std = @import("std");

const Io = std.Io;
const Dir = std.Io.Dir;
const File = std.Io.File;

fn io() Io {
    return Io.Threaded.global_single_threaded.io();
}

// Thread engine: deterministic context-window kernel for the Siftable TUI.
//
// Phase 1 implements token estimation only. The LLM summarize call, history
// rewrite, and model adapters stay host-side (TypeScript); this module owns the
// pure byte-scanning + budget arithmetic that decides what the host should do.
//
// Token estimation here is a heuristic gate, not a BPE-accurate count. It blends
// word runs (~4 chars/token for Latin text), standalone punctuation (~1 token),
// and multibyte codepoints (CJK/emoji, ~1 token each). It is deterministic and
// runs at byte-scan speed, which is what a pre-turn overflow gate needs. A
// BPE-accurate variant can be added later if the gate proves too loose.

// Byte classes for the estimator's single-pass scan. A comptime 256-entry table
// turns the hot per-byte dispatch into one load + switch, which the branch
// predictor handles far better than a chain of range comparisons.
const Class = enum(u8) { word = 0, space = 1, punct = 2, multibyte = 3 };

const class_table: [256]Class = blk: {
    var table: [256]Class = undefined;
    for (0..256) |i| {
        const byte: u8 = @intCast(i);
        table[i] =
            if ((byte >= 'a' and byte <= 'z') or (byte >= 'A' and byte <= 'Z') or (byte >= '0' and byte <= '9'))
                .word
            else if (byte == ' ' or byte == '\t' or byte == '\n' or byte == '\r')
                .space
            else if (byte < 0x80)
                .punct
            else
                .multibyte;
    }
    break :blk table;
};

fn classOf(byte: u8) Class {
    return class_table[byte];
}

fn isContinuationByte(byte: u8) bool {
    return (byte & 0b1100_0000) == 0b1000_0000;
}

fn bytes(ptr: [*]const u8, len: u32) []const u8 {
    return ptr[0..@intCast(len)];
}

// Tokens contributed by a contiguous Latin-ish word run of `chars` codepoints.
// ceil(chars / 4), minimum 1. Matches the rough ~4 chars/token average that
// GPT/Claude BPE vocabularies land on for English.
fn wordRunTokens(chars: usize) u32 {
    if (chars == 0) return 0;
    return @intCast((chars + 3) / 4);
}

// Calibration (Phase 4): a real-tokenizer study (DeepSeek v4) showed the raw
// heuristic OVER-counts prose (the safe direction) but UNDER-counts symbol-dense
// code (the dangerous direction). We correct ONLY upward — punctuation carries a
// surcharge — so prose stays conservative and pure word-runs are unchanged
// (preserving the simple ceil(chars/4) model for plain text). PUNCT_WEIGHT is
// stored as tenths; 14 = 1.4 tokens per standalone punctuation char.
const PUNCT_WEIGHT_TENTHS: u32 = 13;

fn estimateTokens(input: []const u8) u32 {
    var word_tokens: u32 = 0;
    var punct: u32 = 0;
    var multibyte: u32 = 0;
    var i: usize = 0;
    while (i < input.len) {
        switch (classOf(input[i])) {
            .word => {
                // Consume the full alphanumeric run, counting codepoints (all
                // ASCII here, so byte == codepoint).
                const run_start = i;
                i += 1;
                while (i < input.len and class_table[input[i]] == .word) : (i += 1) {}
                word_tokens += wordRunTokens(i - run_start);
            },
            .space => {
                // Whitespace folds into adjacent tokens (BPE attaches leading space).
                i += 1;
            },
            .punct => {
                // Standalone ASCII punctuation / symbol. Counted with a surcharge
                // because real BPE splits dense operator/bracket sequences more
                // finely than one-token-each.
                punct += 1;
                i += 1;
            },
            .multibyte => {
                // Multibyte codepoint (CJK, emoji, accented): ~1 token per codepoint.
                multibyte += 1;
                i += 1;
                while (i < input.len and isContinuationByte(input[i])) : (i += 1) {}
            },
        }
    }
    // round(punct * weight/10), surcharge only — never below the raw punct count.
    const punct_tokens = (punct * PUNCT_WEIGHT_TENTHS + 5) / 10;
    return word_tokens + multibyte + punct_tokens;
}

pub export fn sift_thread_estimate_tokens(ptr: [*]const u8, len: u32) u32 {
    if (len == 0) return 0;
    return estimateTokens(bytes(ptr, len));
}

// ── Text chunk planner ──────────────────────────────────────────────────────
//
// Native offset planner for the backend's structural chunking algorithm. It
// deliberately returns offsets rather than strings so the host keeps ownership
// of text decoding and JSON escaping. The TypeScript bridge passes an already
// trimmed UTF-8 buffer and decodes the returned [start,end) byte ranges.

fn isChunkWhitespace(byte: u8) bool {
    return byte == ' ' or byte == '\t' or byte == '\n' or byte == '\r' or byte == 0x0b or byte == 0x0c;
}

fn trimRange(input: []const u8, start: usize, end: usize) struct { start: usize, end: usize } {
    var s = start;
    var e = end;
    while (s < e and isChunkWhitespace(input[s])) : (s += 1) {}
    while (e > s and isChunkWhitespace(input[e - 1])) : (e -= 1) {}
    return .{ .start = s, .end = e };
}

fn lastIndexOfAtOrBefore(input: []const u8, needle: []const u8, position: usize) ?usize {
    if (needle.len == 0 or input.len < needle.len) return null;
    var i = @min(position, input.len - needle.len);
    while (true) {
        if (std.mem.eql(u8, input[i .. i + needle.len], needle)) return i;
        if (i == 0) break;
        i -= 1;
    }
    return null;
}

pub export fn sift_thread_plan_chunks(
    text_ptr: [*]const u8,
    text_len: u32,
    max_chars: u32,
    overlap_chars: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    if (max_chars == 0) return STATUS_INVALID_ARGS;

    const raw = if (text_len == 0) raw_empty: {
        break :raw_empty @as([]const u8, &.{});
    } else bytes(text_ptr, text_len);
    const outer = trimRange(raw, 0, raw.len);
    const input = raw[outer.start..outer.end];

    var w = PlanWriter{ .buf = outputSlicePlan(out_ptr, out_cap) };
    w.append("{\"chunks\":[");
    if (input.len == 0) {
        w.append("]}");
        return finishPlan(&w, written_out, needed_out);
    }

    const max_len: usize = @intCast(max_chars);
    const overlap_len: usize = @intCast(overlap_chars);
    var start: usize = 0;
    var index: u32 = 0;
    var first = true;

    while (start < input.len) {
        var end = @min(start + max_len, input.len);

        if (end < input.len) {
            if (lastIndexOfAtOrBefore(input, "\n\n", end)) |paragraph_break| {
                if (paragraph_break > start + overlap_len) {
                    end = paragraph_break;
                } else if (lastIndexOfAtOrBefore(input, ". ", end)) |sentence_break| {
                    if (sentence_break > start + overlap_len) {
                        end = sentence_break + 1;
                    } else if (lastIndexOfAtOrBefore(input, " ", end)) |word_break| {
                        if (word_break > start + overlap_len) end = word_break;
                    }
                } else if (lastIndexOfAtOrBefore(input, " ", end)) |word_break| {
                    if (word_break > start + overlap_len) end = word_break;
                }
            } else if (lastIndexOfAtOrBefore(input, ". ", end)) |sentence_break| {
                if (sentence_break > start + overlap_len) {
                    end = sentence_break + 1;
                } else if (lastIndexOfAtOrBefore(input, " ", end)) |word_break| {
                    if (word_break > start + overlap_len) end = word_break;
                }
            } else if (lastIndexOfAtOrBefore(input, " ", end)) |word_break| {
                if (word_break > start + overlap_len) end = word_break;
            }
        }

        var body = trimRange(input, start, end);
        if (body.start == body.end) {
            end = @min(start + max_len, input.len);
            body = trimRange(input, start, end);
            if (body.start == body.end) break;
            if (!first) w.append(",");
            w.appendFmt("{{\"index\":{d},\"start\":{d},\"end\":{d}}}", .{ index, body.start, body.end });
            first = false;
            index += 1;
            start = @min(end, input.len);
            continue;
        }

        if (!first) w.append(",");
        w.appendFmt("{{\"index\":{d},\"start\":{d},\"end\":{d}}}", .{ index, body.start, body.end });
        first = false;
        index += 1;

        if (end == input.len) break;

        start = @max(end - @min(overlap_len, end), start + 1);
        while (start < input.len and isChunkWhitespace(input[start])) : (start += 1) {}
    }

    w.append("]}");
    return finishPlan(&w, written_out, needed_out);
}

// ── Compaction planner ──────────────────────────────────────────────────────
//
// Pure decision engine: given the framed message history + a budget config, it
// decides what the host should do — which old tool outputs to prune, which
// prefix turns to summarize, and where the verbatim tail begins. It never calls
// a model and never mutates anything; the host executes the plan (one summarize
// LLM call + the object surgery) in TypeScript.
//
// Strategy (locked): prune-then-summarize. Only acts when over budget. First
// clears old tool outputs (cheap, no model call); summarizes a prefix of whole
// turns only if pruning alone can't fit. All selection is turn-aligned (a turn
// = a user message and everything up to the next user message), so a tool result
// is never separated from the assistant call that produced it.

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_OUTPUT_TOO_SMALL: u32 = 9;

const ROLE_USER: u8 = 0;
const ROLE_ASSISTANT: u8 = 1;
const ROLE_TOOL: u8 = 2;

const FLAG_PROTECTED: u8 = 0x1; // tool output that must never be pruned (e.g. skill)

// Config layout (u32 each): see PlanConfig below.
const CONFIG_FIELDS: usize = 7;
const MAX_MESSAGES: usize = 4096;

const PlanConfig = struct {
    context_window: u32,
    reserved: u32,
    tail_turns: u32,
    preserve_recent_tokens: u32,
    prune_protect_tokens: u32,
    prune_min_tokens: u32,
    // Manual `/compact`: when non-zero, plan a prune+summarize pass even when the
    // thread is still within budget (auto-compaction only fires on overflow).
    force: u32,
};

const PlanWriter = struct {
    buf: []u8,
    len: usize = 0,
    needed: usize = 0,
    overflow: bool = false,

    fn append(self: *PlanWriter, s: []const u8) void {
        self.needed += s.len;
        if (self.len + s.len > self.buf.len) {
            self.overflow = true;
            return;
        }
        @memcpy(self.buf[self.len .. self.len + s.len], s);
        self.len += s.len;
    }

    fn appendFmt(self: *PlanWriter, comptime fmt: []const u8, args: anytype) void {
        var scratch: [64]u8 = undefined;
        const rendered = std.fmt.bufPrint(&scratch, fmt, args) catch {
            self.overflow = true;
            return;
        };
        self.append(rendered);
    }
};

fn finishPlan(w: *const PlanWriter, written_out: *u32, needed_out: *u32) u32 {
    written_out.* = @intCast(@min(w.len, std.math.maxInt(u32)));
    needed_out.* = @intCast(@min(w.needed, std.math.maxInt(u32)));
    return if (w.overflow) STATUS_OUTPUT_TOO_SMALL else STATUS_OK;
}

const Parsed = struct {
    count: usize,
    roles: [MAX_MESSAGES]u8,
    flags: [MAX_MESSAGES]u8,
    tokens: [MAX_MESSAGES]u32,
};

// Parse the framed buffer: repeated [role:u8][flags:u8][len:u32 LE][bytes…].
fn parseMessages(input: []const u8, out: *Parsed) bool {
    var i: usize = 0;
    var n: usize = 0;
    while (i < input.len) {
        if (i + 6 > input.len) return false; // truncated header
        if (n >= MAX_MESSAGES) return false; // too many messages for the planner
        const role = input[i];
        const flags = input[i + 1];
        const content_len = std.mem.readInt(u32, input[i + 2 ..][0..4], .little);
        i += 6;
        const len: usize = @intCast(content_len);
        if (i + len > input.len) return false; // content runs past the buffer
        out.roles[n] = role;
        out.flags[n] = flags;
        out.tokens[n] = estimateTokens(input[i .. i + len]);
        i += len;
        n += 1;
    }
    out.count = n;
    return true;
}

fn turnTokens(p: *const Parsed, start: usize, end: usize) u64 {
    var sum: u64 = 0;
    var i = start;
    while (i < end) : (i += 1) sum += p.tokens[i];
    return sum;
}

pub export fn sift_thread_plan_compaction(
    msgs_ptr: [*]const u8,
    msgs_len: u32,
    config_ptr: [*]const u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const cfg = PlanConfig{
        .context_window = config_ptr[0],
        .reserved = config_ptr[1],
        .tail_turns = config_ptr[2],
        .preserve_recent_tokens = config_ptr[3],
        .prune_protect_tokens = config_ptr[4],
        .prune_min_tokens = config_ptr[5],
        .force = config_ptr[6],
    };
    if (cfg.context_window == 0) return STATUS_INVALID_ARGS;
    const forced = cfg.force != 0;

    var parsed: Parsed = undefined;
    const input = if (msgs_len == 0) input_empty: {
        break :input_empty @as([]const u8, &.{});
    } else bytes(msgs_ptr, msgs_len);
    if (!parseMessages(input, &parsed)) return STATUS_INVALID_ARGS;
    const n = parsed.count;

    var total: u64 = 0;
    for (0..n) |i| total += parsed.tokens[i];

    // Usable input budget: context window minus the output/safety reserve.
    const usable: u64 = if (cfg.reserved < cfg.context_window)
        cfg.context_window - cfg.reserved
    else
        cfg.context_window / 2;

    // Forced compaction (manual /compact) always runs the pipeline; auto only on overflow.
    const needs = total > usable or forced;

    // ── Prune phase ─────────────────────────────────────────────────────
    // Walk backward, protecting the most recent `prune_protect_tokens` worth of
    // messages; older tool outputs (not flagged protected) become prune
    // candidates. Only commit the prune if it frees at least `prune_min_tokens`.
    var prune_count: usize = 0;
    var prune_indices: [MAX_MESSAGES]usize = undefined;
    var pruned: u64 = 0;
    if (needs) {
        var protect_boundary: usize = 0;
        var protect_acc: u64 = 0;
        var j = n;
        while (j > 0) {
            j -= 1;
            protect_acc += parsed.tokens[j];
            if (protect_acc >= cfg.prune_protect_tokens) {
                protect_boundary = j + 1; // messages at index >= boundary are protected
                break;
            }
        }
        var candidate_tokens: u64 = 0;
        var idx: usize = 0;
        while (idx < protect_boundary) : (idx += 1) {
            if (parsed.roles[idx] == ROLE_TOOL and
                (parsed.flags[idx] & FLAG_PROTECTED) == 0 and
                parsed.tokens[idx] > 0)
            {
                prune_indices[prune_count] = idx;
                prune_count += 1;
                candidate_tokens += parsed.tokens[idx];
            }
        }
        if (candidate_tokens >= cfg.prune_min_tokens) {
            pruned = candidate_tokens;
        } else {
            prune_count = 0; // not worth it
        }
    }

    const projected: u64 = total - pruned;

    // ── Summarize phase ─────────────────────────────────────────────────
    // Only if pruning alone can't fit. Keep the most recent `tail_turns` whole
    // turns (bounded by `preserve_recent_tokens`, always ≥1), summarize the rest.
    var tail_start: usize = 0;
    var summarize_end: usize = 0;
    // Auto: summarize only when pruning alone can't fit. Forced: always summarize
    // the older turns (that's the whole point of an explicit /compact).
    if (needs and (projected > usable or forced)) {
        // Turn starts = indices of user messages.
        var turn_starts: [MAX_MESSAGES]usize = undefined;
        var num_turns: usize = 0;
        for (0..n) |i| {
            if (parsed.roles[i] == ROLE_USER) {
                turn_starts[num_turns] = i;
                num_turns += 1;
            }
        }
        if (num_turns >= 2) {
            var keep_tokens: u64 = 0;
            var kept: u32 = 0;
            var tail_turn: usize = num_turns; // index into turn_starts
            var t = num_turns;
            while (t > 0 and kept < cfg.tail_turns) {
                t -= 1;
                const turn_end = if (t + 1 < num_turns) turn_starts[t + 1] else n;
                const tt = turnTokens(&parsed, turn_starts[t], turn_end);
                if (kept >= 1 and keep_tokens + tt > cfg.preserve_recent_tokens) break;
                keep_tokens += tt;
                kept += 1;
                tail_turn = t;
            }
            // Guarantee at least one summarized turn (non-empty prefix).
            if (tail_turn == 0) tail_turn = 1;
            tail_start = turn_starts[tail_turn];
            summarize_end = tail_start;
        }
    }

    // ── Emit plan JSON ──────────────────────────────────────────────────
    var w = PlanWriter{ .buf = outputSlicePlan(out_ptr, out_cap) };
    w.append("{\"needsCompaction\":");
    w.append(if (needs) "true" else "false");
    w.appendFmt(",\"estimatedTokens\":{d}", .{total});
    w.appendFmt(",\"usableTokens\":{d}", .{usable});
    w.appendFmt(",\"prunedTokens\":{d}", .{pruned});
    w.append(",\"prune\":[");
    for (0..prune_count) |k| {
        if (k != 0) w.append(",");
        w.appendFmt("{d}", .{prune_indices[k]});
    }
    w.append("]");
    w.appendFmt(",\"summarizeRange\":[0,{d}]", .{summarize_end});
    w.appendFmt(",\"tailStartIndex\":{d}", .{tail_start});
    w.append("}");

    return finishPlan(&w, written_out, needed_out);
}

fn outputSlicePlan(ptr: [*]u8, cap: u32) []u8 {
    return ptr[0..@intCast(cap)];
}

// ── Rollout persistence ─────────────────────────────────────────────────────
//
// The rollout is an append-only JSONL log of the human-visible conversation —
// one record per line, written by the host as `{"r":<role>,"t":<text>,…}`. Zig
// owns the file I/O (the locked decision): append a line, or load the tail
// truncated to the last N whole turns. A "turn" starts at a user record, which a
// record always encodes as a leading `{"r":0`, so turn detection needs no JSON
// parse. Tool/assistant-tool-call churn is NOT persisted (the host only logs
// user + final-assistant records), so a reloaded history is always a valid
// user/assistant alternation — no orphaned tool results on resume.

const STATUS_NOT_FOUND: u32 = 2;
const STATUS_IO_ERROR: u32 = 10;
const ROLLOUT_MAX_BYTES: usize = 8 * 1024 * 1024;

fn statusFromFileError(err: anyerror) u32 {
    return switch (err) {
        error.FileNotFound => STATUS_NOT_FOUND,
        error.AccessDenied, error.PermissionDenied => STATUS_INVALID_ARGS,
        else => STATUS_IO_ERROR,
    };
}

fn rolloutWrite(path: []const u8, content: []const u8) u32 {
    var af = Dir.cwd().createFileAtomic(io(), path, .{
        .permissions = File.Permissions.default_file,
        .make_path = true,
        .replace = true,
    }) catch |err| return statusFromFileError(err);
    defer af.deinit(io());
    af.file.writeStreamingAll(io(), content) catch |err| return statusFromFileError(err);
    af.replace(io()) catch |err| return statusFromFileError(err);
    return STATUS_OK;
}

fn isUserLine(s: []const u8) bool {
    return std.mem.startsWith(u8, s, "{\"r\":0");
}

// Append one record line (newline added here) to the rollout, creating parent
// directories as needed. Read-modify-write keeps the write atomic; rollout files
// are small (text only), so re-reading on each append is cheap.
pub export fn sift_thread_rollout_append(
    path_ptr: [*]const u8,
    path_len: u32,
    line_ptr: [*]const u8,
    line_len: u32,
) u32 {
    const path = bytes(path_ptr, path_len);
    const line = bytes(line_ptr, line_len);
    const allocator = std.heap.smp_allocator;

    var existing: []u8 = &[_]u8{};
    if (Dir.cwd().readFileAlloc(io(), path, allocator, .limited(ROLLOUT_MAX_BYTES))) |data| {
        existing = data;
    } else |err| switch (err) {
        error.FileNotFound => {},
        else => return statusFromFileError(err),
    }
    defer if (existing.len > 0) allocator.free(existing);

    const total = existing.len + line.len + 1;
    const buf = allocator.alloc(u8, total) catch return STATUS_IO_ERROR;
    defer allocator.free(buf);
    @memcpy(buf[0..existing.len], existing);
    @memcpy(buf[existing.len..][0..line.len], line);
    buf[total - 1] = '\n';

    return rolloutWrite(path, buf);
}

// Load the rollout, optionally truncated to the last `max_turns` whole turns
// (0 = the whole file). Writes the selected JSONL text into the caller buffer;
// the host splits on newlines and parses each record. Missing file => NOT_FOUND
// (the host treats that as an empty history).
pub export fn sift_thread_rollout_load(
    path_ptr: [*]const u8,
    path_len: u32,
    max_turns: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const path = bytes(path_ptr, path_len);
    const allocator = std.heap.smp_allocator;

    const data = Dir.cwd().readFileAlloc(io(), path, allocator, .limited(ROLLOUT_MAX_BYTES)) catch |err| {
        written_out.* = 0;
        needed_out.* = 0;
        return statusFromFileError(err);
    };
    defer allocator.free(data);

    var start: usize = 0;
    if (max_turns > 0) {
        var offsets: [MAX_MESSAGES]usize = undefined;
        var count: usize = 0;
        var too_many = false;
        var line_start: usize = 0;
        while (line_start < data.len) {
            if (isUserLine(data[line_start..])) {
                if (count < MAX_MESSAGES) {
                    offsets[count] = line_start;
                    count += 1;
                } else {
                    too_many = true;
                }
            }
            const nl = std.mem.indexOfScalarPos(u8, data, line_start, '\n') orelse data.len;
            line_start = nl + 1;
        }
        if (!too_many and count > max_turns) {
            start = offsets[count - max_turns];
        }
    }

    var w = PlanWriter{ .buf = outputSlicePlan(out_ptr, out_cap) };
    w.append(data[start..]);
    return finishPlan(&w, written_out, needed_out);
}

test "empty input is zero tokens" {
    try std.testing.expectEqual(@as(u32, 0), sift_thread_estimate_tokens("".ptr, 0));
}

test "short word is one token" {
    const text = "hello";
    // 5 chars -> ceil(5/4) = 2
    try std.testing.expectEqual(@as(u32, 2), sift_thread_estimate_tokens(text.ptr, text.len));
}

test "four-char word is one token" {
    const text = "test";
    try std.testing.expectEqual(@as(u32, 1), sift_thread_estimate_tokens(text.ptr, text.len));
}

test "whitespace folds, words counted independently" {
    const text = "the quick brown fox"; // 3+5+5+3 chars -> 1+2+2+1
    try std.testing.expectEqual(@as(u32, 6), sift_thread_estimate_tokens(text.ptr, text.len));
}

test "punctuation carries a calibration surcharge" {
    // a(1) b(1) + 2 punct -> round(2*1.4)=3  => 5
    const text = "a, b.";
    try std.testing.expectEqual(@as(u32, 5), sift_thread_estimate_tokens(text.ptr, text.len));
}

test "multibyte codepoints break word runs" {
    // A multibyte codepoint is treated as its own token and breaks the Latin run:
    // "h" (run -> 1) + "é" (1) + "llo" (run -> 1) = 3. A heuristic gate tolerates
    // this slight over-count on accented text.
    const text = "héllo";
    try std.testing.expectEqual(@as(u32, 3), sift_thread_estimate_tokens(text.ptr, text.len));
}

test "cjk counts roughly one token per character" {
    const text = "日本語"; // 3 CJK codepoints, each its own run-breaker -> 3
    try std.testing.expectEqual(@as(u32, 3), sift_thread_estimate_tokens(text.ptr, text.len));
}

test "large english body lands near chars/4" {
    var buf: [4000]u8 = undefined;
    @memset(&buf, 'a');
    // One 4000-char word run -> ceil(4000/4) = 1000
    try std.testing.expectEqual(@as(u32, 1000), sift_thread_estimate_tokens(buf[0..].ptr, buf.len));
}

const TestChunks = struct {
    status: u32,
    json: []const u8,
};

fn tRunChunks(input: []const u8, max_chars: u32, overlap_chars: u32, out: []u8) TestChunks {
    var written: u32 = 0;
    var needed: u32 = 0;
    const status = sift_thread_plan_chunks(
        input.ptr,
        @intCast(input.len),
        max_chars,
        overlap_chars,
        out.ptr,
        @intCast(out.len),
        &written,
        &needed,
    );
    return .{ .status = status, .json = out[0..written] };
}

test "chunks: short text returns one trimmed offset" {
    var out: [256]u8 = undefined;
    const r = tRunChunks("  Short note.  ", 1000, 200, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expectEqualStrings("{\"chunks\":[{\"index\":0,\"start\":0,\"end\":11}]}", r.json);
}

test "chunks: prefers paragraph break over sentence break" {
    var out: [512]u8 = undefined;
    const text = "First paragraph here.\n\nSecond paragraph starts now and continues.";
    const r = tRunChunks(text, 40, 5, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(std.mem.indexOf(u8, r.json, "{\"index\":0,\"start\":0,\"end\":21}") != null);
}

test "chunks: falls back to sentence break when paragraph is unavailable" {
    var out: [512]u8 = undefined;
    const text = "Sentence one is here. Sentence two follows. Sentence three completes.";
    const r = tRunChunks(text, 30, 5, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(std.mem.indexOf(u8, r.json, "{\"index\":0,\"start\":0,\"end\":21}") != null);
}

test "chunks: emits overlapping word-boundary ranges" {
    var text: [1200]u8 = undefined;
    var i: usize = 0;
    while (i < text.len) : (i += 6) {
        @memcpy(text[i .. i + 6], "lorem ");
    }
    var out: [4096]u8 = undefined;
    const r = tRunChunks(&text, 200, 50, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(std.mem.indexOf(u8, r.json, "{\"index\":0,\"start\":0,\"end\":197}") != null);
    try std.testing.expect(std.mem.indexOf(u8, r.json, "{\"index\":1,\"start\":147,") != null);
}

// ── Planner test helpers ────────────────────────────────────────────────────
// Content of N 'a' bytes estimates to exactly ceil(N/4) tokens (one word run),
// so token counts below are trivially N/4 for N divisible by 4.

fn tWriteRecord(buf: []u8, off: *usize, role: u8, flags: u8, content: []const u8) void {
    buf[off.*] = role;
    buf[off.* + 1] = flags;
    std.mem.writeInt(u32, buf[off.* + 2 ..][0..4], @intCast(content.len), .little);
    @memcpy(buf[off.* + 6 ..][0..content.len], content);
    off.* += 6 + content.len;
}

fn tField(json: []const u8, key: []const u8) i64 {
    const idx = std.mem.indexOf(u8, json, key) orelse return -1;
    var i = idx + key.len;
    while (i < json.len and (json[i] == ':' or json[i] == '"' or json[i] == ' ' or json[i] == '[')) : (i += 1) {}
    var val: i64 = 0;
    var seen = false;
    while (i < json.len and json[i] >= '0' and json[i] <= '9') : (i += 1) {
        val = val * 10 + (json[i] - '0');
        seen = true;
    }
    return if (seen) val else -1;
}

fn tBool(json: []const u8, key: []const u8) bool {
    const idx = std.mem.indexOf(u8, json, key) orelse return false;
    var i = idx + key.len;
    while (i < json.len and (json[i] == ':' or json[i] == '"' or json[i] == ' ')) : (i += 1) {}
    return std.mem.startsWith(u8, json[i..], "true");
}

const TestPlan = struct {
    status: u32,
    json: []const u8,
};

fn tRunPlan(buf: []const u8, cfg: [6]u32, out: []u8) TestPlan {
    // Default the manual-force flag off; tRunPlanForce exercises it explicitly.
    return tRunPlanForce(buf, cfg ++ [_]u32{0}, out);
}

fn tRunPlanForce(buf: []const u8, cfg: [7]u32, out: []u8) TestPlan {
    var written: u32 = 0;
    var needed: u32 = 0;
    const status = sift_thread_plan_compaction(buf.ptr, @intCast(buf.len), &cfg, out.ptr, @intCast(out.len), &written, &needed);
    return .{ .status = status, .json = out[0..written] };
}

test "plan: under budget needs no compaction" {
    var buf: [256]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10 tokens
    var out: [512]u8 = undefined;
    // context 1000, reserved 100 -> usable 900
    const r = tRunPlan(buf[0..off], .{ 1000, 100, 2, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(!tBool(r.json, "\"needsCompaction\""));
    try std.testing.expectEqual(@as(i64, 10), tField(r.json, "\"estimatedTokens\""));
    try std.testing.expectEqual(@as(i64, 0), tField(r.json, "\"tailStartIndex\""));
}

test "plan: force compacts a within-budget thread (manual /compact)" {
    var buf: [16384]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10  turn0
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10  turn1
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10  turn2
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    var out: [512]u8 = undefined;
    // total 60 << usable 900: auto would no-op. force=1 still summarizes the
    // older turns, keeping the most recent tail_turns=1 verbatim.
    const r = tRunPlanForce(buf[0..off], .{ 1000, 100, 1, 1000, 40, 20, 1 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(tBool(r.json, "\"needsCompaction\""));
    // tail_turns=1 -> keep turn2 (user at index 4); summarize [0,4).
    try std.testing.expectEqual(@as(i64, 4), tField(r.json, "\"tailStartIndex\""));
    try std.testing.expect(std.mem.indexOf(u8, r.json, "\"summarizeRange\":[0,4]") != null);
}

test "plan: prune alone frees enough, no summarize" {
    var buf: [8192]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_TOOL, 0, "a" ** 4000); // 1000  <- old, prunable
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_TOOL, 0, "a" ** 40); // 10  <- recent, protected by window
    var out: [512]u8 = undefined;
    const r = tRunPlan(buf[0..off], .{ 1000, 100, 2, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(tBool(r.json, "\"needsCompaction\""));
    try std.testing.expectEqual(@as(i64, 1000), tField(r.json, "\"prunedTokens\""));
    try std.testing.expectEqual(@as(i64, 2), tField(r.json, "\"prune\"")); // first pruned index = 2
    try std.testing.expectEqual(@as(i64, 0), tField(r.json, "\"tailStartIndex\"")); // no summarize
}

test "plan: summarizes a whole-turn prefix when prune is insufficient" {
    var buf: [16384]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 2000); // 500  turn0
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 2000); // 500
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 2000); // 500  turn1
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 2000); // 500
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10   turn2
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    var out: [512]u8 = undefined;
    // usable 1400; no tool messages so prune frees nothing -> must summarize.
    const r = tRunPlan(buf[0..off], .{ 1500, 100, 1, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(tBool(r.json, "\"needsCompaction\""));
    try std.testing.expectEqual(@as(i64, 0), tField(r.json, "\"prunedTokens\""));
    // tail_turns=1 -> keep only turn2; tail begins at message index 4 (a user
    // msg). summarizeRange is [0, tailStartIndex), so tailStartIndex proves it.
    try std.testing.expectEqual(@as(i64, 4), tField(r.json, "\"tailStartIndex\""));
    try std.testing.expect(std.mem.indexOf(u8, r.json, "\"summarizeRange\":[0,4]") != null);
}

test "plan: tail bounded by preserve_recent_tokens keeps at least one turn" {
    var buf: [16384]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 2000); // 500 turn0
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 2000); // 500
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10  turn1
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    var out: [512]u8 = undefined;
    // tail_turns=5 but preserve_recent_tokens=15: turn1 (20 tok) is kept anyway
    // (always ≥1), turn0 (1000) would blow the budget -> summarized.
    const r = tRunPlan(buf[0..off], .{ 800, 100, 5, 15, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(tBool(r.json, "\"needsCompaction\""));
    try std.testing.expectEqual(@as(i64, 2), tField(r.json, "\"tailStartIndex\"")); // user msg at idx 2
}

test "plan: always summarizes at least one turn even if all turns are small" {
    var buf: [1024]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10 turn0
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10 turn1
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    var out: [512]u8 = undefined;
    // usable 30 < total 40, both turns would fit the tail budget -> force keep turn1, summarize turn0.
    const r = tRunPlan(buf[0..off], .{ 30, 0, 5, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expectEqual(@as(i64, 2), tField(r.json, "\"tailStartIndex\""));
}

test "plan: protected tool output is never pruned" {
    var buf: [8192]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_TOOL, FLAG_PROTECTED, "a" ** 4000); // 1000 protected
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_ASSISTANT, 0, "a" ** 40); // 10
    tWriteRecord(&buf, &off, ROLE_TOOL, 0, "a" ** 40); // 10
    var out: [512]u8 = undefined;
    const r = tRunPlan(buf[0..off], .{ 1000, 100, 1, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expectEqual(@as(i64, 0), tField(r.json, "\"prunedTokens\"")); // protected -> not pruned
    // Falls through to summarize; tail begins at the second user message (idx 3).
    try std.testing.expectEqual(@as(i64, 3), tField(r.json, "\"tailStartIndex\""));
}

test "plan: malformed buffer is rejected" {
    var bad: [3]u8 = .{ ROLE_USER, 0, 9 }; // truncated header
    var out: [128]u8 = undefined;
    const r = tRunPlan(bad[0..], .{ 1000, 100, 2, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_INVALID_ARGS, r.status);
}

test "plan: empty history is valid and needs nothing" {
    var out: [256]u8 = undefined;
    const r = tRunPlan(&.{}, .{ 1000, 100, 2, 1000, 40, 20 }, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expect(!tBool(r.json, "\"needsCompaction\""));
    try std.testing.expectEqual(@as(i64, 0), tField(r.json, "\"estimatedTokens\""));
}

test "plan: output-too-small negotiates needed size" {
    var buf: [256]u8 = undefined;
    var off: usize = 0;
    tWriteRecord(&buf, &off, ROLE_USER, 0, "a" ** 40);
    var tiny: [8]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    const cfg = [6]u32{ 1000, 100, 2, 1000, 40, 20 };
    const status = sift_thread_plan_compaction(buf[0..off].ptr, @intCast(off), &cfg, &tiny, tiny.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OUTPUT_TOO_SMALL, status);
    try std.testing.expect(needed > tiny.len);
}

// ── Rollout tests ───────────────────────────────────────────────────────────

fn tAppend(path: []const u8, line: []const u8) u32 {
    return sift_thread_rollout_append(path.ptr, @intCast(path.len), line.ptr, @intCast(line.len));
}

fn tLoad(path: []const u8, max_turns: u32, out: []u8) TestPlan {
    var written: u32 = 0;
    var needed: u32 = 0;
    const status = sift_thread_rollout_load(path.ptr, @intCast(path.len), max_turns, out.ptr, @intCast(out.len), &written, &needed);
    return .{ .status = status, .json = out[0..written] };
}

test "rollout: append then load round-trips all lines" {
    const dir = ".zig-cache/thread-rollout-test";
    const path = dir ++ "/roundtrip.jsonl";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    try std.testing.expectEqual(STATUS_OK, tAppend(path, "{\"r\":0,\"t\":\"hi\"}"));
    try std.testing.expectEqual(STATUS_OK, tAppend(path, "{\"r\":1,\"t\":\"yo\"}"));

    var out: [256]u8 = undefined;
    const r = tLoad(path, 0, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expectEqualStrings("{\"r\":0,\"t\":\"hi\"}\n{\"r\":1,\"t\":\"yo\"}\n", r.json);
}

test "rollout: load truncates to the last N whole turns" {
    const dir = ".zig-cache/thread-rollout-test";
    const path = dir ++ "/truncate.jsonl";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    _ = tAppend(path, "{\"r\":0,\"t\":\"q0\"}"); // turn 0
    _ = tAppend(path, "{\"r\":1,\"t\":\"a0\"}");
    _ = tAppend(path, "{\"r\":0,\"t\":\"q1\"}"); // turn 1
    _ = tAppend(path, "{\"r\":1,\"t\":\"a1\"}");

    var out: [256]u8 = undefined;
    const r = tLoad(path, 1, &out); // keep only the last turn
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expectEqualStrings("{\"r\":0,\"t\":\"q1\"}\n{\"r\":1,\"t\":\"a1\"}\n", r.json);
}

test "rollout: max_turns larger than history keeps everything" {
    const dir = ".zig-cache/thread-rollout-test";
    const path = dir ++ "/keepall.jsonl";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};

    _ = tAppend(path, "{\"r\":0,\"t\":\"only\"}");
    _ = tAppend(path, "{\"r\":1,\"t\":\"ans\"}");

    var out: [256]u8 = undefined;
    const r = tLoad(path, 10, &out);
    try std.testing.expectEqual(STATUS_OK, r.status);
    try std.testing.expectEqualStrings("{\"r\":0,\"t\":\"only\"}\n{\"r\":1,\"t\":\"ans\"}\n", r.json);
}

test "rollout: loading a missing file reports not-found" {
    var out: [64]u8 = undefined;
    const r = tLoad(".zig-cache/thread-rollout-test/does-not-exist.jsonl", 0, &out);
    try std.testing.expectEqual(STATUS_NOT_FOUND, r.status);
    try std.testing.expectEqual(@as(usize, 0), r.json.len);
}

test "rollout: load negotiates output-too-small" {
    const dir = ".zig-cache/thread-rollout-test";
    const path = dir ++ "/toosmall.jsonl";
    Dir.cwd().deleteTree(io(), dir) catch {};
    defer Dir.cwd().deleteTree(io(), dir) catch {};
    _ = tAppend(path, "{\"r\":0,\"t\":\"a long enough line to overflow\"}");

    var tiny: [8]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    const status = sift_thread_rollout_load(path.ptr, @intCast(path.len), 0, &tiny, tiny.len, &written, &needed);
    try std.testing.expectEqual(STATUS_OUTPUT_TOO_SMALL, status);
    try std.testing.expect(needed > tiny.len);
}
