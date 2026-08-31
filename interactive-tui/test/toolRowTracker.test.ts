import {describe, expect, it} from "bun:test";
import {ToolRowTracker} from "../toolRowTracker";

describe("ToolRowTracker", () => {
  it("settles parallel same-name calls by callId even when results arrive reversed", () => {
    const t = new ToolRowTracker();
    t.register("read_file", "call-a", 3);
    t.register("read_file", "call-b", 4);

    // Results arrive out of order: call-b finishes first.
    expect(t.settle("read_file", "call-b")).toBe(4);
    expect(t.settle("read_file", "call-a")).toBe(3);
  });

  it("consumes id-settled rows from the name fallback so mixed streams stay coherent", () => {
    const t = new ToolRowTracker();
    t.register("read_file", "call-a", 1);
    t.register("read_file", undefined, 2);

    expect(t.settle("read_file", "call-a")).toBe(1);
    // The id-settled row must not be handed out again by the name fallback.
    expect(t.settle("read_file", undefined)).toBe(2);
  });

  it("without callIds settles same-name rows FIFO instead of updating the last row twice", () => {
    const t = new ToolRowTracker();
    t.register("read_file", undefined, 1);
    t.register("read_file", undefined, 2);

    expect(t.settle("read_file", undefined)).toBe(1);
    expect(t.settle("read_file", undefined)).toBe(2);
  });

  it("falls back to the most recent tool row for events with neither id nor registered name", () => {
    const t = new ToolRowTracker();
    t.register("shell", "call-a", 5);

    expect(t.settle("unregistered_tool", undefined)).toBe(5);
  });

  it("keeps distinct names independent under interleaved id settlement", () => {
    const t = new ToolRowTracker();
    t.register("shell", "s-1", 1);
    t.register("read_file", "r-1", 2);
    t.register("shell", "s-2", 3);

    expect(t.settle("shell", "s-2")).toBe(3);
    expect(t.settle("read_file", "r-1")).toBe(2);
    expect(t.settle("shell", "s-1")).toBe(1);
  });

  it("returns null when nothing was ever registered", () => {
    const t = new ToolRowTracker();
    expect(t.settle("read_file", undefined)).toBeNull();
  });

  it("fails closed on an unknown callId instead of stealing another call's row", () => {
    const t = new ToolRowTracker();
    t.register("read_file", "call-a", 1);
    t.register("read_file", "call-b", 2);

    // Orphan/provider-mismatched result: must settle nothing and consume nothing.
    expect(t.settle("read_file", "call-x")).toBeNull();
    // The real calls still settle their own rows.
    expect(t.settle("read_file", "call-a")).toBe(1);
    expect(t.settle("read_file", "call-b")).toBe(2);
  });

  it("fails closed on a duplicate callId after its row already settled", () => {
    const t = new ToolRowTracker();
    t.register("read_file", "call-a", 1);
    t.register("read_file", "call-b", 2);

    expect(t.settle("read_file", "call-a")).toBe(1);
    expect(t.settle("read_file", "call-a")).toBeNull(); // duplicate must not touch call-b's row
    expect(t.settle("read_file", "call-b")).toBe(2);
  });

  it("consumes the registered-name row when an exact-id result has a malformed name", () => {
    const t = new ToolRowTracker();
    t.register("read_file", "call-a", 1);
    t.register("read_file", undefined, 2);

    expect(t.settle("shell", "call-a")).toBe(1);
    expect(t.settle("read_file", undefined)).toBe(2);
  });

  it("does not hand an id-registered row settled by the name fallback to a late id result", () => {
    const t = new ToolRowTracker();
    t.register("read_file", "call-a", 1);

    // An id-less result consumes the row FIFO…
    expect(t.settle("read_file", undefined)).toBe(1);
    // …so the id arriving later fails closed instead of double-settling it.
    expect(t.settle("read_file", "call-a")).toBeNull();
  });

  it("drains every still-open row exactly once at turn interruption", () => {
    const t = new ToolRowTracker();
    t.register("shell", "call-a", 2);
    t.register("shell", "call-b", 3);
    t.register("read_file", "call-c", 4);
    expect(t.settle("shell", "call-a")).toBe(2);

    expect(t.drain()).toEqual([3, 4]);
    expect(t.drain()).toEqual([]);
    expect(t.settle("shell", "call-b")).toBeNull();
  });
});
