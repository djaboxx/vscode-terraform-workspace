import { describe, it, expect } from 'vitest';
import { GithubModuleClient } from '../../src/github/GithubModuleClient.js';

function mockAuth(routeFn: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  return {
    calls,
    auth: {
      apiBaseUrl: 'https://api.example.com',
      getToken: async (silent?: boolean) => (silent === false ? 'tok' : 'tok'),
      ghHeaders: () => ({ Authorization: 'Bearer tok' }),
      fetch: async (url: string) => {
        calls.push(url);
        return routeFn(url);
      },
    },
  };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('GithubModuleClient.listOrgModules', () => {
  it('returns [] when there is no token', async () => {
    const auth = {
      apiBaseUrl: 'x',
      getToken: async () => undefined,
      ghHeaders: () => ({}),
      fetch: async () => new Response(),
    };
    expect(await new GithubModuleClient(auth as never).listOrgModules('acme')).toEqual([]);
  });

  it('filters search hits to only those with terraform- prefix', async () => {
    const { auth } = mockAuth(url => {
      if (url.includes('/search/repositories')) {
        return json({
          items: [
            { full_name: 'acme/terraform-aws-vpc', owner: { login: 'acme' }, name: 'terraform-aws-vpc',
              description: 'VPC', clone_url: 'https://github.com/acme/terraform-aws-vpc.git',
              html_url: 'https://github.com/acme/terraform-aws-vpc' },
            // Should be filtered out — name doesn't start with terraform-
            { full_name: 'acme/docs-terraform-howto', owner: { login: 'acme' }, name: 'docs-terraform-howto',
              description: 'docs', clone_url: 'x', html_url: 'x' },
          ],
        });
      }
      if (url.includes('/releases/latest')) {
        return json({ tag_name: 'v1.2.0' });
      }
      return new Response('nope', { status: 404 });
    });
    const mods = await new GithubModuleClient(auth as never).listOrgModules('acme');
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      fullName: 'acme/terraform-aws-vpc',
      owner: 'acme',
      name: 'terraform-aws-vpc',
      latestTag: 'v1.2.0',
      sourceUrl: 'git::https://github.com/acme/terraform-aws-vpc.git?ref=v1.2.0',
    });
  });

  it('falls back to a tagless source URL when no release exists', async () => {
    const { auth } = mockAuth(url => {
      if (url.includes('/search/repositories')) {
        return json({
          items: [{ full_name: 'a/terraform-x', owner: { login: 'a' }, name: 'terraform-x',
            description: '', clone_url: 'x', html_url: 'x' }],
        });
      }
      // Releases endpoint returns 404 → triggers fallback path.
      return new Response('', { status: 404 });
    });
    const mods = await new GithubModuleClient(auth as never).listOrgModules('a');
    expect(mods[0].sourceUrl).toBe('git::https://github.com/a/terraform-x.git');
    expect(mods[0].latestTag).toBeUndefined();
  });

  it('returns [] when search itself returns non-OK', async () => {
    const { auth } = mockAuth(() => new Response('rate limited', { status: 429 }));
    expect(await new GithubModuleClient(auth as never).listOrgModules('acme')).toEqual([]);
  });
});
