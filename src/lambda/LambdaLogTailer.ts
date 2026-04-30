import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

/**
 * Streams CloudWatch Logs for a Lambda function into a VS Code output channel
 * by shelling out to `aws logs tail --follow`. Cancellation kills the child
 * process cleanly.
 *
 * Why shell out instead of using the SDK: same reasons as
 * LambdaImageDispatcher — inherits the user's `awscreds` env, no SDK bundle,
 * `aws logs tail --follow` already does the right thing with backoff +
 * resumption, no need to re-implement.
 */

export interface TailLogsInputs {
  region: string;
  functionName: string;
  /** Optional CloudWatch filter pattern. */
  filterPattern?: string;
  /** Look back N minutes when starting the tail (default 5). */
  sinceMinutes?: number;
}

export class LambdaLogTailer {
  constructor(private readonly output: vscode.OutputChannel) {}

  /**
   * Start the tail. Resolves when the tail process exits (cancellation or
   * `aws` failure). Rejects only on spawn failure.
   */
  async tail(inputs: TailLogsInputs, token: vscode.CancellationToken): Promise<number> {
    const logGroup = `/aws/lambda/${inputs.functionName}`;
    const since = `${inputs.sinceMinutes ?? 5}m`;

    const args = [
      'logs', 'tail', logGroup,
      '--region', inputs.region,
      '--since', since,
      '--follow',
      '--format', 'short',
    ];
    if (inputs.filterPattern) {
      args.push('--filter-pattern', inputs.filterPattern);
    }

    this.output.show(true);
    this.log(`▶ Tailing ${logGroup} (region=${inputs.region}, since=${since})`);
    this.log(`  aws ${args.join(' ')}`);

    return new Promise<number>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn('aws', args, {
          env: { ...process.env, AWS_REGION: inputs.region, AWS_DEFAULT_REGION: inputs.region },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        this.output.append(chunk.toString('utf-8'));
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        this.output.append(chunk.toString('utf-8'));
      });

      const cancelSub = token.onCancellationRequested(() => {
        this.log('  ⚠ Cancellation requested — stopping tail.');
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      });

      child.once('error', (err) => {
        cancelSub.dispose();
        reject(new Error(`Failed to spawn aws: ${err.message}`));
      });
      child.once('close', (code) => {
        cancelSub.dispose();
        const exitCode = code ?? 0;
        this.log(`◀ tail exited (${exitCode})`);
        resolve(exitCode);
      });
    });
  }

  private log(line: string): void {
    this.output.appendLine(line);
  }
}
