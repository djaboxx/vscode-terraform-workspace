import { describe, it, expect } from 'vitest';
import * as vscodeStub from './vscode.stub.js';
import { Telemetry } from '../../src/services/Telemetry.js';

interface ChannelLog { lines: string[]; }
function mockChannel(): { ch: ChannelLog; channel: Parameters<typeof Telemetry['prototype']['constructor'] extends never ? never : (c: unknown) => unknown>[0] } {
  const lines: string[] = [];
  const channel = {
    appendLine: (s: string) => { lines.push(s); },
    append: (_s: string) => {},
    show: () => {},
    hide: () => {},
    clear: () => {},
    dispose: () => {},
    name: 'test',
    replace: () => {},
  };
  return { ch: { lines }, channel: channel as never };
}

function setTelemetryEnabled(globalEnabled: boolean, settingEnabled: boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscodeStub.env as any).isTelemetryEnabled = globalEnabled;
  vscodeStub.__configStore['terraformWorkspace'] = {
    ...(vscodeStub.__configStore['terraformWorkspace'] ?? {}),
    enableTelemetry: settingEnabled,
  };
}

describe('Telemetry', () => {
  it('does not log when VS Code global telemetry is disabled', () => {
    setTelemetryEnabled(false, true);
    const { ch, channel } = mockChannel();
    new Telemetry(channel as never).event('foo', { a: 1 });
    expect(ch.lines).toEqual([]);
  });

  it('does not log when extension setting is off', () => {
    setTelemetryEnabled(true, false);
    const { ch, channel } = mockChannel();
    new Telemetry(channel as never).event('foo');
    expect(ch.lines).toEqual([]);
  });

  it('logs events with serialized props when both flags are on', () => {
    setTelemetryEnabled(true, true);
    const { ch, channel } = mockChannel();
    new Telemetry(channel as never).event('user.action', { count: 3, ok: true });
    expect(ch.lines).toHaveLength(1);
    expect(ch.lines[0]).toContain('[telemetry] user.action');
    expect(ch.lines[0]).toContain('"count":3');
    expect(ch.lines[0]).toContain('"ok":true');
  });

  it('time() records ms + ok=true on success', async () => {
    setTelemetryEnabled(true, true);
    const { ch, channel } = mockChannel();
    const t = new Telemetry(channel as never);
    const result = await t.time('work', async () => 42);
    expect(result).toBe(42);
    expect(ch.lines).toHaveLength(1);
    expect(ch.lines[0]).toContain('[telemetry] work');
    expect(ch.lines[0]).toMatch(/"ms":\d+/);
    expect(ch.lines[0]).toContain('"ok":true');
  });

  it('time() records ok=false and rethrows on failure', async () => {
    setTelemetryEnabled(true, true);
    const { ch, channel } = mockChannel();
    const t = new Telemetry(channel as never);
    await expect(t.time('boom', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(ch.lines[0]).toContain('"ok":false');
  });
});
