import {
  requestConfirm,
  resolveConfirm,
  requestApproval,
  resolveApproval,
  isBypassing,
  resetBypass,
  rejectAllConfirms,
  setConfirmListener,
  pendingConfirmCount,
  type ConfirmRequest,
} from '../../interactive-tui/confirmGate';

describe('sift interactive — write/edit confirm gate', () => {
  afterEach(() => {
    rejectAllConfirms();
    setConfirmListener(null);
    resetBypass();
  });

  it('denies when no UI is listening (safe default — never writes unattended)', async () => {
    await expect(requestConfirm({kind: 'write', path: '/x', detail: '1 byte'})).resolves.toBe(false);
    expect(pendingConfirmCount()).toBe(0);
  });

  it('resolves true when the UI approves', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => {
      captured = req;
    });
    const promise = requestConfirm({kind: 'write', path: '/repo/a.txt', detail: '12 bytes'});
    expect(pendingConfirmCount()).toBe(1);
    expect(captured!).toMatchObject({kind: 'write', path: '/repo/a.txt', detail: '12 bytes'});
    resolveConfirm(captured!.id, true);
    await expect(promise).resolves.toBe(true);
    expect(pendingConfirmCount()).toBe(0);
  });

  it('resolves false when the UI declines', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => {
      captured = req;
    });
    const promise = requestConfirm({kind: 'edit', path: '/repo/b.txt', detail: 'replace 3→5 chars'});
    resolveConfirm(captured!.id, false);
    await expect(promise).resolves.toBe(false);
  });

  it('ignores resolveConfirm for unknown/stale ids', () => {
    expect(() => resolveConfirm('does-not-exist', true)).not.toThrow();
  });

  it('rejectAllConfirms denies every pending request', async () => {
    setConfirmListener(() => {});
    const a = requestConfirm({kind: 'write', path: '/repo/a', detail: 'a'});
    const b = requestConfirm({kind: 'write', path: '/repo/b', detail: 'b'});
    expect(pendingConfirmCount()).toBe(2);
    rejectAllConfirms();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    expect(pendingConfirmCount()).toBe(0);
  });
});

describe('sift interactive — 4-way approval gate', () => {
  afterEach(() => {
    rejectAllConfirms();
    setConfirmListener(null);
    resetBypass();
  });

  it('denies (decision "deny") when no UI is listening', async () => {
    await expect(requestApproval({kind: 'command', path: 'rm -rf /', detail: ''})).resolves.toBe('deny');
  });

  it('resolves each of the four decisions', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => { captured = req; });
    for (const decision of ['allow', 'always', 'deny'] as const) {
      const p = requestApproval({kind: 'command', path: `echo ${decision}`, detail: 'cwd=/repo'});
      resolveApproval(captured!.id, decision);
      await expect(p).resolves.toBe(decision);
    }
  });

  it('defaults allowAlways to true on the surfaced request', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => { captured = req; });
    const p = requestApproval({kind: 'edit', path: '/repo/a.ts', detail: 'replace 2→3'});
    expect(captured!.allowAlways).toBe(true);
    expect(captured!.allowBypass).toBe(true);
    resolveApproval(captured!.id, 'allow');
    await p;
  });

  it('can suppress session-wide bypass on sensitive approvals', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => { captured = req; });
    const p = requestApproval({
      kind: 'command',
      path: 'vault read API key',
      detail: 'Use secret for this session',
      allowAlways: false,
      allowBypass: false,
    });
    expect(captured!.allowAlways).toBe(false);
    expect(captured!.allowBypass).toBe(false);
    resolveApproval(captured!.id, 'allow');
    await expect(p).resolves.toBe('allow');
  });

  it('"bypass" lifts the gate for the rest of the session', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => { captured = req; });
    const first = requestApproval({kind: 'command', path: 'ls', detail: ''});
    expect(isBypassing()).toBe(false);
    resolveApproval(captured!.id, 'bypass');
    await expect(first).resolves.toBe('bypass');
    expect(isBypassing()).toBe(true);

    // Subsequent requests auto-allow without ever reaching the UI.
    setConfirmListener(null);
    await expect(requestApproval({kind: 'command', path: 'whoami', detail: ''})).resolves.toBe('allow');
    expect(pendingConfirmCount()).toBe(0);
  });

  it('the boolean shim maps allow/always over deny', async () => {
    let captured: ConfirmRequest | null = null;
    setConfirmListener((req) => { captured = req; });
    const p = requestConfirm({kind: 'write', path: '/repo/x', detail: '1 byte'});
    resolveApproval(captured!.id, 'always');
    await expect(p).resolves.toBe(true);
  });
});
