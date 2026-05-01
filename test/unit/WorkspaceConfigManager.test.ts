import { describe, it, expect, beforeEach } from 'vitest';
import * as vscodeStub from './vscode.stub.js';
import { WorkspaceConfigManager } from '../../src/config/WorkspaceConfigManager.js';

interface FsState { files: Map<string, Uint8Array>; }
let state: FsState;

function setupFs(): void {
  state = { files: new Map() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscodeStub.workspace as any).fs = {
    readFile: async (uri: { fsPath: string }) => {
      const v = state.files.get(uri.fsPath);
      if (!v) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      state.files.set(uri.fsPath, bytes);
    },
    createDirectory: async () => {},
    stat: async (uri: { fsPath: string }) => {
      if (!state.files.has(uri.fsPath)) throw new Error('ENOENT');
      return {};
    },
  };
}

const folder = (root: string) => ({
  uri: { fsPath: root, toString: () => root } as never,
  name: 'r',
  index: 0,
});

const ctx = { extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never;

beforeEach(() => {
  setupFs();
  // Explicit per-test config since other tests mutate __configStore.
  vscodeStub.__configStore['terraformWorkspace'] = { defaultStateRegion: 'us-west-2' };
});

describe('WorkspaceConfigManager.read', () => {
  it('returns undefined when the config file does not exist', async () => {
    const m = new WorkspaceConfigManager(ctx);
    expect(await m.read(folder('/x') as never)).toBeUndefined();
  });

  it('parses the JSON and normalises workspaces → environments', async () => {
    const m = new WorkspaceConfigManager(ctx);
    state.files.set(
      '/x/.vscode/terraform-workspace.json',
      Buffer.from(JSON.stringify({ version: 1, workspaces: [{ name: 'dev' }] })),
    );
    const cfg = await m.read(folder('/x') as never);
    expect(cfg?.environments).toEqual([{ name: 'dev' }]);
  });

  it('coerces missing environments to []', async () => {
    const m = new WorkspaceConfigManager(ctx);
    state.files.set('/x/.vscode/terraform-workspace.json', Buffer.from(JSON.stringify({ version: 1 })));
    const cfg = await m.read(folder('/x') as never);
    expect(cfg?.environments).toEqual([]);
  });
});

describe('WorkspaceConfigManager.write + createDefault', () => {
  it('writes pretty-printed JSON to .vscode/terraform-workspace.json', async () => {
    const m = new WorkspaceConfigManager(ctx);
    await m.write(folder('/x') as never, { version: 1, environments: [] } as never);
    const written = state.files.get('/x/.vscode/terraform-workspace.json');
    expect(written).toBeDefined();
    const text = Buffer.from(written!).toString('utf-8');
    // Pretty-printed (newline + indent).
    expect(text).toContain('\n  "version"');
  });

  it('createDefault uses the configured stateRegion in bucket name + region', async () => {
    const m = new WorkspaceConfigManager(ctx);
    const cfg = await m.createDefault(folder('/x') as never, 'acme/platform', 'acme-org');
    expect(cfg.repo.repoOrg).toBe('acme');
    expect(cfg.repo.name).toBe('platform');
    expect(cfg.compositeActionOrg).toBe('acme-org');
    expect(cfg.stateConfig.region).toBe('us-west-2');
    expect(cfg.stateConfig.bucket).toBe('inf-tfstate-us-west-2');
    // And it persisted to disk.
    expect(state.files.has('/x/.vscode/terraform-workspace.json')).toBe(true);
    expect(state.files.has('/x/.vscode/mcp.json')).toBe(true);
  });
});

describe('WorkspaceConfigManager.writeMcpJson', () => {
  it('creates a fresh mcp.json with terraform server + the two inputs', async () => {
    const m = new WorkspaceConfigManager(ctx);
    await m.writeMcpJson(folder('/x') as never);
    const text = Buffer.from(state.files.get('/x/.vscode/mcp.json')!).toString('utf-8');
    const parsed = JSON.parse(text);
    expect(parsed.servers.terraform.command).toBe('docker');
    expect(parsed.servers.terraform.args).toContain('hashicorp/terraform-mcp-server:0.5.2');
    expect(parsed.inputs.map((i: { id: string }) => i.id).sort()).toEqual(['tfe_address', 'tfe_token']);
  });

  it('preserves other servers and non-terraform inputs', async () => {
    state.files.set(
      '/x/.vscode/mcp.json',
      Buffer.from(JSON.stringify({
        servers: { other: { command: 'node' } },
        inputs: [{ id: 'unrelated', type: 'promptString' }],
      })),
    );
    const m = new WorkspaceConfigManager(ctx);
    await m.writeMcpJson(folder('/x') as never);
    const parsed = JSON.parse(Buffer.from(state.files.get('/x/.vscode/mcp.json')!).toString('utf-8'));
    expect(parsed.servers.other).toEqual({ command: 'node' });
    expect(parsed.servers.terraform).toBeDefined();
    const ids = parsed.inputs.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual(['tfe_address', 'tfe_token', 'unrelated']);
  });

  it('replaces an existing terraform input entry instead of duplicating', async () => {
    state.files.set(
      '/x/.vscode/mcp.json',
      Buffer.from(JSON.stringify({
        servers: {},
        inputs: [
          { id: 'tfe_token', type: 'promptString', description: 'old' },
          { id: 'tfe_address', type: 'promptString', description: 'old addr' },
        ],
      })),
    );
    const m = new WorkspaceConfigManager(ctx);
    await m.writeMcpJson(folder('/x') as never);
    const parsed = JSON.parse(Buffer.from(state.files.get('/x/.vscode/mcp.json')!).toString('utf-8'));
    const tokenInput = parsed.inputs.find((i: { id: string }) => i.id === 'tfe_token');
    expect(tokenInput.description).toBe('Terraform API Token');
    expect(parsed.inputs.filter((i: { id: string }) => i.id === 'tfe_token')).toHaveLength(1);
  });
});
