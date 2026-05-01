// Minimal stub of the `vscode` module so logic-only modules that `import * as vscode`
// can be exercised under Vitest without the electron host. Only the surface
// area the modules under test actually touch is implemented.
//
// Tests that need richer fakes (e.g. flipping `isTelemetryEnabled`, controlling
// `getConfiguration().get` returns) can mutate `__configStore` and the
// `env`/`workspace` fields directly. Keep new additions narrow — the goal is
// "just enough to not crash module-load", not a full VS Code emulator.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const __configStore: Record<string, Record<string, any>> = {};

export const workspace: any = {
  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  textDocuments: [] as Array<unknown>,
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const bucket = section ? __configStore[section] : __configStore[''];
      if (bucket && key in bucket) return bucket[key] as T;
      return defaultValue;
    },
  }),
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    createDirectory: async () => {},
    stat: async () => ({}),
  },
  onDidOpenTextDocument: (_l: unknown) => ({ dispose() {} }),
  onDidSaveTextDocument: (_l: unknown) => ({ dispose() {} }),
  onDidChangeTextDocument: (_l: unknown) => ({ dispose() {} }),
  onDidChangeConfiguration: (_l: unknown) => ({ dispose() {} }),
  findFiles: async () => [],
  openTextDocument: async () => ({}),
};

export const env = {
  isTelemetryEnabled: true,
  openExternal: async () => true,
};

export const commands = {
  executeCommand: async (..._args: unknown[]) => undefined,
};

export const languages = {
  createDiagnosticCollection: (_name: string) => {
    const map = new Map<string, unknown[]>();
    return {
      set: (uri: { toString(): string }, diags: unknown[]) => map.set(uri.toString(), diags),
      get: (uri: { toString(): string }) => map.get(uri.toString()) ?? [],
      delete: (uri: { toString(): string }) => map.delete(uri.toString()),
      clear: () => map.clear(),
      dispose: () => map.clear(),
      __all: () => map,
    };
  },
};

export class Range {
  constructor(public start: unknown, public end: unknown, public _c?: unknown, public _d?: unknown) {}
}
export class Position {
  constructor(public line: number, public character: number) {}
}
export class Diagnostic {
  source = 'terraform-workspace';
  constructor(public range: Range, public message: string, public severity: number) {}
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class CancellationError extends Error {
  constructor() { super('Cancelled'); }
}

export const ProgressLocation = { Notification: 15, Window: 10, SourceControl: 1 };

export const authentication = {
  getSession: async () => undefined,
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
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => fn(),
};
