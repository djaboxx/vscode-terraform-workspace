import { describe, it, expect } from 'vitest';
import { GithubActionsClient } from '../../src/github/GithubActionsClient.js';

interface RouteCall { url: string; init?: RequestInit; }

function mockAuth(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: RouteCall[] = [];
  return {
    calls,
    auth: {
      apiBaseUrl: 'https://api.example.com',
      hostname: 'github.com',
      isEnterprise: false,
      getToken: async () => 'tok',
      ghHeaders: () => ({ Authorization: 'Bearer tok' }),
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      },
    },
  };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const sampleRun = (overrides: Record<string, unknown> = {}) => ({
  id: 1, name: 'plan', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/o/r/actions/runs/1', head_sha: 'abc',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:01:00Z',
  run_number: 42, actor: { login: 'alice' }, triggering_actor: { login: 'bob' },
  ...overrides,
});

describe('GithubActionsClient', () => {
  describe('triggerWorkflow', () => {
    it('POSTs to the dispatches endpoint with ref + inputs', async () => {
      const { auth, calls } = mockAuth(() => new Response(null, { status: 204 }));
      await new GithubActionsClient(auth as never).triggerWorkflow(
        'acme', 'platform', 'plan.yml',
        { workspace: 'prod' }, 'release/1.0',
      );
      expect(calls[0].url).toBe(
        'https://api.example.com/repos/acme/platform/actions/workflows/plan.yml/dispatches',
      );
      expect(calls[0].init?.method).toBe('POST');
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body).toEqual({ ref: 'release/1.0', inputs: { workspace: 'prod' } });
    });

    it('defaults ref to "main" when not provided', async () => {
      const { auth, calls } = mockAuth(() => new Response(null, { status: 204 }));
      await new GithubActionsClient(auth as never).triggerWorkflow('o', 'r', 'wf.yml', { workspace: 'd' });
      expect(JSON.parse(calls[0].init?.body as string).ref).toBe('main');
    });

    it('throws with status + body on failure', async () => {
      const { auth } = mockAuth(() => new Response('forbidden', { status: 403 }));
      await expect(new GithubActionsClient(auth as never).triggerWorkflow('o', 'r', 'w.yml', { workspace: 'd' }))
        .rejects.toThrow(/403[\s\S]*forbidden/);
    });
  });

  describe('getWorkflowRuns', () => {
    it('returns [] when token missing', async () => {
      const auth = { apiBaseUrl: 'x', getToken: async () => undefined, ghHeaders: () => ({}), fetch: async () => new Response() };
      expect(await new GithubActionsClient(auth as never).getWorkflowRuns('o', 'r', 'w.yml')).toEqual([]);
    });

    it('returns [] on non-OK response', async () => {
      const { auth } = mockAuth(() => new Response('', { status: 500 }));
      expect(await new GithubActionsClient(auth as never).getWorkflowRuns('o', 'r', 'w.yml')).toEqual([]);
    });

    it('parses workflow_runs array on success', async () => {
      const { auth } = mockAuth(() => json({ workflow_runs: [sampleRun(), sampleRun({ id: 2 })] }));
      const runs = await new GithubActionsClient(auth as never).getWorkflowRuns('o', 'r', 'w.yml', 5);
      expect(runs.map(r => r.id)).toEqual([1, 2]);
    });
  });

  describe('getRunById', () => {
    it('returns undefined on non-OK', async () => {
      const { auth } = mockAuth(() => new Response('', { status: 404 }));
      expect(await new GithubActionsClient(auth as never).getRunById('o', 'r', 1)).toBeUndefined();
    });
    it('returns the run on success', async () => {
      const { auth } = mockAuth(() => json(sampleRun({ id: 99 })));
      expect((await new GithubActionsClient(auth as never).getRunById('o', 'r', 99))?.id).toBe(99);
    });
  });

  describe('toTfRun', () => {
    it('maps GHA run shape to internal TfRun, preferring triggering_actor', () => {
      const c = new GithubActionsClient({ apiBaseUrl: '', getToken: async () => '', ghHeaders: () => ({}), fetch: async () => new Response() } as never);
      const r = c.toTfRun(sampleRun(), 'ws-1', 'o/r', 'plan' as never);
      expect(r).toMatchObject({
        id: 1, type: 'plan', workspaceId: 'ws-1', repoSlug: 'o/r', workflowRunId: 1,
        status: 'completed', conclusion: 'success', triggeredBy: 'bob', commitSha: 'abc',
      });
    });

    it('falls back to actor when triggering_actor is missing', () => {
      const c = new GithubActionsClient({ apiBaseUrl: '', getToken: async () => '', ghHeaders: () => ({}), fetch: async () => new Response() } as never);
      const r = c.toTfRun(sampleRun({ triggering_actor: null }), 'ws', 'o/r', 'apply' as never);
      expect(r.triggeredBy).toBe('alice');
    });
  });

  describe('listPendingDeployments / reviewDeployments', () => {
    it('returns [] when listing fails', async () => {
      const { auth } = mockAuth(() => new Response('', { status: 404 }));
      expect(await new GithubActionsClient(auth as never).listPendingDeployments('o', 'r', 1)).toEqual([]);
    });

    it('POSTs review payload with environment_ids/state/comment', async () => {
      const { auth, calls } = mockAuth(() => new Response('', { status: 200 }));
      const ok = await new GithubActionsClient(auth as never)
        .reviewDeployments('o', 'r', 5, [10, 20], 'approved', 'lgtm');
      expect(ok).toBe(true);
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({
        environment_ids: [10, 20], state: 'approved', comment: 'lgtm',
      });
    });
  });

  describe('waitForRun', () => {
    it('returns when the run reaches completed', async () => {
      let n = 0;
      const { auth } = mockAuth(() => json(sampleRun({ status: ++n < 2 ? 'in_progress' : 'completed' })));
      const out = { lines: [] as string[], appendLine: (s: string) => out.lines.push(s) } as never;
      const r = await new GithubActionsClient(auth as never)
        .waitForRun('o', 'r', 1, out, 1 /* tight loop */);
      expect(r.status).toBe('completed');
      // Should have logged at least one status line.
      expect((out as unknown as { lines: string[] }).lines.length).toBeGreaterThanOrEqual(1);
    });
  });
});
