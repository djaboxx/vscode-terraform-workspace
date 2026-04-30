import { describe, it, expect } from 'vitest';
import {
  lambdaImagePackerHcl,
  lambdaImageBuildHcl,
  lambdaImageEcrTf,
  lambdaImageLambdaTf,
  lambdaHandlerSkeleton,
} from '../../src/lambda/LambdaImageScaffolder.js';

const base = {
  functionName: 'sc-dispatcher',
  region: 'us-east-1',
  packerSourceBucket: 'my-packer-src',
  packerCodebuildProject: 'packer-pipeline',
};

describe('LambdaImageScaffolder', () => {
  it('packer HCL pins the base image and copies src/', () => {
    const out = lambdaImagePackerHcl(base);
    expect(out).toContain('public.ecr.aws/lambda/python:3.12');
    expect(out).toContain('source      = "src/"');
    expect(out).toContain('post-processor "docker-push"');
  });

  it('packer HCL respects custom baseImage and handler', () => {
    const out = lambdaImagePackerHcl({
      ...base,
      baseImage: 'public.ecr.aws/lambda/python:3.11',
      handler: 'main.entry',
    });
    expect(out).toContain('public.ecr.aws/lambda/python:3.11');
    expect(out).toContain('main.entry');
    expect(out).not.toContain('python:3.12');
  });

  it('build.hcl points packer-pipeline at the right CB project + bucket', () => {
    const out = lambdaImageBuildHcl(base);
    expect(out).toContain('s3_bucket             = "my-packer-src"');
    expect(out).toContain('codebuild_project_name = "packer-pipeline"');
    expect(out).toContain('AWS_REGION = "us-east-1"');
  });

  it('ECR TF generates lifecycle policy + repo URL output', () => {
    const out = lambdaImageEcrTf(base);
    expect(out).toContain('resource "aws_ecr_repository" "fn"');
    expect(out).toContain('name                 = "sc-dispatcher"');
    expect(out).toContain('aws_ecr_lifecycle_policy');
    expect(out).toContain('output "image_repo"');
  });

  it('Lambda TF pins by digest variable, not tag', () => {
    const out = lambdaImageLambdaTf(base);
    expect(out).toContain('variable "image_digest"');
    expect(out).toContain('package_type  = "Image"');
    expect(out).toContain('${aws_ecr_repository.fn.repository_url}@${var.image_digest}');
    expect(out).toContain('AWSLambdaBasicExecutionRole');
  });

  it('Lambda TF emits env vars + extra policy attachments when given', () => {
    const out = lambdaImageLambdaTf({
      ...base,
      envVars: { LOG_LEVEL: 'DEBUG', QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q' },
      extraManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'],
    });
    expect(out).toContain('LOG_LEVEL = "DEBUG"');
    expect(out).toContain('QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/1/q"');
    expect(out).toContain('AmazonS3ReadOnlyAccess');
  });

  it('handler skeleton names the function', () => {
    const out = lambdaHandlerSkeleton(base);
    expect(out).toContain('sc-dispatcher');
    expect(out).toContain('def lambda_handler(event, context):');
  });
});
