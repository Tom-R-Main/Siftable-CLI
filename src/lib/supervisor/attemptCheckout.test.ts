import {describe, expect, it} from 'vitest';
import {checkoutPlanProblem, MAX_WRITE_SCOPES, repositoryUrlProblem, writeScopeProblem} from './attemptCheckout.js';

const plan = {repositoryUrl: 'https://github.com/acme/widgets', baseSha: 'a'.repeat(40), writeScope: ['src', 'test/unit']};

describe('checkout plan', () => {
  it('accepts a public GitHub repository, a base commit and distinct directories', () => {
    expect(checkoutPlanProblem(plan)).toBeUndefined();
    expect(repositoryUrlProblem('https://github.com/acme/widgets.git')).toBeUndefined();
    expect(repositoryUrlProblem('https://github.com/a-b/c.d_e')).toBeUndefined();
  });

  it('refuses any URL that could reach another host, carry a credential or change protocol', () => {
    for (const url of [
      'http://github.com/acme/widgets',
      'ssh://git@github.com/acme/widgets',
      'git@github.com:acme/widgets.git',
      'file:///etc/passwd',
      'https://user:token@github.com/acme/widgets',
      'https://github.com:443/acme/widgets',
      'https://github.com.evil.example/acme/widgets',
      'https://evil.example/github.com/acme/widgets',
      'https://github.com/acme/widgets?x=1',
      'https://github.com/acme/widgets#main',
      'https://github.com/acme/widgets/',
      'https://github.com/acme/widgets/tree/main',
      'https://github.com/acme/..',
      'https://github.com/-acme/widgets',
      ' https://github.com/acme/widgets',
      42,
    ]) expect(repositoryUrlProblem(url), String(url)).toBeDefined();
  });

  it('refuses scopes that could name the root, the git directory, a parent or an ambiguous path', () => {
    for (const scope of ['', '/', '/src', 'src/', '.', '..', 'src/../etc', 'a//b', './src', '.git', 'src/.GIT/hooks',
      'src\\lib', 'src\nlib', 'src\u0000', 'x'.repeat(513), 7]) {
      expect(writeScopeProblem(scope), JSON.stringify(scope)).toBeDefined();
    }
    expect(writeScopeProblem('.github/workflows')).toBeUndefined();
    expect(writeScopeProblem('src/.gitkeep-dir')).toBeUndefined();
  });

  it('refuses nested, repeated, missing or too many scopes', () => {
    expect(checkoutPlanProblem({...plan, writeScope: ['src', 'src/lib']})).toMatch(/nest/);
    expect(checkoutPlanProblem({...plan, writeScope: ['src/lib', 'src']})).toMatch(/nest/);
    expect(checkoutPlanProblem({...plan, writeScope: ['src', 'src']})).toMatch(/distinct/);
    expect(checkoutPlanProblem({...plan, writeScope: ['src', 'srcx']})).toBeUndefined();
    expect(checkoutPlanProblem({...plan, writeScope: []})).toBeDefined();
    expect(checkoutPlanProblem({...plan, writeScope: Array.from({length: MAX_WRITE_SCOPES + 1}, (_, i) => `d${i}`)})).toBeDefined();
    expect(checkoutPlanProblem({...plan, writeScope: undefined})).toBeDefined();
  });

  it('refuses a base that is not a full lowercase commit ID', () => {
    for (const baseSha of ['A'.repeat(40), 'a'.repeat(39), 'main', undefined]) expect(checkoutPlanProblem({...plan, baseSha})).toBeDefined();
  });
});
