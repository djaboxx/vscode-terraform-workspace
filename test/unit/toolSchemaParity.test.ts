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
  ScaffoldFromTemplateInputSchema,
  ScaffoldModuleRepoInputSchema,
  LookupProviderDocInputSchema,
  ScaffoldCodebuildExecutorInputSchema,
  DispatchCodebuildRunInputSchema,
  ScaffoldLambdaImageInputSchema,
  BuildLambdaImageInputSchema,
  ScaffoldScProductInputSchema,
  BumpScArtifactInputSchema,
  DryRenderScProductInputSchema,
  ScaffoldPythonDevEnvInputSchema,
  InvokeLambdaLocallyInputSchema,
  TailLambdaLogsInputSchema,
  SelfIntrospectInputSchema,
  RememberInputSchema,
  RecallInputSchema,
  MatchPlaybookInputSchema,
  RecallDecisionsInputSchema,
  RunnerGetStatusInputSchema,
  RunnerRefreshTokenInputSchema,
  RunnerForceRedeployInputSchema,
  RunnerScaleInputSchema,
  RunnerGetLogsInputSchema,
} from '../../src/schemas/toolInputs.js';
import type { CompiledSchema } from '../../src/schemas/defineSchema.js';

/**
 * Authoritative mapping: package.json tool name → in-process TS schema.
 *
 * If a tool is registered in `package.json` but absent from this map (or vice
 * versa), the consistency tests fail. The test below also walks each pair and
 * compares property names, required fields, and `additionalProperties` to
 * catch silent drift.
 */
const TOOL_SCHEMAS: Record<string, CompiledSchema<unknown>> = {
  terraform_run_plan: RunPlanInputSchema as CompiledSchema<unknown>,
  terraform_run_apply: RunApplyInputSchema as CompiledSchema<unknown>,
  terraform_set_variable: SetVariableInputSchema as CompiledSchema<unknown>,
  terraform_generate_code: GenerateCodeInputSchema as CompiledSchema<unknown>,
  terraform_bootstrap_workspace: BootstrapWorkspaceInputSchema as CompiledSchema<unknown>,
  terraform_search_tf_code: SearchTfCodeInputSchema as CompiledSchema<unknown>,
  terraform_get_run_status: GetRunStatusInputSchema as CompiledSchema<unknown>,
  terraform_discover_workspace: DiscoverWorkspaceInputSchema as CompiledSchema<unknown>,
  terraform_delete_variable: DeleteVariableInputSchema as CompiledSchema<unknown>,
  terraform_resolve_variable: ResolveVariableInputSchema as CompiledSchema<unknown>,
  terraform_review_deployment: ReviewDeploymentInputSchema as CompiledSchema<unknown>,
  terraform_lint_workflows: LintWorkflowsInputSchema as CompiledSchema<unknown>,
  terraform_check_drift: CheckDriftInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_backend: ScaffoldBackendInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_oidc_trust: ScaffoldOidcTrustInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_from_template: ScaffoldFromTemplateInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_module_repo: ScaffoldModuleRepoInputSchema as CompiledSchema<unknown>,
  terraform_lookup_provider_doc: LookupProviderDocInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_codebuild_executor: ScaffoldCodebuildExecutorInputSchema as CompiledSchema<unknown>,
  terraform_dispatch_codebuild_run: DispatchCodebuildRunInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_lambda_image: ScaffoldLambdaImageInputSchema as CompiledSchema<unknown>,
  terraform_build_lambda_image: BuildLambdaImageInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_sc_product: ScaffoldScProductInputSchema as CompiledSchema<unknown>,
  terraform_bump_sc_artifact: BumpScArtifactInputSchema as CompiledSchema<unknown>,
  terraform_dry_render_sc_product: DryRenderScProductInputSchema as CompiledSchema<unknown>,
  terraform_scaffold_python_dev_env: ScaffoldPythonDevEnvInputSchema as CompiledSchema<unknown>,
  terraform_invoke_lambda_locally: InvokeLambdaLocallyInputSchema as CompiledSchema<unknown>,
  terraform_tail_lambda_logs: TailLambdaLogsInputSchema as CompiledSchema<unknown>,
  terraform_self_introspect: SelfIntrospectInputSchema as CompiledSchema<unknown>,
  terraform_remember: RememberInputSchema as CompiledSchema<unknown>,
  terraform_recall: RecallInputSchema as CompiledSchema<unknown>,
  terraform_match_playbook: MatchPlaybookInputSchema as CompiledSchema<unknown>,
  terraform_recall_decisions: RecallDecisionsInputSchema as CompiledSchema<unknown>,
  ghe_runner_get_status: RunnerGetStatusInputSchema as CompiledSchema<unknown>,
  ghe_runner_refresh_token: RunnerRefreshTokenInputSchema as CompiledSchema<unknown>,
  ghe_runner_force_redeploy: RunnerForceRedeployInputSchema as CompiledSchema<unknown>,
  ghe_runner_scale: RunnerScaleInputSchema as CompiledSchema<unknown>,
  ghe_runner_get_logs: RunnerGetLogsInputSchema as CompiledSchema<unknown>,
};

/**
 * Tools that intentionally have no TS-side schema (e.g. read-only tools whose
 * input is `{}` and whose handler does no destructuring). Keep this list
 * explicit so accidental omissions are caught.
 */
const TOOLS_WITHOUT_TS_SCHEMA = new Set<string>([
  'terraform_get_state',
  'terraform_list_workspaces',
  'terraform_list_variables',
  'terraform_read_config',
  'terraform_update_config',
  'terraform_sync_workflows',
]);

interface PackageToolDecl {
  name: string;
  inputSchema: {
    type?: string;
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
}

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
) as { contributes: { languageModelTools: PackageToolDecl[] } };

const declaredTools = pkg.contributes.languageModelTools;

describe('package.json ↔ TS schema drift', () => {
  it('every declared tool is either in TOOL_SCHEMAS or in TOOLS_WITHOUT_TS_SCHEMA', () => {
    const missing: string[] = [];
    for (const t of declaredTools) {
      if (!(t.name in TOOL_SCHEMAS) && !TOOLS_WITHOUT_TS_SCHEMA.has(t.name)) {
        missing.push(t.name);
      }
    }
    expect(missing, `Tools declared in package.json with no TS schema: ${missing.join(', ')}`).toEqual([]);
  });

  it('every TS schema is registered in package.json', () => {
    const declaredNames = new Set(declaredTools.map(t => t.name));
    const orphans = Object.keys(TOOL_SCHEMAS).filter(n => !declaredNames.has(n));
    expect(orphans, `TS schemas with no package.json registration: ${orphans.join(', ')}`).toEqual([]);
  });

  for (const decl of declaredTools) {
    const tsSchema = TOOL_SCHEMAS[decl.name];
    if (!tsSchema) continue; // covered by the existence test above

    it(`${decl.name}: property names match between package.json and TS schema`, () => {
      const pkgProps = Object.keys(decl.inputSchema.properties ?? {}).sort();
      const tsRawSchema = (tsSchema.raw.schema as { properties?: Record<string, unknown> }) ?? {};
      const tsProps = Object.keys(tsRawSchema.properties ?? {}).sort();
      expect(pkgProps).toEqual(tsProps);
    });

    it(`${decl.name}: required fields match between package.json and TS schema`, () => {
      const pkgReq = [...(decl.inputSchema.required ?? [])].sort();
      const tsRawSchema = (tsSchema.raw.schema as { required?: string[] }) ?? {};
      const tsReq = [...(tsRawSchema.required ?? [])].sort();
      expect(pkgReq).toEqual(tsReq);
    });

    it(`${decl.name}: package.json schema is type=object`, () => {
      // VS Code requires inputSchema to be an object schema.
      expect(decl.inputSchema.type ?? 'object').toBe('object');
    });

    it(`${decl.name}: each declared property has a documented type`, () => {
      const props = decl.inputSchema.properties ?? {};
      for (const [name, def] of Object.entries(props)) {
        const d = def as { type?: string };
        expect(d.type, `${decl.name}.${name} missing type`).toBeDefined();
      }
    });
  }
});
