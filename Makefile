.PHONY: help build watch compile lint lint-fix format test test-unit test-integration \
        test-watch test-vscode coverage package clean deploy-local install-latest install-pre

# ── Derived names ──────────────────────────────────────────────────────────────
# vsce package outputs "<name>-<version>.vsix" (no publisher prefix).
NAME       := $(shell node -p "require('./package.json').name")
VERSION    := $(shell node -p "require('./package.json').version")
VSIX       := $(NAME)-$(VERSION).vsix

# ── Default target ─────────────────────────────────────────────────────────────
help:
	@node scripts/help.js

# ── Build ──────────────────────────────────────────────────────────────────────
build:
	node esbuild.js --production

watch:
	node esbuild.js --watch

compile:
	node_modules/.bin/tsc --noEmit

# ── Quality ────────────────────────────────────────────────────────────────────
lint:
	node_modules/.bin/eslint src --ext ts

lint-fix:
	node_modules/.bin/eslint src --ext ts --fix

format:
	node_modules/.bin/prettier --write "src/**/*.ts" "test/**/*.ts"

# ── Tests ──────────────────────────────────────────────────────────────────────
test:
	node_modules/.bin/vitest run

test-unit:
	node_modules/.bin/vitest run test/unit

test-integration:
	node_modules/.bin/vitest run test/integration

test-watch:
	node_modules/.bin/vitest

test-vscode:
	node_modules/.bin/tsc -p test/vscode/tsconfig.json && node out/test-vscode/runTest.js

coverage:
	node_modules/.bin/vitest run --coverage

# ── Packaging ──────────────────────────────────────────────────────────────────
# Produces $(VSIX) in the repo root.
package: build
	npx --yes @vscode/vsce package --no-dependencies

# Install the locally-built VSIX into VS Code.
install: package
	code --install-extension $(VSIX) --force
	@echo "Reload VS Code (Ctrl/Cmd+Shift+P → Developer: Reload Window) to activate."

# Hot-patch dist/extension.js into the already-installed extension directory
# without repackaging. Fastest inner-loop workflow.
deploy-local: build
	npm run deploy-local

# Install the latest released VSIX from GitHub (tagged release).
install-latest:
	bash scripts/install-latest.sh

# Install the latest pre-release VSIX from the most recent CI run on main.
install-pre:
	bash scripts/install-latest.sh --pre

# ── Housekeeping ───────────────────────────────────────────────────────────────
clean:
	@node -e "\
	  const fs=require('fs'); \
	  for(const p of ['dist','coverage','.vitest-cache']){ \
	    try{fs.rmSync(p,{recursive:true,force:true})}catch{} \
	  } \
	  for(const f of fs.readdirSync('.')){ \
	    if(f.endsWith('.vsix'))fs.rmSync(f) \
	  } \
	  console.log('Cleaned dist/, coverage/, .vitest-cache/, *.vsix');"
