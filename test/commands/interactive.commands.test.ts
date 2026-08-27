import {
  applyModelChoice,
  applyExplorerSettings,
  DEFAULT_EXPLORER_SETTINGS,
  explorerModelChoices,
  modeUsesScoutModel,
  ensureExplorerProviderKey,
  interactiveCommands,
  findModelChoice,
  resolveModelChoiceEffort,
  runInteractiveCommand,
  commandSuggestions,
  type CommandMessage,
  type InteractiveCommandContext,
} from '../../interactive-tui/commands';
import {collectDailyReviewContext} from '../../src/lib/daily-review-context';
import {rejectAllConfirms, resetBypass, setConfirmListener} from '../../interactive-tui/confirmGate';
import {buildCommandContext as buildContext} from '../helpers/interactive-command-context';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {rolloutPathForKey} from '../../interactive-tui/threadEngine';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withTemporaryHome(run: (temporaryHome: string) => Promise<void>): Promise<void> {
  const temporaryHome = mkdtempSync(path.join(tmpdir(), 'sift-commands-home-'));
  try {
    await run(temporaryHome);
  } finally {
    rmSync(temporaryHome, {recursive: true, force: true});
  }
}

describe('interactive command registry', () => {
  afterEach(() => {
    rejectAllConfirms();
    setConfirmListener(null);
    resetBypass();
  });

  it('routes DeepSeek aliases to V4 Flash 0731 only', () => {
    expect(findModelChoice('deepseek')?.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(findModelChoice('deepseek-v4-pro')?.model).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('routes GLM aliases to 5.3 Flash and exposes Normal/Fast at Max by default', () => {
    const normal = findModelChoice('glm');
    const fast = findModelChoice('glm-fast');
    expect(normal).toMatchObject({
      model: 'z-ai/glm-5.3-flash',
      defaultEffort: 'max',
    });
    expect(fast).toMatchObject({
      model: 'z-ai/glm-5.3-flash:nitro',
      defaultEffort: 'max',
    });
    expect(resolveModelChoiceEffort(normal!)).toBe('max');
    expect(resolveModelChoiceEffort(fast!, 'low')).toBe('low');
    expect(findModelChoice('glm-5.2')?.model).toBe('z-ai/glm-5.2');
  });

  it('exposes command suggestions from registry metadata (visible commands only)', () => {
    const names = commandSuggestions().map((command) => command.name);
    // Spans the grouped hierarchy; only non-hidden commands surface here.
    expect(names).toEqual(expect.arrayContaining([
      'help',
      'status',
      'copy',
      'model',
      'explorer',
      'branches',
      'handoff',
      'plan',
      'preflight',
      'proof',
      'remember',
    ]));
    // Hidden commands (e.g. those folded into the /work hub) must not leak in.
    const hidden = interactiveCommands.filter((command) => command.hidden).map((command) => command.name);
    for (const name of hidden) expect(names).not.toContain(name);
  });

  it('applies explorer settings to runtime environment without touching the main model', () => {
    const previousExplorer = process.env.SIFT_EXPLORER;
    const previousScout = process.env.SIFT_EXPLORER_SCOUT;
    const previousFanout = process.env.SIFT_EXPLORER_FANOUT;
    const previousExplorerProvider = process.env.SIFT_EXPLORER_PROVIDER;
    const previousExplorerModel = process.env.SIFT_EXPLORER_MODEL;
    const previousProvider = process.env.SIFT_EXPLORER_SCOUT_PROVIDER;
    const previousModel = process.env.SIFT_EXPLORER_SCOUT_MODEL;
    const previousBudget = process.env.SIFT_EXPLORER_BUDGET;
    const previousThoroughness = process.env.SIFT_EXPLORER_THOROUGHNESS;

    try {
      const model = explorerModelChoices().find((choice) => choice.id === DEFAULT_EXPLORER_SETTINGS.modelId);
      expect(model).toBeTruthy();
      const result = applyExplorerSettings({
        mode: 'fanout',
        modelId: DEFAULT_EXPLORER_SETTINGS.modelId,
        budget: 'cheap',
      });

      expect(result.ok).toBe(true);
      expect(process.env.SIFT_EXPLORER).toBe('fast-context');
      expect(process.env.SIFT_EXPLORER_SCOUT).toBe('0');
      expect(process.env.SIFT_EXPLORER_FANOUT).toBe('1');
      expect(process.env.SIFT_EXPLORER_PROVIDER).toBe(model?.provider);
      expect(process.env.SIFT_EXPLORER_MODEL).toBe(model?.model);
      expect(process.env.SIFT_EXPLORER_SCOUT_PROVIDER).toBe(model?.provider);
      expect(process.env.SIFT_EXPLORER_SCOUT_MODEL).toBe(model?.model);
      expect(process.env.SIFT_EXPLORER_BUDGET).toBe('cheap');
      expect(process.env.SIFT_EXPLORER_THOROUGHNESS).toBe('quick');
    } finally {
      restoreEnv('SIFT_EXPLORER', previousExplorer);
      restoreEnv('SIFT_EXPLORER_SCOUT', previousScout);
      restoreEnv('SIFT_EXPLORER_FANOUT', previousFanout);
      restoreEnv('SIFT_EXPLORER_PROVIDER', previousExplorerProvider);
      restoreEnv('SIFT_EXPLORER_MODEL', previousExplorerModel);
      restoreEnv('SIFT_EXPLORER_SCOUT_PROVIDER', previousProvider);
      restoreEnv('SIFT_EXPLORER_SCOUT_MODEL', previousModel);
      restoreEnv('SIFT_EXPLORER_BUDGET', previousBudget);
      restoreEnv('SIFT_EXPLORER_THOROUGHNESS', previousThoroughness);
    }
  });

  it('toggles warp-grep mode via SIFT_EXPLORER_WARPGREP and resets it for other modes', () => {
    const keys = ['SIFT_EXPLORER', 'SIFT_EXPLORER_SCOUT', 'SIFT_EXPLORER_FANOUT', 'SIFT_EXPLORER_WARPGREP'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      const warp = applyExplorerSettings({
        mode: 'warpgrep',
        modelId: DEFAULT_EXPLORER_SETTINGS.modelId,
        budget: 'deep',
      });
      expect(warp.ok).toBe(true);
      expect(process.env.SIFT_EXPLORER).toBe('fast-context');
      expect(process.env.SIFT_EXPLORER_SCOUT).toBe('0');
      expect(process.env.SIFT_EXPLORER_FANOUT).toBe('0');
      expect(process.env.SIFT_EXPLORER_WARPGREP).toBe('1');

      // Switching to any other mode must turn warp-grep back off.
      applyExplorerSettings({
        mode: 'fanout',
        modelId: DEFAULT_EXPLORER_SETTINGS.modelId,
        budget: 'deep',
      });
      expect(process.env.SIFT_EXPLORER_WARPGREP).toBe('0');
      expect(process.env.SIFT_EXPLORER_FANOUT).toBe('1');
    } finally {
      for (const k of keys) restoreEnv(k, saved[k]);
    }
  });

  it('marks only scout/fanout modes as scout-model driven', () => {
    expect(modeUsesScoutModel('scout')).toBe(true);
    expect(modeUsesScoutModel('fanout')).toBe(true);
    expect(modeUsesScoutModel('warpgrep')).toBe(false);
    expect(modeUsesScoutModel('deterministic')).toBe(false);
    expect(modeUsesScoutModel('off')).toBe(false);
    expect(modeUsesScoutModel('auto')).toBe(false);
    expect(modeUsesScoutModel(undefined)).toBe(false);
  });

  it('only attempts vault key recovery for warp-grep mode with a missing MORPH_API_KEY', async () => {
    const prevWg = process.env.SIFT_EXPLORER_WARPGREP;
    const prevKey = process.env.MORPH_API_KEY;
    try {
      // Not warp-grep mode → no-op even with no key.
      process.env.SIFT_EXPLORER_WARPGREP = '0';
      delete process.env.MORPH_API_KEY;
      expect(await ensureExplorerProviderKey({} as never)).toBeNull();

      // Warp-grep mode but key already present → no-op (no prompt).
      process.env.SIFT_EXPLORER_WARPGREP = '1';
      process.env.MORPH_API_KEY = 'sk-test';
      expect(await ensureExplorerProviderKey({} as never)).toBeNull();

      // Warp-grep mode + missing key → tries vault; surfaces a message when
      // vault is unavailable in the session.
      delete process.env.MORPH_API_KEY;
      const msg = await ensureExplorerProviderKey({ apiClient: {} } as never);
      expect(msg).toMatch(/vault plaintext hydration .* is retired/i);
    } finally {
      restoreEnv('SIFT_EXPLORER_WARPGREP', prevWg);
      restoreEnv('MORPH_API_KEY', prevKey);
    }
  });

  it('runs core commands through a context object', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/status');
    expect(messages.at(-1)?.text).toContain('google/gemini-3.7-flash');
    expect(messages.at(-1)?.text).toContain('queued:  2');

    await runInteractiveCommand(ctx, '/copy all');
    expect(messages.at(-1)?.text).toBe('copied 38 chars.');
  });

  it('refuses to persist a cyclic /plan work --after edge', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-after-cycle-'));
    try {
      const {ctx, messages, apiClient} = buildContext({workspaceRoot: () => root, cwd: () => root});
      (apiClient.listWorkItems as jest.Mock).mockReturnValue(Promise.resolve({
        statusCode: 200,
        data: {workItems: [
          {id: 'a', title: 'First', status: 'queued'},
          {id: 'b', title: 'Second', status: 'queued'},
        ]},
      }));
      await runInteractiveCommand(ctx, '/plan work --after a:b');
      await runInteractiveCommand(ctx, '/plan work --after b:a');

      expect(messages.map((message) => message.text).join('\n')).toContain('Refused to record --after edge(s)');
      const overlay = JSON.parse(readFileSync(path.join(root, '.siftable/plans/overlay.json'), 'utf8')) as {declaredEdges: unknown[]};
      expect(overlay.declaredEdges).toHaveLength(1);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('runs /compact and renders the savings report', async () => {
    const compactThread = jest.fn(async () => ({
      engine: 'agent-harness' as const,
      ran: true,
      beforeTokens: 12000,
      afterTokens: 3000,
      prunedMessages: 2,
      summarized: true,
    }));
    const {ctx, messages} = buildContext({compactThread});

    await runInteractiveCommand(ctx, '/compact');

    expect(compactThread).toHaveBeenCalledTimes(1);
    const joined = messages.map((m) => m.text).join('\n');
    expect(joined).toContain('Compacting conversation…');
    expect(joined).toContain('summarized older turns');
    expect(joined).toContain('pruned 2 tool outputs');
    expect(messages.at(-1)?.text).toContain('75%'); // 9000/12000 saved
  });

  it('reports a /compact no-op with its reason', async () => {
    const compactThread = jest.fn(async () => ({
      engine: 'codex' as const,
      ran: false,
      reason: 'Codex manages its own context server-side',
    }));
    const {ctx, messages} = buildContext({compactThread});

    await runInteractiveCommand(ctx, '/compact');
    expect(messages.at(-1)?.text).toContain('Nothing to compact');
    expect(messages.at(-1)?.text).toContain('server-side');
  });

  it('reports durable journal state even when context compaction is disabled', async () => {
    const previous = process.env.SIFT_CONTEXT_COMPACTION;
    const inspectThread = jest.fn(async () => ({
      sessionId: 'stable-session-id',
      eventCount: 17,
      messageCount: 4,
    }));
    try {
      process.env.SIFT_CONTEXT_COMPACTION = '0';
      const {ctx, messages} = buildContext({inspectThread});

      await runInteractiveCommand(ctx, '/threads');

      expect(inspectThread).toHaveBeenCalledTimes(1);
      expect(messages.at(-1)?.text).toContain('4 model-history message(s), 17 journal event(s)');
      expect(messages.at(-1)?.text).toContain('session stable-session-id');
      expect(messages.at(-1)?.text).not.toContain('Thread persistence is off');
    } finally {
      restoreEnv('SIFT_CONTEXT_COMPACTION', previous);
    }
  });

  it('makes /clear reset model history before replacing the visible transcript', async () => {
    const resetThread = jest.fn(async () => true);
    const {ctx, messages} = buildContext({resetThread});

    await runInteractiveCommand(ctx, '/clear');

    expect(resetThread).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([{role: 'system', text: 'cleared.'}]);
  });

  it('leaves the visible transcript intact when /clear cannot reset the journal', async () => {
    const {ctx, messages} = buildContext({resetThread: async () => false});
    messages.push({role: 'assistant', text: 'keep this'});

    await runInteractiveCommand(ctx, '/clear');

    expect(messages).toContainEqual({role: 'assistant', text: 'keep this'});
    expect(messages.at(-1)?.text).toContain('does not expose durable thread reset');
  });

  it('clears the active journal before deleting the matching legacy rollout', async () => {
    await withTemporaryHome(async (temporaryHome) => {
      const previous = process.env.SIFT_CONTEXT_COMPACTION;
      const key = `commands-thread-clear-${process.pid}-${Date.now()}`;
      const rolloutPath = rolloutPathForKey(temporaryHome, key);
      const resetThread = jest.fn(async () => true);
      try {
        process.env.SIFT_CONTEXT_COMPACTION = '1';
        mkdirSync(path.dirname(rolloutPath), {recursive: true});
        writeFileSync(rolloutPath, '{"r":0,"t":"old question"}\n', {mode: 0o600});
        const {ctx, messages} = buildContext({
          conversationKey: () => key,
          homeDir: () => temporaryHome,
          resetThread,
        });

        await runInteractiveCommand(ctx, '/threads clear');

        expect(resetThread).toHaveBeenCalledTimes(1);
        expect(existsSync(rolloutPath)).toBe(false);
        expect(messages.at(-1)?.text).toContain(`Cleared persisted thread for ${key}`);
      } finally {
        restoreEnv('SIFT_CONTEXT_COMPACTION', previous);
      }
    });
  });

  it('preserves the legacy rollout when the active journal cannot be reset', async () => {
    await withTemporaryHome(async (temporaryHome) => {
      const previous = process.env.SIFT_CONTEXT_COMPACTION;
      const key = `commands-thread-reset-failure-${process.pid}-${Date.now()}`;
      const rolloutPath = rolloutPathForKey(temporaryHome, key);
      try {
        process.env.SIFT_CONTEXT_COMPACTION = '1';
        mkdirSync(path.dirname(rolloutPath), {recursive: true});
        writeFileSync(rolloutPath, '{"r":0,"t":"keep me"}\n', {mode: 0o600});
        const {ctx, messages} = buildContext({
          conversationKey: () => key,
          homeDir: () => temporaryHome,
          resetThread: async () => {
            throw new Error('journal unavailable');
          },
        });

        await runInteractiveCommand(ctx, '/threads clear');

        expect(existsSync(rolloutPath)).toBe(true);
        expect(messages.at(-1)?.text).toContain('journal unavailable');
      } finally {
        restoreEnv('SIFT_CONTEXT_COMPACTION', previous);
      }
    });
  });

  it('fails closed when the active harness declines durable reset', async () => {
    await withTemporaryHome(async (temporaryHome) => {
      const key = `commands-thread-reset-unsupported-${process.pid}-${Date.now()}`;
      const rolloutPath = rolloutPathForKey(temporaryHome, key);
      mkdirSync(path.dirname(rolloutPath), {recursive: true});
      writeFileSync(rolloutPath, '{"r":0,"t":"keep me"}\n', {mode: 0o600});
      const {ctx, messages} = buildContext({
        conversationKey: () => key,
        homeDir: () => temporaryHome,
        resetThread: async () => false,
      });

      await runInteractiveCommand(ctx, '/threads clear');

      expect(existsSync(rolloutPath)).toBe(true);
      expect(messages.at(-1)?.text).toContain('does not expose durable thread reset');
    });
  });

  it('routes /copy targets to the right source (copy stays explicit via the command)', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/copy'); // defaults to the latest assistant reply
    expect(messages.at(-1)?.text).toBe(`copied ${'latest answer'.length} chars.`);

    await runInteractiveCommand(ctx, '/copy last');
    expect(messages.at(-1)?.text).toBe(`copied ${'latest answer'.length} chars.`);

    await runInteractiveCommand(ctx, '/copy all');
    expect(messages.at(-1)?.text).toBe(`copied ${'you: please hand this off\nsiftable: ok'.length} chars.`);

    await runInteractiveCommand(ctx, '/copy explorer');
    expect(messages.at(-1)?.text).toBe(`copied ${'explorer report body'.length} chars.`);
  });

  it('does not hydrate missing direct-provider keys from Sift Vault', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const config = jest.fn(async (input) => ({provider: input.provider ?? 'anthropic', model: input.model ?? 'x'}));
    const {ctx, messages, apiClient} = buildContext({
      client: {
        state: jest.fn(),
        config,
        login: jest.fn(),
        send: jest.fn(),
      },
    });
    await applyModelChoice(ctx, findModelChoice('claude-api')!, 'high');

    expect(apiClient.listVaultEntries).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(messages.map((message) => message.text).join('\n')).toContain('Vault plaintext hydration for ANTHROPIC_API_KEY is retired');
    restoreEnv('ANTHROPIC_API_KEY', previous);
  });

  it('retires /key vault before any Vault API call', async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const config = jest.fn(async (input) => ({provider: input.provider ?? 'openrouter', model: input.model ?? 'x'}));
    const {ctx, messages, apiClient} = buildContext({
      client: {
        state: jest.fn(),
        config,
        login: jest.fn(),
        send: jest.fn(),
      },
    });
    await runInteractiveCommand(ctx, '/key vault openrouter');

    expect(apiClient.listVaultEntries).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(messages.at(-1)?.text).toContain('Vault plaintext hydration for OPENROUTER_API_KEY is retired');
    restoreEnv('OPENROUTER_API_KEY', previous);
  });

  it('reports the real read/write boundary in /status', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/status');
    const text = messages.at(-1)?.text ?? '';
    expect(text).toContain('workdir: /repo');
    expect(text).toContain('read:    repo + machine-wide, read-only');
    expect(text).toContain('write:   /repo (approval-gated)');
  });

  it('shows write as disabled when there is no workspace root', async () => {
    const {ctx, messages} = buildContext({workspaceRoot: () => ''});

    await runInteractiveCommand(ctx, '/status');
    expect(messages.at(-1)?.text).toContain('write:   disabled (no workspace root)');
  });

  it('shows the workdir on /cwd and changes it via setCwd', async () => {
    const setCwd = jest.fn();
    const {ctx, messages} = buildContext({setCwd});

    await runInteractiveCommand(ctx, '/cwd');
    expect(messages.at(-1)?.text).toBe('workdir: /repo\nroot:    /repo');

    await runInteractiveCommand(ctx, '/cwd packages/exf-cli');
    expect(setCwd).toHaveBeenCalledWith('packages/exf-cli');
    expect(messages.at(-1)?.text).toBe('workdir → /repo\nroot → /repo');
  });

  it('surfaces a /cwd failure without throwing', async () => {
    const setCwd = jest.fn(() => {
      throw new Error('not a directory: /nope');
    });
    const {ctx, messages} = buildContext({setCwd});

    await runInteractiveCommand(ctx, '/cwd /nope');
    expect(messages.at(-1)?.text).toContain('not a directory: /nope');
  });

  it('renders the agent queue board from work and agent APIs', async () => {
    const {ctx, messages, apiClient} = buildContext();

    await runInteractiveCommand(ctx, '/queue');

    expect(apiClient.listAgents).toHaveBeenCalledWith({includeDisabled: true});
    expect(apiClient.listWorkItems).toHaveBeenCalledWith({limit: 50});
    expect(messages.at(-1)?.text).toContain('Agents');
    expect(messages.at(-1)?.text).toContain('needs_review');
    expect(messages.at(-1)?.text).toContain('Review proof');
  });

  it('renders /work contract and proof summaries from one list read', async () => {
    const {ctx, messages, apiClient} = buildContext();
    (apiClient.listWorkItems as jest.Mock).mockResolvedValue({
      statusCode: 200,
      data: {workItems: [{
        id: 'work-1',
        title: 'Bounded row',
        status: 'queued',
        assignedAlias: {alias: 'codex'},
        contractSummary: {
          classification: 'bounded',
          profile: 'coding',
          verificationCommandCount: 2,
          enabledActions: ['read', 'write', 'test'],
        },
        verificationState: 'unverified',
        verificationResults: [{command: 'npm test', exitCode: 0}],
      }]},
    });

    await runInteractiveCommand(ctx, '/work');

    expect(apiClient.listWorkItems).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)?.text).toContain('bounded:coding · 1/2 proof · unverified');
  });

  it('falls back to zero for malformed contract-summary counts', async () => {
    const {ctx, messages, apiClient} = buildContext();
    (apiClient.listWorkItems as jest.Mock).mockResolvedValue({
      statusCode: 200,
      data: {workItems: [{
        id: 'work-1',
        title: 'Malformed counts',
        status: 'queued',
        contractSummary: {
          classification: 'bounded',
          profile: 'coding',
          acceptanceCriteriaCount: 'unknown',
          verificationCommandCount: 'unknown',
        },
      }]},
    });

    await runInteractiveCommand(ctx, '/work');

    expect(messages.at(-1)?.text).toContain('bounded:coding · 0/0 proof');
    expect(messages.at(-1)?.text).not.toContain('NaN');
  });

  it('creates handoff work items from transcript, cwd, and explicit args', async () => {
    const {ctx, messages, createdWork} = buildContext();

    await runInteractiveCommand(ctx, '/handoff Fix composer wrapping --agent codex --files=packages/exf-cli/interactive-tui/index.tsx --acceptance=wraps;tests-pass --verify=npm-test');

    expect(createdWork).toHaveLength(1);
    expect(createdWork[0]).toMatchObject({
      title: 'Fix composer wrapping',
      assignedAlias: 'codex',
      inputContext: {
        cwd: '/repo',
        files: ['packages/exf-cli/interactive-tui/index.tsx'],
      },
      contract: {
        version: 1,
        profile: 'coding',
        outcome: {acceptanceCriteria: [{text: 'wraps', met: false}, {text: 'tests-pass', met: false}]},
        boundary: {writeScope: {include: ['packages/exf-cli/interactive-tui/index.tsx'], exclude: []}},
        proof: {verificationCommands: ['npm-test']},
      },
    });
    expect(messages.at(-1)?.text).toContain('Work item created: work-new');
  });

  it('surfaces invalid /handoff contracts without rejecting the command', async () => {
    const {ctx, messages, createdWork} = buildContext();

    await expect(runInteractiveCommand(ctx, '/handoff Missing proof --files=src/** --acceptance=works')).resolves.toBeUndefined();

    expect(createdWork).toHaveLength(0);
    expect(messages.at(-1)?.text).toContain('/handoff: Invalid Work Contract V1');
  });

  it('builds focus output from the reusable daily context collector', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/focus');

    expect(messages.at(-1)?.text).toContain('Focus');
    expect(messages.at(-1)?.text).toContain('Review agent work');
    expect(messages.at(-1)?.text).toContain('Ship interactive commands');
  });

  it('requires an explicit remember category before storing code memory', async () => {
    const {ctx, messages, apiClient} = buildContext();

    await runInteractiveCommand(ctx, '/remember This repo uses explicit work leases');
    expect(messages.at(-1)?.text).toContain('usage: /remember');
    expect(apiClient.storeCodeMemory).not.toHaveBeenCalled();

    await runInteractiveCommand(ctx, '/remember This repo uses explicit work leases --category architecture');
    expect(apiClient.storeCodeMemory).toHaveBeenCalledWith(
      {
        fact: 'This repo uses explicit work leases',
        category: 'architecture',
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(messages.at(-1)?.text).toContain('Remembered');
  });
});

describe('daily review context library', () => {
  it('keeps the read-only source collection contract reusable', async () => {
    const {apiClient} = buildContext();

    const context = await collectDailyReviewContext(apiClient as any, {
      skipGit: true,
      now: new Date('2026-06-03T12:00:00Z'),
    });

    expect(context.coverage.checked).toEqual([
      'projects',
      'agents',
      'workItems',
      'tasksInProgress',
      'tasksOpenPhase',
      'repositoryIdentities',
      'codeMemories',
      'calendar',
      'vaultMetadata',
    ]);
    expect(context.localGit.skipped).toBe(true);
    expect((context.sources.workItems as any).workItems).toHaveLength(2);
  });
});
