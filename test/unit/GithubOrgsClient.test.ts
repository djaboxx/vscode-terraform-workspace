import { describe, it, expect } from 'vitest';
import { GithubOrgsClient } from '../../src/github/GithubOrgsClient.js';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function mockAuth(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  return {
    calls,
    auth: {
      apiBaseUrl: 'https://api.example.com',
      getToken: async () => 'tok',
      ghHeaders: () => ({ Authorization: 'Bearer tok' }),
      fetch: async (url: string) => {
        calls.push(url);
        return handler(url);
      },
    },
  };
}

describe('GithubOrgsClient.listTeams / listTeamSlugs', () => {
  it('returns parsed teams', async () => {
    const { auth, calls } = mockAuth(() => json([
      { id: 1, name: 'Platform', slug: 'platform' },
      { id: 2, name: 'Security', slug: 'security' },
    ]));
    const teams = await new GithubOrgsClient(auth as never).listTeams('acme');
    expect(teams.map(t => t.slug)).toEqual(['platform', 'security']);
    expect(calls[0]).toContain('/orgs/acme/teams?per_page=100');
  });

  it('listTeamSlugs returns just the slugs', async () => {
    const { auth } = mockAuth(() => json([{ id: 1, name: 'A', slug: 'a' }]));
    expect(await new GithubOrgsClient(auth as never).listTeamSlugs('acme')).toEqual(['a']);
  });

  it('returns [] on API error', async () => {
    const { auth } = mockAuth(() => new Response('', { status: 403 }));
    expect(await new GithubOrgsClient(auth as never).listTeams('acme')).toEqual([]);
  });
});

describe('GithubOrgsClient.listTerraformRepos', () => {
  it('returns owner/name slugs', async () => {
    const { auth, calls } = mockAuth(() => json({ items: [{ name: 'platform' }, { name: 'modules' }] }));
    const repos = await new GithubOrgsClient(auth as never).listTerraformRepos('acme');
    expect(repos).toEqual(['acme/platform', 'acme/modules']);
    expect(calls[0]).toContain('topic:terraform-managed');
  });
});

describe('GithubOrgsClient.getOrgVariableSet', () => {
  it('aggregates secrets+variables into a TfVariableSet', async () => {
    const { auth } = mockAuth(url => {
      if (url.includes('/secrets')) return json({ secrets: [{ name: 'TOKEN', created_at: '', updated_at: 'u1' }] });
      if (url.includes('/variables')) return json({ variables: [{ name: 'REGION', value: 'us-east-1', created_at: '', updated_at: 'u2' }] });
      return new Response('', { status: 404 });
    });
    const set = await new GithubOrgsClient(auth as never).getOrgVariableSet('acme');
    expect(set.id).toBe('org:acme');
    expect(set.global).toBe(true);
    expect(set.variables).toHaveLength(2);
    const sec = set.variables.find(v => v.key === 'TOKEN');
    expect(sec?.sensitive).toBe(true);
  });
});
