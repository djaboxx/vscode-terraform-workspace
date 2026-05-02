import { describe, expect, it } from 'vitest';
import { WorkflowGenerator } from '../../src/workflows/WorkflowGenerator.js';
import type { WorkspaceConfig } from '../../src/types/index.js';

const stubEnvsClient = {
  listRepoSecrets: async () => [],
  listRepoVariables: async () => [],
  listEnvironmentSecrets: async () => [],
  listEnvironmentVariables: async () => [],
} as any;

function baseConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: 1,
    compositeActionOrg: 'ExampleOrg',
    repo: { name: 'demo', repoOrg: 'ExampleOrg' },
    environments: [
      { name: 'dev', cacheBucket: 'cache-bkt', runnerGroup: 'self-hosted' },
    ],
    ...overrides,
  };
}

describe('WorkflowGenerator', () => {
  it('emits plan + apply per environment', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const out = await gen.generateAll(baseConfig({
      environments: [
        { name: 'dev',  cacheBucket: 'cache-bkt' },
        { name: 'prod', cacheBucket: 'cache-bkt' },
      ],
    }));
    expect(out.map(o => o.filename).sort()).toEqual([
      'terraform-apply-dev.yml',
      'terraform-apply-prod.yml',
      'terraform-plan-dev.yml',
      'terraform-plan-prod.yml',
    ]);
  });

  it('plan workflow contains expected scaffold', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig());
    expect(plan.yaml).toMatchSnapshot();
  });

  it('apply workflow uses two-job pattern with approval gate on apply job', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const out = await gen.generateAll(baseConfig());
    const apply = out.find(o => o.type === 'apply')!;
    // plan job runs first with no environment gate
    expect(apply.yaml).toContain('needs: plan');
    // apply job is gated on pending_changes output from the plan job
    expect(apply.yaml).toContain("if: needs.plan.outputs.pending_changes == 'true'");
    // apply job uses the cache_key from the plan job output (not steps.init)
    expect(apply.yaml).toContain('cache_key:    ${{ needs.plan.outputs.cache_key }}');
    expect(apply.yaml).toContain('Cache Cleanup');
  });

  it('emits proxy env vars when configured', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({
      proxy: { http: 'http://proxy:8080', https: 'http://proxy:8443', no: 'localhost,.svc' },
    }));
    expect(plan.yaml).toContain('HTTP_PROXY: "http://proxy:8080"');
    expect(plan.yaml).toContain('HTTPS_PROXY: "http://proxy:8443"');
    expect(plan.yaml).toContain('NO_PROXY: "localhost,.svc"');
  });

  it('uses per-env terraformVersion when set', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({
      terraformVersion: '1.6.0',
      environments: [{ name: 'dev', cacheBucket: 'c', terraformVersion: '1.7.5' }],
    }));
    expect(plan.yaml).toContain('terraform-version: "1.7.5"');
    expect(plan.yaml).toContain('tofu-version: "1.7.5"');
  });

  it('uses workspace terraformVersion as fallback', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({ terraformVersion: '1.6.0' }));
    expect(plan.yaml).toContain('terraform-version: "1.6.0"');
  });

  it('honors a custom varfile path', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({
      environments: [{ name: 'dev', cacheBucket: 'c', varfile: 'tfvars/dev.auto.tfvars' }],
    }));
    expect(plan.yaml).toContain('varfile: "tfvars/dev.auto.tfvars"');
  });

  it('default varfile is varfiles/<env>.tfvars', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig());
    expect(plan.yaml).toContain('varfile: "varfiles/dev.tfvars"');
  });

  it('awsAuthMode=access-keys drops id-token permission and wires secret inputs', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({ awsAuthMode: 'access-keys' }));
    expect(plan.yaml).not.toContain('id-token: write');
    expect(plan.yaml).toContain('auth-mode: "access-keys"');
    expect(plan.yaml).toContain('aws-access-key-id:     ${{ secrets.AWS_ACCESS_KEY_ID }}');
    expect(plan.yaml).toContain('aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}');
  });

  it('awsAuthMode=profile drops id-token and emits profile step', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({ awsAuthMode: 'profile' }));
    expect(plan.yaml).not.toContain('id-token: write');
    expect(plan.yaml).toContain('auth-mode: "profile"');
    expect(plan.yaml).toContain('aws-profile: ${{ vars.AWS_PROFILE }}');
  });

  it('awsAuthMode=none skips the AWS auth step entirely', async () => {
    const gen = new WorkflowGenerator(stubEnvsClient);
    const [plan] = await gen.generateAll(baseConfig({ awsAuthMode: 'none' }));
    expect(plan.yaml).not.toContain('id-token: write');
    expect(plan.yaml).not.toContain('uses: "./.github/actions/aws-auth"');
    expect(plan.yaml).toContain('AWS auth disabled');
  });
});
