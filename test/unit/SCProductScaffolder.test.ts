import { describe, it, expect } from 'vitest';
import {
  scProductTf,
  scTemplateConstraintsTf,
  scArtifactBumpTf,
  scDryRender,
  jsonSchemaToCfnRules,
} from '../../src/servicecatalog/SCProductScaffolder.js';

const productInputs = {
  productName: 'New Repo Factory',
  portfolioId: 'port-abc123',
  owner: 'Platform Team',
  supportEmail: 'platform@example.com',
  templateBucket: 'sc-templates',
  templateKey: 'new-repo/v1.yaml',
  launchRoleName: 'SCLaunchRole',
  region: 'us-east-1',
};

describe('SCProductScaffolder', () => {
  it('emits product + portfolio assoc + launch constraint', () => {
    const out = scProductTf(productInputs);
    expect(out).toContain('aws_servicecatalog_product');
    expect(out).toContain('"port-abc123"');
    expect(out).toContain('aws_servicecatalog_product_portfolio_association');
    expect(out).toContain('aws_servicecatalog_constraint');
    expect(out).toContain('SCLaunchRole');
    expect(out).toContain('https://s3.amazonaws.com/sc-templates/new-repo/v1.yaml');
    expect(out).toContain('name         = "v1.0.0"');
  });

  it('respects custom initialVersion', () => {
    const out = scProductTf({ ...productInputs, initialVersion: '2.3.0' });
    expect(out).toContain('"v2.3.0"');
  });

  it('artifact bump emits a versioned resource block', () => {
    const out = scArtifactBumpTf({
      productResourceName: 'this',
      newVersion: '1.2.0',
      templateBucket: 'sc-templates',
      templateKey: 'new-repo/v1.2.0.yaml',
    });
    expect(out).toContain('resource "aws_servicecatalog_provisioning_artifact" "v_1_2_0"');
    expect(out).toContain('product_id   = aws_servicecatalog_product.this.id');
    expect(out).toContain('"v1.2.0"');
    expect(out).toContain('new-repo/v1.2.0.yaml');
  });
});

describe('jsonSchemaToCfnRules', () => {
  it('emits required + enum + pattern assertions', () => {
    const rules = jsonSchemaToCfnRules({
      type: 'object',
      required: ['repoName', 'team'],
      properties: {
        repoName: { type: 'string', pattern: '^[a-z0-9-]+$' },
        team: { type: 'string', enum: ['platform', 'data'] },
        optional_field: { type: 'string' },
      },
    });
    expect(Object.keys(rules)).toEqual(expect.arrayContaining(['ValidateRepoName', 'ValidateTeam']));
    expect(rules.ValidateTeam.Assertions.some((a) => a.AssertDescription.includes('platform, data'))).toBe(true);
  });

  it('skips properties with no constraints', () => {
    const rules = jsonSchemaToCfnRules({
      type: 'object',
      properties: { freeText: { type: 'string' } },
    });
    expect(Object.keys(rules)).toHaveLength(0);
  });
});

describe('scTemplateConstraintsTf', () => {
  it('renders the Rules JSON inside an aws_servicecatalog_constraint', () => {
    const out = scTemplateConstraintsTf({
      productId: 'prod-xyz',
      portfolioId: 'port-abc123',
      schema: {
        type: 'object',
        required: ['repoName'],
        properties: { repoName: { type: 'string', pattern: '^[a-z-]+$' } },
      },
    });
    expect(out).toContain('aws_servicecatalog_constraint');
    expect(out).toContain('"TEMPLATE"');
    expect(out).toContain('Rules');
    expect(out).toContain('ValidateRepoName');
  });
});

describe('scDryRender', () => {
  const schema = {
    type: 'object' as const,
    required: ['repoName', 'team'],
    properties: {
      repoName: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', minLength: 3, maxLength: 30 },
      team: { type: 'string', enum: ['platform', 'data'] },
      replicas: { type: 'number', minimum: 1, maximum: 10 },
    },
  };

  it('passes a fully valid sample', () => {
    const r = scDryRender(schema, { repoName: 'my-repo', team: 'platform', replicas: 3 });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it('flags missing required fields', () => {
    const r = scDryRender(schema, { team: 'platform' });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('repoName');
  });

  it('flags enum mismatches and pattern failures', () => {
    const r = scDryRender(schema, { repoName: 'BAD_NAME', team: 'security' });
    expect(r.ok).toBe(false);
    const fields = r.invalid.map((e) => e.field);
    expect(fields).toContain('repoName');
    expect(fields).toContain('team');
  });

  it('flags numeric range violations', () => {
    const r = scDryRender(schema, { repoName: 'ok', team: 'platform', replicas: 99 });
    expect(r.ok).toBe(false);
    expect(r.invalid.some((e) => e.field === 'replicas' && e.reason.includes('maximum'))).toBe(true);
  });
});
