import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

/**
 * Dispatches a Lambda container-image build into the user's existing
 * packer-pipeline CodeBuild project, then captures the resulting ECR image
 * digest and writes it to `terraform.tfvars.json` next to the Lambda
 * Terraform so the next `terraform apply` pins by digest.
 *
 * Mirrors `CodeBuildDispatcher` (zip → S3 → start-build → tail → resolve digest).
 *
 * Why we shell out to `aws` instead of using the SDK: same reasons as
 * CodeBuildDispatcher — inherits the user's `awscreds` env, no SDK bundle,
 * matches what packer-pipeline does in CI.
 */

export interface LambdaImageBuildInputs {
  region: string;
  /** Existing packer-pipeline CodeBuild project. */
  packerCodebuildProject: string;
  /** S3 bucket the packer-pipeline project reads sources from. */
  sourceBucket: string;
  /** ECR repository name (NOT the URI). e.g. `my-fn`. */
  ecrRepoName: string;
  /** Image tag to push (digest is captured separately, this is just for human readability). */
  imageTag: string;
  /** Folder containing packer.pkr.hcl, build.hcl, src/, etc. */
  workingDirectory: vscode.Uri;
  /** Logical function name — used to scope the S3 key + tfvars path. */
  functionName: string;
}

export interface LambdaImageBuildResult {
  buildId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED';
  /** Full ECR URI@sha256 (e.g. `123.dkr.ecr.us-east-1.amazonaws.com/my-fn@sha256:abc…`). */
  imageUri?: string;
  /** Just the digest portion (`sha256:...`). */
  imageDigest?: string;
  /** Path to the tfvars file we wrote (only present on SUCCEEDED). */
  tfvarsPath?: string;
}

export class LambdaImageDispatcher {
  constructor(private readonly output: vscode.OutputChannel) {}

  async buildAndPublish(
    inputs: LambdaImageBuildInputs,
    token: vscode.CancellationToken,
  ): Promise<LambdaImageBuildResult> {
    const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const sourceKey = `lambda-image-src/${inputs.functionName}/${runId}.zip`;

    this.output.show(true);
    this.log(`▶ Building Lambda image for "${inputs.functionName}" → ${inputs.packerCodebuildProject} (${inputs.region})`);

    // 1. Zip the packer dir
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lambda-img-'));
    const zipPath = path.join(tmpDir, 'src.zip');
    this.log(`• Zipping ${inputs.workingDirectory.fsPath} → ${zipPath}`);
    await this.runCmd(
      'zip',
      ['-qr', zipPath, '.', '-x', '.git/*', '-x', '.terraform/*', '-x', 'node_modules/*'],
      { cwd: inputs.workingDirectory.fsPath },
      token,
    );

    // 2. Upload source
    this.log(`• Uploading to s3://${inputs.sourceBucket}/${sourceKey}`);
    await this.runAws(
      ['s3', 'cp', zipPath, `s3://${inputs.sourceBucket}/${sourceKey}`],
      inputs.region,
      token,
    );

    // 3. Start packer-pipeline CodeBuild
    this.log(`• Starting CodeBuild project ${inputs.packerCodebuildProject}`);
    const startOut = await this.runAwsJson<{ build: { id: string } }>(
      [
        'codebuild', 'start-build',
        '--project-name', inputs.packerCodebuildProject,
        '--source-type-override', 'S3',
        '--source-location-override', `${inputs.sourceBucket}/${sourceKey}`,
        '--environment-variables-override',
        `name=IMAGE_TAG,value=${inputs.imageTag}`,
        `name=ECR_REPO,value=${inputs.ecrRepoName}`,
      ],
      inputs.region,
      token,
    );
    const buildId = startOut.build.id;
    this.log(`✓ Build started: ${buildId}`);

    // 4. Tail until done
    const status = await this.tailUntilDone(buildId, inputs.region, token);
    this.log(`◀ Build ended: ${status}`);

    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

    if (status !== 'SUCCEEDED') {
      return { buildId, status };
    }

    // 5. Resolve the digest from ECR (immutable, never trust the tag)
    this.log(`• Resolving digest for ${inputs.ecrRepoName}:${inputs.imageTag} from ECR`);
    let imageUri: string | undefined;
    let imageDigest: string | undefined;
    try {
      const desc = await this.runAwsJson<{
        imageDetails: Array<{ imageDigest: string; registryId: string; repositoryName: string }>;
      }>(
        [
          'ecr', 'describe-images',
          '--repository-name', inputs.ecrRepoName,
          '--image-ids', `imageTag=${inputs.imageTag}`,
        ],
        inputs.region,
        token,
      );
      const detail = desc.imageDetails[0];
      if (detail) {
        imageDigest = detail.imageDigest;
        imageUri = `${detail.registryId}.dkr.ecr.${inputs.region}.amazonaws.com/${detail.repositoryName}@${imageDigest}`;
        this.log(`✓ Digest: ${imageDigest}`);
      }
    } catch (e) {
      this.log(`  (digest lookup failed: ${(e as Error).message})`);
    }

    // 6. Write tfvars so the next `terraform apply` pins
    let tfvarsPath: string | undefined;
    if (imageDigest) {
      tfvarsPath = path.join(inputs.workingDirectory.fsPath, 'terraform.tfvars.json');
      const existing = await this.readJsonIfExists(tfvarsPath);
      const merged = { ...existing, image_digest: imageDigest };
      await fs.writeFile(tfvarsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
      this.log(`✓ Wrote ${tfvarsPath}`);
    }

    return { buildId, status, imageUri, imageDigest, tfvarsPath };
  }

  // ── helpers (parallel structure to CodeBuildDispatcher) ────────────────────

  private async readJsonIfExists(p: string): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private async tailUntilDone(
    buildId: string,
    region: string,
    token: vscode.CancellationToken,
  ): Promise<LambdaImageBuildResult['status']> {
    let logGroup = '';
    let logStream = '';
    let nextToken: string | undefined;
    while (!token.isCancellationRequested) {
      const builds = await this.runAwsJson<{
        builds: Array<{ buildStatus: string; logs?: { groupName?: string; streamName?: string } }>;
      }>(['codebuild', 'batch-get-builds', '--ids', buildId], region, token);
      const b = builds.builds[0];
      if (!logGroup && b.logs?.groupName) logGroup = b.logs.groupName;
      if (!logStream && b.logs?.streamName) logStream = b.logs.streamName;

      if (logGroup && logStream) {
        const args = [
          'logs', 'get-log-events',
          '--log-group-name', logGroup,
          '--log-stream-name', logStream,
          '--start-from-head',
          '--limit', '1000',
        ];
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
          // logs not yet available
        }
      }

      switch (b.buildStatus) {
        case 'SUCCEEDED':
        case 'FAILED':
        case 'FAULT':
        case 'TIMED_OUT':
        case 'STOPPED':
          return b.buildStatus as LambdaImageBuildResult['status'];
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
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
