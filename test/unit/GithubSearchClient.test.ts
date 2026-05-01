import { describe, it, expect } from 'vitest';
import { GithubSearchClient } from '../../src/github/GithubSearchClient.js';

function mockAuth(routes: Array<(url: string) => Response | Promise<Response>>) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    auth: {
      apiBaseUrl: 'https://api.example.com',
      getToken: async () => 'tok',
      ghHeaders: () => ({ Authorization: 'Bearer tok', Accept: 'application/vnd.github+json' }),
      fetch: async (url: string) => {
        calls.push(url);
        return routes[Math.min(i++, routes.length - 1)](url);
      },
    },
  };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('GithubSearchClient.searchOrgCode', () => {
  it('returns empty when there is no token', async () => {
    const auth = { apiBaseUrl: 'x', getToken: async () => undefined, ghHeaders: () => ({}), fetch: async () => new Response() };
    const c = new GithubSearchClient(auth as never);
    const r = await c.searchOrgCode('q', 'acme');
    expect(r).toEqual({ totalCount: 0, incompleteResults: true, items: [] });
  });

  it('builds the query with org+qualifiers and uses the text-match Accept header', async () => {
    let acceptHeader: string | undefined;
    const { auth, calls } = mockAuth([
      (_url: string) => {
        return json({ total_count: 0, incomplete_results: false, items: [] });
      },
    ]);
    // Patch to capture headers.
    const origFetch = auth.fetch;
    auth.fetch = async (url: string, init?: RequestInit) => {
      acceptHeader = (init?.headers as Record<string, string> | undefined)?.['Accept'];
      return origFetch(url);
    };
    await new GithubSearchClient(auth as never).searchOrgCode('aws_s3_bucket', 'acme', 5, ['language:hcl']);
    expect(calls[0]).toContain('per_page=5');
    expect(decodeURIComponent(calls[0])).toContain('aws_s3_bucket org:acme language:hcl');
    expect(acceptHeader).toBe('application/vnd.github.text-match+json');
  });

  it('flattens text_matches into fragments and maps repository.full_name', async () => {
    const { auth } = mockAuth([
      () => json({
        total_count: 1,
        incomplete_results: false,
        items: [{
          name: 'main.tf', path: 'modules/vpc/main.tf',
          html_url: 'https://github.com/acme/x/blob/sha/modules/vpc/main.tf',
          sha: 'abc', repository: { full_name: 'acme/x' },
          text_matches: [{ fragment: 'aws_s3_bucket "x"' }, { fragment: '' }, { fragment: 'replication' }],
        }],
      }),
    ]);
    const r = await new GithubSearchClient(auth as never).searchOrgCode('q', 'acme');
    expect(r.totalCount).toBe(1);
    expect(r.items[0].repoFullName).toBe('acme/x');
    expect(r.items[0].fragments).toEqual(['aws_s3_bucket "x"', 'replication']);
  });

  it('throws a 403-specific message that names the org', async () => {
    const { auth } = mockAuth([() => new Response('forbidden', { status: 403 })]);
    await expect(new GithubSearchClient(auth as never).searchOrgCode('q', 'acme'))
      .rejects.toThrow(/403[\s\S]*acme/);
  });

  it('throws a 422-specific message', async () => {
    const { auth } = mockAuth([() => new Response('bad query', { status: 422 })]);
    await expect(new GithubSearchClient(auth as never).searchOrgCode('q', 'acme'))
      .rejects.toThrow(/422 Unprocessable Entity/);
  });

  it('throws a generic error for other failures', async () => {
    const { auth } = mockAuth([() => new Response('boom', { status: 500 })]);
    await expect(new GithubSearchClient(auth as never).searchOrgCode('q', 'acme'))
      .rejects.toThrow(/error 500/);
  });
});
