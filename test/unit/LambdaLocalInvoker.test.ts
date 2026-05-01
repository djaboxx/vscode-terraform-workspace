import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Uri } from './vscode.stub.js';
import { LambdaLocalInvoker } from '../../src/lambda/LambdaLocalInvoker.js';

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

function mockToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function tmp(): string { return mkdtempSync(join(tmpdir(), 'tf-invoker-')); }

describe('LambdaLocalInvoker.resolvePython', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });

  it('prefers an explicit pythonPath when it exists', async () => {
    const explicit = join(dir, 'mypython');
    writeFileSync(explicit, '#!/bin/sh\nexit 0\n');
    const inv = new LambdaLocalInvoker(mockChannel() as never);
    const py = await inv.resolvePython({
      workingDirectory: new Uri(dir) as never,
      handler: 'h.f', eventPath: 'x.json', functionName: 'fn', pythonPath: explicit,
    });
    expect(py).toBe(explicit);
  });

  it('falls back to .venv/bin/python when present', async () => {
    mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
    const venv = join(dir, '.venv', 'bin', 'python');
    writeFileSync(venv, '#!/bin/sh\nexit 0\n');
    const inv = new LambdaLocalInvoker(mockChannel() as never);
    const py = await inv.resolvePython({
      workingDirectory: new Uri(dir) as never,
      handler: 'h.f', eventPath: 'x.json', functionName: 'fn',
    });
    expect(py).toBe(venv);
  });

  it('falls back to "python3" on PATH when nothing else found', async () => {
    const inv = new LambdaLocalInvoker(mockChannel() as never);
    const py = await inv.resolvePython({
      workingDirectory: new Uri(dir) as never,
      handler: 'h.f', eventPath: 'x.json', functionName: 'fn',
    });
    expect(py).toBe('python3');
  });
});

describe('LambdaLocalInvoker.invoke (validation)', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });

  it('rejects when the driver script is missing', async () => {
    const inv = new LambdaLocalInvoker(mockChannel() as never);
    await expect(
      inv.invoke({
        workingDirectory: new Uri(dir) as never,
        handler: 'h.f', eventPath: 'event.json', functionName: 'fn',
      }, mockToken() as never),
    ).rejects.toThrow(/Driver script not found/);
  });

  it('rejects when the event file is missing', async () => {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'local_invoke.py'), 'print("ok")');
    const inv = new LambdaLocalInvoker(mockChannel() as never);
    await expect(
      inv.invoke({
        workingDirectory: new Uri(dir) as never,
        handler: 'h.f', eventPath: 'missing.json', functionName: 'fn',
      }, mockToken() as never),
    ).rejects.toThrow(/Event JSON not found/);
  });

  it('runs the driver script end-to-end via system python3 (skipped if no python3)', async () => {
    // Smoke test: write a no-op driver and a valid event, run it.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'local_invoke.py'),
      'import sys; sys.stdout.write("invoked\\n"); sys.exit(0)');
    writeFileSync(join(dir, 'event.json'), '{}');
    const ch = mockChannel();
    const inv = new LambdaLocalInvoker(ch as never);
    let result;
    try {
      result = await inv.invoke({
        workingDirectory: new Uri(dir) as never,
        handler: 'h.f', eventPath: 'event.json', functionName: 'fn',
      }, mockToken() as never);
    } catch (err) {
      // Skip when python3 isn't available in the test sandbox.
      if (/Failed to spawn/.test((err as Error).message)) return;
      throw err;
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('invoked');
    expect(result.pythonPath).toMatch(/python/);
    rmSync(dir, { recursive: true, force: true });
  });
});
