import { describe, it, expect, beforeEach } from 'vitest';
import * as vscodeStub from './vscode.stub.js';
import { DriftDetector } from '../../src/workflows/DriftDetector.js';

const channel = (lines: string[]) => ({
  appendLine: (s: string) => lines.push(s),
  append: () => {}, show: () => {}, hide: () => {}, clear: () => {}, dispose: () => {},
  name: 'drift', replace: () => {},
});

function makeServices(opts: {
  active?: { config: { repo: { name: string }; environments?: Array<{ name: string }> } } | null;
  runs?: Record<string, Array<{ status: string; conclusion: string | null; run_number?: number }>>;
  throwOn?: string;
}) {
  return {
    configManager: {
      getActive: async () => opts.active === null ? undefined : opts.active,
    },
    actionsClient: {
      getWorkflowRuns: async (_o: string, _r: string, file: string) => {
        if (opts.throwOn === file) throw new Error('boom');
        return opts.runs?.[file] ?? [];
      },
    },
  };
}

beforeEach(() => {
  // Disable scheduling — tests only call checkAll directly.
  vscodeStub.__configStore['terraformWorkspace'] = { driftCheckMinutes: 0 };
});

describe('DriftDetector.checkAll', () => {
  it('returns [] when no active config is bound', async () => {
    const lines: string[] = [];
    const dd = new DriftDetector(makeServices({ active: null }) as never, channel(lines) as never);
    expect(await dd.checkAll()).toEqual([]);
    dd.dispose();
  });

  it('returns [] when repo.name is not owner/repo', async () => {
    const lines: string[] = [];
    const dd = new DriftDetector(
      makeServices({ active: { config: { repo: { name: 'badname' }, environments: [{ name: 'dev' }] } } }) as never,
      channel(lines) as never,
    );
    expect(await dd.checkAll()).toEqual([]);
    dd.dispose();
  });

  it('flags environments whose latest plan completed with conclusion=neutral', async () => {
    const lines: string[] = [];
    const services = makeServices({
      active: {
        config: {
          repo: { name: 'acme/platform' },
          environments: [{ name: 'dev' }, { name: 'prod' }, { name: 'staging' }],
        },
      },
      runs: {
        'terraform-plan-dev.yml': [{ status: 'completed', conclusion: 'neutral', run_number: 7 }],
        'terraform-plan-prod.yml': [{ status: 'completed', conclusion: 'success', run_number: 12 }],
        'terraform-plan-staging.yml': [], // no runs yet
      },
    });
    const dd = new DriftDetector(services as never, channel(lines) as never);
    const drifted = await dd.checkAll();
    expect(drifted).toEqual(['dev']);
    expect(lines.some(l => l.includes('[drift] dev:') && l.includes('#7'))).toBe(true);
    dd.dispose();
  });

  it('continues past per-environment errors and logs them', async () => {
    const lines: string[] = [];
    const services = makeServices({
      active: { config: { repo: { name: 'acme/p' }, environments: [{ name: 'dev' }, { name: 'prod' }] } },
      runs: { 'terraform-plan-prod.yml': [{ status: 'completed', conclusion: 'neutral' }] },
      throwOn: 'terraform-plan-dev.yml',
    });
    const dd = new DriftDetector(services as never, channel(lines) as never);
    const drifted = await dd.checkAll();
    expect(drifted).toEqual(['prod']);
    expect(lines.some(l => l.includes('[drift] dev:') && l.includes('check failed'))).toBe(true);
    dd.dispose();
  });

  it('reschedule() with 0 minutes installs no timer (and does not blow up)', () => {
    const dd = new DriftDetector(makeServices({ active: null }) as never, channel([]) as never);
    dd.reschedule();
    expect(dd['timer']).toBeUndefined();
    dd.dispose();
  });
});
