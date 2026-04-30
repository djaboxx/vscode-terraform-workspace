import * as path from 'path';
import * as fs from 'fs';
import { TfRun, RunType, RunStatus, RunConclusion } from '../types/index.js';

/**
 * Persistent local cache of observed Terraform workflow runs.
 * Stored as JSON at `{globalStoragePath}/run_history.json`.
 * Pure TypeScript — no native modules required.
 */
export class RunHistoryStore {
  private readonly filePath: string;
  private runs: Map<number, TfRun>;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'run_history.json');
    this.runs = this.load();
  }

  private load(): Map<number, TfRun> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const arr = JSON.parse(raw) as TfRun[];
      return new Map(arr.map(r => [r.id, r]));
    } catch {
      return new Map();
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(Array.from(this.runs.values()), null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  upsert(run: TfRun): void {
    const existing = this.runs.get(run.id);
    this.runs.set(run.id, existing ? { ...existing, ...run } : run);
    this.persist();
  }

  upsertMany(runs: TfRun[]): void {
    for (const r of runs) {
      const existing = this.runs.get(r.id);
      this.runs.set(r.id, existing ? { ...existing, ...r } : r);
    }
    this.persist();
  }

  list(repoSlug: string, limit = 100): TfRun[] {
    return Array.from(this.runs.values())
      .filter(r => r.repoSlug === repoSlug)
      .sort(byStartedAtDesc)
      .slice(0, limit);
  }

  listAll(limit = 100): TfRun[] {
    return Array.from(this.runs.values())
      .sort(byStartedAtDesc)
      .slice(0, limit);
  }

  dispose(): void { /* nothing to close */ }

  static createNoop(): RunHistoryStore {
    return Object.create(RunHistoryStore.prototype, {
      filePath: { value: '' },
      runs: { value: new Map() },
      upsert: { value: () => undefined },
      upsertMany: { value: () => undefined },
      list: { value: () => [] as TfRun[] },
      listAll: { value: () => [] as TfRun[] },
      dispose: { value: () => undefined },
    }) as RunHistoryStore;
  }
}

function byStartedAtDesc(a: TfRun, b: TfRun): number {
  const ta = a.startedAt ?? '';
  const tb = b.startedAt ?? '';
  return tb < ta ? -1 : tb > ta ? 1 : 0;
}

export type { RunType, RunStatus, RunConclusion };
