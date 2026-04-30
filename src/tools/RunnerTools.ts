import * as vscode from 'vscode';
import { ExtensionServices } from '../services.js';
import { discoverRunnerEnvironments, RunnerEnvironment } from '../runners/GheRunnerConfig.js';
import {
  RunnerGetStatusInputSchema,
  RunnerRefreshTokenInputSchema,
  RunnerForceRedeployInputSchema,
  RunnerScaleInputSchema,
  RunnerGetLogsInputSchema,
  RunnerGetStatusInput,
  RunnerRefreshTokenInput,
  RunnerForceRedeployInput,
  RunnerScaleInput,
  RunnerGetLogsInput,
} from '../schemas/toolInputs.js';
import { CompiledSchema, formatSchemaErrors } from '../schemas/defineSchema.js';

export function registerRunnerTools(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
  output: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool('ghe_runner_get_status',      new RunnerGetStatusTool(services)),
    vscode.lm.registerTool('ghe_runner_refresh_token',   new RunnerRefreshTokenTool(services, output)),
    vscode.lm.registerTool('ghe_runner_force_redeploy',  new RunnerForceRedeployTool(services, output)),
    vscode.lm.registerTool('ghe_runner_scale',           new RunnerScaleTool(services, output)),
    vscode.lm.registerTool('ghe_runner_get_logs',        new RunnerGetLogsTool(services, output)),
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function validateInput<T>(
  schema: CompiledSchema<T>,
  input: unknown,
  toolName: string,
): { ok: true; value: T } | { ok: false; result: vscode.LanguageModelToolResult } {
  const r = schema.validate(input);
  if (r.ok) return { ok: true, value: r.value };
  return {
    ok: false,
    result: textResult(`Invalid input for \`${toolName}\`:\n${formatSchemaErrors(r.errors)}`),
  };
}

/** Match an environment by name (case-insensitive substring) or return the only one. */
async function resolveEnvironment(
  services: ExtensionServices,
  name: string | undefined,
): Promise<{ env: RunnerEnvironment } | { error: string }> {
  const envs = await discoverRunnerEnvironments();
  if (envs.length === 0) {
    return { error: 'No runner environments found. Add a ghe-runner workspace folder or configure terraformWorkspace.runners.' };
  }
  if (!name) {
    if (envs.length === 1) return { env: envs[0] };
    return { error: `Multiple runner environments found: ${envs.map(e => e.name).join(', ')}. Specify environment name.` };
  }
  const match = envs.find(e => e.name.toLowerCase().includes(name.toLowerCase()));
  if (!match) {
    return { error: `No environment matching "${name}". Available: ${envs.map(e => e.name).join(', ')}` };
  }
  return { env: match };
}

// ── ghe_runner_get_status ───────────────────────────────────────────────────

class RunnerGetStatusTool implements vscode.LanguageModelTool<RunnerGetStatusInput> {
  constructor(private readonly services: ExtensionServices) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunnerGetStatusInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateInput(RunnerGetStatusInputSchema, options.input, 'ghe_runner_get_status');
    if (!v.ok) return v.result;

    const { runnersClient } = this.services;
    if (!runnersClient) return textResult('Runner client not initialized.');

    const envs: RunnerEnvironment[] = [];

    if (v.value.environment) {
      const r = await resolveEnvironment(this.services, v.value.environment);
      if ('error' in r) return textResult(r.error);
      envs.push(r.env);
    } else {
      const all = await discoverRunnerEnvironments();
      envs.push(...all);
    }

    if (envs.length === 0) {
      return textResult('No runner environments found.');
    }

    const statuses = await Promise.all(
      envs.map(env => runnersClient.getFullStatus(env, token)),
    );

    const lines: string[] = [];
    for (const s of statuses) {
      lines.push(`## ${s.environment.name} (${s.environment.awsRegion})`);
      lines.push(`Cluster: ${s.environment.ecsCluster}`);
      lines.push(`Service: ${s.environment.ecsService}`);

      if (s.ecs) {
        const { runningCount, desiredCount, pendingCount, recentEvents } = s.ecs;
        lines.push(`ECS: ${runningCount}/${desiredCount} running, ${pendingCount} pending`);
        const healthy = runningCount >= desiredCount && desiredCount > 0;
        lines.push(`Health: ${healthy ? '✅ HEALTHY' : runningCount === 0 ? '🚨 DOWN' : '⚠️ DEGRADED'}`);
        if (recentEvents.length) {
          lines.push('Recent ECS events:');
          for (const e of recentEvents.slice(0, 3)) lines.push(`  - ${e}`);
        }
      } else if (s.ecsError) {
        lines.push(`ECS error: ${s.ecsError}`);
      }

      if (s.githubRunners.length > 0) {
        const online = s.githubRunners.filter(r => r.status === 'online').length;
        const busy = s.githubRunners.filter(r => r.busy).length;
        lines.push(`GitHub runners: ${online}/${s.githubRunners.length} online, ${busy} busy`);
        for (const r of s.githubRunners) {
          lines.push(`  - ${r.name}: ${r.status}${r.busy ? ' (busy)' : ''}`);
        }
      } else if (s.githubError) {
        lines.push(`GitHub runners: unavailable (${s.githubError})`);
      } else {
        lines.push('GitHub runners: none registered');
      }

      const lambda = s.environment.lambdaFunctionName;
      lines.push(`Token refresh Lambda: ${lambda ?? 'disabled'}`);
      lines.push(`Fetched at: ${s.fetchedAt}`);
      lines.push('');
    }

    return textResult(lines.join('\n'));
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunnerGetStatusInput>,
  ): vscode.PreparedToolInvocation {
    const env = options.input.environment ?? 'all environments';
    return {
      invocationMessage: `Getting runner status for ${env}…`,
    };
  }
}

// ── ghe_runner_refresh_token ────────────────────────────────────────────────

class RunnerRefreshTokenTool implements vscode.LanguageModelTool<RunnerRefreshTokenInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly output: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunnerRefreshTokenInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateInput(RunnerRefreshTokenInputSchema, options.input, 'ghe_runner_refresh_token');
    if (!v.ok) return v.result;

    const r = await resolveEnvironment(this.services, v.value.environment);
    if ('error' in r) return textResult(r.error);

    const { runnersClient } = this.services;
    if (!runnersClient) return textResult('Runner client not initialized.');

    try {
      this.output.show(true);
      this.output.appendLine(`▶ Invoking Lambda token refresh for ${r.env.name}…`);
      const payload = await runnersClient.forceTokenRefresh(r.env, token);
      this.output.appendLine(`✓ Token refresh complete. Payload: ${payload}`);
      return textResult(
        `✅ Token refresh Lambda invoked successfully for "${r.env.name}".\n` +
        `Lambda: ${r.env.lambdaFunctionName}\n` +
        `Payload: ${payload}\n\n` +
        `The registration token in Secrets Manager has been refreshed. ` +
        `ECS tasks that restart will now pick up the fresh token.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`❌ Token refresh failed for "${r.env.name}": ${msg}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunnerRefreshTokenInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Invoking Lambda token refresh for ${options.input.environment ?? 'runner environment'}…`,
    };
  }
}

// ── ghe_runner_force_redeploy ───────────────────────────────────────────────

class RunnerForceRedeployTool implements vscode.LanguageModelTool<RunnerForceRedeployInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly output: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunnerForceRedeployInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateInput(RunnerForceRedeployInputSchema, options.input, 'ghe_runner_force_redeploy');
    if (!v.ok) return v.result;

    const r = await resolveEnvironment(this.services, v.value.environment);
    if ('error' in r) return textResult(r.error);

    const { runnersClient } = this.services;
    if (!runnersClient) return textResult('Runner client not initialized.');

    try {
      this.output.show(true);
      this.output.appendLine(`▶ Forcing new ECS deployment for ${r.env.name} (${r.env.ecsCluster} / ${r.env.ecsService})…`);
      await runnersClient.forceRedeploy(r.env, token);
      this.output.appendLine('✓ Force-new-deployment triggered.');
      return textResult(
        `✅ Force-new-deployment triggered for "${r.env.name}".\n` +
        `Cluster: ${r.env.ecsCluster}\n` +
        `Service: ${r.env.ecsService}\n\n` +
        `ECS will replace all running tasks with fresh containers over the next 5–15 minutes. ` +
        `Each new task will register with GitHub using the token from Secrets Manager. ` +
        `Monitor progress with \`aws ecs describe-services\` or the Runners view.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`❌ Force redeploy failed for "${r.env.name}": ${msg}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunnerForceRedeployInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Forcing ECS redeployment for ${options.input.environment ?? 'runner environment'}…`,
    };
  }
}

// ── ghe_runner_scale ────────────────────────────────────────────────────────

class RunnerScaleTool implements vscode.LanguageModelTool<RunnerScaleInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly output: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunnerScaleInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateInput(RunnerScaleInputSchema, options.input, 'ghe_runner_scale');
    if (!v.ok) return v.result;

    const r = await resolveEnvironment(this.services, v.value.environment);
    if ('error' in r) return textResult(r.error);

    const { runnersClient } = this.services;
    if (!runnersClient) return textResult('Runner client not initialized.');

    const count = v.value.desiredCount;
    try {
      this.output.show(true);
      this.output.appendLine(`▶ Scaling "${r.env.name}" to ${count} runner(s)…`);
      await runnersClient.scaleRunners(r.env, count, token);
      this.output.appendLine(`✓ Desired count set to ${count}.`);
      const warning = count === 0
        ? '\n\n⚠️ All runners are now scaled to zero. Workflows cannot execute until you scale back up.'
        : '';
      return textResult(
        `✅ ECS desired count for "${r.env.name}" set to ${count}.\n` +
        `Changes take effect over the next few minutes.${warning}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return textResult(`❌ Scale failed for "${r.env.name}": ${msg}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunnerScaleInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Scaling runners for ${options.input.environment ?? 'environment'} to ${options.input.desiredCount}…`,
    };
  }
}

// ── ghe_runner_get_logs ─────────────────────────────────────────────────────

class RunnerGetLogsTool implements vscode.LanguageModelTool<RunnerGetLogsInput> {
  constructor(
    private readonly services: ExtensionServices,
    private readonly output: vscode.OutputChannel,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunnerGetLogsInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const v = validateInput(RunnerGetLogsInputSchema, options.input, 'ghe_runner_get_logs');
    if (!v.ok) return v.result;

    const r = await resolveEnvironment(this.services, v.value.environment);
    if ('error' in r) return textResult(r.error);

    const { runnersClient } = this.services;
    if (!runnersClient) return textResult('Runner client not initialized.');

    // Find the right log group
    const groups = await runnersClient.listLogGroups(r.env, token);
    if (groups.length === 0) {
      return textResult(
        `No CloudWatch log groups found matching /ecs-ghe-runners* in region ${r.env.awsRegion}. ` +
        `Ensure Container Insights is enabled or check the log group name in the AWS Console.`,
      );
    }

    const logGroup = v.value.logGroup ?? groups[0];
    const lines = await runnersClient.getRecentLogs(
      r.env,
      logGroup,
      v.value.lines ?? 50,
      v.value.filterPattern,
      token,
    );

    if (lines.length === 0) {
      return textResult(`No log events found in ${logGroup} for the last 30 minutes.`);
    }

    const header = `## Logs: ${logGroup} (last ${lines.length} events)\n\n`;
    return textResult(header + lines.join('\n'));
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunnerGetLogsInput>,
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: `Fetching runner logs for ${options.input.environment ?? 'environment'}…`,
    };
  }
}
