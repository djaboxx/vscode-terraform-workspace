import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Pinned provider entry parsed from `.terraform.lock.hcl`.
 * Source format: `registry.terraform.io/hashicorp/aws` or `registry.terraform.io/<ns>/<name>`.
 */
export interface PinnedProvider {
  registry: string;
  namespace: string;
  name: string;
  version: string;
  /** Original `<registry>/<ns>/<name>` source string. */
  source: string;
}

export interface ProviderDocEntry {
  /** "resources" | "data-sources" | "guides" | "functions" | "overview" */
  category: string;
  /** e.g. `s3_bucket` (no provider prefix). */
  slug: string;
  /** Friendly title from the registry, when present. */
  title?: string;
  /** Raw markdown content. */
  markdown: string;
}

export interface ProviderDocIndex {
  provider: PinnedProvider;
  fetchedAt: string;
  entries: Array<{ category: string; slug: string; title?: string }>;
}

/**
 * Fetches and caches provider documentation for the exact versions pinned in
 * `.terraform.lock.hcl`. Uses the Terraform Registry v2 (JSON:API) endpoints
 * so docs match the resolved version, not whatever happens to be `latest`.
 *
 * Layout under `globalStorage/provider-docs/`:
 *   <namespace>__<name>__<version>/
 *     index.json
 *     resources/<slug>.md
 *     data-sources/<slug>.md
 *     ...
 */
export class ProviderDocsCache {
  private readonly root: string;

  constructor(globalStoragePath: string) {
    this.root = path.join(globalStoragePath, 'provider-docs');
  }

  /** Ensures the cache root exists. */
  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Returns the cache directory for a single provider/version. */
  private dirFor(p: PinnedProvider): string {
    return path.join(this.root, `${p.namespace}__${p.name}__${p.version}`);
  }

  /**
   * Parses `.terraform.lock.hcl` files inside the workspace folder. Multiple
   * lock files may exist (one per working dir); results are deduplicated by
   * `<source>@<version>`.
   */
  async findPinnedProviders(folder: vscode.WorkspaceFolder): Promise<PinnedProvider[]> {
    const pattern = new vscode.RelativePattern(folder, '**/.terraform.lock.hcl');
    const exclude = '{**/.terraform/**,**/node_modules/**,**/vendor/**}';
    const uris = await vscode.workspace.findFiles(pattern, exclude, 50);

    const seen = new Set<string>();
    const results: PinnedProvider[] = [];
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf-8');
        for (const p of parseLockHcl(text)) {
          const key = `${p.source}@${p.version}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(p);
        }
      } catch {
        // skip unreadable lock files
      }
    }
    return results;
  }

  /** True if the cache for this exact version already exists. */
  async isCached(p: PinnedProvider): Promise<boolean> {
    try {
      await fs.access(path.join(this.dirFor(p), 'index.json'));
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the cached index, if any. */
  async loadIndex(p: PinnedProvider): Promise<ProviderDocIndex | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.dirFor(p), 'index.json'), 'utf-8');
      return JSON.parse(raw) as ProviderDocIndex;
    } catch {
      return undefined;
    }
  }

  /** Reads a single doc page from the cache. */
  async readDoc(p: PinnedProvider, category: string, slug: string): Promise<string | undefined> {
    try {
      return await fs.readFile(
        path.join(this.dirFor(p), category, `${sanitizeSlug(slug)}.md`),
        'utf-8',
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Fetches the doc index + every doc page for a single provider version from
   * the public Terraform Registry. Skips work if the cache is already populated
   * unless `force` is set.
   */
  async fetchProvider(p: PinnedProvider, opts: { force?: boolean } = {}): Promise<ProviderDocIndex> {
    await this.ensureRoot();
    const dir = this.dirFor(p);
    await fs.mkdir(dir, { recursive: true });

    if (!opts.force) {
      const cached = await this.loadIndex(p);
      if (cached) return cached;
    }

    // Step 1: resolve the version-specific provider-version ID.
    const verId = await fetchProviderVersionId(p);
    if (!verId) {
      throw new Error(`Provider ${p.namespace}/${p.name} version ${p.version} not found on registry.`);
    }

    // Step 2: list all docs for that version (JSON:API relationships + included).
    const docs = await fetchProviderDocList(verId);

    // Step 3: fetch each doc page (rate-limited fan-out).
    const entries: ProviderDocIndex['entries'] = [];
    const concurrency = 6;
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < docs.length) {
        const idx = i++;
        const meta = docs[idx];
        try {
          const md = await fetchProviderDocContent(meta.id);
          const safe = sanitizeSlug(meta.slug);
          const catDir = path.join(dir, meta.category);
          await fs.mkdir(catDir, { recursive: true });
          await fs.writeFile(path.join(catDir, `${safe}.md`), md, 'utf-8');
          entries.push({ category: meta.category, slug: meta.slug, title: meta.title });
        } catch {
          // best-effort — skip individual failures
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const index: ProviderDocIndex = {
      provider: p,
      fetchedAt: new Date().toISOString(),
      entries: entries.sort((a, b) =>
        a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug)
      ),
    };
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
    return index;
  }

  /**
   * Refresh docs for every provider pinned in the workspace. Returns a summary
   * suitable for surfacing to the user / output channel.
   */
  async refreshAll(
    folder: vscode.WorkspaceFolder,
    opts: { force?: boolean; onProgress?: (msg: string) => void } = {},
  ): Promise<{ updated: PinnedProvider[]; skipped: PinnedProvider[]; failed: Array<{ provider: PinnedProvider; error: string }> }> {
    const providers = await this.findPinnedProviders(folder);
    const updated: PinnedProvider[] = [];
    const skipped: PinnedProvider[] = [];
    const failed: Array<{ provider: PinnedProvider; error: string }> = [];

    for (const p of providers) {
      if (!opts.force && (await this.isCached(p))) {
        skipped.push(p);
        opts.onProgress?.(`Cached: ${p.namespace}/${p.name}@${p.version}`);
        continue;
      }
      try {
        opts.onProgress?.(`Fetching ${p.namespace}/${p.name}@${p.version}\u2026`);
        await this.fetchProvider(p, { force: opts.force });
        updated.push(p);
      } catch (err) {
        failed.push({ provider: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { updated, skipped, failed };
  }
}

// ─── Lock file parsing ──────────────────────────────────────────────────────

/**
 * Parses the well-known `provider "<source>" { version = "..." }` blocks from
 * `.terraform.lock.hcl`. Only fields we need are extracted; constraints and
 * hashes are ignored.
 */
export function parseLockHcl(text: string): PinnedProvider[] {
  const out: PinnedProvider[] = [];
  // Match `provider "registry.terraform.io/hashicorp/aws" { ... }` blocks.
  const blockRe = /provider\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    const source = m[1];
    const body = m[2];
    const verMatch = /version\s*=\s*"([^"]+)"/.exec(body);
    if (!verMatch) continue;
    const parts = source.split('/');
    if (parts.length !== 3) continue;
    out.push({
      source,
      registry: parts[0],
      namespace: parts[1],
      name: parts[2],
      version: verMatch[1],
    });
  }
  return out;
}

// ─── Registry fetchers ──────────────────────────────────────────────────────

const REGISTRY = 'https://registry.terraform.io';

interface JsonApiResource<T = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: T;
  relationships?: Record<string, { data?: { id: string; type: string } | Array<{ id: string; type: string }> }>;
}
interface JsonApiResponse<T = Record<string, unknown>, I = Record<string, unknown>> {
  data: JsonApiResource<T> | Array<JsonApiResource<T>>;
  included?: Array<JsonApiResource<I>>;
}

async function jsonApi<T = Record<string, unknown>, I = Record<string, unknown>>(
  url: string,
): Promise<JsonApiResponse<T, I>> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Registry ${url} returned ${res.status}`);
  return (await res.json()) as JsonApiResponse<T, I>;
}

interface ProviderVersionAttrs { version: string }

/**
 * Returns the JSON:API id for a specific provider/version, or undefined if the
 * registry doesn't list that version.
 */
async function fetchProviderVersionId(p: PinnedProvider): Promise<string | undefined> {
  // Only the public Hashicorp registry is supported for now — other registries
  // (e.g. private TFE) may use different APIs.
  if (p.registry !== 'registry.terraform.io') return undefined;

  const url = `${REGISTRY}/v2/providers/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}?include=provider-versions`;
  const resp = await jsonApi<Record<string, unknown>, ProviderVersionAttrs>(url);
  for (const inc of resp.included ?? []) {
    if (inc.type === 'provider-versions' && inc.attributes.version === p.version) {
      return inc.id;
    }
  }
  return undefined;
}

interface ProviderDocAttrs {
  category: string;
  slug: string;
  title?: string;
  language?: string;
}

interface ProviderDocMeta {
  id: string;
  category: string;
  slug: string;
  title?: string;
}

async function fetchProviderDocList(versionId: string): Promise<ProviderDocMeta[]> {
  const url = `${REGISTRY}/v2/provider-versions/${encodeURIComponent(versionId)}?include=provider-docs`;
  const resp = await jsonApi<Record<string, unknown>, ProviderDocAttrs>(url);
  const out: ProviderDocMeta[] = [];
  for (const inc of resp.included ?? []) {
    if (inc.type !== 'provider-docs') continue;
    // Skip non-English docs to avoid noise.
    if (inc.attributes.language && inc.attributes.language !== 'hcl' && inc.attributes.language !== 'en') continue;
    out.push({
      id: inc.id,
      category: inc.attributes.category,
      slug: inc.attributes.slug,
      title: inc.attributes.title,
    });
  }
  return out;
}

interface ProviderDocContentAttrs {
  content: string;
  category: string;
  slug: string;
  title?: string;
}

async function fetchProviderDocContent(docId: string): Promise<string> {
  const url = `${REGISTRY}/v2/provider-docs/${encodeURIComponent(docId)}`;
  const resp = await jsonApi<ProviderDocContentAttrs>(url);
  const data = resp.data as JsonApiResource<ProviderDocContentAttrs>;
  return data.attributes.content ?? '';
}

function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]/g, '_');
}
