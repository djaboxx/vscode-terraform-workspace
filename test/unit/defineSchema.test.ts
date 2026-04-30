import { describe, it, expect } from 'vitest';
import { defineSchema, formatSchemaErrors, SchemaValidationError } from '../../src/schemas/defineSchema.js';
import { RunApplyInputSchema, BootstrapWorkspaceInputSchema } from '../../src/schemas/toolInputs.js';

describe('defineSchema', () => {
  const PersonSchema = defineSchema<{ name: string; age?: number }>({
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'number', minimum: 0 },
    },
    additionalProperties: false,
  });

  it('returns ok=true with the typed value on valid input', () => {
    const r = PersonSchema.validate({ name: 'Ada', age: 36 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('Ada');
  });

  it('returns field-pointed error for missing required property', () => {
    const r = PersonSchema.validate({ age: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].message).toContain("must have required property 'name'");
    }
  });

  it('returns error for additional property', () => {
    const r = PersonSchema.validate({ name: 'x', extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].message).toContain("must NOT have additional property 'extra'");
    }
  });

  it('formats errors as a bullet list', () => {
    const r = PersonSchema.validate({ age: -1 });
    if (!r.ok) {
      const out = formatSchemaErrors(r.errors);
      expect(out).toContain('•');
      expect(out).toContain('/age');
    }
  });

  it('assert() throws SchemaValidationError on failure', () => {
    expect(() => PersonSchema.assert({}, 'person')).toThrow(SchemaValidationError);
  });

  it('assert() returns the typed value on success', () => {
    const v = PersonSchema.assert({ name: 'Ada' }, 'person');
    expect(v.name).toBe('Ada');
  });
});

describe('toolInputs schemas', () => {
  it('RunApplyInputSchema requires workspace', () => {
    const r = RunApplyInputSchema.validate({});
    expect(r.ok).toBe(false);
  });

  it('RunApplyInputSchema accepts minimal valid input', () => {
    const r = RunApplyInputSchema.validate({ workspace: 'prod' });
    expect(r.ok).toBe(true);
  });

  it('BootstrapWorkspaceInputSchema rejects empty environments array', () => {
    const r = BootstrapWorkspaceInputSchema.validate({
      repoName: 'r', repoOrg: 'o', environments: [],
    });
    expect(r.ok).toBe(false);
  });

  it('BootstrapWorkspaceInputSchema rejects environment without name', () => {
    const r = BootstrapWorkspaceInputSchema.validate({
      repoName: 'r', repoOrg: 'o', environments: [{ branch: 'main' }],
    });
    expect(r.ok).toBe(false);
  });

  it('BootstrapWorkspaceInputSchema accepts a complete payload', () => {
    const r = BootstrapWorkspaceInputSchema.validate({
      repoName: 'infra', repoOrg: 'acme',
      environments: [{ name: 'prod', branch: 'main', enforceReviewers: true, reviewerTeams: ['sre'] }],
      stateBucket: 'tfstate', stateRegion: 'us-east-1',
    });
    expect(r.ok).toBe(true);
  });
});
