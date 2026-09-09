import {describe, expect, test} from 'bun:test';
import {createChatAgent} from '../agent-harness/framework/chat-agent';
import {InMemorySessionEventStore, SessionKernel} from '../agent-harness/framework/session';
import {projectSearchResult, searchToolFailure, searchToolResult, summarizeSearchResult} from '../searchToolResult';

function data(status = 'partial', clipped = false) {
  return {matches: [] as unknown[], stats: {searchedFiles: 500,
    scan: {status, reasons: status === 'partial' ? ['maxFiles'] : []},
    presentation: {clipped, reasons: clipped ? ['maxSpans'] : []}}};
}

describe('search evidence presentation', () => {
  test('separates zero absence, incomplete scan, failed search, and presentation clipping', () => {
    expect(summarizeSearchResult(data())).toContain('Search incomplete: no matches in 500 files searched; file limit');
    expect(summarizeSearchResult(data('complete'))).toContain('Search complete within eligible files: no matches');
    const clipped = data('complete', true); clipped.matches = [{path: 'a.ts'}, {path: 'b.ts'}];
    expect(summarizeSearchResult(clipped, 'files')).toContain('showing 2 matching files; presentation clipped');
    expect(summarizeSearchResult(clipped)).not.toContain(' of ');
    expect(searchToolResult(data('cancelled'))).toMatchObject({success: false, executionOutcome: 'failed'});
    expect(searchToolFailure(new Error('root must be a directory'))).toMatchObject({
      success: false, message: 'Search failed: root must be a directory',
      data: {stats: {scan: {status: 'failed'}}},
    });
    expect(summarizeSearchResult({matches: [], stats: {}})).toContain('coverage not established');
  });

  test('warning survives model truncation and is identical in history and replay', async () => {
    const source = data();
    source.matches = Array.from({length: 100}, (_, i) => ({path: `${i}.ts`, preview: 'large search evidence '.repeat(100)}));
    const result = searchToolResult(source);
    const store = new InMemorySessionEventStore();
    let requests = 0;
    let modelContent = '';
    const agent = await createChatAgent({memory: false, session: {id: 'search-projection', store},
      toolOutput: {maxBytes: 1024},
      tools: [{name: 'search', description: 'fixture', inputSchema: {type: 'object', properties: {}},
        handler: async () => result, modelResult: projectSearchResult}],
      adapter: {name: 'fixture', model: 'fixture', async chat(messages) {
        if (requests++ === 0) return {toolCall: {id: 'search-1', name: 'search', args: {}}};
        modelContent = messages.find(message => message.role === 'tool')!.content as string;
        expect(modelContent).toContain('Search incomplete');
        expect(modelContent).toContain('file limit');
        return {text: 'Need to narrow the search.'};
      }},
    });
    try {
      await agent.chat('Find the target');
      expect(Buffer.byteLength(modelContent)).toBeLessThanOrEqual(1024);
      expect(agent.getHistory().find(message => message.role === 'tool')!.content).toBe(modelContent);
      const replay = new SessionKernel({sessionId: 'search-projection', store});
      expect(replay.getHistory().find(message => message.role === 'tool')!.content).toBe(modelContent);
      expect(result.data!.matches).toHaveLength(100);
    } finally {await agent.close();}
  });
});
