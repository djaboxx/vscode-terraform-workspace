import { describe, it, expect } from 'vitest';
import { GithubEnvironmentsClient } from '../../src/github/GithubEnvironmentsClient.js';

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

describe('GithubEnvironmentsClient.listEnvironments', () => {
  it('returns [] without a token', async () => {
    const auth = { apiBaseUrl: 'x', getToken: async () => undefined, ghHeaders: () => ({}), fetch: async () => new Response() };
    expect(await new GithubEnvironmentsClient(auth as never).listEnvironments('o', 'r')).toEqual([]);
  });

  it('returns [] on non-OK', async () => {
    const { auth } = mockAuth(() => new Response('', { status: 500 }));
    expect(await new GithubEnvironmentsClient(auth as never).listEnvironments('o', 'r')).toEqual([]);
  });

  it('parses the environments array', async () => {
    const { auth, calls } = mockAuth(() => json({
      environments: [
        { id: 1, name: 'dev', html_url: 'u', created_at: 'c', updated_at: 'u' },
        { id: 2, name: 'prod', html_url: 'u', created_at: 'c', updated_at: 'u' },
      ],
    }));
    const envs = await new GithubEnvironmentsClient(auth as never).listEnvironments('o', 'r');
    expect(envs.map(e => e.name)).toEqual(['dev', 'prod']);
    expect(calls[0].url).toContain('/repos/o/r/environments?per_page=100');
  });
});

describe('GithubEnvironmentsClient.toTfWorkspace', () => {
  it('maps GhaEnvironment → TfWorkspace shape', () => {
    const c = new GithubEnvironmentsClient({} as never);
    const tw = c.toTfWorkspace(
      { id: 1, name: 'prod', html_url: 'h', created_at: 'a', updated_at: 'u' },
      'acme', 'platform', 'org-1',
    );
    expect(tw).toMatchObject({
      id: 'acme/platform/prod', name: 'prod', orgId: 'org-1',
      repoSlug: 'acme/platform', branch: 'main', workingDirectory: '.',
      isActive: false, htmlUrl: 'h', updatedAt: 'u',
    });
  });
});

describe('GithubEnvironmentsClient.toTfVariables', () => {
  it('marks secrets sensitive=true and variables sensitive=false', () => {
    const c = new GithubEnvironmentsClient({} as never);
    const out = c.toTfVariables(
      [{ name: 'TFE_TOKEN', created_at: '', updated_at: 'u1' }],
      [{ name: 'AWS_REGION', value: 'us-east-1', created_at: '', updated_at: 'u2' }],
      'environment' as never, 'dev', 'o/r', 'org-1',
    );
    expect(out).toHaveLength(2);
    const sec = out.find(v => v.key === 'TFE_TOKEN')!;
    expect(sec.sensitive).toBe(true);
    expect((sec as unknown as { value?: string }).value).toBeUndefined();
    const v = out.find(x => x.key === 'AWS_REGION')!;
    expect(v.sensitive).toBe(false);
    expect((v as unknown as { value?: string }).value).toBe('us-east-1');
  });
});

describe('GithubEnvironmentsClient.listOrgVariables / listOrgSecrets', () => {
  it('returns parsed variables', async () => {
    const { auth, calls } = mockAuth(() => json({
      variables: [{ name: 'V', value: '1', created_at: '', updated_at: '' }],
    }));
    const v = await new GithubEnvironmentsClient(auth as never).listOrgVariables('acme');
    expect(v.map(x => x.name)).toEqual(['V']);
    expect(calls[0].url).toContain('/orgs/acme/actions/variables');
  });

  it('returns parsed secrets', async () => {
    const { auth } = mockAuth(() => json({
      secrets: [{ name: 'S', created_at: '', updated_at: '' }],
    }));
    const s = await new GithubEnvironmentsClient(auth as never).listOrgSecrets('acme');
    expect(s.map(x => x.name)).toEqual(['S']);
  });
});

describe('GithubEnvironmentsClient.setOrgVariable', () => {
  it('upserts via PATCH then POSTs on 404', async () => {
    let n = 0;
    const { auth, calls } = mockAuth(() => {
      n++;
      if (n === 1) return new Response('not found', { status: 404 });
      return new Response(null, { status: 201 });
    });
    await new GithubEnvironmentsClient(auth as never).setOrgVariable('acme', 'V', 'x');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ name: 'V', value: 'x', visibility: 'all' });
  });

  it('does not POST when PATCH succeeds', async () => {
    const { auth, calls } = mockAuth(() => new Response(null, { status: 204 }));
    await new GithubEnvironmentsClient(auth as never).setOrgVariable('acme', 'V', 'x');
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('PATCH');
  });

  it('throws with the response body on failure', async () => {
    const { auth } = mockAuth(() => new Response('bad', { status: 400 }));
    await expect(new GithubEnvironmentsClient(auth as never).setOrgVariable('acme', 'V', 'x'))
      .rejects.toThrow(/Failed to set org variable V[\s\S]*bad/);
  });
});

describe('GithubEnvironmentsClient.listRepoSecrets / listRepoVariables', () => {
  it('returns repo-level secrets', async () => {
    const { auth, calls } = mockAuth(() => json({
      secrets: [{ name: 'GH_TOKEN', created_at: '', updated_at: '' }],
    }));
    const s = await new GithubEnvironmentsClient(auth as never).listRepoSecrets('o', 'r');
    expect(s.map(x => x.name)).toEqual(['GH_TOKEN']);
    expect(calls[0].url).toContain('/repos/o/r/actions/secrets?per_page=100');
  });

  it('returns repo-level variables', async () => {
    const { auth } = mockAuth(() => json({
      variables: [{ name: 'REGION', value: 'us-east-1', created_at: '', updated_at: '' }],
    }));
    const v = await new GithubEnvironmentsClient(auth as never).listRepoVariables('o', 'r');
    expect(v.map(x => x.name)).toEqual(['REGION']);
  });
});

describe('GithubEnvironmentsClient.upsertEnvironment', () => {
  it('PUTs only the fields that are set', async () => {
    const { auth, calls } = mockAuth(() => new Response(null, { status: 200 }));
    await new GithubEnvironmentsClient(auth as never).upsertEnvironment('o', 'r', 'prod', {
      waitTimer: 5,
      preventSelfReview: true,
    });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toContain('/repos/o/r/environments/prod');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      wait_timer: 5,
      prevent_self_review: true,
    });
  });

  it('combines reviewer user + team IDs into a typed array', async () => {
    const { auth, calls } = mockAuth(() => new Response(null, { status: 200 }));
    await new GithubEnvironmentsClient(auth as never).upsertEnvironment('o', 'r', 'prod', {
      reviewerUserIds: [10],
      reviewerTeamIds: [20, 21],
      deploymentBranchPolicy: { protected_branches: true, custom_branch_policies: false },
    });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.reviewers).toEqual([
      { type: 'User', id: 10 },
      { type: 'Team', id: 20 },
      { type: 'Team', id: 21 },
    ]);
    expect(body.deployment_branch_policy).toEqual({ protected_branches: true, custom_branch_policies: false });
  });

  it('throws on non-OK response', async () => {
    const { auth } = mockAuth(() => new Response('nope', { status: 422 }));
    await expect(
      new GithubEnvironmentsClient(auth as never).upsertEnvironment('o', 'r', 'prod', { waitTimer: 1 }),
    ).rejects.toThrow(/Failed to upsert environment prod[\s\S]*nope/);
  });
});

describe('GithubEnvironmentsClient.resolveUserIds / resolveTeamIds', () => {
  it('resolves user logins to numeric IDs and skips unknowns', async () => {
    const { auth, calls } = mockAuth(url => {
      if (url.endsWith('/users/alice')) return json({ id: 100 });
      return new Response('', { status: 404 });
    });
    const ids = await new GithubEnvironmentsClient(auth as never).resolveUserIds(['alice', 'ghost']);
    expect(ids).toEqual([100]);
    expect(calls).toHaveLength(2);
  });

  it('resolves team slugs (with and without org prefix)', async () => {
    const { auth, calls } = mockAuth(url => {
      if (url.includes('/orgs/acme/teams/platform')) return json({ id: 200 });
      if (url.includes('/orgs/other/teams/sec')) return json({ id: 300 });
      return new Response('', { status: 404 });
    });
    const ids = await new GithubEnvironmentsClient(auth as never).resolveTeamIds('acme', ['platform', 'other/sec']);
    expect(ids).toEqual([200, 300]);
    expect(calls[0].url).toContain('/orgs/acme/teams/platform');
    expect(calls[1].url).toContain('/orgs/other/teams/sec');
  });
});

describe('GithubEnvironmentsClient.updateRepoMetadata', () => {
  it('PATCHes only provided fields and skips topics when undefined', async () => {
    const { auth, calls } = mockAuth(() => new Response(null, { status: 200 }));
    await new GithubEnvironmentsClient(auth as never).updateRepoMetadata('o', 'r', {
      description: 'new desc',
      isPrivate: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toBe('https://api.example.com/repos/o/r');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      description: 'new desc',
      private: false,
    });
  });

  it('PUTs topics when provided, even if no metadata fields are set', async () => {
    const { auth, calls } = mockAuth(() => new Response(null, { status: 200 }));
    await new GithubEnvironmentsClient(auth as never).updateRepoMetadata('o', 'r', {
      topics: ['terraform', 'aws'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toContain('/repos/o/r/topics');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ names: ['terraform', 'aws'] });
  });

  it('throws with the response body on PATCH failure', async () => {
    const { auth } = mockAuth(() => new Response('forbidden', { status: 403 }));
    await expect(
      new GithubEnvironmentsClient(auth as never).updateRepoMetadata('o', 'r', { description: 'x' }),
    ).rejects.toThrow(/Failed to update repo metadata[\s\S]*forbidden/);
  });
});
