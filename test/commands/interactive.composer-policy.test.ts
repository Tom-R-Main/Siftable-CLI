import {analyzePaste} from '../../interactive-tui/composerPolicy';

describe('sift interactive composer policy', () => {
  it('keeps small pastes inline', () => {
    expect(analyzePaste('hello')).toMatchObject({
      chars: 5,
      lines: 1,
      decision: 'inline',
    });
  });

  it('chips multi-line pastes at the locked threshold', () => {
    expect(analyzePaste(Array(13).fill('line').join('\n'))).toMatchObject({
      lines: 13,
      decision: 'chip',
    });
  });

  it('chips obvious structured pastes earlier', () => {
    const text = `${Array(6).fill('- item').join('\n')}\n${'a'.repeat(1000)}`;
    expect(analyzePaste(text)).toMatchObject({
      structured: true,
      decision: 'chip',
    });
  });
});
