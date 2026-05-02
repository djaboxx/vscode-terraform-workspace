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
  private failureObserver?: (run: TfRun) => void;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'run_history.json');
    this.runs = this.load();
  }

  /**
   * Register a callback fired whenever a run is observed in a failed
   * conclusion (`failure` or `timed_out`) for the first time, OR when a
   * previously-incomplete run transitions to such a conclusion. Used by
   * the agent memory layer to auto-capture failures so they show up in
   * `/digest` without anyone having to type `/remember`.
   *
   * Only one observer is supported — caller is the extension activation.
   */
  setFailureObserver(cb: (run: TfRun) => void): void {
    this.failureObserver = cb;
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

  private writeTimer: NodeJS.Timeout | null = null;

  private persist(): void {
    // Debounce writes — if upsert/upsertMany are called repeatedly in quick
    // succession, only write once at the end of the burst. This avoids both
    // wasted I/O and the chance of two concurrent writers interleaving JSON.
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Array.from(this.runs.values()), null, 2), 'utf8');
        // Atomic rename so a crash mid-write can't leave a half-written file.
        fs.renameSync(tmp, this.filePath);
      } catch { /* non-fatal */ }
    }, 250);
  }

  /**
   * Synchronously flush any pending debounced write. Called from `dispose()`
   * so we don't lose the last batch on extension shutdown.
   */
  private flush(): void {
    if (!this.writeTimer) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Array.from(this.runs.values()), null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* non-fatal */ }
  }

  upsert(run: TfRun): void {
    const existing = this.runs.get(run.id);
    const merged = existing ? { ...existing, ...run } : run;
    this.runs.set(run.id, merged);
    this.maybeNotifyFailure(existing, merged);
    this.persist();
  }

  upsertMany(runs: TfRun[]): void {
    for (const r of runs) {
      const existing = this.runs.get(r.id);
      const merged = existing ? { ...existing, ...r } : r;
      this.runs.set(r.id, merged);
      this.maybeNotifyFailure(existing, merged);
    }
    this.persist();
  }

  private maybeNotifyFailure(prev: TfRun | undefined, next: TfRun): void {
    if (!this.failureObserver) return;
    const isFailure = next.conclusion === 'failure' || next.conclusion === 'timed_out';
    if (!isFailure) return;
    // Notify only on the *transition* to failed: either a brand-new run we
    // already see as failed, or a previously-seen run whose conclusion just
    // became failed. Avoids re-notifying every poll.
    if (!prev || prev.conclusion !== next.conclusion) {
      try { this.failureObserver(next); } catch { /* swallow — observer must be defensive */ }
    }
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

  dispose(): void { this.flush(); }

  static createNoop(): RunHistoryStore {
    return Object.create(RunHistoryStore.prototype, {
      filePath: { value: '' },
      runs: { value: new Map() },
      upsert: { value: () => undefined },
      upsertMany: { value: () => undefined },
      list: { value: () => [] as TfRun[] },
      listAll: { value: () => [] as TfRun[] },
      dispose: { value: () => undefined },
      setFailureObserver: { value: () => undefined },
    }) as RunHistoryStore;
  }
}

function byStartedAtDesc(a: TfRun, b: TfRun): number {
  const ta = a.startedAt ?? '';
  const tb = b.startedAt ?? '';
  return tb < ta ? -1 : tb > ta ? 1 : 0;
}

export type { RunType, RunStatus, RunConclusion };
