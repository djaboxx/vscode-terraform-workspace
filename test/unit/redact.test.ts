import { describe, it, expect } from 'vitest';
import { redact, redactSensitive, fingerprint } from '../../src/util/redact.js';

describe('redact', () => {
  it('returns the same marker regardless of input length', () => {
    expect(redact('a')).toBe('«REDACTED»');
    expect(redact('a'.repeat(1000))).toBe('«REDACTED»');
    expect(redact('')).toBe('«REDACTED»');
    expect(redact(undefined)).toBe('«REDACTED»');
  });
});

describe('fingerprint', () => {
  it('produces a short stable identifier for the same input', async () => {
    const a = await fingerprint('hunter2');
    const b = await fingerprint('hunter2');
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(8);
    expect(a.startsWith('~')).toBe(true);
  });

  it('produces different identifiers for different inputs', async () => {
    const a = await fingerprint('value-one');
    const b = await fingerprint('value-two');
    expect(a).not.toBe(b);
  });

  it('handles empty input safely', async () => {
    expect(await fingerprint('')).toBe('«empty»');
  });
});

describe('redactSensitive', () => {
  it('redacts well-known sensitive keys at any depth', () => {
    const input = {
      key: 'AWS_ACCESS_KEY_ID',
      token: 'ghp_xxxxxxxxxxxx',
      nested: {
        password: 'hunter2',
        api_key: 'sk-abc',
        ok: 'visible',
      },
      list: [{ secret: 's', other: 'visible' }],
    };
    const out = redactSensitive(input);
    expect(out.key).toBe('AWS_ACCESS_KEY_ID');
    expect(out.token).toBe('«REDACTED»');
    expect(out.nested.password).toBe('«REDACTED»');
    expect(out.nested.api_key).toBe('«REDACTED»');
    expect(out.nested.ok).toBe('visible');
    expect(out.list[0].secret).toBe('«REDACTED»');
    expect(out.list[0].other).toBe('visible');
  });

  it('redacts the `value` field only when sensitive=true', () => {
    const input = { key: 'X', value: 'visible-by-default' };
    expect(redactSensitive(input).value).toBe('visible-by-default');
    expect(redactSensitive(input, true).value).toBe('«REDACTED»');
  });

  it('passes primitives and null through untouched', () => {
    expect(redactSensitive('hello' as unknown as Record<string, unknown>)).toBe('hello');
    expect(redactSensitive(42 as unknown as Record<string, unknown>)).toBe(42);
    expect(redactSensitive(null as unknown as Record<string, unknown>)).toBe(null);
  });
});
