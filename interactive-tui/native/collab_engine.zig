const std = @import("std");

const STATUS_OK: u32 = 0;
const STATUS_INVALID_ARGS: u32 = 1;
const STATUS_NOT_FOUND: u32 = 2;
const STATUS_NO_CAPACITY: u32 = 3;
const STATUS_CONFLICT: u32 = 4;
const STATUS_STALE_LEASE: u32 = 5;
const STATUS_OUTPUT_TOO_SMALL: u32 = 6;

const MAX_SESSIONS = 16;
const MAX_BRANCHES = 256;
const MAX_EVENTS = 1024;
const MAX_PATH_BYTES = 320;
const MAX_TEXT_BYTES = 512;
const MAX_PAYLOAD_BYTES = 2048;

const BranchStatus = enum(u32) {
    pending = 0,
    running = 1,
    completed = 2,
    failed = 3,
    cancelled = 4,
};

pub const ClaimOut = extern struct {
    branch_id: u32,
    lease_token: u32,
    lease_expires_ms: u64,
};

const SmallText = struct {
    bytes: [MAX_TEXT_BYTES]u8 = [_]u8{0} ** MAX_TEXT_BYTES,
    len: usize = 0,

    fn set(self: *SmallText, value: []const u8) void {
        self.len = @min(value.len, self.bytes.len);
        @memcpy(self.bytes[0..self.len], value[0..self.len]);
    }

    fn slice(self: *const SmallText) []const u8 {
        return self.bytes[0..self.len];
    }
};

const PathText = struct {
    bytes: [MAX_PATH_BYTES]u8 = [_]u8{0} ** MAX_PATH_BYTES,
    len: usize = 0,

    fn set(self: *PathText, value: []const u8) void {
        self.len = @min(value.len, self.bytes.len);
        @memcpy(self.bytes[0..self.len], value[0..self.len]);
    }

    fn slice(self: *const PathText) []const u8 {
        return self.bytes[0..self.len];
    }
};

const PayloadText = struct {
    bytes: [MAX_PAYLOAD_BYTES]u8 = [_]u8{0} ** MAX_PAYLOAD_BYTES,
    len: usize = 0,

    fn set(self: *PayloadText, value: []const u8) void {
        self.len = @min(value.len, self.bytes.len);
        @memcpy(self.bytes[0..self.len], value[0..self.len]);
    }

    fn slice(self: *const PayloadText) []const u8 {
        return self.bytes[0..self.len];
    }
};

const Session = struct {
    id: u32 = 0,
    active: bool = false,
    cancelled: bool = false,
    root: PathText = .{},
    cwd: PathText = .{},
    max_branches: u32 = 0,
    branch_count: u32 = 0,
};

const Branch = struct {
    id: u32 = 0,
    session_id: u32 = 0,
    active: bool = false,
    status: BranchStatus = .pending,
    role: SmallText = .{},
    focus: SmallText = .{},
    worker: SmallText = .{},
    output: PayloadText = .{},
    failure: SmallText = .{},
    max_tool_calls: u32 = 0,
    max_elapsed_ms: u32 = 0,
    lease_token: u32 = 0,
    lease_expires_ms: u64 = 0,
    event_count: u32 = 0,
};

const Event = struct {
    id: u32 = 0,
    branch_id: u32 = 0,
    active: bool = false,
    at_ms: u64 = 0,
    kind: SmallText = .{},
    payload: PayloadText = .{},
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
};

var sessions: [MAX_SESSIONS]Session = [_]Session{.{}} ** MAX_SESSIONS;
var branches: [MAX_BRANCHES]Branch = [_]Branch{.{}} ** MAX_BRANCHES;
var events: [MAX_EVENTS]Event = [_]Event{.{}} ** MAX_EVENTS;
var next_session_id: u32 = 1;
var next_branch_id: u32 = 1;
var next_event_id: u32 = 1;
var next_lease_token: u32 = 1000;

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

fn findBranch(branch_id: u32) ?*Branch {
    if (branch_id == 0) return null;
    for (&branches) |*branch| {
        if (branch.active and branch.id == branch_id) return branch;
    }
    return null;
}

fn allocSession() ?*Session {
    for (&sessions) |*session| {
        if (!session.active) return session;
    }
    return null;
}

fn allocBranch() ?*Branch {
    for (&branches) |*branch| {
        if (!branch.active) return branch;
    }
    return null;
}

fn allocEvent() ?*Event {
    for (&events) |*event| {
        if (!event.active) return event;
    }
    return null;
}

fn leaseValid(branch: *const Branch, lease_token: u32, now_ms: u64) bool {
    return branch.lease_token != 0 and
        branch.lease_token == lease_token and
        branch.lease_expires_ms >= now_ms;
}

fn issueLease(branch: *Branch, worker: []const u8, now_ms: u64, lease_ms: u32, out: *ClaimOut) void {
    next_lease_token += 1;
    branch.worker.set(worker);
    branch.lease_token = next_lease_token;
    branch.lease_expires_ms = now_ms + @as(u64, lease_ms);
    branch.status = .running;
    out.* = .{
        .branch_id = branch.id,
        .lease_token = branch.lease_token,
        .lease_expires_ms = branch.lease_expires_ms,
    };
}

pub export fn sift_collab_reset() void {
    sessions = [_]Session{.{}} ** MAX_SESSIONS;
    branches = [_]Branch{.{}} ** MAX_BRANCHES;
    events = [_]Event{.{}} ** MAX_EVENTS;
    next_session_id = 1;
    next_branch_id = 1;
    next_event_id = 1;
    next_lease_token = 1000;
}

pub export fn sift_collab_create_session(
    root_ptr: [*]const u8,
    root_len: u32,
    cwd_ptr: [*]const u8,
    cwd_len: u32,
    max_branches: u32,
) u32 {
    if (max_branches == 0) return 0;
    const session = allocSession() orelse return 0;
    session.* = .{
        .id = next_session_id,
        .active = true,
        .cancelled = false,
        .max_branches = @min(max_branches, MAX_BRANCHES),
    };
    next_session_id += 1;
    session.root.set(inputSlice(root_ptr, root_len));
    session.cwd.set(inputSlice(cwd_ptr, cwd_len));
    return session.id;
}

pub export fn sift_collab_enqueue_branch(
    session_id: u32,
    role_ptr: [*]const u8,
    role_len: u32,
    focus_ptr: [*]const u8,
    focus_len: u32,
    max_tool_calls: u32,
    max_elapsed_ms: u32,
) u32 {
    const session = findSession(session_id) orelse return 0;
    if (session.cancelled or session.branch_count >= session.max_branches) return 0;
    const branch = allocBranch() orelse return 0;
    branch.* = .{
        .id = next_branch_id,
        .session_id = session_id,
        .active = true,
        .status = .pending,
        .max_tool_calls = max_tool_calls,
        .max_elapsed_ms = max_elapsed_ms,
    };
    next_branch_id += 1;
    branch.role.set(inputSlice(role_ptr, role_len));
    branch.focus.set(inputSlice(focus_ptr, focus_len));
    session.branch_count += 1;
    return branch.id;
}

pub export fn sift_collab_claim_next_branch(
    session_id: u32,
    worker_ptr: [*]const u8,
    worker_len: u32,
    now_ms: u64,
    lease_ms: u32,
    out: *ClaimOut,
) u32 {
    const session = findSession(session_id) orelse return STATUS_NOT_FOUND;
    if (session.cancelled or lease_ms == 0) return STATUS_INVALID_ARGS;
    const worker = inputSlice(worker_ptr, worker_len);
    for (&branches) |*branch| {
        if (!branch.active or branch.session_id != session_id) continue;
        if (branch.status == .pending or
            (branch.status == .running and branch.lease_expires_ms < now_ms))
        {
            issueLease(branch, worker, now_ms, lease_ms, out);
            return STATUS_OK;
        }
    }
    return STATUS_NOT_FOUND;
}

pub export fn sift_collab_heartbeat(
    branch_id: u32,
    lease_token: u32,
    now_ms: u64,
    lease_ms: u32,
    lease_expires_out: *u64,
) u32 {
    const branch = findBranch(branch_id) orelse return STATUS_NOT_FOUND;
    if (branch.status != .running or lease_ms == 0) return STATUS_CONFLICT;
    if (!leaseValid(branch, lease_token, now_ms)) return STATUS_STALE_LEASE;
    branch.lease_expires_ms = now_ms + @as(u64, lease_ms);
    lease_expires_out.* = branch.lease_expires_ms;
    return STATUS_OK;
}

pub export fn sift_collab_append_event(
    branch_id: u32,
    lease_token: u32,
    kind_ptr: [*]const u8,
    kind_len: u32,
    payload_ptr: [*]const u8,
    payload_len: u32,
    now_ms: u64,
) u32 {
    const branch = findBranch(branch_id) orelse return STATUS_NOT_FOUND;
    if (branch.status != .running) return STATUS_CONFLICT;
    if (!leaseValid(branch, lease_token, now_ms)) return STATUS_STALE_LEASE;
    const event = allocEvent() orelse return STATUS_NO_CAPACITY;
    event.* = .{
        .id = next_event_id,
        .branch_id = branch_id,
        .active = true,
        .at_ms = now_ms,
    };
    next_event_id += 1;
    event.kind.set(inputSlice(kind_ptr, kind_len));
    event.payload.set(inputSlice(payload_ptr, payload_len));
    branch.event_count += 1;
    return STATUS_OK;
}

pub export fn sift_collab_complete_branch(
    branch_id: u32,
    lease_token: u32,
    output_ptr: [*]const u8,
    output_len: u32,
    now_ms: u64,
) u32 {
    const branch = findBranch(branch_id) orelse return STATUS_NOT_FOUND;
    if (branch.status != .running) return STATUS_CONFLICT;
    if (!leaseValid(branch, lease_token, now_ms)) return STATUS_STALE_LEASE;
    branch.output.set(inputSlice(output_ptr, output_len));
    branch.status = .completed;
    branch.lease_token = 0;
    branch.lease_expires_ms = 0;
    return STATUS_OK;
}

pub export fn sift_collab_fail_branch(
    branch_id: u32,
    lease_token: u32,
    error_ptr: [*]const u8,
    error_len: u32,
    now_ms: u64,
) u32 {
    const branch = findBranch(branch_id) orelse return STATUS_NOT_FOUND;
    if (branch.status != .running) return STATUS_CONFLICT;
    if (!leaseValid(branch, lease_token, now_ms)) return STATUS_STALE_LEASE;
    branch.failure.set(inputSlice(error_ptr, error_len));
    branch.status = .failed;
    branch.lease_token = 0;
    branch.lease_expires_ms = 0;
    return STATUS_OK;
}

pub export fn sift_collab_cancel_session(session_id: u32) u32 {
    const session = findSession(session_id) orelse return STATUS_NOT_FOUND;
    session.cancelled = true;
    for (&branches) |*branch| {
        if (!branch.active or branch.session_id != session_id) continue;
        if (branch.status == .pending or branch.status == .running) {
            branch.status = .cancelled;
            branch.lease_token = 0;
            branch.lease_expires_ms = 0;
        }
    }
    return STATUS_OK;
}

pub export fn sift_collab_snapshot_session(
    session_id: u32,
    out_ptr: [*]u8,
    out_cap: u32,
    written_out: *u32,
    needed_out: *u32,
) u32 {
    const session = findSession(session_id) orelse return STATUS_NOT_FOUND;
    var w: Writer = .{ .buf = outputSlice(out_ptr, out_cap) };
    w.append("{\"sessionId\":");
    w.appendFmt("{}", .{session.id});
    w.append(",\"cancelled\":");
    w.append(if (session.cancelled) "true" else "false");
    w.append(",\"root\":");
    w.appendJsonString(session.root.slice());
    w.append(",\"cwd\":");
    w.appendJsonString(session.cwd.slice());
    w.append(",\"maxBranches\":");
    w.appendFmt("{}", .{session.max_branches});
    w.append(",\"branches\":[");
    var first_branch = true;
    for (&branches) |*branch| {
        if (!branch.active or branch.session_id != session_id) continue;
        if (!first_branch) w.append(",");
        first_branch = false;
        w.append("{\"branchId\":");
        w.appendFmt("{}", .{branch.id});
        w.append(",\"status\":");
        w.appendJsonString(@tagName(branch.status));
        w.append(",\"role\":");
        w.appendJsonString(branch.role.slice());
        w.append(",\"focus\":");
        w.appendJsonString(branch.focus.slice());
        w.append(",\"worker\":");
        w.appendJsonString(branch.worker.slice());
        w.append(",\"leaseExpiresMs\":");
        w.appendFmt("{}", .{branch.lease_expires_ms});
        w.append(",\"maxToolCalls\":");
        w.appendFmt("{}", .{branch.max_tool_calls});
        w.append(",\"maxElapsedMs\":");
        w.appendFmt("{}", .{branch.max_elapsed_ms});
        w.append(",\"eventCount\":");
        w.appendFmt("{}", .{branch.event_count});
        w.append(",\"output\":");
        w.appendJsonString(branch.output.slice());
        w.append(",\"error\":");
        w.appendJsonString(branch.failure.slice());
        w.append(",\"events\":[");
        var first_event = true;
        for (&events) |*event| {
            if (!event.active or event.branch_id != branch.id) continue;
            if (!first_event) w.append(",");
            first_event = false;
            w.append("{\"eventId\":");
            w.appendFmt("{}", .{event.id});
            w.append(",\"atMs\":");
            w.appendFmt("{}", .{event.at_ms});
            w.append(",\"type\":");
            w.appendJsonString(event.kind.slice());
            w.append(",\"payload\":");
            w.appendJsonString(event.payload.slice());
            w.append("}");
        }
        w.append("]}");
    }
    w.append("]}");
    return finish(&w, written_out, needed_out);
}

test "collab session leases and snapshot" {
    sift_collab_reset();
    const root = "/tmp/sift";
    const cwd = "/tmp/sift/pkg";
    const session_id = sift_collab_create_session(root.ptr, root.len, cwd.ptr, cwd.len, 4);
    try std.testing.expect(session_id > 0);
    const role = "tests";
    const focus = "Find tests";
    const branch_id = sift_collab_enqueue_branch(session_id, role.ptr, role.len, focus.ptr, focus.len, 4, 5000);
    try std.testing.expect(branch_id > 0);

    var claim: ClaimOut = .{ .branch_id = 0, .lease_token = 0, .lease_expires_ms = 0 };
    const worker = "worker-a";
    try std.testing.expectEqual(STATUS_OK, sift_collab_claim_next_branch(session_id, worker.ptr, worker.len, 1000, 2500, &claim));
    try std.testing.expectEqual(branch_id, claim.branch_id);
    try std.testing.expect(claim.lease_token > 0);
    try std.testing.expectEqual(@as(u64, 3500), claim.lease_expires_ms);

    const kind = "tool_call";
    const payload = "{\"name\":\"search_local_files\"}";
    try std.testing.expectEqual(STATUS_OK, sift_collab_append_event(branch_id, claim.lease_token, kind.ptr, kind.len, payload.ptr, payload.len, 1200));
    const output = "{\"files\":[\"a.test.ts\"]}";
    try std.testing.expectEqual(STATUS_OK, sift_collab_complete_branch(branch_id, claim.lease_token, output.ptr, output.len, 1300));

    var out: [4096]u8 = undefined;
    var written: u32 = 0;
    var needed: u32 = 0;
    try std.testing.expectEqual(STATUS_OK, sift_collab_snapshot_session(session_id, &out, out.len, &written, &needed));
    const json = out[0..written];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"status\":\"completed\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"eventCount\":1") != null);
}

test "expired lease can be claimed by another worker" {
    sift_collab_reset();
    const root = "/tmp/sift";
    const session_id = sift_collab_create_session(root.ptr, root.len, root.ptr, root.len, 2);
    const role = "source_runtime";
    const branch_id = sift_collab_enqueue_branch(session_id, role.ptr, role.len, role.ptr, role.len, 2, 1000);
    try std.testing.expect(branch_id > 0);

    var first: ClaimOut = .{ .branch_id = 0, .lease_token = 0, .lease_expires_ms = 0 };
    const worker_a = "a";
    try std.testing.expectEqual(STATUS_OK, sift_collab_claim_next_branch(session_id, worker_a.ptr, worker_a.len, 10, 10, &first));

    var second: ClaimOut = .{ .branch_id = 0, .lease_token = 0, .lease_expires_ms = 0 };
    const worker_b = "b";
    try std.testing.expectEqual(STATUS_OK, sift_collab_claim_next_branch(session_id, worker_b.ptr, worker_b.len, 25, 50, &second));
    try std.testing.expectEqual(branch_id, second.branch_id);
    try std.testing.expect(second.lease_token != first.lease_token);
}
