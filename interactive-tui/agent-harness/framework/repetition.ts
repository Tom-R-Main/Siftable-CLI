import type { ToolCall } from "./adapters/types.js";

const REMINDER_COUNTS = new Set([3, 5, 8]);
// These tools intentionally inspect state that can change without new arguments.
const POLLING_TOOLS = new Set(["read_process_job", "list_process_jobs"]);

function canonicalArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalArguments);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalArguments(entry)]));
  }
  return value;
}

/**
 * Advisory exact-call detection for one user turn. Observe settled attempts in
 * model order, including failed calls. Polling neither counts nor resets a
 * chain; a different tracked call resets it. No result or execution is changed.
 */
export function createRepetitionTracker(): { observe(call: ToolCall): string | undefined } {
  let previous: string | undefined;
  let count = 0;
  return {
    observe(call) {
      if (POLLING_TOOLS.has(call.name)) return undefined;
      const key = JSON.stringify([call.name, canonicalArguments(call.args)]);
      count = key === previous ? count + 1 : 1;
      previous = key;
      if (!REMINDER_COUNTS.has(count)) return undefined;
      // Do not echo arguments: they may contain secrets or large file bodies.
      return `[Sift harness advisory: repeated-tool-call]\n`
        + `${JSON.stringify(call.name)} has been called ${count} consecutive times with identical arguments. `
        + "Inspect the latest result before calling again. Repetition alone does not establish a lack of progress: "
        + "if you are intentionally polling changing state, continue only when another check is useful. "
        + "Otherwise consider different arguments or a different approach. "
        + "Finish only when the task's completion is supported by evidence.";
    },
  };
}
