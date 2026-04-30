import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  RunPlanInputSchema,
  RunApplyInputSchema,
  SetVariableInputSchema,
  GenerateCodeInputSchema,
  BootstrapWorkspaceInputSchema,
  SearchTfCodeInputSchema,
  GetRunStatusInputSchema,
  DiscoverWorkspaceInputSchema,
  DeleteVariableInputSchema,
  ResolveVariableInputSchema,
  ReviewDeploymentInputSchema,
  LintWorkflowsInputSchema,
  CheckDriftInputSchema,
  ScaffoldBackendInputSchema,
  ScaffoldOidcTrustInputSchema,
} from '../../src/schemas/toolInputs.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
) as { contributes: { languageModelTools: Array<{ name: string; inputSchema: object }> } };

describe('toolInputs ↔ package.json', () => {
  const declared = pkg.contributes.languageModelTools.map(t => t.name);

  it('declares every tool that has a TS schema', () => {
    // Sanity: spot-check that the new tools are registered in package.json.
    expect(declared).toContain('terraform_delete_variable');
    expect(declared).toContain('terraform_resolve_variable');
    expect(declared).toContain('terraform_review_deployment');
    expect(declared).toContain('terraform_lint_workflows');
    expect(declared).toContain('terraform_check_drift');
    expect(declared).toContain('terraform_scaffold_backend');
    expect(declared).toContain('terraform_scaffold_oidc_trust');
    expect(declared).toContain('terraform_discover_workspace');
  });

  it('all schemas accept an empty object or reject it consistently with their requireds', () => {
    // Schemas with no required fields should accept {}; ones with required should reject.
    const noRequired = [
      RunPlanInputSchema,
      GetRunStatusInputSchema,
      DiscoverWorkspaceInputSchema,
      LintWorkflowsInputSchema,
      CheckDriftInputSchema,
    ];
    for (const s of noRequired) {
      const r = s.validate({});
      expect(r.ok, `schema with no required fields rejected {}: ${JSON.stringify(r)}`).toBe(true);
    }

    const required = [
      RunApplyInputSchema,
      SetVariableInputSchema,
      GenerateCodeInputSchema,
      BootstrapWorkspaceInputSchema,
      SearchTfCodeInputSchema,
      DeleteVariableInputSchema,
      ResolveVariableInputSchema,
      ReviewDeploymentInputSchema,
      ScaffoldBackendInputSchema,
      ScaffoldOidcTrustInputSchema,
    ];
    for (const s of required) {
      const r = s.validate({});
      expect(r.ok, 'schema with required fields accepted {}').toBe(false);
    }
  });

  it('rejects unknown properties (additionalProperties: false)', () => {
    const r = DiscoverWorkspaceInputSchema.validate({ bogus: true });
    expect(r.ok).toBe(false);
  });

  it('enforces enum constraints', () => {
    const bad = ReviewDeploymentInputSchema.validate({ runId: 1, state: 'maybe' });
    expect(bad.ok).toBe(false);

    const good = ReviewDeploymentInputSchema.validate({ runId: 1, state: 'approved' });
    expect(good.ok).toBe(true);
  });

  it('validates pattern constraints', () => {
    const bad = ScaffoldOidcTrustInputSchema.validate({ awsAccountId: 'not-numeric', githubOrg: 'acme' });
    expect(bad.ok).toBe(false);

    const good = ScaffoldOidcTrustInputSchema.validate({ awsAccountId: '123456789012', githubOrg: 'acme' });
    expect(good.ok).toBe(true);
  });
});
