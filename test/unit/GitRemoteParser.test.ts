import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the SUT so its module-load sees the mock.
vi.mock('child_process', () => {
  const handlers = new Map<string, (cwd: string) => { err?: Error | null; stdout?: string }>();
  return {
    execFile: (cmd: string, args: string[], opts: { cwd: string }, cb: (err: Error | null, stdout: string) => void) => {
      const key = `${cmd} ${args.join(' ')}`;
      const h = handlers.get(key);
      if (!h) {
        cb(new Error(`unmocked execFile: ${key}`), '');
        return;
      }
      const r = h(opts.cwd);
      cb(r.err ?? null, r.stdout ?? '');
    },
    __setHandler: (key: string, fn: (cwd: string) => { err?: Error | null; stdout?: string }) => {
      handlers.set(key, fn);
    },
    __reset: () => handlers.clear(),
  };
});

import * as cp from 'child_process';
import * as vscodeStub from './vscode.stub.js';
import { GitRemoteParser } from '../../src/auth/GitRemoteParser.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedCp = cp as any;

beforeEach(() => {
  mockedCp.__reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscodeStub.workspace as any).workspaceFolders = [
    { uri: { fsPath: '/repo' }, name: 'repo', index: 0 },
  ];
});

describe('GitRemoteParser', () => {
  it('parses SSH github.com remotes', async () => {
    mockedCp.__setHandler('git remote -v', () => ({
      stdout:
        'origin\tgit@github.com:HappyPathway/my-repo.git (fetch)\n' +
        'origin\tgit@github.com:HappyPathway/my-repo.git (push)\n',
    }));
    expect(await GitRemoteParser.getHostname()).toBe('github.com');
    expect(await GitRemoteParser.getOrgs()).toEqual(['HappyPathway']);
    expect(await GitRemoteParser.getRepoSlugs()).toEqual(['HappyPathway/my-repo']);
    expect(await GitRemoteParser.getPrimaryRepoSlug('/repo')).toBe('HappyPathway/my-repo');
  });

  it('parses HTTPS GHE remotes and extracts the enterprise hostname', async () => {
    mockedCp.__setHandler('git remote -v', () => ({
      stdout: 'origin\thttps://ghe.example.com/MyOrg/my-repo.git (fetch)\n',
    }));
    expect(await GitRemoteParser.getHostname()).toBe('ghe.example.com');
    expect(await GitRemoteParser.getOrgs()).toEqual(['MyOrg']);
  });

  it('skips push lines so duplicates are not emitted', async () => {
    mockedCp.__setHandler('git remote -v', () => ({
      stdout:
        'origin\tgit@github.com:o/r.git (fetch)\n' +
        'origin\tgit@github.com:o/r.git (push)\n' +
        'upstream\tgit@github.com:o/r.git (fetch)\n',
    }));
    expect(await GitRemoteParser.getRepoSlugs()).toEqual(['o/r']);
  });

  it('falls back to github.com when no folder is a git repo', async () => {
    mockedCp.__setHandler('git remote -v', () => ({ err: new Error('not a git repo') }));
    expect(await GitRemoteParser.getHostname()).toBe('github.com');
    expect(await GitRemoteParser.getOrgs()).toEqual([]);
    expect(await GitRemoteParser.getRepoSlugs()).toEqual([]);
  });

  it('getCurrentBranch returns the branch name', async () => {
    mockedCp.__setHandler('git rev-parse --abbrev-ref HEAD', () => ({ stdout: 'feature/x\n' }));
    expect(await GitRemoteParser.getCurrentBranch('/repo')).toBe('feature/x');
  });

  it('getCurrentBranch returns undefined when HEAD is detached', async () => {
    mockedCp.__setHandler('git rev-parse --abbrev-ref HEAD', () => ({ stdout: 'HEAD\n' }));
    expect(await GitRemoteParser.getCurrentBranch('/repo')).toBeUndefined();
  });

  it('getDefaultBranch derives main-branch name from origin/HEAD', async () => {
    mockedCp.__setHandler('git symbolic-ref --short refs/remotes/origin/HEAD', () => ({ stdout: 'origin/develop\n' }));
    expect(await GitRemoteParser.getDefaultBranch('/repo')).toBe('develop');
  });

  it('getDefaultBranch falls back to "main" on error', async () => {
    mockedCp.__setHandler('git symbolic-ref --short refs/remotes/origin/HEAD', () => ({ err: new Error('no upstream') }));
    expect(await GitRemoteParser.getDefaultBranch('/repo')).toBe('main');
  });
});
