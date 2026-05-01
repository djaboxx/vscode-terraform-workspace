import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscodeStub from './vscode.stub.js';
import { discoverRunnerEnvironments } from '../../src/runners/GheRunnerConfig.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ghe-runner-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscodeStub.workspace as any).workspaceFolders = [
    { uri: { fsPath: tmpRoot }, name: 'root', index: 0 },
  ];
  vscodeStub.__configStore['terraformWorkspace'] = { runners: [] };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeRunnerDir(
  rel: string,
  tfvars: string,
  providers?: string,
): Promise<string> {
  const dir = path.join(tmpRoot, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'default.auto.tfvars'), tfvars);
  if (providers) await fs.writeFile(path.join(dir, 'providers.tf'), providers);
  return dir;
}

describe('discoverRunnerEnvironments', () => {
  it('returns [] when no folders look like runner configs', async () => {
    expect(await discoverRunnerEnvironments()).toEqual([]);
  });

  it('discovers a single runner from default.auto.tfvars + providers.tf', async () => {
    const dir = await writeRunnerDir(
      'csvd-dev-ew',
      'ecs_cluster_name = "ecs-ghe-runners"\nrepo_org = "SCT-Engineering"\naws_account = "csvd-dev-ew"\ndesired_count = 3\nenable_lambda_token_refresh = true\nserver_url = "https://ghe.example.com"\n',
      'provider "aws" {\n  region = "us-gov-west-1"\n}\n',
    );
    const envs = await discoverRunnerEnvironments();
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({
      name: 'csvd-dev-ew',
      awsRegion: 'us-gov-west-1',
      ecsCluster: 'ecs-ghe-runners-us-gov-west-1',
      ecsService: 'SCT-Engineering',
      desiredCount: 3,
      lambdaFunctionName: 'github-runner-token-refresh-csvd-dev-ew',
      githubOrg: 'SCT-Engineering',
      githubUrl: 'https://ghe.example.com',
      repoPath: dir,
      source: 'discovered',
    });
  });

  it('uses default region when providers.tf is missing', async () => {
    await writeRunnerDir(
      'envA',
      'ecs_cluster_name = "ecs-x"\nrepo_org = "Acme"\n',
    );
    const envs = await discoverRunnerEnvironments();
    expect(envs[0].awsRegion).toBe('us-gov-west-1');
    expect(envs[0].ecsCluster).toBe('ecs-x-us-gov-west-1');
    // lambda disabled by default
    expect(envs[0].lambdaFunctionName).toBeNull();
  });

  it('skips dirs missing required tfvars', async () => {
    const dir = path.join(tmpRoot, 'incomplete');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'default.auto.tfvars'), 'foo = "bar"\n');
    expect(await discoverRunnerEnvironments()).toEqual([]);
  });

  it('falls back to a *.auto.tfvars file when default.auto.tfvars is absent', async () => {
    const dir = path.join(tmpRoot, 'envB');
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, 'overrides.auto.tfvars'),
      'ecs_cluster_name = "ecs-y"\nrepo_org = "OrgB"\n',
    );
    const envs = await discoverRunnerEnvironments();
    expect(envs).toHaveLength(1);
    expect(envs[0].ecsService).toBe('OrgB');
  });

  it('appends manual entries from settings, dedupes by ecsCluster', async () => {
    await writeRunnerDir(
      'envC',
      'ecs_cluster_name = "shared-cluster"\nrepo_org = "OrgC"\n',
    );
    vscodeStub.__configStore['terraformWorkspace'] = {
      runners: [
        // duplicate of discovered cluster — should be skipped
        { ecsCluster: 'shared-cluster-us-gov-west-1', ecsService: 'OrgC' },
        // genuinely new manual entry
        { ecsCluster: 'manual-cluster', ecsService: 'OrgZ', awsRegion: 'us-east-1' },
      ],
    };
    const envs = await discoverRunnerEnvironments();
    const clusters = envs.map(e => e.ecsCluster).sort();
    expect(clusters).toEqual(['manual-cluster', 'shared-cluster-us-gov-west-1']);
    const manual = envs.find(e => e.source === 'manual')!;
    expect(manual.awsRegion).toBe('us-east-1');
    expect(manual.githubOrg).toBe('OrgZ'); // defaults to ecsService
  });

  it('strips inline comments and quote chars from parsed tfvars', async () => {
    await writeRunnerDir(
      'envD',
      'ecs_cluster_name = "ecs-z"  # inline comment\nrepo_org = "OrgD" # also a comment\ndesired_count = 5 # really\n',
    );
    const envs = await discoverRunnerEnvironments();
    expect(envs[0].desiredCount).toBe(5);
    expect(envs[0].ecsService).toBe('OrgD');
  });
});
