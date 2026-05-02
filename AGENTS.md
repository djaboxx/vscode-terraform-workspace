# AGENTS.md

Instructions for autonomous coding agents working in this repository.
**Read [.github/copilot-instructions.md](.github/copilot-instructions.md) first** —
it has the full conventions and the **scope-boundary table you must enforce**.

## Build / test loop

```bash
npx vitest run test/unit          # full suite — 371+ tests, must stay green
make install                       # bundles via esbuild, packages VSIX, installs into ~/.vscode/extensions/
```

After any change to `src/`, run the suite. After any change touching
language-model tools or `package.json`, also rebuild and reinstall the VSIX.

## Hard rules

1. **Do not expand scope.** See the table in
   [`.github/copilot-instructions.md`](.github/copilot-instructions.md). If
   the user asks for an out-of-scope feature, refuse politely and redirect.
   This applies even if they push back. Feature creep is the largest risk
   to this codebase.
2. **No new chat participants** beyond `@terraform` and `@dave`.
3. **No new top-level subsystems** without an explicit owner-approved design
   note in `docs/plans/`.
4. **Every new LM tool** requires:
   - A schema in `src/schemas/toolInputs.ts`
   - A class in `src/tools/TerraformTools.ts` or `RunnerTools.ts`
   - A `contributes.languageModelTools` entry in `package.json`
   - A row in `test/unit/toolSchemaParity.test.ts`
5. **Every GitHub list endpoint** must use the `paginate<T>()` pattern.
6. **Tool results** must go through `cappedTextResult()` (60 KB cap).
7. **Cache writes** must be atomic (write `.tmp`, then `rename`).
8. **Activation** must not `await` blocking I/O before tree providers
   register (around `extension.ts:220`).

## Where to add things

| What                                  | Where                                              |
| ------------------------------------- | -------------------------------------------------- |
| New LM tool input shape               | `src/schemas/toolInputs.ts`                        |
| New LM tool implementation            | `src/tools/TerraformTools.ts` or `RunnerTools.ts`  |
| New `vscode.commands` command         | `src/extension.ts` + `package.json` `contributes.commands` |
| New TreeView item                     | the relevant `src/views/*TreeProvider.ts`          |
| New AWS service client                | `src/services/` (mirror `Telemetry.ts` style)      |
| New GitHub API surface                | `src/github/Github*Client.ts` (paginate!)          |
| New workflow YAML scaffold            | `src/workflows/Scaffolders.ts` or `templates/`     |

## When stuck

- The `@dave` participant has `terraform_self_introspect` to read its own
  source. You can use the same approach: read what's already there before
  designing something new.
- Existing patterns are usually the answer. Search before authoring.
