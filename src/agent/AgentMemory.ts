import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { asRecord, asString, asNumber, asOptionalString } from '../util/narrow.js';

/**
 * One discrete observation, decision, or hypothesis the autonomous agent
 * has recorded for itself. Survives reload, queryable by topic, prunable by age.
 */
export interface MemoryEntry {
  id: number;
  topic: string;
  kind: 'fact' | 'decision' | 'hypothesis' | 'failure' | 'todo';
  content: string;
  /** Free-form JSON blob for structured context. */
  meta: Record<string, unknown>;
  createdAt: number;
  /** For hypotheses & todos: did we ever resolve them? */
  resolvedAt?: number;
  resolution?: string;
}

/**
 * Persistent agent scratchpad. Distinct from RunHistoryStore (which records
 * external workflow runs) — this is the agent's own thoughts.
 *
 * Stored at `{globalStoragePath}/agent_memory.db`.
 */
export class AgentMemory {
  private readonly db: Database.Database;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.db = new Database(path.join(storagePath, 'agent_memory.db'));
    this.db.pragma('journal_mode = WAL');
    this.runMigrations();
  }

  private runMigrations(): void {
    const userVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (userVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          topic       TEXT NOT NULL,
          kind        TEXT NOT NULL,
          content     TEXT NOT NULL,
          meta        TEXT NOT NULL DEFAULT '{}',
          created_at  INTEGER NOT NULL,
          resolved_at INTEGER,
          resolution  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_topic ON memory(topic);
        CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
        CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at);
      `);
      this.db.pragma('user_version = 1');
    }
  }

  record(topic: string, kind: MemoryEntry['kind'], content: string, meta: Record<string, unknown> = {}): number {
    const stmt = this.db.prepare(
      'INSERT INTO memory (topic, kind, content, meta, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const result = stmt.run(topic, kind, content, JSON.stringify(meta), Date.now());
    return Number(result.lastInsertRowid);
  }

  resolve(id: number, resolution: string): void {
    this.db.prepare('UPDATE memory SET resolved_at = ?, resolution = ? WHERE id = ?')
      .run(Date.now(), resolution, id);
  }

  /** Most recent entries for a topic. */
  forTopic(topic: string, limit = 50): MemoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory WHERE topic = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(topic, limit) as unknown[];
    return rows.map(toEntry);
  }

  /** Open todos / unresolved hypotheses across all topics. */
  openItems(): MemoryEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM memory WHERE kind IN ('todo', 'hypothesis') AND resolved_at IS NULL ORDER BY created_at ASC, id ASC`,
    ).all() as unknown[];
    return rows.map(toEntry);
  }

  /** Things the agent already tried and failed on — feeds future decisions. */
  recentFailures(limit = 20): MemoryEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM memory WHERE kind = 'failure' ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(limit) as unknown[];
    return rows.map(toEntry);
  }

  /** Build a compact context blob to inject into an LM request. */
  buildContextDigest(topic: string): string {
    const recent = this.forTopic(topic, 10);
    const failures = this.recentFailures(5);
    const todos = this.openItems().slice(0, 10);

    const parts: string[] = [];
    if (recent.length) {
      parts.push('## Recent notes on this topic');
      for (const e of recent) parts.push(`- [${e.kind}] ${e.content}`);
    }
    if (failures.length) {
      parts.push('\n## Recent failures (do not repeat)');
      for (const e of failures) parts.push(`- ${e.content}`);
    }
    if (todos.length) {
      parts.push('\n## Open todos');
      for (const e of todos) parts.push(`- ${e.content}`);
    }
    return parts.join('\n');
  }

  close(): void { this.db.close(); }
}

function toEntry(row: unknown): MemoryEntry {
  const r = asRecord(row);
  return {
    id: asNumber(r.id),
    topic: asString(r.topic),
    kind: asString(r.kind) as MemoryEntry['kind'],
    content: asString(r.content),
    meta: safeParseJson(asString(r.meta)),
    createdAt: asNumber(r.created_at),
    resolvedAt: r.resolved_at == null ? undefined : asNumber(r.resolved_at),
    resolution: asOptionalString(r.resolution),
  };
}

function safeParseJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
