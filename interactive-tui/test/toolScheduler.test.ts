import {describe, expect, it} from "bun:test";
import {
  classifyToolCall,
  normalizeParallelCap,
  runToolBatch,
} from "../agent-harness/framework/tool-scheduler";

/** A manually resolvable gate. */
function gate(): {promise: Promise<void>; open: () => void} {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return {promise, open};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("classifyToolCall", () => {
  it("fails closed for missing tools, missing classifiers, bad returns, and throws", () => {
    expect(classifyToolCall(undefined, {})).toBe("exclusive");
    expect(classifyToolCall({}, {})).toBe("exclusive");
    expect(classifyToolCall({executionMode: () => "weird" as never}, {})).toBe("exclusive");
    expect(
      classifyToolCall({executionMode: () => {
        throw new Error("boom");
      }}, {}),
    ).toBe("exclusive");
  });

  it("honors a parallel-safe declaration and passes the args through", () => {
    const seen: Array<Record<string, unknown>> = [];
    const mode = classifyToolCall(
      {executionMode: (args) => {
        seen.push(args);
        return "parallel-safe";
      }},
      {path: "a.txt"},
    );
    expect(mode).toBe("parallel-safe");
    expect(seen).toEqual([{path: "a.txt"}]);
  });
});

describe("runToolBatch", () => {
  it("caps concurrent parallel-safe executions and settles results by call index", async () => {
    const gates = [gate(), gate(), gate()];
    let active = 0;
    let maxActive = 0;
    const outcome = runToolBatch([0, 1, 2], {
      mode: () => "parallel-safe",
      maxParallel: 2,
      execute: async (call: number) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[call].promise;
        active -= 1;
        return `r${call}`;
      },
    });

    await tick();
    expect(maxActive).toBe(2); // third call waits for a slot

    // Complete out of order: 1 first frees the slot for 2, then 0.
    gates[1].open();
    await tick();
    gates[2].open();
    gates[0].open();
    const results = await outcome;
    expect(results).toEqual([
      {status: "executed", value: "r0"},
      {status: "executed", value: "r1"},
      {status: "executed", value: "r2"},
    ]);
    expect(maxActive).toBe(2);
  });

  it("runs an exclusive call as a barrier: alone, after in-flight drains", async () => {
    const order: string[] = [];
    let active = 0;
    const activeDuring: Record<string, number> = {};
    const g0 = gate();
    const outcome = runToolBatch(["p0", "excl", "p1"], {
      mode: (call) => (call === "excl" ? "exclusive" : "parallel-safe"),
      maxParallel: 4,
      execute: async (call: string) => {
        active += 1;
        activeDuring[call] = active;
        order.push(`start:${call}`);
        if (call === "p0") await g0.promise;
        await tick();
        active -= 1;
        order.push(`end:${call}`);
        return call;
      },
    });

    await tick();
    // The exclusive call must not have started while p0 is in flight.
    expect(order).toEqual(["start:p0"]);
    g0.open();
    const results = await outcome;
    expect(order).toEqual([
      "start:p0", "end:p0",
      "start:excl", "end:excl",
      "start:p1", "end:p1",
    ]);
    expect(activeDuring.excl).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["executed", "executed", "executed"]);
  });

  it("stops admissions on cancellation but drains the started call", async () => {
    let cancelled = false;
    const g = gate();
    const started: string[] = [];
    const outcome = runToolBatch(["a", "b"], {
      mode: () => "parallel-safe",
      maxParallel: 1, // b must wait for a's slot
      isCancelled: () => cancelled,
      execute: async (call: string) => {
        started.push(call);
        await g.promise;
        return call;
      },
    });

    await tick();
    expect(started).toEqual(["a"]);
    cancelled = true; // cancel while a holds the only slot
    g.open();
    const results = await outcome;
    expect(started).toEqual(["a"]); // b was never admitted
    expect(results).toEqual([
      {status: "executed", value: "a"},
      {status: "cancelled"},
    ]);
  });

  it("cancels every remaining admission once cancelled, including exclusives", async () => {
    const results = await runToolBatch(["a", "b", "c"], {
      mode: (call) => (call === "b" ? "exclusive" : "parallel-safe"),
      maxParallel: 2,
      isCancelled: () => true,
      execute: async (call: string) => call,
    });
    expect(results).toEqual([
      {status: "cancelled"},
      {status: "cancelled"},
      {status: "cancelled"},
    ]);
  });

  it("reports a rejection at its own index while other calls still settle", async () => {
    const results = await runToolBatch([0, 1], {
      mode: () => "parallel-safe",
      maxParallel: 2,
      execute: async (call: number) => {
        if (call === 0) throw new Error("journal append failed");
        return "ok";
      },
    });
    expect(results[0].status).toBe("rejected");
    expect(results[1]).toEqual({status: "executed", value: "ok"});
  });

  it("fails closed to serial for non-finite caps instead of unbounded parallelism", async () => {
    expect(normalizeParallelCap(Number.NaN)).toBe(1);
    expect(normalizeParallelCap(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeParallelCap(-3)).toBe(1);
    expect(normalizeParallelCap(2.5)).toBe(2);

    for (const cap of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let active = 0;
      let maxActive = 0;
      const results = await runToolBatch([0, 1, 2, 3, 4, 5], {
        mode: () => "parallel-safe",
        maxParallel: cap,
        execute: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await tick();
          active -= 1;
          return "ok";
        },
      });
      expect(maxActive).toBe(1); // NaN/Infinity would disarm the size >= cap guard
      expect(results.every((r) => r.status === "executed")).toBe(true);
    }
  });

  it("floors a fractional cap", async () => {
    const gates = [gate(), gate(), gate()];
    let active = 0;
    let maxActive = 0;
    const outcome = runToolBatch([0, 1, 2], {
      mode: () => "parallel-safe",
      maxParallel: 2.5,
      execute: async (call: number) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[call].promise;
        active -= 1;
        return call;
      },
    });
    await tick();
    expect(maxActive).toBe(2); // floor(2.5), not ceil
    for (const g of gates) g.open();
    await outcome;
    expect(maxActive).toBe(2);
  });

  it("clamps a nonsensical cap to serial execution", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await runToolBatch([0, 1, 2], {
      mode: () => "parallel-safe",
      maxParallel: 0,
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick();
        active -= 1;
        return "ok";
      },
    });
    expect(maxActive).toBe(1);
    expect(results.every((r) => r.status === "executed")).toBe(true);
  });
});
