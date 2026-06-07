const std = @import("std");

// mergeMaster registry kernel.
//
// Owns the in-process state for Git-native parent/child sessions: who exists,
// each session's distinct directory/ref bookkeeping, the status lifecycle, and
// the parent's merge-view projection. This is the concurrency-relevant hot path
// — the parent and every child agent read and mutate this registry — so it
// lives in Zig as a fixed, allocation-free table mirroring native/collab_engine.zig.
//
// Scope discipline: this kernel holds STATE and computes DERIVED VIEWS only. It
// never shells out to git, touches the filesystem, or spawns worktrees — those
// side effects belong to later lanes (B: worktree lifecycle, D: merge gate,
// E: parent merge action). String derivation of branch/worktree paths stays in
// the TS host (pure, called once per child, not a hot path).
//
// Concurrency note: like collab_engine, the table is single-writer — the Bun
// JS event loop calls these exports synchronously, so calls are serialized and
// no locks are needed. If true OS-thread callers are ever added, the globals
// would need atomics/a mutex; that is deliberately out of scope here.

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_NOT_FOUND: u32 = 2;
const STATUS_NO_CAPACITY: u32 = 3;
const STATUS_CONFLICT: u32 = 4;
const STATUS_ILLEGAL_TRANSITION: u32 = 5;
const STATUS_OUTPUT_TOO_SMALL: u32 = 6;

const MAX_SESSIONS = 64;
const MAX_PATH_BYTES = 512;
const MAX_TEXT_BYTES = 256;

// Order matches the MergeMasterStatus union in mergeMaster.ts. @tagName renders
// the exact wire strings ("needs_input", "ready_to_merge", ...).
const Status = enum(u32) {
    running = 0,
    needs_input = 1,
    ready_to_merge = 2,
    merge_blocked = 3,
    merged = 4,
    rejected = 5,
    abandoned = 6,
};

const Role = enum(u32) {
    parent = 0,
    child = 1,
};

const AccessMode = enum(u32) {
    read_only = 0,
    read_write = 1,
};

const MergeStrategy = enum(u32) {
    squash_merge = 0,
    merge_commit = 1,
    rebase_merge = 2,
};

fn statusFromU32(v: u32) ?Status {
    return switch (v) {
        0 => .running,
        1 => .needs_input,
        2 => .ready_to_merge,
        3 => .merge_blocked,
        4 => .merged,
        5 => .rejected,
        6 => .abandoned,
        else => null,
    };
}

fn mergeStrategyFromU32(v: u32) MergeStrategy {
    return switch (v) {
        1 => .merge_commit,
        2 => .rebase_merge,
        else => .squash_merge,
    };
}

fn isTerminal(status: Status) bool {
    return switch (status) {
        .merged, .rejected, .abandoned => true,
        else => false,
    };
}

// The single source of truth for the lifecycle. Kept in lockstep with
// STATUS_TRANSITIONS in mergeMaster.ts.
fn allowedTransition(from: Status, to: Status) bool {
    return switch (from) {
        .running => switch (to) {
            .needs_input, .ready_to_merge, .merge_blocked, .abandoned => true,
            else => false,
        },
        .needs_input => switch (to) {
            .running, .abandoned => true,
            else => false,
        },
        .ready_to_merge => switch (to) {
            .merged, .rejected, .merge_blocked, .running, .abandoned => true,
            else => false,
        },
        .merge_blocked => switch (to) {
            .running, .ready_to_merge, .rejected, .abandoned => true,
            else => false,
        },
        .merged, .rejected, .abandoned => false,
    };
}

fn Text(comptime cap: usize) type {
    return struct {
        bytes: [cap]u8 = [_]u8{0} ** cap,
        len: usize = 0,

        const Self = @This();

        fn set(self: *Self, value: []const u8) void {
            self.len = @min(value.len, self.bytes.len);
            @memcpy(self.bytes[0..self.len], value[0..self.len]);
        }

        fn slice(self: *const Self) []const u8 {
            return self.bytes[0..self.len];
        }

        fn eql(self: *const Self, other: *const Self) bool {
            return std.mem.eql(u8, self.slice(), other.slice());
        }
    };
}

const PathText = Text(MAX_PATH_BYTES);
const SmallText = Text(MAX_TEXT_BYTES);

const Session = struct {
    id: u32 = 0,
    active: bool = false,
    role: Role = .parent,
    access_mode: AccessMode = .read_only,
    status: Status = .running,
    parent_id: u32 = 0,

    launch_dir: PathText = .{},
    session_cwd: PathText = .{},
    repo_root: PathText = .{},
    worktree_path: PathText = .{},
    branch: SmallText = .{},
    base_branch: SmallText = .{},
    base_commit: SmallText = .{},
    head_commit: SmallText = .{},
    conversation_key: PathText = .{},

    created_at_ms: u64 = 0,
    updated_at_ms: u64 = 0,
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
        var scratch: [256]u8 = undefined;
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

    fn appendField(self: *Writer, comptime key: []const u8, value: []const u8) void {
        self.append("\"" ++ key ++ "\":");
        self.appendJsonString(value);
    }
};

var sessions: [MAX_SESSIONS]Session = [_]Session{.{}} ** MAX_SESSIONS;
var next_session_id: u32 = 1;

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

fn findSession(session_id: u32) ?*Session {
    if (session_id == 0) return null;
    for (&sessions) |*session| {
        if (session.active and session.id == session_id) return session;
    }
    return null;
}

fn allocSession() ?*Session {
    for (&sessions) |*session| {
        if (!session.active) return session;
    }
    return null;
}

// Derive the durable conversation key when the caller did not supply one. Kept
// byte-for-byte in lockstep with conversationKeyForSession() in mergeMaster.ts:
//   parent: "<repoRoot> parent"
//   child:  "<repoRoot> child <branch> <sessionId>"
// The child seed is the assigned session id (the TS fallback uses String(id)).
fn ensureConversationKey(session: *Session) void {
    if (session.conversation_key.len != 0) return;
    var buf: [MAX_PATH_BYTES]u8 = undefined;
    const text = switch (session.role) {
        .parent => std.fmt.bufPrint(&buf, "{s} parent", .{session.repo_root.slice()}),
        .child => std.fmt.bufPrint(&buf, "{s} child {s} {d}", .{
            session.repo_root.slice(),
            session.branch.slice(),
            session.id,
        }),
    } catch return; // key too long for the buffer — leave empty rather than truncate mid-field
    session.conversation_key.set(text);
}

pub export fn sift_mm_reset() void {
    sessions = [_]Session{.{}} ** MAX_SESSIONS;
    next_session_id = 1;
}

pub export fn sift_mm_create_parent(
    repo_root_ptr: [*]const u8,
    repo_root_len: u32,
    launch_dir_ptr: [*]const u8,
    launch_dir_len: u32,
    session_cwd_ptr: [*]const u8,
    session_cwd_len: u32,
    branch_ptr: [*]const u8,
    branch_len: u32,
    head_commit_ptr: [*]const u8,
    head_commit_len: u32,
    conversation_key_ptr: [*]const u8,
    conversation_key_len: u32,
    now_ms: u64,
) u32 {
    const session = allocSession() orelse return 0;
    session.* = .{
        .id = next_session_id,
        .active = true,
        .role = .parent,
        // The parent owns the primary working tree; it is the write authority.
        .access_mode = .read_write,
        .status = .running,
        .parent_id = 0,
        .created_at_ms = now_ms,
        .updated_at_ms = now_ms,
    };
    next_session_id += 1;
    session.repo_root.set(inputSlice(repo_root_ptr, repo_root_len));
    session.launch_dir.set(inputSlice(launch_dir_ptr, launch_dir_len));
    session.session_cwd.set(inputSlice(session_cwd_ptr, session_cwd_len));
    session.worktree_path.set(inputSlice(repo_root_ptr, repo_root_len));
    session.branch.set(inputSlice(branch_ptr, branch_len));
    session.head_commit.set(inputSlice(head_commit_ptr, head_commit_len));
    session.conversation_key.set(inputSlice(conversation_key_ptr, conversation_key_len));
    ensureConversationKey(session);
    return session.id;
}

pub export fn sift_mm_create_child(
    parent_id: u32,
    access_mode_raw: u32,
    branch_ptr: [*]const u8,
    branch_len: u32,
    worktree_path_ptr: [*]const u8,
    worktree_path_len: u32,
    session_cwd_ptr: [*]const u8,
    session_cwd_len: u32,
    base_branch_ptr: [*]const u8,
    base_branch_len: u32,
    base_commit_ptr: [*]const u8,
    base_commit_len: u32,
    head_commit_ptr: [*]const u8,
    head_commit_len: u32,
    conversation_key_ptr: [*]const u8,
    conversation_key_len: u32,
    now_ms: u64,
) u32 {
    const parent = findSession(parent_id) orelse return 0;
    if (parent.role != .parent) return 0;
    if (access_mode_raw > 1) return 0;
    const access_mode: AccessMode = if (access_mode_raw == 1) .read_write else .read_only;

    const worktree = inputSlice(worktree_path_ptr, worktree_path_len);
    // Distinctness invariant: a write-capable child must not share the parent's
    // working tree; a read-only child may (and should) reuse it.
    if (access_mode == .read_write and std.mem.eql(u8, worktree, parent.worktree_path.slice())) {
        return 0;
    }
    // A child must declare where it forked from.
    if (base_branch_len == 0 or base_commit_len == 0) return 0;

    const session = allocSession() orelse return 0;
    session.* = .{
        .id = next_session_id,
        .active = true,
        .role = .child,
        .access_mode = access_mode,
        .status = .running,
        .parent_id = parent_id,
        .created_at_ms = now_ms,
        .updated_at_ms = now_ms,
    };
    next_session_id += 1;
    // repo_root and launch_dir are inherited from the parent — children never
    // invent their own.
    session.repo_root.set(parent.repo_root.slice());
    session.launch_dir.set(parent.launch_dir.slice());
    session.worktree_path.set(worktree);
    session.session_cwd.set(inputSlice(session_cwd_ptr, session_cwd_len));
    session.branch.set(inputSlice(branch_ptr, branch_len));
    session.base_branch.set(inputSlice(base_branch_ptr, base_branch_len));
    session.base_commit.set(inputSlice(base_commit_ptr, base_commit_len));
    session.head_commit.set(inputSlice(head_commit_ptr, head_commit_len));
    session.conversation_key.set(inputSlice(conversation_key_ptr, conversation_key_len));
    ensureConversationKey(session);
    return session.id;
}

/// Advance a session's head commit (e.g. after the child commits work).
pub export fn sift_mm_set_head_commit(
    session_id: u32,
    head_commit_ptr: [*]const u8,
    head_commit_len: u32,
    now_ms: u64,
) u32 {
    const session = findSession(session_id) orelse return STATUS_NOT_FOUND;
    session.head_commit.set(inputSlice(head_commit_ptr, head_commit_len));
    session.updated_at_ms = now_ms;
    return STATUS_OK;
}

pub export fn sift_mm_set_status(session_id: u32, new_status_raw: u32, now_ms: u64) u32 {
    const session = findSession(session_id) orelse return STATUS_NOT_FOUND;
    if (session.role != .child) return STATUS_CONFLICT; // only children carry lifecycle
    const new_status = statusFromU32(new_status_raw) orelse return STATUS_INVALID_ARGS;
    if (session.status == new_status) return STATUS_OK; // idempotent
    if (isTerminal(session.status)) return STATUS_ILLEGAL_TRANSITION;
    if (!allowedTransition(session.status, new_status)) return STATUS_ILLEGAL_TRANSITION;
    session.status = new_status;
    session.updated_at_ms = now_ms;
    return STATUS_OK;
}

fn writeSessionObject(w: *Writer, session: *const Session) void {
    w.append("{\"sessionId\":");
    w.appendFmt("{}", .{session.id});
    w.append(",\"role\":");
    w.appendJsonString(@tagName(session.role));
    w.append(",\"accessMode\":");
    w.appendJsonString(@tagName(session.access_mode));
    w.append(",\"status\":");
    w.appendJsonString(@tagName(session.status));
    w.append(",\"parentSessionId\":");
    if (session.parent_id == 0) w.append("null") else w.appendFmt("{}", .{session.parent_id});
    w.append(",");
    w.appendField("launchDir", session.launch_dir.slice());
    w.append(",");
    w.appendField("sessionCwd", session.session_cwd.slice());
    // Git state is nested under "git" to match MergeMasterGitState in mergeMaster.ts.
    w.append(",\"git\":{");
    w.appendField("repoRoot", session.repo_root.slice());
    w.append(",");
    w.appendField("worktreePath", session.worktree_path.slice());
    w.append(",");
    w.appendField("branch", session.branch.slice());
    w.append(",");
    w.appendField("headCommit", session.head_commit.slice());
    w.append("}");
    w.append(",\"baseBranch\":");
    if (session.base_branch.len == 0) w.append("null") else w.appendJsonString(session.base_branch.slice());
    w.append(",\"baseCommit\":");
    if (session.base_commit.len == 0) w.append("null") else w.appendJsonString(session.base_commit.slice());
    w.append(",");
    w.appendField("conversationKey", session.conversation_key.slice());
    w.append(",\"createdAtMs\":");
    w.appendFmt("{}", .{session.created_at_ms});
    w.append(",\"updatedAtMs\":");
    w.appendFmt("{}", .{session.updated_at_ms});
    w.append("}");
}

pub export fn sift_mm_snapshot_session(
    session_id: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const session = findSession(session_id) orelse return STATUS_NOT_FOUND;
    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    writeSessionObject(&w, session);
    return finish(&w, written_out, needed_out);
}

/// The parent's-eye merge view: pulls parent and child facts into separately
/// named fields so nothing is collapsed. Validates the relationship first.
pub export fn sift_mm_snapshot_merge_view(
    child_id: u32,
    merge_strategy_raw: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const child = findSession(child_id) orelse return STATUS_NOT_FOUND;
    if (child.role != .child) return STATUS_CONFLICT;
    const parent = findSession(child.parent_id) orelse return STATUS_NOT_FOUND;
    if (parent.role != .parent) return STATUS_CONFLICT;
    if (child.base_branch.len == 0 or child.base_commit.len == 0) return STATUS_CONFLICT;

    const strategy = mergeStrategyFromU32(merge_strategy_raw);
    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    w.append("{\"parentSessionId\":");
    w.appendFmt("{}", .{parent.id});
    w.append(",\"childSessionId\":");
    w.appendFmt("{}", .{child.id});
    w.append(",");
    w.appendField("repoRoot", parent.repo_root.slice());
    w.append(",");
    w.appendField("parentWorktreePath", parent.worktree_path.slice());
    w.append(",");
    w.appendField("childWorktreePath", child.worktree_path.slice());
    w.append(",");
    w.appendField("baseBranch", child.base_branch.slice());
    w.append(",");
    w.appendField("childBranch", child.branch.slice());
    w.append(",");
    w.appendField("baseCommit", child.base_commit.slice());
    w.append(",");
    w.appendField("headCommit", child.head_commit.slice());
    w.append(",\"status\":");
    w.appendJsonString(@tagName(child.status));
    w.append(",\"mergeStrategy\":");
    w.appendJsonString(@tagName(strategy));
    w.append("}");
    return finish(&w, written_out, needed_out);
}

pub export fn sift_mm_list_sessions(
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    w.appendByte('[');
    var first = true;
    for (&sessions) |*session| {
        if (!session.active) continue;
        if (!first) w.appendByte(',');
        first = false;
        writeSessionObject(&w, session);
    }
    w.appendByte(']');
    return finish(&w, written_out, needed_out);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

fn createParentForTest() u32 {
    const repo = "/Users/dev/projects/widgets";
    const launch = "/Users/dev";
    const branch = "main";
    const head = "a" ** 40;
    const key = "/Users/dev/projects/widgets parent";
    return sift_mm_create_parent(
        repo.ptr,
        repo.len,
        launch.ptr,
        launch.len,
        repo.ptr,
        repo.len,
        branch.ptr,
        branch.len,
        head.ptr,
        head.len,
        key.ptr,
        key.len,
        100,
    );
}

fn createWriteChildForTest(parent_id: u32) u32 {
    const worktree = "/Users/dev/.siftable/worktrees/widgets-abc/feature";
    const cwd = worktree;
    const branch = "sift/feature-abc123";
    const base_branch = "main";
    const base_commit = "a" ** 40;
    const head = "b" ** 40;
    const key = "child-key";
    return sift_mm_create_child(
        parent_id,
        1, // read_write
        branch.ptr,
        branch.len,
        worktree.ptr,
        worktree.len,
        cwd.ptr,
        cwd.len,
        base_branch.ptr,
        base_branch.len,
        base_commit.ptr,
        base_commit.len,
        head.ptr,
        head.len,
        key.ptr,
        key.len,
        200,
    );
}

test "parent and write child get distinct worktrees" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    try testing.expect(parent_id > 0);
    const child_id = createWriteChildForTest(parent_id);
    try testing.expect(child_id > 0);
    try testing.expect(child_id != parent_id);

    var out: [2048]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    try testing.expectEqual(STATUS_OK, sift_mm_snapshot_merge_view(child_id, 0, &out, out.len, &written, &needed));
    const json = out[0..written];
    try testing.expect(std.mem.indexOf(u8, json, "\"repoRoot\":\"/Users/dev/projects/widgets\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"parentWorktreePath\":\"/Users/dev/projects/widgets\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"childWorktreePath\":\"/Users/dev/.siftable/worktrees/widgets-abc/feature\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"baseBranch\":\"main\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"childBranch\":\"sift/feature-abc123\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"mergeStrategy\":\"squash_merge\"") != null);
}

test "read-only child may share the parent worktree, write child may not" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    const repo = "/Users/dev/projects/widgets";
    const base_branch = "main";
    const base_commit = "a" ** 40;
    const head = "a" ** 40;
    const key = "ro-child";
    // read_only sharing the parent worktree is allowed.
    const ro_child = sift_mm_create_child(
        parent_id,
        0,
        base_branch.ptr,
        base_branch.len,
        repo.ptr,
        repo.len, // worktree == parent worktree
        repo.ptr,
        repo.len,
        base_branch.ptr,
        base_branch.len,
        base_commit.ptr,
        base_commit.len,
        head.ptr,
        head.len,
        key.ptr,
        key.len,
        200,
    );
    try testing.expect(ro_child > 0);

    // read_write sharing the parent worktree is rejected (returns 0).
    const rw_child = sift_mm_create_child(
        parent_id,
        1,
        base_branch.ptr,
        base_branch.len,
        repo.ptr,
        repo.len, // worktree == parent worktree — illegal for read_write
        repo.ptr,
        repo.len,
        base_branch.ptr,
        base_branch.len,
        base_commit.ptr,
        base_commit.len,
        head.ptr,
        head.len,
        key.ptr,
        key.len,
        200,
    );
    try testing.expectEqual(@as(u32, 0), rw_child);
}

test "status transitions honor the lifecycle and terminal states" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    const child_id = createWriteChildForTest(parent_id);

    // running -> ready_to_merge -> merged is legal.
    try testing.expectEqual(STATUS_OK, sift_mm_set_status(child_id, @intFromEnum(Status.ready_to_merge), 300));
    try testing.expectEqual(STATUS_OK, sift_mm_set_status(child_id, @intFromEnum(Status.merged), 400));
    // merged is terminal — no further moves.
    try testing.expectEqual(STATUS_ILLEGAL_TRANSITION, sift_mm_set_status(child_id, @intFromEnum(Status.running), 500));

    // running -> merged directly is illegal (must pass the gate).
    const child2 = createWriteChildForTest(parent_id);
    try testing.expectEqual(STATUS_ILLEGAL_TRANSITION, sift_mm_set_status(child2, @intFromEnum(Status.merged), 600));
    // merge_blocked is recoverable back to running.
    try testing.expectEqual(STATUS_OK, sift_mm_set_status(child2, @intFromEnum(Status.merge_blocked), 700));
    try testing.expectEqual(STATUS_OK, sift_mm_set_status(child2, @intFromEnum(Status.running), 800));
}

test "parent carries no lifecycle and unknown sessions are not found" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    try testing.expectEqual(STATUS_CONFLICT, sift_mm_set_status(parent_id, @intFromEnum(Status.merged), 300));
    try testing.expectEqual(STATUS_NOT_FOUND, sift_mm_set_status(9999, @intFromEnum(Status.running), 300));
}

test "list sessions reports parent and children" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    _ = createWriteChildForTest(parent_id);
    var out: [4096]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    try testing.expectEqual(STATUS_OK, sift_mm_list_sessions(&out, out.len, &written, &needed));
    const json = out[0..written];
    try testing.expect(std.mem.indexOf(u8, json, "\"role\":\"parent\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"role\":\"child\"") != null);
}

test "output too small reports needed bytes without overflowing" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    const child_id = createWriteChildForTest(parent_id);
    var tiny: [8]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    try testing.expectEqual(STATUS_OUTPUT_TOO_SMALL, sift_mm_snapshot_merge_view(child_id, 0, &tiny, tiny.len, &written, &needed));
    try testing.expect(needed > written);
}

test "session snapshot nests git state under \"git\"" {
    sift_mm_reset();
    const parent_id = createParentForTest();
    const child_id = createWriteChildForTest(parent_id);
    var out: [2048]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    try testing.expectEqual(STATUS_OK, sift_mm_snapshot_session(child_id, &out, out.len, &written, &needed));
    const json = out[0..written];
    // Git fields live inside a nested object, matching MergeMasterGitState in mergeMaster.ts.
    try testing.expect(std.mem.indexOf(u8, json, "\"git\":{\"repoRoot\":\"/Users/dev/projects/widgets\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"worktreePath\":\"/Users/dev/.siftable/worktrees/widgets-abc/feature\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"branch\":\"sift/feature-abc123\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"headCommit\":\"" ++ ("b" ** 40) ++ "\"}") != null);
}

test "empty conversation key is derived to match conversationKeyForSession" {
    sift_mm_reset();
    const parent_id = createParentForTest(); // id 1
    const repo = "/Users/dev/projects/widgets";
    const worktree = "/Users/dev/.siftable/worktrees/widgets-abc/feature";
    const branch = "sift/feature-abc123";
    const base_branch = "main";
    const base_commit = "a" ** 40;
    const head = "b" ** 40;
    const empty = "";
    const child_id = sift_mm_create_child(
        parent_id,
        1,
        branch.ptr,
        branch.len,
        worktree.ptr,
        worktree.len,
        worktree.ptr,
        worktree.len,
        base_branch.ptr,
        base_branch.len,
        base_commit.ptr,
        base_commit.len,
        head.ptr,
        head.len,
        empty.ptr,
        empty.len, // no conversation key supplied
        200,
    );
    try testing.expect(child_id > 0);
    var out: [2048]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    try testing.expectEqual(STATUS_OK, sift_mm_snapshot_session(child_id, &out, out.len, &written, &needed));
    const json = out[0..written];
    var expected_buf: [256]u8 = undefined;
    const expected = try std.fmt.bufPrint(&expected_buf, "\"conversationKey\":\"{s} child {s} {d}\"", .{ repo, branch, child_id });
    try testing.expect(std.mem.indexOf(u8, json, expected) != null);
}
