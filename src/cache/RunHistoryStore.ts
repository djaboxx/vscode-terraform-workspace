import * as path from 'path';
import * as fs from 'fs';
import { TfRun, RunType, RunStatus, RunConclusion } from '../types/index.js';
import { asRecord, asString, asNumber, asOptionalString } from '../util/narrow.js';

// Loaded lazily inside the constructor so a native ABI mismatch throws at
// instantiation time (catchable) rather than at bundle-load time (fatal).
type BetterSqlite3 = typeof import('better-sqlite3');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadSqlite = (): BetterSqlite3 => require('better-sqlite3') as BetterSqlite3;

/**
 * Persistent local cache of observed Terraform workflow runs. Survives
 * window reloads and is the source of truth for the historical Runs view —
 * GitHub's API only returns the most recent N runs per page, so we record
 * every run we see and merge with live API data on display.
 *
 * Stored at `{globalStoragePath}/run_history.db`.
 */
export class RunHistoryStore {
  private readonly db: import('better-sqlite3').Database;
  private readonly stmtUpsert: import('better-sqlite3').Statement;
  private readonly stmtList: import('better-sqlite3').Statement;
  private readonly stmtListAll: import('better-sqlite3').Statement;

  constructor(storagePath: string) {
    const Database = loadSqlite();
    fs.mkdirSync(storagePath, { recursive: true });
    this.db = new Database(path.join(storagePath, 'run_history.db'));
    this.db.pragma('journal_mode = WAL');
    this.runMigrations();

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO runs (id, type, workspace_id, repo_slug, run_id, html_url, status, conclusion, triggered_by, commit_sha, started_at, completed_at, seen_at)
      VALUES (@id, @type, @workspace_id, @repo_slug, @run_id, @html_url, @status, @conclusion, @triggered_by, @commit_sha, @started_at, @completed_at, @seen_at)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        conclusion = excluded.conclusion,
        completed_at = excluded.completed_at,
        seen_at = excluded.seen_at
    `);

    this.stmtList = this.db.prepare(`
      SELECT * FROM runs WHERE repo_slug = ? ORDER BY started_at DESC LIMIT ?
    `);
    this.stmtListAll = this.db.prepare(`
      SELECT * FROM runs ORDER BY started_at DESC LIMIT ?
    `);
  }

  /**
   * Schema-versioning ladder. Each migration runs once, in order, when the
   * stored `user_version` is below its index. Adding a future migration is
   * a matter of pushing onto `MIGRATIONS` — never edit a published step.
   *
   * On unrecoverable corruption we drop and recreate the table so a stale
   * cache can never wedge activation.
   */
  private runMigrations(): void {
    const MIGRATIONS: Array<(db: import('better-sqlite3').Database) => void> = [
      (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS runs (
            id            INTEGER PRIMARY KEY,
            type          TEXT NOT NULL,
            workspace_id  TEXT NOT NULL,
            repo_slug     TEXT NOT NULL,
            run_id        INTEGER NOT NULL,
            html_url      TEXT,
            status        TEXT,
            conclusion    TEXT,
            triggered_by  TEXT,
            commit_sha    TEXT,
            started_at    TEXT,
            completed_at  TEXT,
            seen_at       INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS runs_repo_started ON runs(repo_slug, started_at DESC);
        `);
      },
      // Future: push e.g. (db) => db.exec('ALTER TABLE runs ADD COLUMN ...')
    ];

    const current = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    // A user_version higher than what we know about means the DB was last
    // touched by a newer extension version. We can't safely run unknown
    // migrations forward; the safest recovery is to drop and rebuild —
    // run history is reconstructible from the GitHub API.
    if (current > MIGRATIONS.length) {
      console.warn(`[RunHistoryStore] DB is from a newer version (user_version=${current} > ${MIGRATIONS.length}); rebuilding.`);
      this.db.exec('DROP TABLE IF EXISTS runs');
      this.db.pragma('user_version = 0');
      for (let v = 0; v < MIGRATIONS.length; v++) {
        MIGRATIONS[v](this.db);
        this.db.pragma(`user_version = ${v + 1}`);
      }
      return;
    }
    try {
      for (let v = current; v < MIGRATIONS.length; v++) {
        const migrate = MIGRATIONS[v];
        const tx = this.db.transaction(() => {
          migrate(this.db);
          this.db.pragma(`user_version = ${v + 1}`);
        });
        tx();
      }
    } catch (err) {
      // Corrupted/incompatible DB: nuke the table and run all migrations from
      // scratch. Run history is recoverable by re-syncing from the GitHub API.
      console.warn('[RunHistoryStore] migration failed, rebuilding:', err);
      this.db.exec('DROP TABLE IF EXISTS runs');
      this.db.pragma('user_version = 0');
      for (let v = 0; v < MIGRATIONS.length; v++) {
        MIGRATIONS[v](this.db);
        this.db.pragma(`user_version = ${v + 1}`);
      }
    }
  }

  upsert(run: TfRun): void {
    this.stmtUpsert.run({
      id: run.id,
      type: run.type,
      workspace_id: run.workspaceId,
      repo_slug: run.repoSlug,
      run_id: run.workflowRunId,
      html_url: run.htmlUrl ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      triggered_by: run.triggeredBy ?? null,
      commit_sha: run.commitSha ?? null,
      started_at: run.startedAt ?? null,
      completed_at: run.completedAt ?? null,
      seen_at: Date.now(),
    });
  }

  upsertMany(runs: TfRun[]): void {
    const tx = this.db.transaction((rs: TfRun[]) => { for (const r of rs) this.upsert(r); });
    tx(runs);
  }

  list(repoSlug: string, limit = 100): TfRun[] {
    return (this.stmtList.all(repoSlug, limit) as unknown[]).map(rowToRun);
  }

  listAll(limit = 100): TfRun[] {
    return (this.stmtListAll.all(limit) as unknown[]).map(rowToRun);
  }

  dispose(): void {
    this.db.close();
  }

  /** Returns a no-op store used as a fallback when SQLite fails to load. */
  static createNoop(): RunHistoryStore {
    return Object.create(RunHistoryStore.prototype, {
      db: { value: null },
      stmtUpsert: { value: null },
      stmtList: { value: null },
      stmtListAll: { value: null },
      upsert: { value: () => undefined },
      upsertMany: { value: () => undefined },
      list: { value: () => [] },
      listAll: { value: () => [] },
      dispose: { value: () => undefined },
    }) as RunHistoryStore;
  }
}

function rowToRun(raw: unknown): TfRun {
  const row = asRecord(raw);
  return {
    id: asNumber(row.id),
    type: asString(row.type) as RunType,
    workspaceId: asString(row.workspace_id),
    repoSlug: asString(row.repo_slug),
    workflowRunId: asNumber(row.run_id),
    htmlUrl: asString(row.html_url),
    status: asString(row.status) as RunStatus,
    conclusion: asString(row.conclusion) as RunConclusion,
    triggeredBy: asOptionalString(row.triggered_by),
    commitSha: asOptionalString(row.commit_sha),
    startedAt: asOptionalString(row.started_at),
    completedAt: asOptionalString(row.completed_at),
  };
}
