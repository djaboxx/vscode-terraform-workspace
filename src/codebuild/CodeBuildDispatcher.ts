import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { createWriteStream } from 'fs';
import * as crypto from 'crypto';

/**
 * Dispatches Terraform plan/apply runs into a pre-provisioned AWS CodeBuild
 * project — the same shape as djaboxx/packer-pipeline, applied to terraform.
 *
 * Flow (run from VS Code, locally):
 *   1. Zip the workspace folder (excluding .git, .terraform, node_modules…).
 *   2. `aws s3 cp` the zip to `s3://<sourceBucket>/terraform-src/<env>/<id>.zip`.
 *   3. `aws codebuild start-build` with TF_COMMAND/TF_WORKSPACE/ARTIFACT_* env overrides.
 *   4. Poll `aws codebuild batch-get-builds` and stream CloudWatch logs into the
 *      output channel until the build reaches a terminal state.
 *   5. `aws s3 cp --recursive` the artifacts back into a per-run local dir.
 *
 * Why shell out to `aws` instead of using the AWS SDK:
 *   - Inherits the user's already-exported `awscreds` env (no SDK config dance).
 *   - Avoids bundling the SDK (~2 MB) into the extension.
 *   - Same code path as the generated GHA workflow, so behavior matches 1:1.
 */
export interface CodeBuildDispatchInputs {
  region: string;
  project: string;
  sourceBucket: string;
  artifactBucket?: string;
  workspace: string;
  command: 'plan' | 'apply';
  /** Folder to zip and ship. */
  workingDirectory: vscode.Uri;
}

export interface CodeBuildDispatchResult {
  buildId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED';
  artifactsDir: vscode.Uri;
}

export class CodeBuildDispatcher {
  constructor(private readonly output: vscode.OutputChannel) {}

  async dispatch(
    inputs: CodeBuildDispatchInputs,
    token: vscode.CancellationToken,
  ): Promise<CodeBuildDispatchResult> {
    const artifactBucket = inputs.artifactBucket ?? inputs.sourceBucket;
    const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const sourceKey = `terraform-src/${inputs.workspace}/${runId}.zip`;
    const artifactKey = `terraform-artifacts/${inputs.workspace}/${runId}/`;

    this.output.show(true);
    this.log(`▶ Dispatching ${inputs.command} for "${inputs.workspace}" → ${inputs.project} (${inputs.region})`);

    // ── 1. Zip ──────────────────────────────────────────────────────────────
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-cb-'));
    const zipPath = path.join(tmpDir, 'src.zip');
    this.log(`• Zipping ${inputs.workingDirectory.fsPath} → ${zipPath}`);
    await this.runCmd(
      'zip',
      ['-qr', zipPath, '.', '-x', '.git/*', '-x', '.terraform/*', '-x', 'node_modules/*', '-x', '.tf-artifacts/*'],
      { cwd: inputs.workingDirectory.fsPath },
      token,
    );

    // ── 2. Upload ───────────────────────────────────────────────────────────
    this.log(`• Uploading to s3://${inputs.sourceBucket}/${sourceKey}`);
    await this.runAws(
      ['s3', 'cp', zipPath, `s3://${inputs.sourceBucket}/${sourceKey}`],
      inputs.region,
      token,
    );

    // ── 3. start-build ──────────────────────────────────────────────────────
    this.log(`• Starting CodeBuild project ${inputs.project}`);
    const startOut = await this.runAwsJson<{ build: { id: string } }>(
      [
        'codebuild', 'start-build',
        '--project-name', inputs.project,
        '--source-type-override', 'S3',
        '--source-location-override', `${inputs.sourceBucket}/${sourceKey}`,
        '--environment-variables-override',
        `name=TF_COMMAND,value=${inputs.command}`,
        `name=TF_WORKSPACE,value=${inputs.workspace}`,
        `name=ARTIFACT_BUCKET,value=${artifactBucket}`,
        `name=ARTIFACT_KEY,value=${artifactKey}`,
        `name=GITHUB_REPOSITORY,value=local-vscode`,
        `name=GITHUB_SHA,value=${runId}`,
      ],
      inputs.region,
      token,
    );
    const buildId = startOut.build.id;
    this.log(`✓ Build started: ${buildId}`);

    // ── 4. Poll + stream logs ───────────────────────────────────────────────
    const status = await this.tailUntilDone(buildId, inputs.region, token);
    this.log(`◀ Build ended: ${status}`);

    // ── 5. Download artifacts ───────────────────────────────────────────────
    const artifactsDir = vscode.Uri.joinPath(
      inputs.workingDirectory, '.tf-artifacts', inputs.workspace, runId,
    );
    await fs.mkdir(artifactsDir.fsPath, { recursive: true });
    this.log(`• Downloading artifacts to ${artifactsDir.fsPath}`);
    try {
      await this.runAws(
        ['s3', 'cp', `s3://${artifactBucket}/${artifactKey}`, artifactsDir.fsPath, '--recursive'],
        inputs.region,
        token,
      );
    } catch (e) {
      this.log(`  (artifact download failed or none present: ${(e as Error).message})`);
    }

    // best-effort cleanup of the temp zip
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

    return { buildId, status, artifactsDir };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async tailUntilDone(
    buildId: string,
    region: string,
    token: vscode.CancellationToken,
  ): Promise<CodeBuildDispatchResult['status']> {
    let logGroup = '';
    let logStream = '';
    let nextToken: string | undefined;
    while (!token.isCancellationRequested) {
      const builds = await this.runAwsJson<{ builds: Array<{
        buildStatus: string;
        logs?: { groupName?: string; streamName?: string };
      }> }>(
        ['codebuild', 'batch-get-builds', '--ids', buildId],
        region,
        token,
      );
      const b = builds.builds[0];
      if (!logGroup && b.logs?.groupName) logGroup = b.logs.groupName;
      if (!logStream && b.logs?.streamName) logStream = b.logs.streamName;

      if (logGroup && logStream) {
        const args = ['logs', 'get-log-events',
          '--log-group-name', logGroup,
          '--log-stream-name', logStream,
          '--start-from-head',
          '--limit', '1000'];
        if (nextToken) args.push('--next-token', nextToken);
        try {
          const events = await this.runAwsJson<{
            events: Array<{ message: string }>;
            nextForwardToken?: string;
          }>(args, region, token);
          for (const e of events.events) this.output.append(e.message);
          if (events.nextForwardToken && events.nextForwardToken !== nextToken) {
            nextToken = events.nextForwardToken;
          }
        } catch {
          // logs not yet available — keep polling
        }
      }

      switch (b.buildStatus) {
        case 'SUCCEEDED':
        case 'FAILED':
        case 'FAULT':
        case 'TIMED_OUT':
        case 'STOPPED':
          return b.buildStatus as CodeBuildDispatchResult['status'];
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    // Cancelled — try to stop the build to avoid runaway charges.
    this.log('• Cancellation requested; stopping build');
    try {
      await this.runAws(['codebuild', 'stop-build', '--id', buildId], region, token);
    } catch { /* best effort */ }
    return 'STOPPED';
  }

  private log(msg: string): void {
    this.output.appendLine(msg);
  }

  private runAws(
    args: string[],
    region: string,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return this.runCmd('aws', args, { env: this.awsEnv(region) }, token);
  }

  private async runAwsJson<T>(
    args: string[],
    region: string,
    token: vscode.CancellationToken,
  ): Promise<T> {
    const stdout = await this.runCmd(
      'aws',
      [...args, '--output', 'json'],
      { env: this.awsEnv(region) },
      token,
    );
    return JSON.parse(stdout) as T;
  }

  private awsEnv(region: string): NodeJS.ProcessEnv {
    // Inherit the user's exported AWS_* env (e.g. from `awscreds`), but force
    // AWS_REGION so SDK calls don't fail when the shell didn't export it.
    return {
      ...process.env,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
    };
  }

  private runCmd(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
    token: vscode.CancellationToken,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const cancelSub = token.onCancellationRequested(() => child.kill('SIGTERM'));
      child.on('error', (err) => { cancelSub.dispose(); reject(err); });
      child.on('close', (code) => {
        cancelSub.dispose();
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} ${args[0]} exited ${code}: ${stderr || stdout}`));
      });
    });
  }
}

// Suppress unused-import warning for createWriteStream in some toolchains.
void createWriteStream;
