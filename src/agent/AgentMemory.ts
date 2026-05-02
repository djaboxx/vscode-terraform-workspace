import * as path from 'path';
import * as fs from 'fs';

export interface MemoryEntry {
  id: number;
  topic: string;
  kind: 'fact' | 'decision' | 'hypothesis' | 'failure' | 'todo';
  content: string;
  meta: Record<string, unknown>;
  createdAt: number;
  resolvedAt?: number;
  resolution?: string;
}

interface StoredData {
  nextId: number;
  entries: MemoryEntry[];
}

/**
 * Persistent agent scratchpad.
 * Stored as JSON at `{globalStoragePath}/agent_memory.json`.
 * Pure TypeScript — no native modules required.
 */
export class AgentMemory {
  private readonly filePath: string;
  private data: StoredData;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'agent_memory.json');
    this.data = this.load();
  }

  private load(): StoredData {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StoredData;
    } catch {
      return { nextId: 1, entries: [] };
    }
  }

  private persist(): void {
    try {
      // Atomic write: serialize to a sibling .tmp file then rename, so a
      // crash mid-write can never leave a half-written agent_memory.json
      // that the next load() call would discard via the JSON.parse catch.
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* non-fatal */ }
  }

  record(topic: string, kind: MemoryEntry['kind'], content: string, meta: Record<string, unknown> = {}): number {
    const id = this.data.nextId++;
    this.data.entries.push({ id, topic, kind, content, meta, createdAt: Date.now() });
    this.persist();
    return id;
  }

  /**
   * Idempotent record: if any existing entry has `meta.dedupKey === dedupKey`,
   * returns its id without writing a new entry. Otherwise records normally
   * with `dedupKey` baked into meta. Used by the failure auto-capture and
   * the inbox watcher to avoid spamming the same PR / failed run repeatedly.
   *
   * Returns the id of the (existing or newly-created) entry.
   */
  recordOnce(
    topic: string,
    kind: MemoryEntry['kind'],
    content: string,
    dedupKey: string,
    meta: Record<string, unknown> = {},
  ): number {
    const existing = this.data.entries.find(e => e.meta?.dedupKey === dedupKey);
    if (existing) return existing.id;
    return this.record(topic, kind, content, { ...meta, dedupKey });
  }

  /**
   * True if any entry was previously recorded with this dedupKey.
   * Useful for callers that want to report "added vs skipped" counts after a
   * batch of `recordOnce` calls (e.g. the seed-memory command).
   */
  hasDedupKey(dedupKey: string): boolean {
    return this.data.entries.some(e => e.meta?.dedupKey === dedupKey);
  }

  resolve(id: number, resolution: string): void {
    const entry = this.data.entries.find(e => e.id === id);
    if (entry) {
      entry.resolvedAt = Date.now();
      entry.resolution = resolution;
      this.persist();
    }
  }

  forTopic(topic: string, limit = 50): MemoryEntry[] {
    return this.data.entries
      .filter(e => e.topic === topic)
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit);
  }

  openItems(): MemoryEntry[] {
    return this.data.entries
      .filter(e => (e.kind === 'todo' || e.kind === 'hypothesis') && e.resolvedAt == null)
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  recentFailures(limit = 20): MemoryEntry[] {
    return this.data.entries
      .filter(e => e.kind === 'failure')
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit);
  }

  /**
   * Distinct playbook names — entries whose topic starts with `playbook:`.
   * Returned in alphabetical order. Used by Dave's `/playbook` listing.
   */
  allPlaybookNames(): string[] {
    const names = new Set<string>();
    for (const e of this.data.entries) {
      if (e.topic.startsWith('playbook:')) {
        names.add(e.topic.slice('playbook:'.length));
      }
    }
    return Array.from(names).sort();
  }

  /**
   * Returns the latest captured body of a playbook, or undefined if not found.
   * "Latest" = highest id under topic `playbook:{name}` with kind `decision`
   * (which is what `/learn` writes).
   */
  getPlaybookBody(name: string): MemoryEntry | undefined {
    return this.forTopic(`playbook:${name}`, 1)[0];
  }

  /**
   * Aggregate rating signal for a playbook: count of `good` vs `bad`
   * entries (kind `fact` with meta.rating set). Used so degraded playbooks
   * become visible in listings before they're replayed.
   */
  playbookRating(name: string): { good: number; bad: number; latestNote?: string } {
    let good = 0;
    let bad = 0;
    let latestNote: string | undefined;
    let latestAt = 0;
    for (const e of this.data.entries) {
      if (e.topic !== `playbook:${name}`) continue;
      const rating = e.meta?.rating as string | undefined;
      if (rating === 'good') good++;
      else if (rating === 'bad') bad++;
      else continue;
      if (e.createdAt > latestAt) {
        latestAt = e.createdAt;
        latestNote = e.content;
      }
    }
    return { good, bad, latestNote };
  }

  /**
   * A playbook is "auto-trusted" once it has 5+ good ratings and zero bad.
   * Dave skips the "want me to run it?" handshake for these and just
   * executes — they've earned that.
   */
  isAutoTrusted(name: string): boolean {
    const r = this.playbookRating(name);
    return r.good >= 5 && r.bad === 0;
  }

  /**
   * All distinct decision slugs — entries whose topic starts with `decision:`.
   * Sorted by recency (most recently touched first).
   */
  allDecisionSlugs(): string[] {
    const seen = new Map<string, number>(); // slug → max createdAt
    for (const e of this.data.entries) {
      if (!e.topic.startsWith('decision:')) continue;
      const slug = e.topic.slice('decision:'.length);
      const cur = seen.get(slug) ?? 0;
      if (e.createdAt > cur) seen.set(slug, e.createdAt);
    }
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([slug]) => slug);
  }

  /**
   * Distinct playbook names that have *no* good or bad rating yet.
   * Used by `/digest` to surface what's worth validating.
   */
  unratedPlaybooks(): string[] {
    return this.allPlaybookNames().filter(n => {
      const r = this.playbookRating(n);
      return r.good === 0 && r.bad === 0;
    });
  }

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

  close(): void { /* nothing to close */ }
}
