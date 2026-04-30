import { describe, it, expect } from 'vitest';
import { generateModuleRepoFiles } from '../../src/workflows/ModuleRepoScaffolder.js';

describe('generateModuleRepoFiles', () => {
  it('produces the standard set of files with sensible defaults', () => {
    const files = generateModuleRepoFiles({ moduleName: 'terraform-aws-vpc', provider: 'aws' });
    const paths = [...files.keys()].sort();
    expect(paths).toEqual(
      [
        '.gitignore',
        '.terraform-docs.yml',
        'README.md',
        'examples/basic/main.tf',
        'examples/basic/versions.tf',
        'main.tf',
        'outputs.tf',
        'variables.tf',
        'versions.tf',
      ].sort(),
    );
  });

  it('versions.tf pins the requested provider with a known source', () => {
    const files = generateModuleRepoFiles({ moduleName: 'terraform-aws-vpc', provider: 'aws' });
    const versions = files.get('versions.tf')!;
    expect(versions).toMatch(/required_version\s*=\s*">= 1\.5\.0"/);
    expect(versions).toMatch(/source\s*=\s*"hashicorp\/aws"/);
    expect(versions).toMatch(/aws\s*=\s*\{/);
  });

  it('falls back to hashicorp/<provider> for unknown providers', () => {
    const files = generateModuleRepoFiles({ moduleName: 'terraform-foo-thing', provider: 'foo' });
    expect(files.get('versions.tf')!).toMatch(/source\s*=\s*"hashicorp\/foo"/);
  });

  it('respects custom requiredVersion', () => {
    const files = generateModuleRepoFiles({
      moduleName: 'terraform-aws-vpc',
      provider: 'aws',
      requiredVersion: '>= 1.7.0',
    });
    expect(files.get('versions.tf')!).toMatch(/required_version\s*=\s*">= 1\.7\.0"/);
    expect(files.get('examples/basic/versions.tf')!).toMatch(/required_version\s*=\s*">= 1\.7\.0"/);
  });

  it('scaffolds one folder per requested example name', () => {
    const files = generateModuleRepoFiles({
      moduleName: 'terraform-aws-vpc',
      provider: 'aws',
      exampleNames: ['basic', 'with-flow-logs', 'multi-az'],
    });
    expect(files.has('examples/basic/main.tf')).toBe(true);
    expect(files.has('examples/with-flow-logs/main.tf')).toBe(true);
    expect(files.has('examples/multi-az/main.tf')).toBe(true);
  });

  it('example main.tf instantiates module from "../../" with a snake_case local name', () => {
    const files = generateModuleRepoFiles({ moduleName: 'terraform-aws-vpc', provider: 'aws' });
    const example = files.get('examples/basic/main.tf')!;
    expect(example).toMatch(/module\s+"vpc"\s*\{/);
    expect(example).toMatch(/source\s*=\s*"\.\.\/\.\.\/"/);
  });

  it('README contains terraform-docs injection markers and example links', () => {
    const files = generateModuleRepoFiles({
      moduleName: 'terraform-aws-vpc',
      provider: 'aws',
      exampleNames: ['basic', 'multi-az'],
      description: 'A VPC module.',
    });
    const readme = files.get('README.md')!;
    expect(readme).toContain('# terraform-aws-vpc');
    expect(readme).toContain('A VPC module.');
    expect(readme).toContain('<!-- BEGIN_TF_DOCS -->');
    expect(readme).toContain('<!-- END_TF_DOCS -->');
    expect(readme).toMatch(/examples\/basic/);
    expect(readme).toMatch(/examples\/multi-az/);
  });

  it('omits devcontainer.json by default and includes it when requested', () => {
    const without = generateModuleRepoFiles({ moduleName: 'terraform-aws-vpc', provider: 'aws' });
    expect(without.has('.devcontainer/devcontainer.json')).toBe(false);
    const withDc = generateModuleRepoFiles({
      moduleName: 'terraform-aws-vpc',
      provider: 'aws',
      includeDevcontainer: true,
    });
    expect(withDc.has('.devcontainer/devcontainer.json')).toBe(true);
  });

  it('terraform-docs config injects between the README markers', () => {
    const files = generateModuleRepoFiles({ moduleName: 'terraform-aws-vpc', provider: 'aws' });
    const cfg = files.get('.terraform-docs.yml')!;
    expect(cfg).toMatch(/mode:\s*inject/);
    expect(cfg).toMatch(/file:\s*README\.md/);
    expect(cfg).toContain('BEGIN_TF_DOCS');
  });
});
