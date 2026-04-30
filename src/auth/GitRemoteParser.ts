import * as vscode from 'vscode';
import * as cp from 'child_process';

interface ParsedRemote {
  hostname: string;
  org: string;
  repo: string;
  slug: string; // org/repo
}

/**
 * Parses `git remote -v` output from all VS Code workspace folders to extract
 * unique GitHub org names. Supports both SSH and HTTPS remote formats for
 * github.com and GitHub Enterprise Server.
 *
 * SSH:   git@github.com:HappyPathway/my-repo.git
 *        git@ghe.example.com:MyOrg/my-repo.git
 * HTTPS: https://github.com/HappyPathway/my-repo.git
 *        https://ghe.example.com/MyOrg/my-repo.git
 */
export class GitRemoteParser {
  /** Captures: [1]=hostname, [2]=org, [3]=repo */
  private static readonly SSH_PATTERN = /git@([^:]+)[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s/;
  /** Captures: [1]=hostname, [2]=org, [3]=repo */
  private static readonly HTTPS_PATTERN = /https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/([^/\s]+?)(?:\.git)?\s/;

  /**
   * Returns the primary GitHub hostname found in git remotes across all open
   * workspace folders. Returns `'github.com'` if no remotes are found or all
   * remotes point to github.com.
   */
  static async getHostname(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      try {
        const remotes = await this.getRemotesForFolder(folder.uri.fsPath);
        if (remotes.length > 0) {
          return remotes[0].hostname;
        }
      } catch {
        // not a git repo
      }
    }
    return 'github.com';
  }

  /**
   * Returns all unique GitHub org names found in git remotes across all open
   * VS Code workspace folders.
   */
  static async getOrgs(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const orgs = new Set<string>();

    for (const folder of folders) {
      try {
        const remotes = await this.getRemotesForFolder(folder.uri.fsPath);
        for (const r of remotes) {
          orgs.add(r.org);
        }
      } catch {
        // Folder may not be a git repo — ignore
      }
    }

    return Array.from(orgs);
  }

  /**
   * Returns all unique org/repo slugs across all open workspace folders.
   */
  static async getRepoSlugs(): Promise<string[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const slugs = new Set<string>();

    for (const folder of folders) {
      try {
        const remotes = await this.getRemotesForFolder(folder.uri.fsPath);
        for (const r of remotes) {
          slugs.add(r.slug);
        }
      } catch {
        // Not a git repo — ignore
      }
    }

    return Array.from(slugs);
  }

  /**
   * Returns the primary repo slug (org/repo) for the given workspace folder.
   * Uses the 'origin' remote first, then the first available remote.
   */
  static async getPrimaryRepoSlug(folderPath?: string): Promise<string | undefined> {
    const target = folderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!target) {
      return undefined;
    }

    const remotes = await this.getRemotesForFolder(target);
    const origin = remotes.find(r => r.org && r.repo);
    return origin?.slug;
  }

  private static getRemotesForFolder(folderPath: string): Promise<ParsedRemote[]> {
    return new Promise((resolve, reject) => {
      cp.execFile('git', ['remote', '-v'], { cwd: folderPath }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }

        const seen = new Set<string>();
        const results: ParsedRemote[] = [];

        for (const line of stdout.split('\n')) {
          // Only process fetch remotes (skip duplicate push lines)
          if (!line.includes('(fetch)')) {
            continue;
          }

          let match = line.match(this.SSH_PATTERN);
          if (!match) {
            match = line.match(this.HTTPS_PATTERN);
          }

          if (match) {
            const hostname = match[1];
            const org = match[2];
            const repo = match[3];
            const slug = `${org}/${repo}`;

            if (!seen.has(slug)) {
              seen.add(slug);
              results.push({ hostname, org, repo, slug });
            }
          }
        }

        resolve(results);
      });
    });
  }

  /**
   * Returns the current branch (HEAD) for the given folder, or `undefined`
   * if it isn't a git checkout or HEAD is detached.
   */
  static getCurrentBranch(folderPath?: string): Promise<string | undefined> {
    const target = folderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!target) return Promise.resolve(undefined);

    return new Promise(resolve => {
      cp.execFile(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: target },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const branch = stdout.trim();
          resolve(branch && branch !== 'HEAD' ? branch : undefined);
        },
      );
    });
  }

  /**
   * Returns the default branch (the upstream tracked by `origin/HEAD`) for
   * the given folder. Falls back to `main` when it cannot be determined —
   * useful as the `ref` for a `workflow_dispatch` API call.
   */
  static getDefaultBranch(folderPath?: string): Promise<string> {
    const target = folderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!target) return Promise.resolve('main');

    return new Promise(resolve => {
      cp.execFile(
        'git',
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        { cwd: target },
        (err, stdout) => {
          if (err) {
            resolve('main');
            return;
          }
          const ref = stdout.trim();
          // ref is like "origin/main"
          const slash = ref.indexOf('/');
          resolve(slash >= 0 ? ref.slice(slash + 1) : 'main');
        },
      );
    });
  }
}
