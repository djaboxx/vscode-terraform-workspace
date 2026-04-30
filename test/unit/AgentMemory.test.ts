import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentMemory } from '../../src/agent/AgentMemory.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tf-agent-mem-'));
}

describe('AgentMemory', () => {
  it('records and retrieves entries by topic', () => {
    const dir = tmpDir();
    try {
      const mem = new AgentMemory(dir);
      mem.record('task-1', 'fact', 'Workspace uses S3 backend');
      mem.record('task-1', 'decision', 'Will scaffold OIDC trust');
      mem.record('task-2', 'fact', 'Other task fact');

      const t1 = mem.forTopic('task-1');
      expect(t1).toHaveLength(2);
      expect(t1[0].kind).toBe('decision'); // most recent first
      expect(t1[1].content).toBe('Workspace uses S3 backend');

      const t2 = mem.forTopic('task-2');
      expect(t2).toHaveLength(1);
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists open todos & hypotheses but excludes resolved ones', () => {
    const dir = tmpDir();
    try {
      const mem = new AgentMemory(dir);
      const todoId = mem.record('t', 'todo', 'Add a backend test');
      mem.record('t', 'hypothesis', 'Maybe the lint rule is too strict');
      mem.record('t', 'fact', 'Just a fact, not open');

      let open = mem.openItems();
      expect(open.map(e => e.kind).sort()).toEqual(['hypothesis', 'todo']);

      mem.resolve(todoId, 'Done in PR #42');
      open = mem.openItems();
      expect(open.map(e => e.kind)).toEqual(['hypothesis']);
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records failures and surfaces them in the digest', () => {
    const dir = tmpDir();
    try {
      const mem = new AgentMemory(dir);
      mem.record('topic-x', 'failure', 'tried plan, got 401');
      mem.record('topic-x', 'fact', 'auth token rotated', { source: 'GH' });
      const digest = mem.buildContextDigest('topic-x');
      expect(digest).toContain('Recent notes on this topic');
      expect(digest).toContain('auth token rotated');
      expect(digest).toContain('Recent failures');
      expect(digest).toContain('tried plan, got 401');
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves meta JSON across reloads', () => {
    const dir = tmpDir();
    try {
      const mem1 = new AgentMemory(dir);
      mem1.record('persist', 'fact', 'hello', { foo: 'bar', n: 7 });
      mem1.close();

      const mem2 = new AgentMemory(dir);
      const entries = mem2.forTopic('persist');
      expect(entries).toHaveLength(1);
      expect(entries[0].meta).toEqual({ foo: 'bar', n: 7 });
      mem2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
