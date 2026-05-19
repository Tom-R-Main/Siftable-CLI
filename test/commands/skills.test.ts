import {runCommand} from '../helpers/mock-api';

describe('skills commands', () => {
  it('lists canonical skillpacks', async () => {
    const result = await runCommand(['skills', 'list', '--json']);
    const json = JSON.parse(result.stdout);

    expect(json.ok).toBe(true);
    expect(json.skillpacks.some((skillpack: {id: string}) => skillpack.id === 'grounding')).toBe(true);
  });
});
