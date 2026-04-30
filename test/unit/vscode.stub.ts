// Minimal stub of the `vscode` module so logic-only modules that `import * as vscode`
// can be exercised under Vitest without the electron host. Only the surface
// area the modules under test actually touch is implemented.

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    createDirectory: async () => {},
    stat: async () => ({}),
  },
};

export class Uri {
  constructor(public readonly fsPath: string) {}
  static joinPath(base: Uri, ...segments: string[]) {
    return new Uri([base.fsPath, ...segments].join('/'));
  }
  toString() { return this.fsPath; }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => { this.listeners = this.listeners.filter(x => x !== l); } };
  };
  fire(e: T) { for (const l of this.listeners) l(e); }
  dispose() { this.listeners = []; }
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}

// ─── Language Model tool surfaces ────────────────────────────────────────────
// Just enough to exercise tool `invoke()` paths under Vitest. The real
// VS Code runtime supplies richer behavior; these mirror the constructor
// shape so `instanceof` and `.value`/`.content` reads work in tests.

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(public readonly content: Array<LanguageModelTextPart>) {}
}

export const lm = {
  registerTool: () => ({ dispose() {} }),
};

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};
