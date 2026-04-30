import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunHistoryStore } from '../../src/cache/RunHistoryStore.js';
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

describe('RunHistoryStore', () => {
  it('initializes cleanly on a fresh directory', () => {
    const dir = tmpDir();
    try {
      const store = new RunHistoryStore(dir);
      expect(store.listAll()).toEqual([]);
      store.dispose();
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

  it('persists across instances', () => {
    const dir = tmpDir();
    try {
      const s1 = new RunHistoryStore(dir);
      s1.upsert(makeRun(42));
      s1.dispose();

      const s2 = new RunHistoryStore(dir);
      const rows = s2.list('acme/platform');
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(42);
      s2.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers gracefully when the JSON file is corrupt', () => {
    const dir = tmpDir();
    try {
      // Write invalid JSON to simulate corruption
      writeFileSync(join(dir, 'run_history.json'), 'not-json!!', 'utf8');

      // Constructor should not throw — falls back to empty state
      const store = new RunHistoryStore(dir);
      expect(store.listAll()).toEqual([]);

      // Normal upsert should work after recovery
      store.upsert(makeRun(7));
      expect(store.list('acme/platform').length).toBe(1);
      store.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters list() by repoSlug', () => {
    const dir = tmpDir();
    try {
      const store = new RunHistoryStore(dir);
      store.upsert(makeRun(1, 'acme/platform'));
      store.upsert(makeRun(2, 'acme/other'));
      store.upsert(makeRun(3, 'acme/platform'));
      expect(store.list('acme/platform').length).toBe(2);
      expect(store.list('acme/other').length).toBe(1);
      expect(store.listAll().length).toBe(3);
      store.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upsert merges updates into existing runs', () => {
    const dir = tmpDir();
    try {
      const store = new RunHistoryStore(dir);
      store.upsert(makeRun(1));
      store.upsert({ ...makeRun(1), status: 'in_progress' as TfRun['status'], conclusion: 'failure' as TfRun['conclusion'] });
      const rows = store.list('acme/platform');
      expect(rows.length).toBe(1);
      expect(rows[0].conclusion).toBe('failure');
      store.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('existsSync check — json file is created on first upsert', () => {
    const dir = tmpDir();
    const jsonPath = join(dir, 'run_history.json');
    try {
      const store = new RunHistoryStore(dir);
      store.upsert(makeRun(1));
      expect(existsSync(jsonPath)).toBe(true);
      store.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
