import {runInteractiveCommand, commandSuggestions} from '../../interactive-tui/commands';
import {inspectSessionEvents} from '../../interactive-tui/requestInspection';
import {buildCommandContext} from '../helpers/interactive-command-context';

describe('/context inspection', () => {
  it.each(['', ' request', ' events'])('renders recorded inspection%s without sending an agent turn', async suffix => {
    const inspection = inspectSessionEvents([], []);
    const {ctx, messages} = buildCommandContext({inspectThread: jest.fn(async () => ({sessionId: 'fixture', eventCount: 0, messageCount: 0, inspection}))});
    await runInteractiveCommand(ctx, `/context${suffix}`);
    expect(messages).toHaveLength(1);
    expect(ctx.submit).not.toHaveBeenCalled();
    expect(ctx.inspectThread).toHaveBeenCalledTimes(1);
    expect(messages[0]?.text).toMatch(/Context:|No recorded model request|Journal events:/);
  });
  it('explains when the active harness lacks inspection', async () => {
    const {ctx, messages} = buildCommandContext({inspectThread: undefined});
    await runInteractiveCommand(ctx, '/context');
    expect(messages[0]?.text).toContain('unavailable for the active harness');
  });
  it('rejects unsupported parts without inspecting or sending', async () => {
    const inspectThread = jest.fn();
    const {ctx, messages} = buildCommandContext({inspectThread});
    await runInteractiveCommand(ctx, '/context invalid');
    expect(messages[0]?.text).toContain('usage: /context');
    expect(inspectThread).not.toHaveBeenCalled();
    expect(ctx.submit).not.toHaveBeenCalled();
  });
  it('surfaces journal validation failures', async () => {
    const {ctx, messages} = buildCommandContext({inspectThread: jest.fn(async () => {throw new Error('history digest mismatch');})});
    await runInteractiveCommand(ctx, '/context request');
    expect(messages[0]?.text).toContain('Could not inspect session context: history digest mismatch');
  });
  it('appears in command discovery', () => {
    expect(commandSuggestions().some(command => command.name === 'context')).toBe(true);
  });
});
