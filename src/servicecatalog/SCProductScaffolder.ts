/**
 * AWS Service Catalog product/portfolio scaffolders.
 *
 *   - `scProductTf(inputs)`               — initial product + S3 bucket + portfolio + launch role + constraint
 *   - `scTemplateConstraintsTf(schema)`   — Rules block generated from a JSON schema
 *   - `scArtifactBumpTf(inputs)`          — adds a new provisioning_artifact + null_resource to deprecate old
 *   - `scDryRender(schema, sampleInputs)` — validates a sample inputs JSON against the schema (no AWS calls)
 *
 * Pure string + plain-object generation; the caller owns I/O.
 *
 * Patterns match the lambda-template-repo-generator deploy_product/ workspace:
 *   - Dedicated S3 bucket with server-side encryption and public-read policy
 *     (required so CFN can read the template via the launch role; the
 *     servicecatalog-product-artifacts-* bucket has bucket-level restrictions
 *     that prevent launch-role access in GovCloud).
 *   - A "dummy" initial artifact (required by create-product) + a real
 *     aws_servicecatalog_provisioning_artifact with active=true + a
 *     null_resource that deprecates the dummy via local-exec.
 *   - Launch role with CFN ops + s3:* on * (for CFN internal staging in
 *     GovCloud) + lambda:InvokeFunction on the product's Lambda.
 *   - GovCloud-aware console URL output.
 */

export interface SCProductScaffoldInputs {
  /** Short slug used for resource names, bucket name, and S3 key prefix. */
  productSlug: string;
  portfolioName: string;
  portfolioDescription?: string;
  owner: string;
  /** Optional — kept for backwards compatibility with callers that still pass it. */
  portfolioId?: string;
  supportEmail?: string;
  /** S3 key for the CFN template artifact, e.g. "2-0-0.yaml". */
  templateKey: string;
  /**
   * ARN of the Lambda function the CFN Custom Resource will invoke.
   * Used in the launch role's lambda:InvokeFunction policy statement.
   * For centralized/cross-account Lambdas, pass the full ARN with the owning
   * account ID, e.g. `arn:aws-us-gov:lambda:us-gov-west-1:229685449397:function:my-fn`.
   */
  lambdaArn?: string;
  /** AWS region to deploy resources in. */
  region: string;
  description?: string;
  /** Initial provisioning artifact version label shown in the console. Default `1.0.0`. */
  initialVersion?: string;
  /**
   * IAM principal ARNs (or IAM_PATTERN glob ARNs) granted access to the
   * portfolio. Example GovCloud SSO pattern:
   *   `arn:aws-us-gov:iam::*:role/aws-reserved/sso.amazonaws.com/ * /AWSReservedSSO_AdministratorAccess_*`
   */
  principalArns?: string[];
  /** Optional: name of pre-existing launch role. When set, no new role is created. */
  existingLaunchRoleName?: string;
  /** Name tag of the VPC subnet to look up (only rendered when truthy). */
  subnetName?: string;
  /** Security group name to look up (only rendered when truthy). */
  securityGroupName?: string;
}

export function scProductTf(inputs: SCProductScaffoldInputs): string {
  const v1 = inputs.initialVersion ?? '1.0.0';
  const slug = sanitize(inputs.productSlug);
  const bucketName = `\${data.aws_caller_identity.current.account_id}-${slug}-sc-templates`;
  const templateUrl = `https://${bucketName}.s3.\${data.aws_region.current.name}.amazonaws.com/${inputs.templateKey}`;
  const launchRoleResource = inputs.existingLaunchRoleName
    ? `data "aws_iam_role" "sc_launch" {
  name = "${inputs.existingLaunchRoleName}"
}
`
    : `resource "aws_iam_role" "sc_launch" {
  name = "${slug}-sc-launch-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["servicecatalog.amazonaws.com", "cloudformation.amazonaws.com"] }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "sc_launch" {
  name = "cfn-and-s3-and-lambda"
  role = aws_iam_role.sc_launch.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudFormationOperations"
        Effect = "Allow"
        Action = [
          "cloudformation:CreateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:GetTemplate",
          "cloudformation:GetTemplateSummary",
          "cloudformation:ValidateTemplate",
          "cloudformation:UpdateStack",
          "cloudformation:SetStackPolicy",
          "cloudformation:TagResource",
        ]
        Resource = "*"
      },
      {
        # s3:* on * is required in GovCloud so CFN's internal GetTemplateSummary
        # call (invoked as the launch role by servicecatalog.amazonaws.com) can
        # access the AWS-managed staging bucket. Scoping to just the product
        # bucket causes "S3 error: Access Denied" on the internal resource.
        Sid      = "S3ForCFNTemplateStagingAccess"
        Effect   = "Allow"
        Action   = "s3:*"
        Resource = "*"
      },${inputs.lambdaArn ? `
      {
        Sid      = "InvokeLambda"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "${inputs.lambdaArn}"
      },` : ''}
    ]
  })
}
`;

  const launchRoleArnRef = inputs.existingLaunchRoleName
    ? 'data.aws_iam_role.sc_launch.arn'
    : 'aws_iam_role.sc_launch.arn';

  const principalAssociations = (inputs.principalArns ?? []).length > 0
    ? `
# Portfolio access — IAM principals / IAM_PATTERN globs granted launch access
resource "aws_servicecatalog_principal_portfolio_association" "this" {
  for_each = toset(${JSON.stringify(inputs.principalArns ?? [])})

  portfolio_id   = aws_servicecatalog_portfolio.this.id
  principal_arn  = each.value
  # Use IAM_PATTERN for wildcard ARNs (SSO role patterns); plain IAM otherwise.
  principal_type = can(regex("\\\\*", each.value)) ? "IAM_PATTERN" : "IAM"
}
` : '';

  return `# Generated by terraform-workspace.
# Matches the deploy_product/ pattern in lambda-template-repo-generator:
#   - Dedicated S3 bucket for template storage (public-read for CFN access)
#   - Dummy initial artifact + separate real provisioning_artifact + deprecation
#   - Launch role with CFN + s3:* + Lambda invoke
terraform {
  required_version = ">= 1.0"
  required_providers {
    aws  = { source = "hashicorp/aws",  version = "~> 5.0" }
    null = { source = "hashicorp/null", version = "~> 3.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "${inputs.region}"
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}
data "aws_partition"       "current" {}
data "aws_region"          "current" {}

# ── S3 bucket for the SC product CFN template ─────────────────────────────────
# Dedicated bucket avoids the servicecatalog-product-artifacts-* bucket's
# bucket-level ACL restrictions that block the launch role in GovCloud.
resource "aws_s3_bucket" "sc_templates" {
  bucket        = "${bucketName}"
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "sc_templates" {
  bucket                  = aws_s3_bucket.sc_templates.id
  block_public_acls       = false
  ignore_public_acls      = false
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sc_templates" {
  bucket = aws_s3_bucket.sc_templates.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_policy" "sc_templates" {
  bucket = aws_s3_bucket.sc_templates.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicRead"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "\${aws_s3_bucket.sc_templates.arn}/*"
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.sc_templates]
}

resource "aws_s3_object" "product_template" {
  bucket               = aws_s3_bucket.sc_templates.id
  key                  = "${inputs.templateKey}"
  source               = "\${path.module}/product-template.yaml"
  content_type         = "text/yaml"
  etag                 = filemd5("\${path.module}/product-template.yaml")
  server_side_encryption = "AES256"

  tags = merge(var.tags, {
    "servicecatalog:provisioning" = "true"
  })

  depends_on = [aws_s3_bucket.sc_templates]
}

# ── Launch role ───────────────────────────────────────────────────────────────
${launchRoleResource}
# ── Portfolio ─────────────────────────────────────────────────────────────────
resource "aws_servicecatalog_portfolio" "this" {
  name          = ${JSON.stringify(inputs.portfolioName)}
  description   = ${JSON.stringify(inputs.portfolioDescription ?? inputs.portfolioName)}
  provider_name = ${JSON.stringify(inputs.owner)}
  tags          = var.tags
}

# ── Product ───────────────────────────────────────────────────────────────────
# The initial artifact created by create-product is always "broken" in GovCloud
# because SC cannot re-validate it at describe-provisioning-parameters time via
# the launch role.  We create a dummy placeholder here, then add the real
# artifact as a separate resource below, and deprecate the dummy via null_resource.
resource "aws_servicecatalog_product" "this" {
  name        = ${JSON.stringify(inputs.productSlug)}
  owner       = ${JSON.stringify(inputs.owner)}
  type        = "CLOUD_FORMATION_TEMPLATE"
  description = ${JSON.stringify(inputs.description ?? '')}

  provisioning_artifact_parameters {
    name                        = "${v1}-initial"
    description                 = "Initial placeholder — replaced by ${v1} below. Do not use."
    template_url                = "${templateUrl}"
    type                        = "CLOUD_FORMATION_TEMPLATE"
    disable_template_validation = true
  }

  tags = var.tags

  depends_on = [aws_s3_object.product_template]
}

resource "aws_servicecatalog_product_portfolio_association" "this" {
  portfolio_id = aws_servicecatalog_portfolio.this.id
  product_id   = aws_servicecatalog_product.this.id
}

# Real working artifact — created separately so SC pre-validates the template
# URL using the caller's credentials (marks it as "pre-validated", which is
# required so describe-provisioning-parameters succeeds for users).
resource "aws_servicecatalog_provisioning_artifact" "v${sanitize(v1)}" {
  product_id   = aws_servicecatalog_product.this.id
  name         = "${v1}"
  description  = ${JSON.stringify(inputs.description ?? `Version ${v1}`)}
  type         = "CLOUD_FORMATION_TEMPLATE"
  template_url = "${templateUrl}"
  active       = true
  guidance     = "DEFAULT"

  depends_on = [aws_servicecatalog_constraint.launch]
}

# Deprecate the broken initial artifact
resource "null_resource" "deprecate_initial_artifact" {
  triggers = {
    product_id = aws_servicecatalog_product.this.id
  }

  provisioner "local-exec" {
    command = <<-EOF
      INIT_ART=$(aws servicecatalog list-provisioning-artifacts \\
        --product-id \${aws_servicecatalog_product.this.id} \\
        --query 'ProvisioningArtifactDetails[?contains(Name,\`-initial\`)].Id' \\
        --output text 2>/dev/null) && \\
      [ -n "$INIT_ART" ] && aws servicecatalog update-provisioning-artifact \\
        --product-id \${aws_servicecatalog_product.this.id} \\
        --provisioning-artifact-id "$INIT_ART" \\
        --no-active --guidance DEPRECATED 2>/dev/null || true
    EOF
  }

  depends_on = [aws_servicecatalog_provisioning_artifact.v${sanitize(v1)}]
}

# ── Launch constraint ─────────────────────────────────────────────────────────
resource "aws_servicecatalog_constraint" "launch" {
  portfolio_id = aws_servicecatalog_portfolio.this.id
  product_id   = aws_servicecatalog_product.this.id
  type         = "LAUNCH"
  description  = "Launch role for ${inputs.productSlug}"

  parameters = jsonencode({ RoleArn = ${launchRoleArnRef} })

  depends_on = [aws_servicecatalog_product_portfolio_association.this]
}
${principalAssociations}
# ── Outputs ───────────────────────────────────────────────────────────────────
locals {
  console_domain = can(regex("us-gov-", var.aws_region)) ? "amazonaws-us-gov.com" : "aws.amazon.com"
}

output "portfolio_id" {
  value = aws_servicecatalog_portfolio.this.id
}

output "product_id" {
  value = aws_servicecatalog_product.this.id
}

output "launch_role_arn" {
  value = ${launchRoleArnRef}
}

output "provisioning_url" {
  value = "https://console.\${local.console_domain}/servicecatalog/home?region=\${var.aws_region}#/products/\${aws_servicecatalog_product.this.id}"
}
`;
}

// ── TemplateConstraints from JSON Schema ─────────────────────────────────────

export interface JsonSchemaProperty {
  type?: string;
  enum?: Array<string | number>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
}

export interface JsonSchemaForForm {
  type?: 'object';
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
}

export interface SCTemplateConstraintsInputs {
  productId: string;
  portfolioId: string;
  schema: JsonSchemaForForm;
}

/**
 * Generates an `aws_servicecatalog_constraint` of type `TEMPLATE` whose
 * `parameters` JSON contains a CloudFormation Rules block derived from the
 * given JSON schema. CloudFormation evaluates these rules **before** the
 * stack is created, so bad form input fails at the SC console — not three
 * minutes later inside the Lambda.
 */
export function scTemplateConstraintsTf(inputs: SCTemplateConstraintsInputs): string {
  const rules = jsonSchemaToCfnRules(inputs.schema);
  return `# Generated by terraform-workspace.
# CloudFormation Rules derived from the form's JSON schema. Evaluated by SC
# before launch — bad inputs fail at the SC console, not inside the Lambda.

resource "aws_servicecatalog_constraint" "template_${sanitize(inputs.productId)}" {
  portfolio_id = "${inputs.portfolioId}"
  product_id   = "${inputs.productId}"
  type         = "TEMPLATE"
  parameters = jsonencode(${JSON.stringify({ Rules: rules }, null, 2).split('\n').join('\n    ')})
}
`;
}

interface CfnRule {
  Assertions: Array<{
    Assert: Record<string, unknown>;
    AssertDescription: string;
  }>;
}

export function jsonSchemaToCfnRules(
  schema: JsonSchemaForForm,
): Record<string, CfnRule> {
  const rules: Record<string, CfnRule> = {};
  const required = new Set(schema.required ?? []);
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const assertions: CfnRule['Assertions'] = [];
    if (required.has(name)) {
      assertions.push({
        Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: name }, ''] }] },
        AssertDescription: `${name} is required.`,
      });
    }
    if (prop.enum && prop.enum.length > 0) {
      assertions.push({
        Assert: { 'Fn::Contains': [prop.enum, { Ref: name }] },
        AssertDescription: `${name} must be one of: ${prop.enum.join(', ')}.`,
      });
    }
    if (prop.pattern) {
      // CFN doesn't support regex natively in Rules; surface as a doc-only assertion.
      assertions.push({
        Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: name }, ''] }] },
        AssertDescription: `${name} must match pattern: ${prop.pattern}`,
      });
    }
    if (assertions.length > 0) {
      rules[`Validate${pascalCase(name)}`] = { Assertions: assertions };
    }
  }
  return rules;
}

// ── Provisioning artifact bumper ─────────────────────────────────────────────

export interface SCArtifactBumpInputs {
  productResourceName: string; // e.g. "this" — references aws_servicecatalog_product.<name>
  newVersion: string;          // semver-ish, e.g. "1.1.0"
  templateBucket: string;
  templateKey: string;
  description?: string;
}

/**
 * Renders an additive Terraform snippet: a new `aws_servicecatalog_provisioning_artifact`
 * pointing at the new template artifact.  Matches the deploy_product/ pattern:
 *   - Uses region-qualified S3 URL (works in GovCloud and all commercial regions)
 *   - Adds a null_resource that deprecates the previous artifact via local-exec
 *     so it no longer appears in the SC launch form.
 */
export function scArtifactBumpTf(inputs: SCArtifactBumpInputs): string {
  const slug = sanitize(inputs.newVersion);
  // Region-qualified URL so both GovCloud and commercial work correctly.
  const templateUrl = `https://${inputs.templateBucket}.s3.\${data.aws_region.current.name}.amazonaws.com/${inputs.templateKey}`;
  return `# Generated by terraform-workspace — appended ${new Date().toISOString()}.
# New provisioning artifact: ${inputs.productResourceName} @ ${inputs.newVersion}.
#
# After applying, the previous default artifact is kept active until you manually
# flip it, so existing provisioned products continue to work. The null_resource
# below marks the OLD default artifact (the one previously at guidance=DEFAULT)
# as DEPRECATED once the new one is active.

resource "aws_servicecatalog_provisioning_artifact" "v_${slug}" {
  product_id   = aws_servicecatalog_product.${inputs.productResourceName}.id
  name         = "${inputs.newVersion}"
  description  = ${JSON.stringify(inputs.description ?? `Version ${inputs.newVersion}`)}
  type         = "CLOUD_FORMATION_TEMPLATE"
  template_url = "${templateUrl}"
  active       = true
  guidance     = "DEFAULT"
}

# Deprecate the previous DEFAULT artifact now that the new one is active.
resource "null_resource" "deprecate_previous_artifact_${slug}" {
  triggers = {
    new_artifact = aws_servicecatalog_provisioning_artifact.v_${slug}.id
  }

  provisioner "local-exec" {
    command = <<-EOF
      PREV_ART=$(aws servicecatalog list-provisioning-artifacts \\
        --product-id \${aws_servicecatalog_product.${inputs.productResourceName}.id} \\
        --query 'ProvisioningArtifactDetails[?Name!=\`${inputs.newVersion}\` && Guidance==\`DEFAULT\`].Id | [0]' \\
        --output text 2>/dev/null) && \\
      [ -n "$PREV_ART" ] && [ "$PREV_ART" != "None" ] && \\
        aws servicecatalog update-provisioning-artifact \\
          --product-id \${aws_servicecatalog_product.${inputs.productResourceName}.id} \\
          --provisioning-artifact-id "$PREV_ART" \\
          --no-active --guidance DEPRECATED 2>/dev/null || true
    EOF
  }

  depends_on = [aws_servicecatalog_provisioning_artifact.v_${slug}]
}
`;
}

// ── Dry render (schema validation, no AWS) ───────────────────────────────────

export interface DryRenderResult {
  ok: boolean;
  missing: string[];
  invalid: Array<{ field: string; reason: string }>;
  /** Resolved inputs (with defaults filled in, if applicable). */
  resolved: Record<string, unknown>;
}

/**
 * Validates a sample inputs object against a JSON-schema-shaped form spec.
 * No AWS calls — purely local.
 */
export function scDryRender(
  schema: JsonSchemaForForm,
  sample: Record<string, unknown>,
): DryRenderResult {
  const required = new Set(schema.required ?? []);
  const missing: string[] = [];
  const invalid: DryRenderResult['invalid'] = [];

  for (const r of required) {
    if (sample[r] === undefined || sample[r] === null || sample[r] === '') missing.push(r);
  }

  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (!(name in sample)) continue;
    const v = sample[name];
    if (prop.type === 'string' && typeof v !== 'string') {
      invalid.push({ field: name, reason: `expected string, got ${typeof v}` });
      continue;
    }
    if (prop.type === 'number' && typeof v !== 'number') {
      invalid.push({ field: name, reason: `expected number, got ${typeof v}` });
      continue;
    }
    if (prop.enum && !prop.enum.includes(v as string | number)) {
      invalid.push({ field: name, reason: `must be one of ${JSON.stringify(prop.enum)}, got ${JSON.stringify(v)}` });
    }
    if (prop.pattern && typeof v === 'string' && !new RegExp(prop.pattern).test(v)) {
      invalid.push({ field: name, reason: `does not match pattern /${prop.pattern}/` });
    }
    if (prop.minLength !== undefined && typeof v === 'string' && v.length < prop.minLength) {
      invalid.push({ field: name, reason: `length ${v.length} < minLength ${prop.minLength}` });
    }
    if (prop.maxLength !== undefined && typeof v === 'string' && v.length > prop.maxLength) {
      invalid.push({ field: name, reason: `length ${v.length} > maxLength ${prop.maxLength}` });
    }
    if (prop.minimum !== undefined && typeof v === 'number' && v < prop.minimum) {
      invalid.push({ field: name, reason: `value ${v} < minimum ${prop.minimum}` });
    }
    if (prop.maximum !== undefined && typeof v === 'number' && v > prop.maximum) {
      invalid.push({ field: name, reason: `value ${v} > maximum ${prop.maximum}` });
    }
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, resolved: sample };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

function pascalCase(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}
