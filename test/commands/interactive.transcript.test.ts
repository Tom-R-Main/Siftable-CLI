import {serializeConversation, type TranscriptMessage} from '../../interactive-tui/transcript';

// A realistic transcript including every kind of chrome row the TUI pushes:
// the system header/status, a tool-call line, and shell output.
const sample: TranscriptMessage[] = [
  {role: 'system', text: 'sift interactive — ask about your work · type / for commands'},
  {role: 'you', text: 'give me a haiku'},
  {role: 'tool', text: '⚙ read_file index.tsx'},
  {
    role: 'assistant',
    text: 'Code flows like a stream,\nTasks are waiting in the queue,\nLet us build today.',
  },
  {role: 'shell', text: '$ ls\n[exit 0]'},
  {role: 'system', text: 'ready · google/gemini-3.5-flash'},
];

describe('sift interactive transcript serialization', () => {
  it('includes only you and siftable turns', () => {
    const out = serializeConversation(sample);
    expect(out).toContain('you: give me a haiku');
    expect(out).toContain('siftable: Code flows like a stream,');
    // Chrome roles must be dropped entirely.
    expect(out).not.toContain('read_file');
    expect(out).not.toContain('$ ls');
    expect(out).not.toContain('ask about your work');
  });

  // The brutal-simple guard: a copied transcript must never contain terminal
  // chrome. If any of these show up, we're serializing rendered cells / chrome
  // rows instead of the conversation.
  it('never leaks terminal chrome into the clipboard payload', () => {
    const out = serializeConversation(sample);
    for (const chrome of ['┌', '┐', '└', '┘', '│', 'sift interactive', 'ready ·', '›type a message']) {
      expect(out).not.toContain(chrome);
    }
  });

  it('drops empty/whitespace turns and trims', () => {
    expect(
      serializeConversation([
        {role: 'you', text: '   '},
        {role: 'assistant', text: ''},
      ]),
    ).toBe('');
    expect(serializeConversation([{role: 'assistant', text: '  hi  '}])).toBe('siftable: hi');
  });

  it('returns empty string for an empty transcript', () => {
    expect(serializeConversation([])).toBe('');
  });
});
