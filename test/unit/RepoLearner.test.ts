import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentMemory } from '../../src/agent/AgentMemory.js';
import { RepoLearner } from '../../src/agent/RepoLearner.js';
import type { GithubAuthProvider } from '../../src/auth/GithubAuthProvider.js';

function tmpDir(): string { return mkdtempSync(join(tmpdir(), 'tf-learner-')); }

function makeAuth(routes: Record<string, unknown>): GithubAuthProvider {
  const fetch = vi.fn(async (url: string) => {
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as unknown as Response;
  });
  return { apiBaseUrl: 'https://api.example.test', fetch } as unknown as GithubAuthProvider;
}

describe('RepoLearner', () => {
  let dir: string;
  let mem: AgentMemory;
  beforeEach(() => { dir = tmpDir(); mem = new AgentMemory(dir); });

  it('first-pass ingests convention docs + commits, records lastSha', async () => {
    const auth = makeAuth({
      '/search/repositories': {
        items: [{ full_name: 'acme/terraform-foo', description: 'Foo module', topics: ['learning', 'terraform'], default_branch: 'main', language: 'HCL' }],
      },
      // Order matters: more-specific routes first so /commits/sha1 matches before /commits.
      '/repos/acme/terraform-foo/commits/sha1': {
        sha: 'sha1', html_url: 'https://x/sha1',
        commit: { message: 'feat: initial', author: { name: 'Alice', date: '2026-04-01T00:00:00Z' } },
        files: [{ filename: 'variables.tf', additions: 1, deletions: 0, patch: '+variable "x" {}' }],
      },
      '/repos/acme/terraform-foo/commits/sha0': {
        sha: 'sha0', html_url: 'https://x/sha0',
        commit: { message: 'chore: setup', author: { name: 'Bob', date: '2026-03-31T00:00:00Z' } },
        files: [],
      },
      '/repos/acme/terraform-foo/commits': [
        { sha: 'sha1', html_url: 'https://x/sha1', commit: { message: 'feat: initial', author: { name: 'Alice', date: '2026-04-01T00:00:00Z' } } },
        { sha: 'sha0', html_url: 'https://x/sha0', commit: { message: 'chore: setup', author: { name: 'Bob', date: '2026-03-31T00:00:00Z' } } },
      ],
      '/repos/acme/terraform-foo/contents/AGENTS.md': { encoding: 'base64', content: Buffer.from('# Agents\nUse Terraform fmt.').toString('base64') },
      '/repos/acme/terraform-foo/contents/CONTRIBUTING.md': { encoding: 'base64', content: Buffer.from('# Contributing\nOpen a PR.').toString('base64') },
    });

    const learner = new RepoLearner(auth, mem, { owners: ['acme'], topic: 'learning' });
    const result = await learner.tick();

    expect(result.reposScanned).toBe(1);
    expect(result.reposUpdated).toBe(1);

    const entries = mem.forTopic('repo:acme/terraform-foo');
    const contents = entries.map(e => e.content);
    // Repo header line: "Repo {fullName} ({language}): {description}"
    expect(contents.some(c => c.startsWith('Repo acme/terraform-foo (HCL):'))).toBe(true);
    // Convention docs ingested.
    expect(contents.some(c => c.startsWith('Convention doc AGENTS.md:'))).toBe(true);
    expect(contents.some(c => c.startsWith('Convention doc CONTRIBUTING.md:'))).toBe(true);
    // Commit subject line included with author + date.
    expect(contents.some(c => c.includes('Alice: feat: initial'))).toBe(true);
    // lastSha marker recorded.
    expect(contents.some(c => c.startsWith('__lastSha=sha1'))).toBe(true);

    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('second pass with no new commits is a no-op (no updated)', async () => {
    const auth = makeAuth({
      '/search/repositories': {
        items: [{ full_name: 'acme/terraform-foo', description: 'd', topics: ['learning'], default_branch: 'main' }],
      },
      '/repos/acme/terraform-foo/commits': [
        { sha: 'sha1', html_url: 'https://x/sha1', commit: { message: 'feat', author: { name: 'A', date: '2026-04-01T00:00:00Z' } } },
      ],
      '/repos/acme/terraform-foo/contents/README.md': { encoding: 'base64', content: Buffer.from('hi').toString('base64') },
    });

    const learner = new RepoLearner(auth, mem, { owners: ['acme'], topic: 'learning' });
    await learner.tick();
    const before = mem.forTopic('repo:acme/terraform-foo').length;
    const second = await learner.tick();
    expect(second.reposUpdated).toBe(0);
    const after = mem.forTopic('repo:acme/terraform-foo').length;
    expect(after).toBe(before); // no new entries written

    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records only the delta when new commits appear', async () => {
    let commits = [
      { sha: 'sha1', html_url: 'https://x/sha1', commit: { message: 'one', author: { name: 'A', date: '2026-04-01T00:00:00Z' } } },
    ];
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/search/repositories')) {
        return { ok: true, json: async () => ({ items: [{ full_name: 'acme/terraform-foo', description: '', topics: ['learning'], default_branch: 'main' }] }) } as unknown as Response;
      }
      if (url.includes('/repos/acme/terraform-foo/commits')) {
        return { ok: true, json: async () => commits } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    const auth = { apiBaseUrl: 'https://api.example.test', fetch } as unknown as GithubAuthProvider;

    const learner = new RepoLearner(auth, mem, { owners: ['acme'], topic: 'learning' });
    await learner.tick();

    // New commit appears
    commits = [
      { sha: 'sha2', html_url: 'https://x/sha2', commit: { message: 'two', author: { name: 'B', date: '2026-04-02T00:00:00Z' } } },
      ...commits,
    ];
    const second = await learner.tick();
    expect(second.reposUpdated).toBe(1);
    const decisions = mem.forTopic('repo:acme/terraform-foo').filter(e => e.kind === 'decision');
    expect(decisions.some(e => e.content.includes('two'))).toBe(true);
    // 'one' should appear exactly once across both ticks
    const oneCount = decisions.filter(e => e.content.includes('one')).length;
    expect(oneCount).toBe(1);

    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
