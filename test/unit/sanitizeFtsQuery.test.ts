import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from '../../src/cache/sanitizeFtsQuery.js';

describe('sanitizeFtsQuery', () => {
  it('quotes individual tokens and AND-joins them', () => {
    expect(sanitizeFtsQuery('aws_s3_bucket replication')).toBe('"aws_s3_bucket" AND "replication"');
  });

  it('preserves an explicit phrase', () => {
    expect(sanitizeFtsQuery('"assume role"')).toBe('"assume role"');
  });

  it('handles single tokens', () => {
    expect(sanitizeFtsQuery('module')).toBe('"module"');
  });

  it('quotes hyphenated/dotted identifiers', () => {
    expect(sanitizeFtsQuery('module.vpc-prod')).toBe('"module.vpc-prod"');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });

  it('strips embedded quotes from tokens', () => {
    expect(sanitizeFtsQuery('foo"bar baz')).toBe('"foobar" AND "baz"');
  });
});
