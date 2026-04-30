/**
 * Helpers for keeping secret material out of logs, error messages, and
 * model-visible output. Apply these wherever a value originally typed as
 * "sensitive" might otherwise leak into the OutputChannel or be echoed
 * back to the language model.
 */

/**
 * Replace a secret string with a fixed-length redaction marker.
 * Always returns the same shape regardless of input length so that callers
 * cannot infer entropy from the rendered output.
 */
export function redact(_value: string | undefined | null): string {
  return '«REDACTED»';
}

/**
 * Returns a short fingerprint suitable for logs: the first 4 characters of
 * the SHA-256 hash, prefixed with `~`. This lets operators correlate without
 * exposing the value. Empty input returns the literal `«empty»`.
 */
export async function fingerprint(value: string): Promise<string> {
  if (!value) return '«empty»';
  const enc = new TextEncoder().encode(value);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  return `~${hex.slice(0, 4)}`;
}

/**
 * Walk an arbitrary object and replace any string field whose key matches
 * a known-sensitive name with `«REDACTED»`. Use when echoing a tool input
 * back into a log line.
 */
const SENSITIVE_KEYS = new Set([
  'secret', 'token', 'password', 'apiKey', 'api_key',
  'access_token', 'accessToken', 'authorization', 'aws_secret_access_key',
]);

export function redactSensitive<T>(input: T, sensitive = false): T {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(v => redactSensitive(v, sensitive)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (sensitive && k === 'value' && typeof v === 'string') {
      out[k] = redact(v);
    } else if (SENSITIVE_KEYS.has(k) && typeof v === 'string') {
      out[k] = redact(v);
    } else if (v && typeof v === 'object') {
      out[k] = redactSensitive(v, sensitive);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
