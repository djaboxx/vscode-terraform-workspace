import * as vscode from 'vscode';
import { WorkspaceConfig } from '../types/index.js';

const CONFIG_FILENAME = 'terraform-workspace.json';
const CONFIG_DIR = '.vscode';

/**
 * Manages `.vscode/terraform-workspace.json` — the per-folder binding that
 * replaces the need for a Terraform workspace to configure
 * `terraform-github-workspace` module inputs.
 *
 * One config file per VS Code workspace folder. The extension registers a
 * FileSystemWatcher so changes on disk (manual edits, git pulls) are reflected
 * live without reloading the window.
 */
export class WorkspaceConfigManager {
  private _onDidChange = new vscode.EventEmitter<vscode.WorkspaceFolder>();
  /** Fires whenever a terraform-workspace.json changes on disk. */
  readonly onDidChange = this._onDidChange.event;

  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Returns the URI of the config file for a given workspace folder. */
  configUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, CONFIG_DIR, CONFIG_FILENAME);
  }

  /**
   * Reads the config for the given folder. Returns undefined if the file does
   * not exist yet (not yet bootstrapped).
   */
  async read(folder: vscode.WorkspaceFolder): Promise<WorkspaceConfig | undefined> {
    const uri = this.configUri(folder);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      return JSON.parse(text) as WorkspaceConfig;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes (creates or overwrites) the config file for the given folder.
   * Creates the `.vscode/` directory if it doesn't exist.
   */
  async write(folder: vscode.WorkspaceFolder, config: WorkspaceConfig): Promise<void> {
    const uri = this.configUri(folder);
    const dirUri = vscode.Uri.joinPath(folder.uri, CONFIG_DIR);

    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // Already exists — ignore
    }

    const json = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
  }

  /**
   * Upserts the `terraform` server entry in `.vscode/mcp.json`.
   * If the file already exists, it is read and the `terraform` server + its
   * two inputs are merged in — preserving any other servers or inputs the user
   * may have added. The inputs use VS Code's `${input:…}` substitution so TFE
   * credentials are prompted at runtime rather than stored in plain text.
   */
  async writeMcpJson(folder: vscode.WorkspaceFolder): Promise<void> {
    const mcpUri = vscode.Uri.joinPath(folder.uri, CONFIG_DIR, 'mcp.json');

    // Read existing file, or start with an empty skeleton.
    let existing: { servers?: Record<string, unknown>; inputs?: unknown[] } = {};
    try {
      const bytes = await vscode.workspace.fs.readFile(mcpUri);
      existing = JSON.parse(Buffer.from(bytes).toString('utf-8'));
    } catch {
      // File absent or unparseable — start fresh
      const dirUri = vscode.Uri.joinPath(folder.uri, CONFIG_DIR);
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch {
        // Already exists
      }
    }

    // Upsert the terraform server entry.
    existing.servers = existing.servers ?? {};
    existing.servers['terraform'] = {
      command: 'docker',
      args: [
        'run', '-i', '--rm',
        '-e', 'TFE_TOKEN=${input:tfe_token}',
        '-e', 'TFE_ADDRESS=${input:tfe_address}',
        'hashicorp/terraform-mcp-server:0.5.2',
      ],
    };

    // Upsert the two inputs, replacing by id if already present.
    const terraformInputs = [
      {
        type: 'promptString',
        id: 'tfe_token',
        description: 'Terraform API Token',
        password: true,
      },
      {
        type: 'promptString',
        id: 'tfe_address',
        description: 'HCP Terraform / TFE address (e.g. https://app.terraform.io)',
      },
    ];
    const otherInputs = (existing.inputs ?? []).filter(
      (i): i is Record<string, unknown> =>
        typeof i === 'object' && i !== null &&
        !terraformInputs.some(ti => ti.id === (i as Record<string, unknown>)['id']),
    );
    existing.inputs = [...otherInputs, ...terraformInputs];

    await vscode.workspace.fs.writeFile(
      mcpUri,
      Buffer.from(JSON.stringify(existing, null, 2), 'utf-8'),
    );
  }

  /**
   * Creates a default (stub) config for the given folder + repo slug,
   * writing it to disk. Used when the user runs "Bootstrap Workspace".
   */
  async createDefault(
    folder: vscode.WorkspaceFolder,
    repoSlug: string,
    compositeActionOrg: string
  ): Promise<WorkspaceConfig> {
    const [owner, repoName] = repoSlug.split('/');
    const vsConfig = vscode.workspace.getConfiguration('terraformWorkspace');
    const stateRegion = vsConfig.get<string>('defaultStateRegion', 'us-gov-west-1');

    const config: WorkspaceConfig = {
      version: 1,
      compositeActionOrg,
      repo: {
        name: repoName,
        repoOrg: owner,
        description: '',
        createRepo: false,
        isPrivate: false,
        enforcePrs: true,
        adminTeams: [],
        repoTopics: ['terraform-managed'],
        vars: [],
        secrets: [],
      },
      stateConfig: {
        bucket: `inf-tfstate-${stateRegion}`,
        keyPrefix: 'terraform-state-files',
        region: stateRegion,
        dynamodbTable: 'tf_remote_state',
        setBackend: false,
      },
      environments: [],
      compositeActions: {
        checkout: 'gh-actions-checkout@v4',
        awsAuth: 'aws-auth@main',
        ghAuth: 'gh-auth@main',
        setupTerraform: 'gh-actions-terraform@v1',
        terraformInit: 'terraform-init@main',
        terraformPlan: 'terraform-plan@main',
        terraformApply: 'terraform-apply@main',
        s3Cleanup: 's3-cleanup@main',
      },
    };

    await this.write(folder, config);
    await this.writeMcpJson(folder);
    return config;
  }

  /**
   * Returns configs for all open workspace folders that have a
   * terraform-workspace.json file. Folders without one are omitted.
   */
  async readAll(): Promise<Array<{ folder: vscode.WorkspaceFolder; config: WorkspaceConfig }>> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const results: Array<{ folder: vscode.WorkspaceFolder; config: WorkspaceConfig }> = [];

    for (const folder of folders) {
      const config = await this.read(folder);
      if (config) {
        results.push({ folder, config });
      }
    }

    return results;
  }

  // ── Active folder selection ─────────────────────────────────────────────────

  private static readonly ACTIVE_FOLDER_KEY = 'terraform.activeFolderUri';

  /**
   * Persists the user's explicit folder choice across window reloads.
   * Fires `onDidChange` so tree views refresh immediately.
   */
  setActiveFolder(folder: vscode.WorkspaceFolder): void {
    this.context.workspaceState.update(WorkspaceConfigManager.ACTIVE_FOLDER_KEY, folder.uri.toString());
    this._onDidChange.fire(folder);
  }

  /**
   * Returns the explicitly-chosen folder, if it is still open in the workspace.
   * Returns undefined if the user has never chosen or the folder was removed.
   */
  getActiveFolder(): vscode.WorkspaceFolder | undefined {
    const stored = this.context.workspaceState.get<string>(WorkspaceConfigManager.ACTIVE_FOLDER_KEY);
    if (!stored) {
      return undefined;
    }
    return vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === stored);
  }

  /**
   * Shows a QuickPick of all open workspace folders, with the currently-active
   * one pre-selected.  All folders are shown (not just those with a config) so
   * the user can pick one to bootstrap.  Saves the selection and returns it.
   */
  async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      vscode.window.showWarningMessage('No workspace folders are open.');
      return undefined;
    }

    if (folders.length === 1) {
      this.setActiveFolder(folders[0]);
      return folders[0];
    }

    const current = this.getActiveFolder();
    const all = await this.readAll();
    const withConfig = new Set(all.map(r => r.folder.uri.toString()));

    const items = folders.map(folder => ({
      label: folder.name,
      description: folder.uri.fsPath,
      detail: withConfig.has(folder.uri.toString()) ? '$(check) has terraform-workspace.json' : '$(circle-slash) no config yet',
      folder,
      picked: folder.uri.toString() === current?.uri.toString(),
    }));

    const chosen = await vscode.window.showQuickPick(items, {
      title: 'Select Terraform Workspace Folder',
      placeHolder: 'Choose the root folder for Terraform operations',
      matchOnDescription: true,
    });

    if (chosen) {
      this.setActiveFolder(chosen.folder);
      return chosen.folder;
    }

    return undefined;
  }

  /**
   * Returns the active workspace folder config.
   * Priority: explicit user selection → active editor's folder → first folder
   * with a terraform-workspace.json.
   */
  async getActive(): Promise<
    { folder: vscode.WorkspaceFolder; config: WorkspaceConfig } | undefined
  > {
    // 1. Explicit user selection (persisted in workspaceState)
    const pinned = this.getActiveFolder();
    if (pinned) {
      const config = await this.read(pinned);
      if (config) {
        return { folder: pinned, config };
      }
    }

    // 2. Active editor's folder
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        const config = await this.read(folder);
        if (config) {
          return { folder, config };
        }
      }
    }

    // 3. First folder that has a config
    const all = await this.readAll();
    return all[0];
  }

  /** Opens the raw JSON config file in the editor. */
  async openInEditor(folder: vscode.WorkspaceFolder): Promise<void> {
    const uri = this.configUri(folder);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      vscode.window.showWarningMessage(
        `No terraform-workspace.json found in ${folder.name}. Use "Bootstrap Workspace" to create one.`
      );
      return;
    }
    await vscode.window.showTextDocument(uri);
  }

  /** Registers FileSystemWatchers for all open folders. Call once on activate. */
  startWatching(): vscode.Disposable {
    const pattern = new vscode.RelativePattern(
      // Watch across all workspace folders
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      `**/${CONFIG_DIR}/${CONFIG_FILENAME}`
    );

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onChange = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) {
        this._onDidChange.fire(folder);
      }
    };

    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.watchers.push(watcher);

    return new vscode.Disposable(() => {
      for (const w of this.watchers) {
        w.dispose();
      }
      this.watchers = [];
    });
  }

  dispose(): void {
    this._onDidChange.dispose();
    for (const w of this.watchers) {
      w.dispose();
    }
  }
}
