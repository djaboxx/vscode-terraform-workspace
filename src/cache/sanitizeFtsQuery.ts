/**
 * Tokenize a free-text query and quote each token for FTS5 MATCH so that
 * punctuation, hyphens, and underscores in HCL identifiers don't trip the
 * FTS5 tokenizer. Multi-token queries are AND-ed.
 *
 * Examples:
 *   `aws_s3_bucket replication`  →  `"aws_s3_bucket" AND "replication"`
 *   `"assume role"`              →  `"assume role"`  (preserves explicit phrase)
 *   `module.vpc-prod`            →  `"module.vpc-prod"`
 */
export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  if (/^".+"$/.test(trimmed)) return trimmed;
  const tokens = trimmed
    .split(/\s+/)
    .map(t => t.replace(/"/g, ''))
    .filter(t => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t}"`).join(' AND ');
}
