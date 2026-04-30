/**
 * Tiny narrowing helpers for unknown values returned from external sources
 * (SQLite rows, JSON responses). Use these instead of casting through `any`
 * so the boundary between "validated" and "raw" data is explicit.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object') ? value as Record<string, unknown> : {};
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
