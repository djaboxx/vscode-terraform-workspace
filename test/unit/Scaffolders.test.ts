import { describe, it, expect } from 'vitest';
import {
  backendBootstrapTf,
  oidcTrustPolicy,
  defaultOidcProvider,
} from '../../src/workflows/Scaffolders.js';

describe('backendBootstrapTf', () => {
  it('emits AES256 backend by default', () => {
    const tf = backendBootstrapTf({
      bucketName: 'my-tfstate',
      region: 'us-east-1',
      dynamodbTable: 'tf-locks',
    });
    expect(tf).toContain('bucket = "my-tfstate"');
    expect(tf).toContain('region = "us-east-1"');
    expect(tf).toContain('name         = "tf-locks"');
    expect(tf).toContain('sse_algorithm = "AES256"');
    expect(tf).not.toContain('kms_master_key_id');
    // Versioning, public-access-block, and lock table are mandatory hardening.
    expect(tf).toContain('aws_s3_bucket_versioning');
    expect(tf).toContain('aws_s3_bucket_public_access_block');
    expect(tf).toContain('aws_dynamodb_table');
    expect(tf).toContain('hash_key     = "LockID"');
  });

  it('switches to SSE-KMS when kmsKeyAlias is set', () => {
    const tf = backendBootstrapTf({
      bucketName: 'b',
      region: 'us-west-2',
      dynamodbTable: 't',
      kmsKeyAlias: 'tf-state-key',
    });
    expect(tf).toContain('kms_master_key_id = "alias/tf-state-key"');
    expect(tf).toContain('sse_algorithm     = "aws:kms"');
    expect(tf).not.toContain('AES256');
  });
});

describe('defaultOidcProvider', () => {
  it('uses the public OIDC issuer for github.com', () => {
    expect(defaultOidcProvider('github.com')).toBe('token.actions.githubusercontent.com');
  });
  it('uses the per-host issuer for GHE', () => {
    expect(defaultOidcProvider('ghe.example.com')).toBe('ghe.example.com/_services/token');
  });
});

describe('oidcTrustPolicy', () => {
  it('emits a wildcard repo+env policy when neither is provided', () => {
    const json = oidcTrustPolicy({
      awsAccountId: '123456789012',
      githubOrg: 'acme',
    });
    const parsed = JSON.parse(json);
    expect(parsed.Version).toBe('2012-10-17');
    const stmt = parsed.Statement[0];
    expect(stmt.Effect).toBe('Allow');
    expect(stmt.Principal.Federated).toBe(
      'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
    );
    expect(stmt.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(stmt.Condition.StringEquals['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
    expect(stmt.Condition.StringLike['token.actions.githubusercontent.com:sub']).toBe('repo:acme/*:*');
  });

  it('narrows sub to a specific repo + environment', () => {
    const json = oidcTrustPolicy({
      awsAccountId: '111111111111',
      githubOrg: 'acme',
      repo: 'platform',
      environment: 'prod',
    });
    const sub = JSON.parse(json).Statement[0].Condition.StringLike[
      'token.actions.githubusercontent.com:sub'
    ];
    expect(sub).toBe('repo:acme/platform:environment:prod');
  });

  it('honors a custom oidcProvider host', () => {
    const json = oidcTrustPolicy({
      awsAccountId: '222222222222',
      githubOrg: 'acme',
      oidcProvider: 'ghe.example.com/_services/token',
    });
    const stmt = JSON.parse(json).Statement[0];
    expect(stmt.Principal.Federated).toContain('ghe.example.com/_services/token');
    expect(stmt.Condition.StringEquals['ghe.example.com/_services/token:aud']).toBe('sts.amazonaws.com');
  });

  it('serializes deterministically with a trailing newline', () => {
    const json = oidcTrustPolicy({ awsAccountId: '1'.repeat(12), githubOrg: 'a' });
    expect(json.endsWith('\n')).toBe(true);
    // Pretty-printed (multi-line) for human readability.
    expect(json.split('\n').length).toBeGreaterThan(5);
  });
});
