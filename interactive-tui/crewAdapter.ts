import {
  runCollabBranches,
  type CollabBranchRunContext,
} from './collabRunner';

export interface SiftCrewAgent {
  id: string;
  role: string;
  goal?: string;
  prompt: string;
  maxToolCalls?: number;
  maxElapsedMs?: number;
}

export interface SiftCrewTask {
  id: string;
  agent: string;
  input: string;
  dependsOn?: string[];
  expectedOutput?: string;
}

export interface SiftCrewTaskContext {
  agent: SiftCrewAgent;
  task: SiftCrewTask;
  input: string;
  priorResults: SiftCrewTaskResult<unknown>[];
  appendEvent: (type: string, payload?: unknown) => void;
  heartbeat: () => void;
}

export interface SiftCrewTaskResult<TResult> {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed';
  elapsedMs: number;
  output?: TResult;
  error?: string;
}

export interface RunSiftCrewOptions<TResult> {
  root: string;
  cwd: string;
  name: string;
  agents: SiftCrewAgent[];
  tasks: SiftCrewTask[];
  process?: 'parallel' | 'sequential';
  leaseMs?: number;
  runTask: (context: SiftCrewTaskContext) => Promise<TResult>;
  reduce?: (results: SiftCrewTaskResult<TResult>[]) => unknown;
}

export interface SiftCrewResult<TResult> {
  sessionId?: number;
  taskResults: SiftCrewTaskResult<TResult>[];
  output?: unknown;
}

interface SiftCrewBranch {
  task: SiftCrewTask;
  agent: SiftCrewAgent;
}

export async function runSiftCrew<TResult>(
  options: RunSiftCrewOptions<TResult>,
): Promise<SiftCrewResult<TResult>> {
  if (options.tasks.length === 0) throw new Error('runSiftCrew: tasks must be non-empty');
  const agentsById = new Map(options.agents.map((agent) => [agent.id, agent]));
  const branches = options.tasks.map((task) => {
    const agent = agentsById.get(task.agent);
    if (!agent) throw new Error(`runSiftCrew: task "${task.id}" references unknown agent "${task.agent}"`);
    return { task, agent };
  });
  const completed: SiftCrewTaskResult<TResult>[] = [];
  const run = await runCollabBranches({
    root: options.root,
    cwd: options.cwd,
    leaseMs: options.leaseMs,
    maxBranches: branches.length,
    process: options.process ?? 'parallel',
    workerPrefix: `crew:${options.name}`,
    branches,
    specForBranch: ({ task, agent }) => ({
      id: task.id,
      role: agent.role,
      focus: task.expectedOutput ? `${task.input}\nExpected output: ${task.expectedOutput}` : task.input,
      maxToolCalls: agent.maxToolCalls,
      maxElapsedMs: agent.maxElapsedMs,
    }),
    runBranch: async (context) => {
      const result = await runCrewTaskBranch(options, context, completed);
      completed.push(result);
      return result;
    },
    finalizeBranch: (result) => result.status === 'failed'
      ? { status: 'failed', error: result.error ?? 'crew task failed' }
      : { status: 'completed', output: result.output ?? '' },
  });
  const taskResults = run.results;
  const reduced = options.reduce?.(taskResults);
  return {
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    taskResults,
    ...(reduced !== undefined ? { output: reduced } : {}),
  };
}

async function runCrewTaskBranch<TResult>(
  options: RunSiftCrewOptions<TResult>,
  context: CollabBranchRunContext<SiftCrewBranch>,
  completed: SiftCrewTaskResult<TResult>[],
): Promise<SiftCrewTaskResult<TResult>> {
  const { agent, task } = context.branch;
  const startedAt = Date.now();
  try {
    const priorResults = selectPriorResults(task, completed, options.process ?? 'parallel');
    const input = renderCrewTaskInput(agent, task, priorResults);
    context.appendEvent('crew_task_started', { taskId: task.id, agentId: agent.id });
    context.appendEvent('task_context_ready', {
      taskId: task.id,
      priorResultCount: priorResults.length,
      inputChars: input.length,
    });
    const output = await options.runTask({
      agent,
      task,
      input,
      priorResults: priorResults as SiftCrewTaskResult<unknown>[],
      appendEvent: context.appendEvent,
      heartbeat: context.heartbeat,
    });
    context.heartbeat();
    context.appendEvent('task_output', { taskId: task.id, outputChars: String(output ?? '').length });
    return {
      taskId: task.id,
      agentId: agent.id,
      status: 'completed',
      elapsedMs: Date.now() - startedAt,
      output,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    context.appendEvent('task_failed', { taskId: task.id, error });
    return {
      taskId: task.id,
      agentId: agent.id,
      status: 'failed',
      elapsedMs: Date.now() - startedAt,
      error,
    };
  }
}

function selectPriorResults<TResult>(
  task: SiftCrewTask,
  completed: SiftCrewTaskResult<TResult>[],
  process: 'parallel' | 'sequential',
): SiftCrewTaskResult<TResult>[] {
  if (task.dependsOn?.length) {
    const dependencies = new Set(task.dependsOn);
    return completed.filter((result) => dependencies.has(result.taskId));
  }
  return process === 'sequential' ? completed : [];
}

function renderCrewTaskInput(
  agent: SiftCrewAgent,
  task: SiftCrewTask,
  priorResults: SiftCrewTaskResult<unknown>[],
): string {
  const lines = [
    `Agent role: ${agent.role}`,
    ...(agent.goal ? [`Agent goal: ${agent.goal}`] : []),
    `Agent prompt: ${agent.prompt}`,
    '',
    `Task ${task.id}:`,
    task.input,
  ];
  if (task.expectedOutput) {
    lines.push('', `Expected output: ${task.expectedOutput}`);
  }
  if (priorResults.length) {
    lines.push('', 'Prior task results:');
    for (const result of priorResults) {
      lines.push(
        `- ${result.taskId} (${result.status}): ${
          result.status === 'failed' ? result.error ?? '' : String(result.output ?? '')
        }`,
      );
    }
  }
  return lines.join('\n');
}
