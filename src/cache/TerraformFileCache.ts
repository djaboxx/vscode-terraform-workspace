import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export { sanitizeFtsQuery } from './sanitizeFtsQuery.js';

/** Max bytes to store per individual .tf file */
const FILE_CAP = 8 * 1024;
/** Max bytes of total context handed to the LLM */
const TOTAL_CAP = 80 * 1024;

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

interface StoredCache {
  files: TfFileRow[];
}

/**
 * In-memory cache of all `.tf` files in the open workspace, with optional
 * JSON persistence across window reloads.
 * Pure TypeScript — no native modules required.
 */
export class TerraformFileCache implements vscode.Disposable {
  private readonly filePath: string;
  private files: Map<string, TfFileRow> = new Map();
  private readonly watcher: vscode.FileSystemWatcher;
  private dirty = true;
  private cachedContext: string | null = null;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'tf_cache.json');
    this.loadFromDisk();

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.tf');
    this.watcher.onDidCreate(uri => this.onFileChanged(uri));
    this.watcher.onDidChange(uri => this.onFileChanged(uri));
    this.watcher.onDidDelete(uri => {
      if (this.files.delete(uri.toString())) {
        this.dirty = true;
        this.persistToDisk();
      }
    });
  }

  private loadFromDisk(): void {
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StoredCache;
      for (const row of stored.files ?? []) {
        this.files.set(row.uri, row);
      }
    } catch { /* fresh start */ }
  }

  private persistToDisk(): void {
    try {
      const stored: StoredCache = { files: Array.from(this.files.values()) };
      fs.writeFileSync(this.filePath, JSON.stringify(stored), 'utf8');
    } catch { /* non-fatal */ }
  }

  async initialize(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.tf',
      '{**/.terraform/**,**/node_modules/**}',
      500,
    );
    await Promise.all(uris.map(uri => this.readAndStore(uri)));
    this.dirty = true;
  }

  getContext(): string | null {
    if (!this.dirty && this.cachedContext !== null) {
      return this.cachedContext;
    }
    const rows = Array.from(this.files.values()).sort((a, b) => a.rel_path.localeCompare(b.rel_path));
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
      if (totalBytes + bytes > TOTAL_CAP) { truncated = true; break; }
      totalBytes += bytes;
      lines.push(`### ${row.rel_path}\n\`\`\`hcl\n${row.content}\n\`\`\`\n`);
    }
    if (truncated) lines.push('\n...(remaining files omitted — context limit reached)');
    this.cachedContext = lines.join('\n');
    this.dirty = false;
    return this.cachedContext;
  }

  search(query: string): TfSearchRow[] {
    if (!query.trim()) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: TfSearchRow[] = [];
    for (const row of this.files.values()) {
      const lower = row.content.toLowerCase();
      if (!terms.every(t => lower.includes(t))) continue;
      // Build a short snippet around the first match
      const idx = lower.indexOf(terms[0]);
      const start = Math.max(0, idx - 60);
      const end = Math.min(row.content.length, idx + 120);
      const snippet = (start > 0 ? '…' : '') + row.content.slice(start, end).replace(/\n/g, ' ') + (end < row.content.length ? '…' : '');
      results.push({ uri: row.uri, rel_path: row.rel_path, snippet });
      if (results.length >= 20) break;
    }
    return results;
  }

  getFile(uri: string): TfFileRow | undefined {
    return this.files.get(uri);
  }

  get size(): number {
    return this.files.size;
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  static createNoop(): TerraformFileCache {
    const noop = (): void => undefined;
    return Object.create(TerraformFileCache.prototype, {
      filePath: { value: '' },
      files: { value: new Map() },
      watcher: { value: { dispose: noop } },
      dirty: { value: false, writable: true },
      cachedContext: { value: null, writable: true },
      initialize: { value: async () => undefined },
      getContext: { value: () => null },
      search: { value: () => [] },
      getFile: { value: () => undefined },
      size: { get: () => 0 },
      dispose: { value: noop },
    }) as TerraformFileCache;
  }

  private async onFileChanged(uri: vscode.Uri): Promise<void> {
    await this.readAndStore(uri);
  }

  private async readAndStore(uri: vscode.Uri): Promise<void> {
    if (uri.fsPath.includes('/.terraform/')) return;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      let content = doc.getText();
      if (Buffer.byteLength(content) > FILE_CAP) {
        content = content.slice(0, FILE_CAP) + '\n... (truncated)';
      }
      const stat = await vscode.workspace.fs.stat(uri);
      this.files.set(uri.toString(), {
        uri: uri.toString(),
        rel_path: vscode.workspace.asRelativePath(uri),
        content,
        mtime_ms: stat.mtime,
      });
      this.dirty = true;
      this.persistToDisk();
    } catch { /* unreadable or deleted */ }
  }
}
