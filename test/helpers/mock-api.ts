import path from 'path';

const API_URL = 'https://siftable.io';

/**
 * Mock global.fetch to intercept API calls.
 * Returns a builder for setting up expected requests and responses.
 */
export function mockFetch(): MockFetchBuilder {
  return new MockFetchBuilder();
}

interface MockRoute {
  method: string;
  pathPattern: string;
  queryMatcher?: (url: URL) => boolean;
  bodyMatcher?: (body: unknown) => boolean;
  status: number;
  response: unknown;
}

class MockFetchBuilder {
  private routes: MockRoute[] = [];

  on(method: string, pathPattern: string): MockRouteBuilder {
    return new MockRouteBuilder(this, method, pathPattern);
  }

  addRoute(route: MockRoute): void {
    this.routes.push(route);
  }

  install(): void {
    const routes = this.routes;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = (init?.method || 'GET').toUpperCase();
      const reqPath = url.pathname;

      let body: unknown;
      if (init?.body) {
        try { body = JSON.parse(init.body as string); } catch { body = init.body; }
      }

      for (const route of routes) {
        if (route.method !== method) continue;
        if (reqPath !== route.pathPattern) continue;
        if (route.queryMatcher && !route.queryMatcher(url)) continue;
        if (route.bodyMatcher && !route.bodyMatcher(body)) continue;

        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          headers: new Headers({'content-type': 'application/json'}),
          text: async () => JSON.stringify(route.response),
          json: async () => route.response,
        } as Response;
      }

      // No match — return network error
      return {
        ok: false,
        status: 500,
        headers: new Headers({'content-type': 'application/json'}),
        text: async () => JSON.stringify({error: `No mock for ${method} ${reqPath}`}),
        json: async () => ({error: `No mock for ${method} ${reqPath}`}),
      } as Response;
    }) as jest.Mock;
  }
}

class MockRouteBuilder {
  private parent: MockFetchBuilder;
  private method: string;
  private pathPattern: string;
  private _bodyMatcher?: (body: unknown) => boolean;
  private _queryMatcher?: (url: URL) => boolean;

  constructor(parent: MockFetchBuilder, method: string, pathPattern: string) {
    this.parent = parent;
    this.method = method.toUpperCase();
    this.pathPattern = pathPattern;
  }

  query(matcher: Record<string, string> | true | ((url: URL) => boolean)): this {
    if (matcher === true) {
      this._queryMatcher = () => true;
    } else if (typeof matcher === 'function') {
      this._queryMatcher = matcher;
    } else {
      this._queryMatcher = (url: URL) => {
        for (const [key, value] of Object.entries(matcher)) {
          if (url.searchParams.get(key) !== value) return false;
        }
        return true;
      };
    }
    return this;
  }

  body(matcher: (body: unknown) => boolean): this {
    this._bodyMatcher = matcher;
    return this;
  }

  reply(status: number, response: unknown): MockFetchBuilder {
    this.parent.addRoute({
      method: this.method,
      pathPattern: this.pathPattern,
      queryMatcher: this._queryMatcher,
      bodyMatcher: this._bodyMatcher,
      status,
      response,
    });
    return this.parent;
  }
}

export const fixtures = {
  task: (overrides: Record<string, unknown> = {}) => ({
    id: 'task-001',
    title: 'Test task',
    status: 'inbox',
    priority: 'schedule',
    description: null,
    dueAt: null,
    projectId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }),

  project: (overrides: Record<string, unknown> = {}) => ({
    id: 'proj-001',
    name: 'Test project',
    status: 'active',
    emoji: '🚀',
    summary: 'A test project',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }),

  note: (overrides: Record<string, unknown> = {}) => ({
    id: 'note-001',
    title: 'Test note',
    noteType: 'note',
    content: 'Test content',
    projectId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }),

  event: (overrides: Record<string, unknown> = {}) => ({
    id: 'event-001',
    title: 'Test event',
    startTime: '2026-03-01T09:00:00Z',
    endTime: '2026-03-01T10:00:00Z',
    description: null,
    location: null,
    ...overrides,
  }),

  person: (overrides: Record<string, unknown> = {}) => ({
    id: 'person-001',
    name: 'Test Person',
    email: 'test@example.com',
    phone: null,
    company: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }),

  vaultEntry: (overrides: Record<string, unknown> = {}) => ({
    id: 'vault-001',
    name: 'Test Secret',
    entryType: 'credential',
    slug: 'test-secret',
    category: null,
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }),

  repository: (overrides: Record<string, unknown> = {}) => ({
    id: 'repo-001',
    name: 'test-repo',
    rootPath: '/tmp/repo',
    status: 'indexed',
    filesIndexed: 42,
    lastIndexedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  }),

  memory: (overrides: Record<string, unknown> = {}) => ({
    id: 'mem-001',
    content: 'Test fact',
    factType: 'code.convention',
    filePath: null,
    repositoryId: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }),
};

const originalFetch = global.fetch;

export function restoreFetch(): void {
  global.fetch = originalFetch;
}

/**
 * Run a CLI command and capture output.
 */
export async function runCommand(argv: string[]): Promise<{stdout: string; error?: Error; exitCode?: number}> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];

  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = () => {};
  console.warn = () => {};

  let error: Error | undefined;
  let exitCode = 0;

  try {
    const {run} = require('@oclif/core');
    await run(argv, {root: path.join(__dirname, '..', '..')});
    exitCode = process.exitCode ?? 0;
  } catch (err: any) {
    error = err;
    exitCode = err.oclif?.exit ?? 1;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.exitCode = originalExitCode;
  }

  return {stdout: lines.join('\n'), error, exitCode};
}
