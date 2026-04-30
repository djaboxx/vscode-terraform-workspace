import { describe, expect, it } from 'vitest';
import {
  detectPythonVersionFromBaseImage,
  pythonConftest,
  pythonDevcontainer,
  pythonLaunchJson,
  pythonLocalInvokeScript,
  pythonMakefile,
  pythonPyprojectToml,
  pythonSampleEvent,
  pythonTestHandler,
  pythonVersionFile,
  type PythonDevScaffoldInputs,
} from '../../src/lambda/PythonDevScaffolder.js';

const baseInputs: PythonDevScaffoldInputs = {
  functionName: 'my-fn',
  pythonVersion: '3.12',
  handler: 'handler.lambda_handler',
};

describe('PythonDevScaffolder', () => {
  describe('pythonPyprojectToml', () => {
    it('pins requires-python to the target version with a tight upper bound', () => {
      const tf = pythonPyprojectToml(baseInputs);
      expect(tf).toContain('requires-python = ">=3.12,<3.13"');
      expect(tf).toContain('name = "my-fn"');
      expect(tf).toContain('target-version = "py312"');
      expect(tf).toContain('python_version = "3.12"');
    });

    it('includes test/lint/typecheck dev deps', () => {
      const tf = pythonPyprojectToml(baseInputs);
      expect(tf).toContain('pytest');
      expect(tf).toContain('moto[lambda,s3,dynamodb]');
      expect(tf).toContain('boto3-stubs[essential]');
      expect(tf).toContain('ruff');
      expect(tf).toContain('mypy');
      expect(tf).toContain('pip-tools');
    });

    it('handles non-3.12 versions', () => {
      const tf = pythonPyprojectToml({ ...baseInputs, pythonVersion: '3.11' });
      expect(tf).toContain('requires-python = ">=3.11,<3.12"');
      expect(tf).toContain('target-version = "py311"');
    });
  });

  describe('pythonConftest', () => {
    it('adds src/ to sys.path and exposes a lambda_context fixture', () => {
      const tf = pythonConftest();
      expect(tf).toContain('sys.path.insert(0, str(SRC))');
      expect(tf).toContain('def lambda_context');
      expect(tf).toContain('get_remaining_time_in_millis');
    });
  });

  describe('pythonTestHandler', () => {
    it('imports the handler dotted path correctly', () => {
      const tf = pythonTestHandler(baseInputs);
      expect(tf).toContain('from handler import lambda_handler');
      expect(tf).toContain('lambda_handler(event, lambda_context)');
    });

    it('handles a top-level handler attribute (no module dot)', () => {
      const tf = pythonTestHandler({ ...baseInputs, handler: 'lambda_handler' });
      expect(tf).toContain('from handler import lambda_handler');
    });
  });

  describe('pythonSampleEvent', () => {
    it('emits valid JSON', () => {
      expect(() => JSON.parse(pythonSampleEvent())).not.toThrow();
    });
  });

  describe('pythonVersionFile', () => {
    it('writes a single-line python version', () => {
      expect(pythonVersionFile(baseInputs)).toBe('3.12\n');
    });
  });

  describe('pythonDevcontainer', () => {
    it('does not request the docker-outside-of-docker feature', () => {
      const tf = pythonDevcontainer(baseInputs);
      expect(tf).not.toContain('docker-outside-of-docker');
    });

    it('parses as JSON and pins the python image to the requested version', () => {
      const tf = pythonDevcontainer(baseInputs);
      const parsed = JSON.parse(tf) as { image: string; features: Record<string, unknown> };
      expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/python:3.12');
      expect(parsed.features['ghcr.io/devcontainers/features/aws-cli:1']).toBeDefined();
    });

    it('embeds AWS_REGION when supplied', () => {
      const tf = pythonDevcontainer({ ...baseInputs, region: 'us-west-2' });
      expect(tf).toContain('"AWS_REGION": "us-west-2"');
      expect(tf).toContain('"AWS_DEFAULT_REGION": "us-west-2"');
    });
  });

  describe('pythonMakefile', () => {
    it('exposes the standard targets and pip-compiles to src/requirements.txt', () => {
      const tf = pythonMakefile(baseInputs);
      expect(tf).toMatch(/^install:/m);
      expect(tf).toMatch(/^test:/m);
      expect(tf).toMatch(/^lint:/m);
      expect(tf).toMatch(/^typecheck:/m);
      expect(tf).toMatch(/^freeze:/m);
      expect(tf).toContain('--output-file=src/requirements.txt');
    });
  });

  describe('pythonLaunchJson', () => {
    it('does not reference the Lambda RIE / port 5678', () => {
      const tf = pythonLaunchJson(baseInputs);
      expect(tf).not.toContain('5678');
      expect(tf).not.toContain('Lambda RIE');
    });

    it('runs the local_invoke driver with the configured handler', () => {
      const tf = pythonLaunchJson(baseInputs);
      expect(tf).toContain('scripts/local_invoke.py');
      expect(tf).toContain('"--handler", "handler.lambda_handler"');
      expect(tf).toContain('tests/events/sample.json');
    });
  });

  describe('pythonLocalInvokeScript', () => {
    it('uses only the stdlib (no boto3/docker imports)', () => {
      const tf = pythonLocalInvokeScript();
      expect(tf).toContain('import argparse');
      expect(tf).toContain('import importlib');
      expect(tf).not.toContain('import boto3');
      expect(tf).not.toContain('docker');
      expect(tf).not.toContain('http://localhost:9000');
    });

    it('exposes --handler/--event/--src CLI flags', () => {
      const tf = pythonLocalInvokeScript();
      expect(tf).toContain('"--handler"');
      expect(tf).toContain('"--event"');
      expect(tf).toContain('"--src"');
    });

    it('synthesizes a LambdaContext class with get_remaining_time_in_millis', () => {
      const tf = pythonLocalInvokeScript();
      expect(tf).toContain('class LambdaContext');
      expect(tf).toContain('get_remaining_time_in_millis');
    });
  });

  describe('detectPythonVersionFromBaseImage', () => {
    it('extracts the python tag from a Lambda base image ref', () => {
      expect(detectPythonVersionFromBaseImage('public.ecr.aws/lambda/python:3.12')).toBe('3.12');
      expect(detectPythonVersionFromBaseImage('public.ecr.aws/lambda/python:3.11')).toBe('3.11');
    });

    it('falls back to the default for unknown images', () => {
      expect(detectPythonVersionFromBaseImage(undefined)).toBe('3.12');
      expect(detectPythonVersionFromBaseImage('public.ecr.aws/lambda/nodejs:20')).toBe('3.12');
    });
  });
});
