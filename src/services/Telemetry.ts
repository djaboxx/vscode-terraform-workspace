import * as vscode from 'vscode';

/**
 * Tiny opt-in telemetry shim. We don't ship a real telemetry backend — this
 * just plumbs counters/timers into the OutputChannel when the user enables
 * `terraformWorkspace.enableTelemetry` AND VS Code's global telemetry switch
 * is on. Hooking in a real reporter (e.g. `@vscode/extension-telemetry`)
 * later only needs to replace `record()`.
 */
export class Telemetry {
  constructor(private readonly out: vscode.OutputChannel) {}

  private get enabled(): boolean {
    if (!vscode.env.isTelemetryEnabled) return false;
    return vscode.workspace.getConfiguration('terraformWorkspace').get<boolean>('enableTelemetry', false);
  }

  event(name: string, props: Record<string, string | number | boolean> = {}): void {
    if (!this.enabled) return;
    this.out.appendLine(`[telemetry] ${name} ${JSON.stringify(props)}`);
  }

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    let ok = true;
    try {
      return await fn();
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      this.event(name, { ms: Date.now() - start, ok });
    }
  }
}
