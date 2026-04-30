import Ajv, { ErrorObject, JSONSchemaType, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Schema-at-the-boundary primitive.
 *
 * Wraps an AJV-compiled JSON Schema in a small, typed surface that returns a
 * discriminated `Result` rather than throwing. Inspired by the Pydantic
 * `BaseModel.model_validate(...)` idiom: validation either succeeds with a
 * typed value, or fails with a list of human-readable, field-pointed errors.
 *
 * Use this for every input crossing a process/tool/UI boundary:
 *   - chat tool inputs (`vscode.lm` tools)
 *   - GitHub API DTOs deserialized from untrusted payloads
 *   - on-disk config files (`terraform-workspace.json`)
 *
 * Errors quote the offending field path (`/repo/repoOrg`) and value, so the
 * caller can surface a useful diagnostic without re-walking AJV's error tree.
 */

export interface SchemaError {
  /** JSON-pointer style path, e.g. `/environments/0/name`. */
  path: string;
  /** Human-readable message including the failed constraint. */
  message: string;
  /** The offending value, when AJV provides one. */
  value?: unknown;
}

export type SchemaResult<T> =
  | { ok: true; value: T; errors?: undefined }
  | { ok: false; value?: undefined; errors: SchemaError[] };

export interface CompiledSchema<T> {
  /** Validate without throwing. Preferred at boundaries. */
  validate(input: unknown): SchemaResult<T>;
  /** Validate and throw a `SchemaValidationError` on failure. */
  assert(input: unknown, label?: string): T;
  /** Underlying AJV validator, escape hatch for advanced use. */
  raw: ValidateFunction;
}

export class SchemaValidationError extends Error {
  constructor(
    public readonly label: string,
    public readonly errors: SchemaError[],
  ) {
    super(`${label}: ${errors.map(e => `${e.path || '<root>'} ${e.message}`).join('; ')}`);
    this.name = 'SchemaValidationError';
  }
}

// One AJV instance per process, reused for every schema. AJV's compile cache
// keys on the schema object identity, so reuse keeps memory + warmup costs flat.
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, useDefaults: true });
addFormats(ajv);

/**
 * Compile a JSON Schema into a typed validator.
 *
 * @param schema JSON Schema (object). Pass `as JSONSchemaType<T>` for strict
 *   type-binding, or a plain object literal for loose binding.
 * @returns A `CompiledSchema<T>` with `validate` and `assert` helpers.
 *
 * @example
 *   const RunApplyInputSchema = defineSchema<RunApplyInput>({
 *     type: 'object',
 *     required: ['workspace'],
 *     properties: {
 *       workspace: { type: 'string', minLength: 1 },
 *       workingDirectory: { type: 'string' },
 *     },
 *     additionalProperties: false,
 *   });
 *   const result = RunApplyInputSchema.validate(options.input);
 *   if (!result.ok) return textResult(formatErrors(result.errors));
 */
export function defineSchema<T = unknown>(schema: object | JSONSchemaType<T>): CompiledSchema<T> {
  const validator = ajv.compile<T>(schema as object);

  const validate = (input: unknown): SchemaResult<T> => {
    const ok = validator(input);
    if (ok) return { ok: true, value: input as T };
    return { ok: false, errors: (validator.errors ?? []).map(formatAjvError) };
  };

  return {
    validate,
    assert(input: unknown, label = 'input') {
      const r = validate(input);
      if (!r.ok) throw new SchemaValidationError(label, r.errors);
      return r.value;
    },
    raw: validator,
  };
}

function formatAjvError(err: ErrorObject): SchemaError {
  const path = err.instancePath || '';
  // AJV puts the offending key for `additionalProperties` / `required` in `params`.
  let message = err.message ?? 'is invalid';
  if (err.keyword === 'required' && err.params && typeof err.params === 'object') {
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    if (missing) message = `must have required property '${missing}'`;
  } else if (err.keyword === 'additionalProperties' && err.params && typeof err.params === 'object') {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    if (extra) message = `must NOT have additional property '${extra}'`;
  } else if (err.keyword === 'enum' && err.params && typeof err.params === 'object') {
    const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues;
    if (allowed) message = `must be one of: ${allowed.map(v => JSON.stringify(v)).join(', ')}`;
  }
  return { path, message, value: (err as { data?: unknown }).data };
}

/** Format errors as a single user-facing string (good for tool results / diagnostics). */
export function formatSchemaErrors(errors: SchemaError[]): string {
  return errors.map(e => `  • ${e.path || '<root>'}: ${e.message}`).join('\n');
}
