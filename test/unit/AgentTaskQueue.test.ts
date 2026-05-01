import { describe, it, expect } from 'vitest';
import { AgentTaskQueue } from '../../src/agent/AgentTaskQueue.js';

interface FetchCall { url: string; init?: RequestInit; }

function mockAuth(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  const auth = {
    apiBaseUrl: 'https://api.example.com',
    hostname: 'github.com',
    isEnterprise: false,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // Find first matching route by substring (insertion order).
      for (const key of Object.keys(routes)) {
        if (url.includes(key)) return routes[key]();
      }
      return new Response('not found', { status: 404 });
    },
    getToken: async () => 'tok',
    ghHeaders: () => ({ Authorization: 'Bearer tok' }),
  };
  return { auth, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AgentTaskQueue.pullIssueQueue', () => {
  it('returns [] when no owners are supplied (no API call)', async () => {
    const { auth, calls } = mockAuth({});
    const q = new AgentTaskQueue(auth as never);
    expect(await q.pullIssueQueue([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('maps GitHub issue search results to AgentTask shape', async () => {
    const { auth, calls } = mockAuth({
      '/search/issues': () =>
        jsonResponse({
          items: [
            {
              id: 7,
              title: 'Plan failed',
              body: 'see logs',
              html_url: 'https://github.com/acme/platform/issues/7',
              labels: [{ name: 'agent' }, { name: 'bug' }],
              created_at: '2026-04-01T00:00:00Z',
            },
          ],
        }),
    });
    const tasks = await new AgentTaskQueue(auth as never).pullIssueQueue(['acme']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'gh-issue:7',
      source: 'github-issue',
      title: 'Plan failed',
      body: 'see logs',
      url: 'https://github.com/acme/platform/issues/7',
      repo: 'acme/platform',
      labels: ['agent', 'bug'],
    });
    expect(tasks[0].createdAt).toBe(Date.parse('2026-04-01T00:00:00Z'));
    // URL contains the configured triggerLabel (default "agent") and the owner.
    expect(calls[0].url).toContain('user%3Aacme');
    expect(calls[0].url).toContain('label%3A%22agent%22');
  });

  it('honors a custom triggerLabel', async () => {
    const { auth, calls } = mockAuth({
      '/search/issues': () => jsonResponse({ items: [] }),
    });
    await new AgentTaskQueue(auth as never, 'autorun').pullIssueQueue(['acme']);
    expect(calls[0].url).toContain('label%3A%22autorun%22');
  });

  it('skips owners that error or return non-OK without throwing', async () => {
    let n = 0;
    const { auth } = mockAuth({
      '/search/issues': () => {
        n++;
        if (n === 1) throw new Error('network down');
        if (n === 2) return new Response('rate limited', { status: 429 });
        return jsonResponse({
          items: [{
            id: 9, title: 't', body: '', html_url: 'https://github.com/o/r/issues/9',
            labels: [], created_at: '2026-04-02T00:00:00Z',
          }],
        });
      },
    });
    const tasks = await new AgentTaskQueue(auth as never).pullIssueQueue(['a', 'b', 'c']);
    expect(tasks.map(t => t.id)).toEqual(['gh-issue:9']);
  });

  it('sorts results most-recent-first across owners', async () => {
    const items: Record<string, unknown[]> = {
      a: [{ id: 1, title: 'old', body: '', html_url: 'https://github.com/a/r/issues/1', labels: [], created_at: '2026-01-01T00:00:00Z' }],
      b: [{ id: 2, title: 'new', body: '', html_url: 'https://github.com/b/r/issues/2', labels: [], created_at: '2026-04-15T00:00:00Z' }],
    };
    let i = 0;
    const owners = ['a', 'b'];
    const { auth } = mockAuth({
      '/search/issues': () => jsonResponse({ items: items[owners[i++]] }),
    });
    const tasks = await new AgentTaskQueue(auth as never).pullIssueQueue(owners);
    expect(tasks.map(t => t.title)).toEqual(['new', 'old']);
  });
});
