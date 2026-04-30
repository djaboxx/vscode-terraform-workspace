import * as vscode from 'vscode';

/**
 * The set of composite actions the extension knows how to scaffold into a
 * workspace repo under `.github/actions/<name>/action.yml`. The names here
 * must match the directory names under `templates/actions/` shipped with the
 * extension AND the keys exposed via `LOCAL_ACTION_REFS` below.
 */
export const LOCAL_ACTION_NAMES = [
  'aws-auth',
  'gh-auth',
  'setup-terraform',
  'terraform-init',
  'terraform-plan',
  'terraform-apply',
  's3-cleanup',
] as const;

export type LocalActionName = (typeof LOCAL_ACTION_NAMES)[number];

/**
 * Composite action `uses:` references resolved as repo-local paths. These are
 * what we substitute into generated workflow YAML when local actions are
 * enabled. `checkout` is intentionally excluded — it always points to the
 * official `actions/checkout@v4`.
 */
export const LOCAL_ACTION_REFS: Record<LocalActionName, string> = {
  'aws-auth':        './.github/actions/aws-auth',
  'gh-auth':         './.github/actions/gh-auth',
  'setup-terraform': './.github/actions/setup-terraform',
  'terraform-init':  './.github/actions/terraform-init',
  'terraform-plan':  './.github/actions/terraform-plan',
  'terraform-apply': './.github/actions/terraform-apply',
  's3-cleanup':      './.github/actions/s3-cleanup',
};

/**
 * Copies bundled action templates from the extension's `templates/actions/`
 * directory into the user's repo at `.github/actions/<name>/action.yml`.
 *
 * Files are only overwritten when their contents differ from the bundled
 * version, so users can safely customize an action and keep their changes
 * (the next sync will leave it alone unless the user discards their edits).
 *
 * Uses `vscode.workspace.fs` exclusively so it works in remote / virtual
 * workspaces (Codespaces, SSH, Dev Containers).
 */
export class LocalActionsScaffolder {
  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Writes all known local actions into `<folder>/.github/actions/`.
   * Returns the URIs of files that were actually created or updated.
   */
  async scaffold(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    const written: vscode.Uri[] = [];
    for (const name of LOCAL_ACTION_NAMES) {
      const wrote = await this.writeOne(folder, name);
      if (wrote) written.push(wrote);
    }
    return written;
  }

  private async writeOne(
    folder: vscode.WorkspaceFolder,
    name: LocalActionName,
  ): Promise<vscode.Uri | undefined> {
    const sourceUri = vscode.Uri.joinPath(
      this.extensionUri, 'templates', 'actions', name, 'action.yml',
    );

    let template: Uint8Array;
    try {
      template = await vscode.workspace.fs.readFile(sourceUri);
    } catch (err) {
      throw new Error(
        `Action template not found: ${sourceUri.toString()}. ` +
        `Make sure templates/ is included in the published extension (.vscodeignore).`,
      );
    }

    const destDir  = vscode.Uri.joinPath(folder.uri, '.github', 'actions', name);
    const destFile = vscode.Uri.joinPath(destDir, 'action.yml');

    // Skip writes when content is byte-for-byte identical
    try {
      const existing = await vscode.workspace.fs.readFile(destFile);
      if (Buffer.compare(Buffer.from(template), Buffer.from(existing)) === 0) {
        return undefined;
      }
    } catch {
      // file doesn't exist — fall through to write
    }

    await vscode.workspace.fs.createDirectory(destDir);
    await vscode.workspace.fs.writeFile(destFile, template);
    return destFile;
  }
}
