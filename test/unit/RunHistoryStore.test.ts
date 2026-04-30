import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunHistoryStore } from '../../src/cache/RunHistoryStore.js';
import Database from 'better-sqlite3';
import type { TfRun } from '../../src/types/index.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tf-rhstore-'));
}

function makeRun(id: number, repoSlug = 'acme/platform'): TfRun {
  return {
    id,
    type: 'plan' as TfRun['type'],
    workspaceId: 'production',
    repoSlug,
    workflowRunId: id * 100,
    htmlUrl: `https://example.com/${id}`,
    status: 'completed' as TfRun['status'],
    conclusion: 'success' as TfRun['conclusion'],
    triggeredBy: 'tester',
    commitSha: 'deadbeef',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
  };
}

describe('RunHistoryStore migrations', () => {
  it('initializes user_version to the migration count on a fresh DB', () => {
    const dir = tmpDir();
    try {
      const store = new RunHistoryStore(dir);
      // We don't expose user_version through the API, but we can verify by
      // re-opening the same file directly and reading the pragma.
      store.dispose();
      const raw = new Database(join(dir, 'run_history.db'));
      const v = raw.pragma('user_version', { simple: true }) as number;
      expect(v).toBeGreaterThan(0);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a run through upsert/list', () => {
    const dir = tmpDir();
    try {
      const store = new RunHistoryStore(dir);
      store.upsert(makeRun(1));
      const rows = store.list('acme/platform');
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].status).toBe('completed');
      store.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds gracefully when the existing DB is corrupt', () => {
    const dir = tmpDir();
    try {
      // Pre-create a "DB" with an incompatible schema so the migration ladder
      // throws and falls into the rebuild path.
      const dbPath = join(dir, 'run_history.db');
      const raw = new Database(dbPath);
      raw.exec('CREATE TABLE runs (totally_wrong_column INTEGER)');
      raw.pragma('user_version = 99'); // ahead of any real migration
      raw.close();

      // Re-opening should not throw, and the table should be reinitialized
      // so a normal upsert works.
      const store = new RunHistoryStore(dir);
      // Either the migrations short-circuited (user_version >= ours) and the
      // bad table survived → upsert throws here; OR the rebuild path ran and
      // upsert succeeds. Verify by attempting one:
      let rebuilt = true;
      try {
        store.upsert(makeRun(7));
      } catch {
        rebuilt = false;
      }
      // Either way the file must exist and the constructor must not have thrown.
      expect(existsSync(dbPath)).toBe(true);
      // We need at least one of these guarantees: the user_version > ours
      // path is only safe if upsert still works (it won't, since the schema
      // is wrong). So enforce that we either rebuilt OR the schema happened
      // to be compatible. In practice for user_version=99 the constructor
      // will see "ahead" and skip; but our INSERT statement will then fail.
      // Treat upsert success as a stronger guarantee.
      expect(rebuilt).toBe(true);
      store.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
