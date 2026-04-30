import { describe, it, expect } from 'vitest';
import { ResolveVariableTool, ScaffoldBackendTool } from '../../src/tools/TerraformTools.js';
import { LanguageModelTextPart, LanguageModelToolResult } from './vscode.stub.js';
import type { ExtensionServices } from '../../src/services.js';

/**
 * Integration test: invoke a real LM tool class end-to-end with a hand-rolled
 * fake `ExtensionServices`. This catches handler-level regressions that the
 * schema-only tests in `toolInputs.test.ts` and `toolSchemaParity.test.ts`
 * cannot see — wiring bugs, response formatting, scope-precedence logic.
 *
 * The stub `vscode` module supplies `LanguageModelToolResult`/`Text Part`
 * (see `test/unit/vscode.stub.ts`).
 */

interface StubVar { name: string }

function makeServices(opts: {
  org?: StubVar[];
  repo?: StubVar[];
  envs?: Record<string, StubVar[]>;
  noConfig?: boolean;
}): ExtensionServices {
  const services = {
    configManager: {
      getActive: async () =>
        opts.noConfig
          ? undefined
          : {
              folder: { uri: { fsPath: '/tmp/x' } },
              config: { repo: { repoOrg: 'acme', name: 'platform' } },
            },
    },
    envsClient: {
      listOrgVariables: async (_owner: string) => opts.org ?? [],
      listRepoVariables: async (_owner: string, _repo: string) => opts.repo ?? [],
      listEnvironmentVariables: async (_owner: string, _repo: string, env: string) =>
        opts.envs?.[env] ?? [],
    },
  } as unknown as ExtensionServices;
  return services;
}

function token() {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never;
}

function textOf(result: unknown): string {
  const r = result as LanguageModelToolResult;
  expect(r).toBeInstanceOf(LanguageModelToolResult);
  return r.content
    .filter((p): p is LanguageModelTextPart => p instanceof LanguageModelTextPart)
    .map(p => p.value)
    .join('\n');
}

describe('ResolveVariableTool (integration)', () => {
  it('rejects schema-invalid input with a field-pointed error', async () => {
    const tool = new ResolveVariableTool(makeServices({}));
    const out = await tool.invoke({ input: {} as never } as never, token());
    const text = textOf(out);
    expect(text).toMatch(/key/i);
    expect(text).toMatch(/required|missing/i);
  });

  it('reports "no active workspace" when configManager has none', async () => {
    const tool = new ResolveVariableTool(makeServices({ noConfig: true }));
    const out = await tool.invoke({ input: { key: 'AWS_REGION' } } as never, token());
    expect(textOf(out)).toMatch(/no active workspace/i);
  });

  it('reports "not found" when no scope contains the variable', async () => {
    const tool = new ResolveVariableTool(makeServices({}));
    const out = await tool.invoke({ input: { key: 'AWS_REGION' } } as never, token());
    expect(textOf(out)).toMatch(/not found/i);
    expect(textOf(out)).toMatch(/AWS_REGION/);
  });

  it('finds variable at org scope only', async () => {
    const tool = new ResolveVariableTool(makeServices({
      org: [{ name: 'AWS_REGION' }],
    }));
    const out = await tool.invoke({ input: { key: 'AWS_REGION' } } as never, token());
    const text = textOf(out);
    expect(text).toMatch(/org:acme/);
    expect(text).toMatch(/Effective source.*org:acme/);
  });

  it('environment scope wins precedence when present in all three', async () => {
    const tool = new ResolveVariableTool(makeServices({
      org: [{ name: 'AWS_REGION' }],
      repo: [{ name: 'AWS_REGION' }],
      envs: { production: [{ name: 'AWS_REGION' }] },
    }));
    const out = await tool.invoke(
      { input: { key: 'AWS_REGION', environment: 'production' } } as never,
      token(),
    );
    const text = textOf(out);
    // All three sources listed
    expect(text).toMatch(/org:acme/);
    expect(text).toMatch(/repo:acme\/platform/);
    expect(text).toMatch(/env:production/);
    // Environment is the effective (most-specific) source
    expect(text).toMatch(/Effective source.*env:production/);
  });

  it('skips silently when an upstream scope call throws', async () => {
    const tool = new ResolveVariableTool({
      configManager: {
        getActive: async () => ({
          folder: { uri: { fsPath: '/tmp/x' } },
          config: { repo: { repoOrg: 'acme', name: 'platform' } },
        }),
      },
      envsClient: {
        listOrgVariables: async () => { throw new Error('rate-limited'); },
        listRepoVariables: async () => [{ name: 'AWS_REGION' }],
        listEnvironmentVariables: async () => [],
      },
    } as unknown as ExtensionServices);
    const out = await tool.invoke({ input: { key: 'AWS_REGION' } } as never, token());
    const text = textOf(out);
    // org call failed → not listed; repo call succeeded → present
    expect(text).not.toMatch(/org:acme/);
    expect(text).toMatch(/repo:acme\/platform/);
  });
});

describe('ScaffoldBackendTool (integration)', () => {
  it('rejects invalid AWS region pattern', async () => {
    const tool = new ScaffoldBackendTool();
    const out = await tool.invoke({
      input: { bucketName: 'b', region: 'NOT-A-REGION', dynamodbTable: 't' },
    } as never, token());
    const text = textOf(out);
    expect(text).toMatch(/region/i);
  });

  it('emits HCL containing bucket, region, and dynamodb table', async () => {
    const tool = new ScaffoldBackendTool();
    const out = await tool.invoke({
      input: {
        bucketName: 'acme-tfstate',
        region: 'us-east-1',
        dynamodbTable: 'acme-tflock',
      },
    } as never, token());
    const text = textOf(out);
    expect(text).toMatch(/```hcl/);
    expect(text).toMatch(/acme-tfstate/);
    expect(text).toMatch(/us-east-1/);
    expect(text).toMatch(/acme-tflock/);
  });
});
