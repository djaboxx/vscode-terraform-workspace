import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { RunnerEnvironment } from './GheRunnerConfig.js';
import { GithubAuthProvider } from '../auth/GithubAuthProvider.js';

// ── Data shapes ────────────────────────────────────────────────────────────

export interface EcsServiceStatus {
  runningCount: number;
  desiredCount: number;
  pendingCount: number;
  /** e.g. "PRIMARY" */
  primaryDeploymentStatus: string;
  /** ISO timestamp of the most recent deployment event */
  lastEventAt: string | null;
  /** Last few ECS service event messages */
  recentEvents: string[];
}

export interface GithubRunner {
  id: number;
  name: string;
  /** "online" | "offline" */
  status: string;
  /** "idle" | "active" */
  busy: boolean;
  labels: string[];
}

export interface RunnerFullStatus {
  environment: RunnerEnvironment;
  ecs: EcsServiceStatus | null;
  ecsError: string | null;
  githubRunners: GithubRunner[];
  githubError: string | null;
  /** ISO timestamp */
  fetchedAt: string;
}

// ── Shell helpers ──────────────────────────────────────────────────────────

function runCmd(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  token?: vscode.CancellationToken,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const sub = token?.onCancellationRequested(() => {
      try { child.kill('SIGTERM'); } catch { /* ok */ }
    });

    child.once('error', (err) => {
      sub?.dispose();
      reject(new Error(`spawn ${cmd}: ${err.message}`));
    });
    child.once('close', (code) => {
      sub?.dispose();
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

async function runAwsJson<T>(
  args: string[],
  region: string,
  token?: vscode.CancellationToken,
): Promise<T> {
  const env = { AWS_REGION: region, AWS_DEFAULT_REGION: region };
  const { stdout, stderr, code } = await runCmd('aws', args, env, token);
  if (code !== 0) {
    throw new Error(`aws ${args.slice(0, 3).join(' ')} failed (${code}): ${stderr.trim()}`);
  }
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`aws command returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
}

// ── Main client ────────────────────────────────────────────────────────────

/**
 * All operations that talk to AWS (via `aws` CLI) or GitHub (via
 * `GithubAuthProvider`) for managing self-hosted runner environments.
 *
 * Follows the same shell-out philosophy as `CodeBuildDispatcher` /
 * `LambdaLogTailer` — inherits the user's `awscreds` env, no SDK bundle.
 */
export class GheRunnersClient {
  constructor(private readonly auth: GithubAuthProvider) {}

  // ── ECS operations ───────────────────────────────────────────────────────

  /**
   * Returns ECS service health for the given runner environment.
   */
  async getEcsStatus(
    env: RunnerEnvironment,
    token?: vscode.CancellationToken,
  ): Promise<EcsServiceStatus> {
    const result = await runAwsJson<{
      services: Array<{
        runningCount: number;
        desiredCount: number;
        pendingCount: number;
        deployments: Array<{ status: string }>;
        events: Array<{ createdAt: string; message: string }>;
      }>;
    }>(
      [
        'ecs', 'describe-services',
        '--cluster', env.ecsCluster,
        '--services', env.ecsService,
        '--output', 'json',
      ],
      env.awsRegion,
      token,
    );

    const svc = result.services?.[0];
    if (!svc) throw new Error(`ECS service "${env.ecsService}" not found in cluster "${env.ecsCluster}"`);

    const primary = svc.deployments?.find(d => d.status === 'PRIMARY');
    const recentEvents = (svc.events ?? []).slice(0, 5).map(e => e.message);
    const lastEventAt = svc.events?.[0]?.createdAt ?? null;

    return {
      runningCount: svc.runningCount,
      desiredCount: svc.desiredCount,
      pendingCount: svc.pendingCount,
      primaryDeploymentStatus: primary?.status ?? 'UNKNOWN',
      lastEventAt,
      recentEvents,
    };
  }

  /**
   * Force a new ECS deployment (equivalent to `aws ecs update-service --force-new-deployment`).
   * Restarts all runner tasks, picking up fresh tokens from Secrets Manager.
   */
  async forceRedeploy(
    env: RunnerEnvironment,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await runAwsJson(
      [
        'ecs', 'update-service',
        '--cluster', env.ecsCluster,
        '--service', env.ecsService,
        '--force-new-deployment',
        '--output', 'json',
      ],
      env.awsRegion,
      token,
    );
  }

  /**
   * Update the ECS service desired count (scale up or down).
   */
  async scaleRunners(
    env: RunnerEnvironment,
    desiredCount: number,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (desiredCount < 0) throw new Error('desiredCount must be >= 0');
    await runAwsJson(
      [
        'ecs', 'update-service',
        '--cluster', env.ecsCluster,
        '--service', env.ecsService,
        '--desired-count', String(desiredCount),
        '--output', 'json',
      ],
      env.awsRegion,
      token,
    );
  }

  // ── Lambda token refresh ─────────────────────────────────────────────────

  /**
   * Invoke the token-refresh Lambda function and return its response payload.
   * Throws if `env.lambdaFunctionName` is null (refresh not enabled) or the
   * invocation fails.
   */
  async forceTokenRefresh(
    env: RunnerEnvironment,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    if (!env.lambdaFunctionName) {
      throw new Error(
        `Lambda token refresh is not enabled for environment "${env.name}". ` +
        `Set enable_lambda_token_refresh = true in default.auto.tfvars and re-apply.`,
      );
    }

    // Write output to a temp file so we can read it back; use /dev/stdout trick
    // by passing /dev/stderr-style path — but simpler: use a temp path
    const tmpPath = `/tmp/runner-token-refresh-${Date.now()}.json`;

    const env2 = { AWS_REGION: env.awsRegion, AWS_DEFAULT_REGION: env.awsRegion };
    const { stderr, code } = await runCmd(
      'aws',
      [
        'lambda', 'invoke',
        '--function-name', env.lambdaFunctionName,
        '--region', env.awsRegion,
        '--log-type', 'Tail',
        tmpPath,
      ],
      env2,
      token,
    );

    if (code !== 0) {
      throw new Error(`Lambda invoke failed (${code}): ${stderr.trim()}`);
    }

    // Read output file
    try {
      const { readFile } = await import('fs/promises');
      const payload = await readFile(tmpPath, 'utf-8');
      // Clean up
      const { unlink } = await import('fs/promises');
      await unlink(tmpPath).catch(() => { /* ok */ });
      return payload;
    } catch {
      return '(payload not available)';
    }
  }

  // ── CloudWatch log tailing ───────────────────────────────────────────────

  /**
   * Find CloudWatch log groups whose name starts with `/ecs-ghe-runners`
   * inside the runner's account+region. Returns matching group names.
   */
  async listLogGroups(
    env: RunnerEnvironment,
    token?: vscode.CancellationToken,
  ): Promise<string[]> {
    try {
      const result = await runAwsJson<{
        logGroups: Array<{ logGroupName: string }>;
      }>(
        [
          'logs', 'describe-log-groups',
          '--log-group-name-prefix', '/ecs-ghe-runners',
          '--output', 'json',
        ],
        env.awsRegion,
        token,
      );
      return (result.logGroups ?? []).map(g => g.logGroupName);
    } catch {
      return [];
    }
  }

  /**
   * Tail a CloudWatch log group in the VS Code output channel.
   * The tail runs until the cancellation token fires.
   */
  async tailLogs(
    env: RunnerEnvironment,
    logGroup: string,
    output: vscode.OutputChannel,
    filterPattern: string | undefined,
    sinceMinutes: number,
    cancellationToken: vscode.CancellationToken,
  ): Promise<void> {
    const args = [
      'logs', 'tail', logGroup,
      '--region', env.awsRegion,
      '--since', `${sinceMinutes}m`,
      '--follow',
      '--format', 'short',
    ];
    if (filterPattern) args.push('--filter-pattern', filterPattern);

    output.show(true);
    output.appendLine(`▶ Tailing ${logGroup} (region=${env.awsRegion}, since=${sinceMinutes}m)`);

    await runCmd(
      'aws', args,
      { AWS_REGION: env.awsRegion, AWS_DEFAULT_REGION: env.awsRegion },
      cancellationToken,
    );
  }

  /**
   * Fetch the most recent log events (non-streaming snapshot).
   * Used by the LM tool so the AI can see recent runner activity.
   */
  async getRecentLogs(
    env: RunnerEnvironment,
    logGroup: string,
    lines: number = 50,
    filterPattern?: string,
    token?: vscode.CancellationToken,
  ): Promise<string[]> {
    const args = [
      'logs', 'filter-log-events',
      '--log-group-name', logGroup,
      '--region', env.awsRegion,
      '--start-time', String(Date.now() - 30 * 60 * 1000), // last 30 min
      '--limit', String(Math.min(lines, 100)),
      '--output', 'json',
    ];
    if (filterPattern) args.push('--filter-pattern', filterPattern);

    try {
      const result = await runAwsJson<{
        events: Array<{ timestamp: number; message: string }>;
      }>(args, env.awsRegion, token);

      return (result.events ?? []).map(e => {
        const ts = new Date(e.timestamp).toISOString();
        return `[${ts}] ${e.message.trim()}`;
      });
    } catch {
      return [];
    }
  }

  // ── GitHub runner list ───────────────────────────────────────────────────

  /**
   * List self-hosted runners for the GitHub org using the provided auth.
   * The `env.githubUrl` is used as the API base (GHE support).
   */
  async listGithubRunners(
    env: RunnerEnvironment,
    token?: vscode.CancellationToken,
  ): Promise<GithubRunner[]> {
    // Temporarily override the auth provider's perceived host
    const authToken = await this.auth.getToken(true).catch(() => null);
    if (!authToken) return [];

    const apiBase = env.githubUrl.endsWith('/api/v3')
      ? env.githubUrl
      : `${env.githubUrl}/api/v3`;

    try {
      const response = await this.auth.fetch(
        `${apiBase}/orgs/${env.githubOrg}/actions/runners?per_page=100`,
        {
          headers: {
            Authorization: `token ${authToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
          signal: token ? AbortSignal.timeout(10_000) : undefined,
        },
      );

      if (!response.ok) return [];

      const data = (await response.json()) as {
        runners: Array<{
          id: number;
          name: string;
          status: string;
          busy: boolean;
          labels: Array<{ name: string }>;
        }>;
      };

      return (data.runners ?? []).map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        busy: r.busy,
        labels: (r.labels ?? []).map(l => l.name),
      }));
    } catch {
      return [];
    }
  }

  // ── Combined status ──────────────────────────────────────────────────────

  /**
   * Fetch both ECS service status and GitHub runner list in parallel.
   * Never throws — errors are captured in the returned object.
   */
  async getFullStatus(
    env: RunnerEnvironment,
    token?: vscode.CancellationToken,
  ): Promise<RunnerFullStatus> {
    const [ecsResult, ghResult] = await Promise.allSettled([
      this.getEcsStatus(env, token),
      this.listGithubRunners(env, token),
    ]);

    return {
      environment: env,
      ecs: ecsResult.status === 'fulfilled' ? ecsResult.value : null,
      ecsError: ecsResult.status === 'rejected' ? String(ecsResult.reason) : null,
      githubRunners: ghResult.status === 'fulfilled' ? ghResult.value : [],
      githubError: ghResult.status === 'rejected' ? String(ghResult.reason) : null,
      fetchedAt: new Date().toISOString(),
    };
  }
}
