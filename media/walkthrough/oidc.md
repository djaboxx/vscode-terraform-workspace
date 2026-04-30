# Wire OIDC trust & remote backend

This extension assumes **GitHub Actions assumes an AWS role via OIDC** and
that Terraform state lives in **S3 with DynamoDB locking**. Those are the
only supported patterns. Set them up once per AWS account.

## OIDC trust policy

Run **Terraform: Scaffold OIDC Trust** (or ask `@terraform` to do it).
You provide:

- 12-digit **AWS account ID**
- The **GitHub org** that will assume the role
- Optionally a specific **repo** and **environment** to scope the trust

You get back an IAM trust policy JSON, scoped to
`repo:org/repo:environment:env-name`. Apply it via your AWS account
bootstrap process — this extension generates, it does not apply.

**No long-lived AWS access keys.** If you find yourself reaching for
`AWS_ACCESS_KEY_ID` secrets, stop and revisit OIDC.

## S3 + DynamoDB backend

Run **Terraform: Scaffold Backend**. It produces paste-ready HCL for a
`backend.tf`:

```hcl
terraform {
  backend "s3" {
    bucket         = "..."
    key            = "..."
    region         = "..."
    dynamodb_table = "..."
    encrypt        = true
  }
}
```

The bucket and DynamoDB table themselves are bootstrapped out-of-band
(usually by a one-time `account-bootstrap` repo). This extension assumes
they exist.
