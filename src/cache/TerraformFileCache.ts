import * as vscode from 'vscode';
import * as path from 'path';
import Database from 'better-sqlite3';

/** Max bytes to store per individual .tf file */
const FILE_CAP = 8 * 1024;
/** Max bytes of total context handed to the LLM */
const TOTAL_CAP = 80 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tf_files (
  uri       TEXT PRIMARY KEY,
  rel_path  TEXT NOT NULL,
  content   TEXT NOT NULL,
  mtime_ms  INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS tf_fts
  USING fts5(uri UNINDEXED, rel_path, content, content=tf_files, content_rowid=rowid);

CREATE TRIGGER IF NOT EXISTS tf_files_ai AFTER INSERT ON tf_files BEGIN
  INSERT INTO tf_fts(rowid, uri, rel_path, content)
    VALUES (new.rowid, new.uri, new.rel_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS tf_files_ad AFTER DELETE ON tf_files BEGIN
  INSERT INTO tf_fts(tf_fts, rowid, uri, rel_path, content)
    VALUES ('delete', old.rowid, old.uri, old.rel_path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS tf_files_au AFTER UPDATE ON tf_files BEGIN
  INSERT INTO tf_fts(tf_fts, rowid, uri, rel_path, content)
    VALUES ('delete', old.rowid, old.uri, old.rel_path, old.content);
  INSERT INTO tf_fts(rowid, uri, rel_path, content)
    VALUES (new.rowid, new.uri, new.rel_path, new.content);
END;
`;

export interface TfFileRow {
  uri: string;
  rel_path: string;
  content: string;
  mtime_ms: number;
}

export interface TfSearchRow {
  uri: string;
  rel_path: string;
  snippet: string;
}

/**
 * SQLite-backed cache of all `.tf` files in the open workspace.
 *
 * - Stored at `{globalStoragePath}/tf_cache.db` — persists across window reloads.
 * - Populated once on construction via `initialize()`.
 * - Kept current by a `FileSystemWatcher` — individual files are re-read or
 *   removed as they change; no full rescans are needed.
 * - `getContext()` returns a pre-built LLM context string, rebuilt only when dirty.
 * - `search(query)` runs an FTS5 full-text query against all cached HCL content.
 */
export class TerraformFileCache implements vscode.Disposable {
  private readonly db: Database.Database;
  private readonly watcher: vscode.FileSystemWatcher;
  private dirty = true;
  private cachedContext: string | null = null;

  // Prepared statements — created once, reused on every call
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtAll: Database.Statement;
  private readonly stmtSearch: Database.Statement;
  private readonly stmtCount: Database.Statement;

  constructor(storagePath: string) {
    // Ensure the storage directory exists
    const fs = require('fs') as typeof import('fs');
    fs.mkdirSync(storagePath, { recursive: true });

    this.db = new Database(path.join(storagePath, 'tf_cache.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO tf_files (uri, rel_path, content, mtime_ms)
      VALUES (@uri, @rel_path, @content, @mtime_ms)
      ON CONFLICT(uri) DO UPDATE SET
        rel_path = excluded.rel_path,
        content  = excluded.content,
        mtime_ms = excluded.mtime_ms
    `);

    this.stmtDelete = this.db.prepare(`DELETE FROM tf_files WHERE uri = ?`);

    this.stmtAll = this.db.prepare(`
      SELECT uri, rel_path, content FROM tf_files ORDER BY rel_path
    `);

    this.stmtSearch = this.db.prepare(`
      SELECT
        f.uri,
        f.rel_path,
        snippet(tf_fts, 2, '[', ']', '…', 32) AS snippet
      FROM tf_fts
      JOIN tf_files f ON f.uri = tf_fts.uri
      WHERE tf_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `);

    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS n FROM tf_files`);

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.tf');
    this.watcher.onDidCreate(uri => this.onFileChanged(uri));
    this.watcher.onDidChange(uri => this.onFileChanged(uri));
    this.watcher.onDidDelete(uri => {
      const key = uri.toString();
      const result = this.stmtDelete.run(key);
      if (result.changes > 0) {
        this.dirty = true;
      }
    });
  }

  /**
   * Initial scan — reads all `.tf` files and populates the DB.
   * Call once on activation; the watcher handles incremental updates after.
   */
  async initialize(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.tf',
      '{**/.terraform/**,**/node_modules/**}',
      500,
    );
    await Promise.all(uris.map(uri => this.readAndStore(uri)));
    this.dirty = true;
  }

  /**
   * Returns a pre-built LLM context string with all cached .tf files.
   * Rebuilt only when something changed since the last call.
   */
  getContext(): string | null {
    if (!this.dirty && this.cachedContext !== null) {
      return this.cachedContext;
    }

    const rows = this.stmtAll.all() as TfFileRow[];
    if (rows.length === 0) {
      this.cachedContext = null;
      this.dirty = false;
      return null;
    }

    const lines: string[] = [
      `The open workspace contains ${rows.length} Terraform file(s). Their contents are provided below for context.\n`,
    ];

    let totalBytes = 0;
    let truncated = false;

    for (const row of rows) {
      const bytes = Buffer.byteLength(row.content);
      if (totalBytes + bytes > TOTAL_CAP) {
        truncated = true;
        break;
      }
      totalBytes += bytes;
      lines.push(`### ${row.rel_path}\n\`\`\`hcl\n${row.content}\n\`\`\`\n`);
    }

    if (truncated) {
      lines.push(`\n...(remaining files omitted — context limit reached)`);
    }

    this.cachedContext = lines.join('\n');
    this.dirty = false;
    return this.cachedContext;
  }

  /**
   * Full-text search against all cached Terraform file content.
   * Uses FTS5 MATCH syntax — e.g. `aws_iam_policy_document`, `"assume role"`.
   * Returns up to 20 results with a highlighted snippet.
   */
  search(query: string): TfSearchRow[] {
    try {
      return this.stmtSearch.all(query) as TfSearchRow[];
    } catch {
      // FTS5 syntax errors surface as exceptions — return empty rather than crashing
      return [];
    }
  }

  /**
   * Returns the full content of a single file by URI string.
   */
  getFile(uri: string): TfFileRow | undefined {
    const stmt = this.db.prepare(`SELECT * FROM tf_files WHERE uri = ?`);
    return stmt.get(uri) as TfFileRow | undefined;
  }

  /** Number of files currently cached. */
  get size(): number {
    return (this.stmtCount.get() as { n: number }).n;
  }

  dispose(): void {
    this.watcher.dispose();
    this.db.close();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async onFileChanged(uri: vscode.Uri): Promise<void> {
    await this.readAndStore(uri);
  }

  private async readAndStore(uri: vscode.Uri): Promise<void> {
    if (uri.fsPath.includes('/.terraform/')) {
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      let content = doc.getText();

      if (Buffer.byteLength(content) > FILE_CAP) {
        content = content.slice(0, FILE_CAP) + '\n... (truncated)';
      }

      const stat = await vscode.workspace.fs.stat(uri);

      this.stmtUpsert.run({
        uri: uri.toString(),
        rel_path: vscode.workspace.asRelativePath(uri),
        content,
        mtime_ms: stat.mtime,
      });

      this.dirty = true;
    } catch {
      // file unreadable or deleted between glob and read — skip
    }
  }
}

