import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TfRun, RunStatus, RunConclusion, RunType } from '../types/index.js';
import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';

function sleepCancellable(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    const sub = token?.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}


export interface WorkflowDispatchInputs {
  workspace: string;
  working_directory?: string;
  [key: string]: string | undefined;
}

export interface GhaWorkflowRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  run_number?: number;
  actor: { login: string } | null;
  triggering_actor: { login: string } | null;
}

/**
 * Thin GitHub Actions API client.
 * All operations use the VS Code GitHub auth session — no separate token storage.
 */
export class GithubActionsClient {
  constructor(private readonly auth: GithubAuthProvider) {}

  /**
   * Triggers a workflow via workflow_dispatch event.
   * @param owner   GitHub org or user
   * @param repo    Repo name
   * @param workflowFile  Workflow filename (e.g. "terraform-plan-production.yml")
   * @param inputs  workflow_dispatch inputs
   * @param ref     Branch / tag / SHA to dispatch from. Defaults to "main".
   */
  async triggerWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    inputs: WorkflowDispatchInputs,
    ref: string = 'main'
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      throw new Error('GitHub authentication required');
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ ref, inputs }),
      }
    );

    if (!response.ok && response.status !== 204) {
      const body = await response.text();
      throw new Error(`Workflow dispatch failed (${response.status}): ${body}`);
    }
  }

  /**
   * Lists recent workflow runs for a given workflow file.
   */
  async getWorkflowRuns(
    owner: string,
    repo: string,
    workflowFile: string,
    perPage = 20
  ): Promise<GhaWorkflowRun[]> {
    const token = await this.auth.getToken();
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=${perPage}`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { workflow_runs: GhaWorkflowRun[] };
    return data.workflow_runs ?? [];
  }

  /**
   * Gets a single workflow run by ID.
   */
  async getRunById(owner: string, repo: string, runId: number): Promise<GhaWorkflowRun | undefined> {
    const token = await this.auth.getToken();
    if (!token) {
      return undefined;
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return undefined;
    }

    return (await response.json()) as GhaWorkflowRun;
  }

  /**
   * Polls a workflow run until it reaches a terminal state, emitting status
   * updates to the provided OutputChannel.
   */
  async waitForRun(
    owner: string,
    repo: string,
    runId: number,
    outputChannel: vscode.OutputChannel,
    intervalMs = 5000,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<GhaWorkflowRun> {
    const terminalStatuses = new Set(['completed', 'cancelled', 'failure', 'skipped']);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (cancellationToken?.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      const run = await this.getRunById(owner, repo, runId);
      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      outputChannel.appendLine(
        `[${new Date().toISOString()}] Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`
      );

      if (terminalStatuses.has(run.status)) {
        return run;
      }

      await sleepCancellable(intervalMs, cancellationToken);
    }
  }

  /**
   * Downloads and streams run logs to the provided OutputChannel.
   * GitHub returns a zip archive — we write the raw redirect URL to the channel
   * and open it in the browser for full log access.
   */
  async streamRunLogs(
    owner: string,
    repo: string,
    runId: number,
    outputChannel: vscode.OutputChannel
  ): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) {
      return;
    }

    // GitHub redirects to a pre-signed URL for the log archive
    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
      {
        method: 'GET',
        headers: this.headers(token),
        redirect: 'manual',
      }
    );

    if (response.status === 302) {
      const logsUrl = response.headers.get('location');
      if (logsUrl) {
        outputChannel.appendLine(`\nFull logs available at: ${logsUrl}`);
        await vscode.env.openExternal(vscode.Uri.parse(`https://${this.auth.hostname}/${owner}/${repo}/actions/runs/${runId}`));
      }
    } else {
      outputChannel.appendLine(`Unable to retrieve logs (status ${response.status})`);
    }
  }

  /**
   * Finds the most recently dispatched run for a workflow (useful after
   * triggerWorkflow to get the run ID). Polls briefly since GHA ingests
   * dispatches asynchronously.
   */
  async waitForNewRun(
    owner: string,
    repo: string,
    workflowFile: string,
    afterTimestamp: Date,
    timeoutMs = 30000,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<GhaWorkflowRun | undefined> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (cancellationToken?.isCancellationRequested) {
        return undefined;
      }
      const runs = await this.getWorkflowRuns(owner, repo, workflowFile, 5);
      // Use a small grace buffer (3s) to absorb GitHub server-clock skew —
      // otherwise a run created in the same second as our trigger can be missed.
      const cutoff = afterTimestamp.getTime() - 3000;
      const newRun = runs.find(r => new Date(r.created_at).getTime() >= cutoff);

      if (newRun) {
        return newRun;
      }

      await sleepCancellable(2000, cancellationToken);
    }

    return undefined;
  }

  /**
   * Lists all recent workflow runs for a repository (not scoped to a single workflow file).
   */
  async listRepoRuns(owner: string, repo: string, perPage = 20): Promise<GhaWorkflowRun[]> {
    const token = await this.auth.getToken(true);
    if (!token) {
      return [];
    }

    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`,
      { headers: this.headers(token) }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { workflow_runs: GhaWorkflowRun[] };
    return data.workflow_runs ?? [];
  }

  /**
   * Lists pending deployments waiting on environment protection rules for a run.
   * Returns the environments + IDs needed to call `reviewDeployments`.
   */
  async listPendingDeployments(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<Array<{ environment: { id: number; name: string }; current_user_can_approve: boolean }>> {
    const token = await this.auth.getToken(true);
    if (!token) return [];
    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`,
      { headers: this.headers(token) },
    );
    if (!response.ok) return [];
    return (await response.json()) as Array<{
      environment: { id: number; name: string };
      current_user_can_approve: boolean;
    }>;
  }

  /**
   * Approves or rejects pending deployments for a run.
   * `state` is `'approved'` or `'rejected'`. `comment` is shown in the audit log.
   */
  async reviewDeployments(
    owner: string,
    repo: string,
    runId: number,
    environmentIds: number[],
    state: 'approved' | 'rejected',
    comment: string,
  ): Promise<boolean> {
    const token = await this.auth.getToken(true);
    if (!token) return false;
    const response = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}/pending_deployments`,
      {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ environment_ids: environmentIds, state, comment }),
      },
    );
    return response.ok;
  }

  /** Converts a GHA workflow run to our TfRun domain type. */
  toTfRun(run: GhaWorkflowRun, workspaceId: string, repoSlug: string, type: RunType): TfRun {
    return {
      id: run.id,
      type,
      workspaceId,
      repoSlug,
      workflowRunId: run.id,
      htmlUrl: run.html_url,
      status: run.status as RunStatus,
      conclusion: (run.conclusion as RunConclusion) ?? null,
      triggeredBy: (run.triggering_actor ?? run.actor)?.login,
      commitSha: run.head_sha,
      startedAt: run.created_at,
      completedAt: run.updated_at,
    };
  }

  private headers(token: string): Record<string, string> {
    return { ...this.auth.ghHeaders(token), 'Content-Type': 'application/json' };
  }

  // ── Plan-output helpers ───────────────────────────────────────────────────

  /**
   * Tries to retrieve `plan.txt` for a completed workflow run.
   *
   * Strategy (in order):
   *  1. Look for an artifact named `terraform-plan-<env>` (uploaded by the
   *     CodeBuild-dispatching GHA step via `actions/upload-artifact@v4`).
   *  2. Fall back to scanning the raw run-logs zip for a step whose name
   *     contains "Terraform Plan" and extracting the log text.
   *
   * Returns `undefined` if neither source yields usable text.
   */
  async fetchPlanText(
    owner: string,
    repo: string,
    runId: number,
    envName: string,
    cacheBucket?: string,
  ): Promise<string | undefined> {
    // ── Strategy 1: S3 plan-output (uploaded by terraform-plan action) ────
    // Key: plan-output/<runId>/plan.stdout — deterministic, survives cache cleanup.
    if (cacheBucket) {
      const fromS3 = await this.fetchPlanFromS3(cacheBucket, runId);
      if (fromS3) return fromS3;
    }

    // ── Strategy 2: raw log zip ────────────────────────────────────────────
    return this.fetchPlanFromLogs(owner, repo, runId);
  }

  /**
   * Downloads `plan-output/<runId>/plan.stdout` from the cache S3 bucket using
   * the local `aws` CLI (same credential chain the runner uses). This is the
   * primary strategy when `cacheBucket` is known — it does not require the GHA
   * Artifact service, which is unavailable in some enterprise environments.
   */
  private async fetchPlanFromS3(
    cacheBucket: string,
    runId: number,
  ): Promise<string | undefined> {
    const dest = path.join(os.tmpdir(), `tfplan-${runId}.txt`);
    const s3Uri = `s3://${cacheBucket}/plan-output/${runId}/plan.stdout`;
    const ok = await new Promise<boolean>(resolve => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('child_process') as typeof import('child_process');
      const child = spawn('aws', ['s3', 'cp', s3Uri, dest], {
        env: process.env,
        stdio: 'ignore',
      });
      child.on('close', (code: number | null) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
    if (!ok) return undefined;
    try {
      const text = await fs.readFile(dest, 'utf-8');
      await fs.unlink(dest).catch(() => {/* best-effort cleanup */});
      return text;
    } catch {
      return undefined;
    }
  }

  /**
   * Downloads the run-logs zip and searches for a log file whose path
   * contains "Terraform Plan" (the step name from the generated workflows).
   * Returns the first match, stripping GitHub's `YYYY-MM-DDTHH:MM:SSZ ` timestamp prefix.
   */
  private async fetchPlanFromLogs(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<string | undefined> {
    const token = await this.auth.getToken();
    if (!token) return undefined;

    const resp = await this.auth.fetch(
      `${this.auth.apiBaseUrl}/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
      { headers: this.headers(token), redirect: 'follow' },
    );
    if (!resp.ok && resp.status !== 302) return undefined;

    // When redirect:'follow' the response body is the zip.
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) return undefined;

    // Find the step log file whose name contains "Terraform_Plan" or "Terraform Plan".
    return this.extractFileFromZip(buf, null, /terraform.?plan/i);
  }

  /**
   * Extracts a file from a zip buffer using jszip (already a transitive dep).
   * Pass `fileName` for an exact match, or `namePattern` for a regex search.
   * Strips GitHub's `YYYY-MM-DDTHH:MM:SSZ ` log-line prefix when present.
   */
  private async extractFileFromZip(
    buf: Buffer,
    fileName: string | null,
    namePattern?: RegExp,
  ): Promise<string | undefined> {
    try {
      // jszip is an existing dep — import lazily to keep activation fast.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const JSZip = (require('jszip') as { default: new () => import('jszip') }).default ?? require('jszip');
      const zip = await (new JSZip()).loadAsync(buf);
      const entry = Object.values(zip.files).find(f => {
        if (f.dir) return false;
        if (fileName) return f.name.endsWith(fileName);
        if (namePattern) return namePattern.test(f.name);
        return false;
      });
      if (!entry) return undefined;

      const raw = await entry.async('string');
      // Strip GHA log timestamps: "2024-01-15T12:34:56.7890000Z "
      return raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, '').trimEnd();
    } catch {
      return undefined;
    }
  }
}
