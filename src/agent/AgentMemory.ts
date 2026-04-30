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
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  record(topic: string, kind: MemoryEntry['kind'], content: string, meta: Record<string, unknown> = {}): number {
    const id = this.data.nextId++;
    this.data.entries.push({ id, topic, kind, content, meta, createdAt: Date.now() });
    this.persist();
    return id;
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
