import { describe, it, expect } from 'vitest';
import { parseLockHcl } from '../../src/providers/ProviderDocsCache.js';

describe('parseLockHcl', () => {
  it('returns [] for an empty file', () => {
    expect(parseLockHcl('')).toEqual([]);
  });

  it('parses a single hashicorp provider block', () => {
    const text = `
provider "registry.terraform.io/hashicorp/aws" {
  version     = "5.20.0"
  constraints = "~> 5.20"
  hashes = [
    "h1:abcd",
  ]
}
`;
    expect(parseLockHcl(text)).toEqual([
      { source: 'registry.terraform.io/hashicorp/aws', registry: 'registry.terraform.io',
        namespace: 'hashicorp', name: 'aws', version: '5.20.0' },
    ]);
  });

  it('parses multiple blocks, including third-party namespaces', () => {
    const text = `
provider "registry.terraform.io/hashicorp/aws" {
  version = "5.20.0"
}
provider "registry.terraform.io/integrations/github" {
  version = "6.0.1"
}
`;
    const out = parseLockHcl(text);
    expect(out.map(p => `${p.namespace}/${p.name}@${p.version}`).sort()).toEqual([
      'hashicorp/aws@5.20.0',
      'integrations/github@6.0.1',
    ]);
  });

  it('skips blocks without a version line', () => {
    const text = `
provider "registry.terraform.io/hashicorp/aws" {
  constraints = "~> 5.20"
}
`;
    expect(parseLockHcl(text)).toEqual([]);
  });

  it('skips sources that do not have exactly 3 path segments', () => {
    // E.g. malformed entry — not registry/namespace/name
    const text = `
provider "hashicorp/aws" {
  version = "5.20.0"
}
provider "registry.terraform.io/hashicorp/aws/extra" {
  version = "5.20.0"
}
`;
    expect(parseLockHcl(text)).toEqual([]);
  });
});
