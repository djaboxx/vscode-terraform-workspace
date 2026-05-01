import { describe, it, expect, vi } from 'vitest';
import { LambdaLogTailer } from '../../src/lambda/LambdaLogTailer.js';

function mockChannel() {
  const lines: string[] = [];
  return {
    show: vi.fn(),
    appendLine: (l: string) => { lines.push(l); },
    append: (s: string) => { lines.push(s); },
    name: 'test',
    replace: vi.fn(),
    clear: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    lines,
  };
}

describe('LambdaLogTailer', () => {
  it('rejects when the aws CLI cannot be spawned', async () => {
    // Force a spawn failure by pretending PATH has no `aws` binary.
    const ch = mockChannel();
    const tailer = new LambdaLogTailer(ch as never);
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const cancelled = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      };
      // Spawn returns a child that emits 'error' asynchronously when the
      // executable cannot be found. Wait for that error to surface.
      const promise = tailer.tail({ region: 'us-east-1', functionName: 'no-fn', sinceMinutes: 1 }, cancelled as never);
      await expect(promise).rejects.toThrow(/Failed to spawn aws/);
    } finally {
      process.env.PATH = origPath;
    }

    // The startup banner is logged before spawn, so we should see those lines.
    expect(ch.lines.some(l => l.includes('Tailing /aws/lambda/no-fn'))).toBe(true);
    expect(ch.lines.some(l => l.startsWith('  aws logs tail'))).toBe(true);
  });

  it('builds the expected aws CLI argument vector', () => {
    // White-box check: the tail() function constructs args inline and we want
    // to make sure we always include --follow and --format short. We capture
    // them via the channel banner that mirrors the args.
    const ch = mockChannel();
    const tailer = new LambdaLogTailer(ch as never);
    const cancelled = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    // Fire and forget; we only inspect the synchronous banner before spawn.
    void tailer.tail(
      { region: 'us-west-2', functionName: 'my-fn', sinceMinutes: 15, filterPattern: 'ERROR' },
      cancelled as never,
    ).catch(() => { /* expected */ });
    process.env.PATH = origPath;

    const banner = ch.lines.find(l => l.startsWith('  aws logs tail')) ?? '';
    expect(banner).toContain('logs tail /aws/lambda/my-fn');
    expect(banner).toContain('--region us-west-2');
    expect(banner).toContain('--since 15m');
    expect(banner).toContain('--follow');
    expect(banner).toContain('--format short');
    expect(banner).toContain('--filter-pattern ERROR');
  });

  it('defaults sinceMinutes to 5 when omitted', () => {
    const ch = mockChannel();
    const tailer = new LambdaLogTailer(ch as never);
    const cancelled = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    void tailer.tail({ region: 'us-east-1', functionName: 'fn' }, cancelled as never)
      .catch(() => { /* expected */ });
    process.env.PATH = origPath;

    expect(ch.lines.some(l => l.includes('since=5m'))).toBe(true);
  });
});
