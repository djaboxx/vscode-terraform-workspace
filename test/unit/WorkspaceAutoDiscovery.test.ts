import { describe, it, expect } from 'vitest';
import {
  parseBackendBlock,
  parseRequiredProviders,
  branchHintForEnv,
  type DiscoveryResult,
} from '../../src/discovery/WorkspaceAutoDiscovery.js';
import {
  buildConfigFromDiscovery,
  summarizeDiscovery,
} from '../../src/discovery/buildConfigFromDiscovery.js';

describe('parseBackendBlock', () => {
  it('extracts bucket, region, dynamodb_table and key prefix', () => {
    const body = `
      bucket         = "my-tfstate"
      key            = "envs/prod/terraform.tfstate"
      region         = "us-west-2"
      dynamodb_table = "tf_locks"
      encrypt        = true
    `;
    const out = parseBackendBlock(body);
    expect(out).toEqual({
      bucket: 'my-tfstate',
      region: 'us-west-2',
      dynamodbTable: 'tf_locks',
      key: 'envs/prod/terraform.tfstate',
      keyPrefix: 'envs',
    });
  });

  it('returns empty object on empty body', () => {
    expect(parseBackendBlock('')).toEqual({});
  });
});

describe('parseRequiredProviders', () => {
  it('parses provider blocks with source + version', () => {
    const body = `
      aws = {
        source  = "hashicorp/aws"
        version = "~> 5.0"
      }
      random = {
        source = "hashicorp/random"
      }
    `;
    const out = parseRequiredProviders(body);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'aws', source: 'hashicorp/aws', version: '~> 5.0' });
    expect(out[1]).toEqual({ name: 'random', source: 'hashicorp/random', version: undefined });
  });
});

describe('branchHintForEnv', () => {
  it('maps known env names to branches', () => {
    expect(branchHintForEnv('prod')).toBe('main');
    expect(branchHintForEnv('production')).toBe('main');
    expect(branchHintForEnv('staging')).toBe('staging');
    expect(branchHintForEnv('dev')).toBe('develop');
    expect(branchHintForEnv('qa')).toBe('develop');
  });

  it('returns undefined for unknown names', () => {
    expect(branchHintForEnv('eu-sandbox')).toBeUndefined();
  });
});

function emptyResult(): DiscoveryResult {
  return {
    folderPath: '/x',
    hostname: 'github.com',
    workingDirectories: [],
    providers: [],
    awsRegions: [],
    environments: [],
    workflows: [],
    repoVariableNames: [],
    repoSecretNames: [],
    notes: [],
    warnings: [],
  };
}

describe('buildConfigFromDiscovery', () => {
  const defaults = {
    compositeActionOrg: 'acme',
    defaultStateRegion: 'us-east-1',
    defaultRunnerGroup: 'self-hosted',
  };

  it('seeds repo + state from discovery when present', () => {
    const d = emptyResult();
    d.owner = 'acme';
    d.repo = 'infra';
    d.repoSlug = 'acme/infra';
    d.backend = { bucket: 'tfstate-acme', region: 'us-west-2', dynamodbTable: 'tf_locks' };
    d.terraformVersion = '~> 1.7';
    d.environments = [
      { name: 'prod', source: 'github-environment', branchHint: 'main' },
      { name: 'dev', source: 'tfvars-file', tfvarsPath: 'varfiles/dev.tfvars', branchHint: 'develop' },
    ];

    const cfg = buildConfigFromDiscovery(d, defaults);
    expect(cfg.repo.repoOrg).toBe('acme');
    expect(cfg.repo.name).toBe('infra');
    expect(cfg.terraformVersion).toBe('~> 1.7');
    expect(cfg.stateConfig?.bucket).toBe('tfstate-acme');
    expect(cfg.stateConfig?.region).toBe('us-west-2');
    expect(cfg.stateConfig?.setBackend).toBe(false); // already has a backend
    expect(cfg.environments).toHaveLength(2);
    expect(cfg.environments[0].varfile).toBe('varfiles/prod.tfvars');
    expect(cfg.environments[1].varfile).toBe('varfiles/dev.tfvars');
    expect(cfg.environments[0].deploymentBranchPolicy?.branch).toBe('main');
  });

  it('falls back to defaults when nothing is discovered', () => {
    const cfg = buildConfigFromDiscovery(emptyResult(), defaults);
    expect(cfg.repo.repoOrg).toBe('');
    expect(cfg.stateConfig?.region).toBe('us-east-1');
    expect(cfg.stateConfig?.bucket).toBe('inf-tfstate-us-east-1');
    expect(cfg.stateConfig?.setBackend).toBe(true);
    expect(cfg.environments).toHaveLength(0);
  });
});

describe('summarizeDiscovery', () => {
  it('renders a non-empty markdown summary', () => {
    const d = emptyResult();
    d.repoSlug = 'acme/infra';
    d.providers = [{ name: 'aws' }];
    const out = summarizeDiscovery(d);
    expect(out).toContain('acme/infra');
    expect(out).toContain('aws');
    expect(out).toContain('Environments');
  });
});
