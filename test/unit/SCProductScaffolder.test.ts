import { describe, it, expect } from 'vitest';
import {
  scProductTf,
  scTemplateConstraintsTf,
  scArtifactBumpTf,
  scDryRender,
  jsonSchemaToCfnRules,
} from '../../src/servicecatalog/SCProductScaffolder.js';

const productInputs = {
  productSlug: 'new-repo',
  portfolioName: 'New Repo Factory',
  owner: 'Platform Team',
  supportEmail: 'platform@example.com',
  templateKey: 'new-repo/v1.yaml',
  region: 'us-east-1',
};

describe('SCProductScaffolder', () => {
  it('emits product + portfolio assoc + launch role + dummy/real artifacts', () => {
    const out = scProductTf(productInputs);
    expect(out).toContain('aws_servicecatalog_product');
    expect(out).toContain('aws_servicecatalog_portfolio');
    expect(out).toContain('aws_servicecatalog_product_portfolio_association');
    // Launch role created (no existingLaunchRoleName provided).
    expect(out).toContain('resource "aws_iam_role" "sc_launch"');
    expect(out).toContain('"new_repo-sc-launch-role"');
    // S3 bucket for the CFN template artifact.
    expect(out).toContain('resource "aws_s3_bucket" "sc_templates"');
    // Region-qualified template URL using the per-product bucket name.
    expect(out).toContain('-new_repo-sc-templates.s3.${data.aws_region.current.name}.amazonaws.com/new-repo/v1.yaml');
    // Initial provisioning artifact name (no "v" prefix in the human-readable name).
    expect(out).toContain('name         = "1.0.0"');
    // Resource address has the sanitized "v" prefix.
    expect(out).toContain('aws_servicecatalog_provisioning_artifact" "v1_0_0"');
  });

  it('respects custom initialVersion', () => {
    const out = scProductTf({ ...productInputs, initialVersion: '2.3.0' });
    expect(out).toContain('name         = "2.3.0"');
    expect(out).toContain('aws_servicecatalog_provisioning_artifact" "v2_3_0"');
  });

  it('uses an existing launch role when provided', () => {
    const out = scProductTf({ ...productInputs, existingLaunchRoleName: 'PreBakedRole' });
    expect(out).toContain('data "aws_iam_role" "sc_launch"');
    expect(out).toContain('name = "PreBakedRole"');
    expect(out).not.toContain('resource "aws_iam_role" "sc_launch"');
  });

  it('artifact bump emits a versioned resource block + deprecation provisioner', () => {
    const out = scArtifactBumpTf({
      productResourceName: 'this',
      newVersion: '1.2.0',
      templateBucket: 'sc-templates',
      templateKey: 'new-repo/v1.2.0.yaml',
    });
    expect(out).toContain('resource "aws_servicecatalog_provisioning_artifact" "v_1_2_0"');
    expect(out).toContain('product_id   = aws_servicecatalog_product.this.id');
    expect(out).toContain('name         = "1.2.0"');
    expect(out).toContain('new-repo/v1.2.0.yaml');
    // Deprecation null_resource is emitted alongside the new artifact.
    expect(out).toContain('null_resource" "deprecate_previous_artifact_1_2_0"');
    expect(out).toContain('aws servicecatalog update-provisioning-artifact');
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
