// Capa de compatibilidad: lo que una extensión recibe al hacer require('vscode').
// Equivale a vs/workbench/api/common/extHost.api.impl.ts del VS Code real, pero
// solo con la parte más usada de la API. Todo lo que toca la interfaz se
// convierte en una petición "ui" que contesta el workbench.
const path = require('node:path');

// ---- Tipos básicos ------------------------------------------------------------
class Position {
  constructor(line, character) {
    this.line = Math.max(0, line);
    this.character = Math.max(0, character);
  }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isBeforeOrEqual(o) { return this.isBefore(o) || this.isEqual(o); }
  isAfter(o) { return !this.isBeforeOrEqual(o); }
  isAfterOrEqual(o) { return !this.isBefore(o); }
  isEqual(o) { return this.line === o.line && this.character === o.character; }
  compareTo(o) { return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1; }
  translate(a = 0, b = 0) {
    if (typeof a === 'object') return new Position(this.line + (a.lineDelta || 0), this.character + (a.characterDelta || 0));
    return new Position(this.line + a, this.character + b);
  }
  with(a, b) {
    if (a && typeof a === 'object') return new Position(a.line ?? this.line, a.character ?? this.character);
    return new Position(a ?? this.line, b ?? this.character);
  }
}

class Range {
  constructor(a, b, c, d) {
    let start = typeof a === 'number' ? new Position(a, b) : a;
    let end = typeof a === 'number' ? new Position(c, d) : b;
    if (end.isBefore(start)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(x) {
    if (x instanceof Range) return this.contains(x.start) && this.contains(x.end);
    return x.isAfterOrEqual(this.start) && x.isBeforeOrEqual(this.end);
  }
  isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
  intersection(o) {
    const start = this.start.isAfter(o.start) ? this.start : o.start;
    const end = this.end.isBefore(o.end) ? this.end : o.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(o) {
    return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end);
  }
  with(a, b) {
    if (a && !(a instanceof Position)) return new Range(a.start ?? this.start, a.end ?? this.end);
    return new Range(a ?? this.start, b ?? this.end);
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    const anchor = typeof a === 'number' ? new Position(a, b) : a;
    const active = typeof a === 'number' ? new Position(c, d) : b;
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
  get isReversed() { return this.anchor.isAfter(this.active); }
}

class Uri {
  constructor(scheme, authority, p, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority || '';
    this.path = p;
    this.query = query;
    this.fragment = fragment;
  }
  static file(p) {
    return new Uri('file', '', p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '/$1:'));
  }
  static parse(value) {
    const u = new URL(value);
    return new Uri(u.protocol.replace(/:$/, ''), u.host, decodeURIComponent(u.pathname), u.search.slice(1), u.hash.slice(1));
  }
  static joinPath(base, ...parts) {
    return base.with({ path: path.posix.join(base.path, ...parts) });
  }
  get fsPath() {
    const p = this.path.replace(/^\/([a-zA-Z]:)/, '$1');
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  }
  with(c) {
    return new Uri(c.scheme ?? this.scheme, c.authority ?? this.authority, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment);
  }
  toString() {
    return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? '?' + this.query : ''}`;
  }
  toJSON() { return { scheme: this.scheme, path: this.path, fsPath: this.fsPath }; }
}

class Disposable {
  constructor(fn) { this._fn = fn; }
  static from(...items) { return new Disposable(() => items.forEach((i) => i?.dispose?.())); }
  dispose() { this._fn?.(); this._fn = null; }
}

class EventEmitter {
  constructor() { this._listeners = new Set(); }
  get event() {
    return (listener, thisArg, disposables) => {
      const fn = thisArg ? listener.bind(thisArg) : listener;
      this._listeners.add(fn);
      const d = new Disposable(() => this._listeners.delete(fn));
      disposables?.push(d);
      return d;
    };
  }
  fire(data) { for (const l of [...this._listeners]) { try { l(data); } catch {} } }
  dispose() { this._listeners.clear(); }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: this._emitter.event };
  }
  cancel() { this.token.isCancellationRequested = true; this._emitter.fire(); }
  dispose() { this._emitter.dispose(); }
}

class SnippetString {
  constructor(value = '') { this.value = value; }
  appendText(s) { this.value += s.replace(/[$}\\]/g, '\\$&'); return this; }
  appendPlaceholder(s) { this.value += typeof s === 'string' ? s : ''; return this; }
  appendTabstop() { return this; }
}

class TextEdit {
  constructor(range, newText) { this.range = range; this.newText = newText; }
  static replace(range, newText) { return new TextEdit(range, newText); }
  static insert(position, newText) { return new TextEdit(new Range(position, position), newText); }
  static delete(range) { return new TextEdit(range, ''); }
}

class WorkspaceEdit {
  constructor() { this._edits = []; }
  replace(uri, range, newText) { this._edits.push({ uri, range, newText }); }
  insert(uri, position, newText) { this._edits.push({ uri, range: new Range(position, position), newText }); }
  delete(uri, range) { this._edits.push({ uri, range, newText: '' }); }
  set(uri, edits) { for (const e of edits) this._edits.push({ uri, range: e.range, newText: e.newText }); }
  get size() { return new Set(this._edits.map((e) => e.uri.toString())).size; }
}

class ThemeColor { constructor(id) { this.id = id; } }
class ThemeIcon { constructor(id) { this.id = id; } }
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');
class MarkdownString {
  constructor(value = '') { this.value = value; }
  appendText(s) { this.value += s; return this; }
  appendMarkdown(s) { this.value += s; return this; }
  appendCodeblock(s, lang = '') { this.value += `\n\`\`\`${lang}\n${s}\n\`\`\`\n`; return this; }
}

const enums = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  EndOfLine: { LF: 1, CRLF: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  TextEditorCursorStyle: { Line: 1, Block: 2, Underline: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  UIKind: { Desktop: 1, Web: 2 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  CompletionItemKind: new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? 0 : undefined) }),
  SymbolKind: new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? 0 : undefined) }),
};

// ---- Documento y editor (instantánea del editor activo) ------------------------
function createDocument(state, ctx) {
  const text = state.text;
  const eol = state.eol || '\n';
  const lines = text.split(/\r?\n/);
  const lineStarts = [];
  const re = /\r?\n/g;
  lineStarts.push(0);
  let m;
  while ((m = re.exec(text))) lineStarts.push(m.index + m[0].length);
  const uri = Uri.file(state.path || 'Sin título');

  const doc = {
    uri,
    fileName: state.path || 'Sin título',
    isUntitled: !state.path,
    languageId: state.languageId || 'plaintext',
    version: state.version || 1,
    isDirty: !!state.dirty,
    isClosed: false,
    eol: eol === '\r\n' ? enums.EndOfLine.CRLF : enums.EndOfLine.LF,
    lineCount: lines.length,
    getText(range) {
      if (!range) return text;
      const r = doc.validateRange(range);
      return text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end));
    },
    lineAt(x) {
      const line = typeof x === 'number' ? x : x.line;
      if (line < 0 || line >= lines.length) throw new Error(`Línea fuera de rango: ${line}`);
      const t = lines[line];
      const firstNonWs = t.search(/\S/);
      return {
        lineNumber: line,
        text: t,
        range: new Range(line, 0, line, t.length),
        rangeIncludingLineBreak: line < lines.length - 1 ? new Range(line, 0, line + 1, 0) : new Range(line, 0, line, t.length),
        firstNonWhitespaceCharacterIndex: firstNonWs === -1 ? t.length : firstNonWs,
        isEmptyOrWhitespace: firstNonWs === -1,
      };
    },
    offsetAt(pos) {
      const p = doc.validatePosition(pos);
      return lineStarts[p.line] + p.character;
    },
    positionAt(off) {
      off = Math.max(0, Math.min(off, text.length));
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= off) lo = mid;
        else hi = mid - 1;
      }
      return new Position(lo, Math.min(off - lineStarts[lo], lines[lo].length));
    },
    validatePosition(pos) {
      const line = Math.max(0, Math.min(pos.line, lines.length - 1));
      return new Position(line, Math.max(0, Math.min(pos.character, lines[line].length)));
    },
    validateRange(r) { return new Range(doc.validatePosition(r.start), doc.validatePosition(r.end)); },
    getWordRangeAtPosition(pos, regex) {
      const p = doc.validatePosition(pos);
      const lineText = lines[p.line];
      const wordRe = regex ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g') : /[\p{L}\p{N}_$-]+/gu;
      let match;
      while ((match = wordRe.exec(lineText))) {
        const start = match.index;
        const end = start + match[0].length;
        if (start <= p.character && p.character <= end && match[0].length) return new Range(p.line, start, p.line, end);
        if (!match[0].length) wordRe.lastIndex++;
      }
      return undefined;
    },
    save: () => ctx.ui('save', []).then(() => true),
  };
  return doc;
}

function toPlainRange(r) {
  return { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } };
}
function toSelections(list) {
  return (list || []).map((s) => new Selection(new Position(s.anchor.line, s.anchor.character), new Position(s.active.line, s.active.character)));
}

function createEditor(state, ctx) {
  const document = createDocument(state, ctx);
  let selections = toSelections(state.selections);
  if (!selections.length) selections = [new Selection(0, 0, 0, 0)];

  const editor = {
    document,
    options: { tabSize: state.tabSize || 4, insertSpaces: state.insertSpaces !== false },
    viewColumn: 1,
    visibleRanges: [new Range(0, 0, document.lineCount - 1, 0)],
    get selection() { return selections[0]; },
    set selection(s) { editor.selections = [s]; },
    get selections() { return selections; },
    set selections(list) {
      selections = list;
      ctx.notify('setSelections', [list.map((s) => ({ anchor: s.anchor, active: s.active }))]);
    },
    async edit(callback) {
      const edits = [];
      const builder = {
        replace: (loc, text) => edits.push({ range: toPlainRange(loc instanceof Position ? new Range(loc, loc) : loc), text }),
        insert: (pos, text) => edits.push({ range: toPlainRange(new Range(pos, pos)), text }),
        delete: (range) => edits.push({ range: toPlainRange(range), text: '' }),
        setEndOfLine: () => {},
      };
      callback(builder);
      if (!edits.length) return true;
      const newState = await ctx.ui('edit', [edits]);
      ctx.setEditorState(newState);
      return true;
    },
    async insertSnippet(snippet, location) {
      const text = (snippet.value ?? String(snippet)).replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
      const targets = location ? (Array.isArray(location) ? location : [location]) : selections;
      return editor.edit((b) => targets.forEach((t) => b.replace(t instanceof Position ? new Range(t, t) : t, text)));
    },
    revealRange(range) { ctx.notify('reveal', [toPlainRange(range)]); },
    setDecorations() {},
    show() {},
    hide() {},
  };
  return editor;
}

// ---- La API ----------------------------------------------------------------------
function createVscodeApi(ctx) {
  const unsupported = (name) => (...args) => {
    ctx.log(`API no soportada en Mini Code: ${name}`);
    return new Disposable();
  };
  const stubNamespace = (name, impl) =>
    new Proxy(impl, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key !== 'string') return undefined;
        if (key.startsWith('onDid') || key.startsWith('onWill')) return () => new Disposable();
        if (key.startsWith('register') || key.startsWith('create')) return unsupported(`${name}.${key}`);
        return undefined;
      },
    });

  const event = () => () => new Disposable();

  const commands = {
    registerCommand(id, handler, thisArg) {
      ctx.registry.register(id, thisArg ? handler.bind(thisArg) : handler);
      return new Disposable(() => ctx.registry.unregister(id));
    },
    registerTextEditorCommand(id, handler, thisArg) {
      return commands.registerCommand(id, async (...args) => {
        const editor = ctx.activeEditor();
        if (!editor) return;
        const edits = [];
        const builder = {
          replace: (loc, text) => edits.push([loc, text]),
          insert: (pos, text) => edits.push([new Range(pos, pos), text]),
          delete: (range) => edits.push([range, '']),
          setEndOfLine: () => {},
        };
        const result = await handler.call(thisArg, editor, builder, ...args);
        if (edits.length) await editor.edit((b) => edits.forEach(([r, t]) => b.replace(r, t)));
        return result;
      });
    },
    executeCommand(id, ...args) {
      if (ctx.registry.has(id)) return ctx.registry.run(id, args);
      return ctx.ui('executeCommand', [id, args]);
    },
    getCommands: async () => [...ctx.registry.ids()],
  };

  const message = (level) => (text, ...items) => {
    const options = items[0] && typeof items[0] === 'object' && !('title' in items[0]) ? items.shift() : {};
    const labels = items.map((i) => (typeof i === 'string' ? i : i.title));
    return ctx.ui('message', [level, String(text), labels, !!options.modal]).then((index) => (index == null ? undefined : items[index]));
  };

  const outputChannels = (name) => ({
    name,
    append: (s) => ctx.log(`[${name}] ${s}`),
    appendLine: (s) => ctx.log(`[${name}] ${s}`),
    trace: (s) => ctx.log(`[${name}] ${s}`),
    debug: (s) => ctx.log(`[${name}] ${s}`),
    info: (s) => ctx.log(`[${name}] ${s}`),
    warn: (s) => ctx.log(`[${name}] ${s}`),
    error: (s) => ctx.log(`[${name}] ${s}`),
    replace() {},
    clear() {},
    show() {},
    hide() {},
    dispose() {},
  });

  const window = stubNamespace('window', {
    get activeTextEditor() { return ctx.activeEditor(); },
    get visibleTextEditors() { const e = ctx.activeEditor(); return e ? [e] : []; },
    get activeColorTheme() { return { kind: 2 }; },
    state: { focused: true },
    showInformationMessage: message('info'),
    showWarningMessage: message('warning'),
    showErrorMessage: message('error'),
    async showQuickPick(items, options = {}) {
      const list = await items;
      if (!list?.length) return undefined;
      const plain = list.map((i) => (typeof i === 'string' ? { label: i } : { label: i.label, description: i.description, detail: i.detail, picked: i.picked }));
      const res = await ctx.ui('quickPick', [plain, { placeHolder: options.placeHolder || options.title || '', canPickMany: !!options.canPickMany }]);
      if (res == null) return undefined;
      return Array.isArray(res) ? res.map((i) => list[i]) : list[res];
    },
    async showInputBox(options = {}) {
      const value = await ctx.ui('inputBox', [{ prompt: options.prompt || options.title || '', placeHolder: options.placeHolder || '', value: options.value || '' }]);
      if (value == null) return undefined;
      if (options.validateInput) {
        const err = await options.validateInput(value);
        if (err) {
          await ctx.ui('message', ['error', typeof err === 'string' ? err : err.message, [], false]);
          return undefined;
        }
      }
      return value;
    },
    createOutputChannel: (name) => outputChannels(name),
    createStatusBarItem(...args) {
      const id = ctx.nextId();
      const item = { text: '', tooltip: '', command: undefined, alignment: 1, priority: 0, backgroundColor: undefined, color: undefined };
      const sync = (visible) => ctx.notify('statusBarItem', [id, visible ? { text: item.text, tooltip: typeof item.tooltip === 'string' ? item.tooltip : '', command: typeof item.command === 'string' ? item.command : item.command?.command } : null]);
      let visible = false;
      return new Proxy(item, {
        get(t, k) {
          if (k === 'show') return () => { visible = true; sync(true); };
          if (k === 'hide') return () => { visible = false; sync(false); };
          if (k === 'dispose') return () => { visible = false; sync(false); };
          return t[k];
        },
        set(t, k, v) { t[k] = v; if (visible) sync(true); return true; },
      });
    },
    setStatusBarMessage(text, timeout) {
      ctx.notify('statusMessage', [String(text), typeof timeout === 'number' ? timeout : 5000]);
      return new Disposable(() => ctx.notify('statusMessage', ['', 0]));
    },
    async withProgress(options, task) {
      if (options?.title) ctx.notify('statusMessage', [options.title, 0]);
      try {
        return await task({ report: () => {} }, new CancellationTokenSource().token);
      } finally {
        if (options?.title) ctx.notify('statusMessage', ['', 0]);
      }
    },
    async showTextDocument(doc) {
      const p = doc?.fsPath || doc?.uri?.fsPath || doc?.fileName;
      if (p) await ctx.ui('openFile', [p]);
      return ctx.activeEditor();
    },
    createTextEditorDecorationType: () => ({ key: `deco${ctx.nextId()}`, dispose() {} }),
    onDidChangeActiveTextEditor: event(),
    onDidChangeTextEditorSelection: event(),
    onDidChangeVisibleTextEditors: event(),
    onDidChangeWindowState: event(),
    onDidChangeActiveColorTheme: event(),
  });

  const workspace = stubNamespace('workspace', {
    get workspaceFolders() {
      const root = ctx.workspaceRoot();
      return root ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }] : undefined;
    },
    get rootPath() { return ctx.workspaceRoot() || undefined; },
    get name() { const r = ctx.workspaceRoot(); return r ? path.basename(r) : undefined; },
    get textDocuments() { const e = ctx.activeEditor(); return e ? [e.document] : []; },
    getConfiguration(section) {
      const defaults = ctx.configurationDefaults();
      const prefix = section ? `${section}.` : '';
      const lookup = (key) => {
        const full = prefix + key;
        if (full in defaults) return defaults[full];
        // Objeto anidado: "editor" → { tabSize: ... }
        const nested = {};
        let found = false;
        for (const [k, v] of Object.entries(defaults)) {
          if (k.startsWith(full + '.')) {
            nested[k.slice(full.length + 1)] = v;
            found = true;
          }
        }
        return found ? nested : undefined;
      };
      return {
        get: (key, fallback) => lookup(key) ?? fallback,
        has: (key) => lookup(key) !== undefined,
        inspect: (key) => ({ key: prefix + key, defaultValue: lookup(key) }),
        update: async () => {},
      };
    },
    getWorkspaceFolder(uri) { return workspace.workspaceFolders?.[0]; },
    asRelativePath(p) {
      const full = typeof p === 'string' ? p : p.fsPath;
      const root = ctx.workspaceRoot();
      return root && full.startsWith(root) ? full.slice(root.length + 1).replace(/\\/g, '/') : full;
    },
    async applyEdit(edit) {
      const editor = ctx.activeEditor();
      if (!editor) return false;
      const own = edit._edits.filter((e) => e.uri.fsPath.toLowerCase() === editor.document.uri.fsPath.toLowerCase());
      if (own.length !== edit._edits.length) ctx.log('applyEdit: solo se aplican cambios al archivo activo');
      return editor.edit((b) => own.forEach((e) => b.replace(e.range, e.newText)));
    },
    async openTextDocument(arg) {
      const p = typeof arg === 'string' ? arg : arg?.fsPath;
      if (!p) throw new Error('openTextDocument sin ruta no está soportado');
      const state = await ctx.ui('readDocument', [p]);
      return createDocument(state, ctx);
    },
    fs: {
      readFile: async (uri) => Buffer.from(await require('node:fs/promises').readFile(uri.fsPath)),
      writeFile: (uri, content) => require('node:fs/promises').writeFile(uri.fsPath, content),
      stat: async (uri) => {
        const s = await require('node:fs/promises').stat(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
      },
    },
    onDidChangeConfiguration: event(),
    onDidChangeTextDocument: event(),
    onDidOpenTextDocument: event(),
    onDidCloseTextDocument: event(),
    onDidSaveTextDocument: event(),
    onWillSaveTextDocument: event(),
    onDidChangeWorkspaceFolders: event(),
    createFileSystemWatcher: () => ({ onDidChange: event(), onDidCreate: event(), onDidDelete: event(), dispose() {} }),
  });

  const languages = stubNamespace('languages', {
    getLanguages: async () => [],
    match: () => 0,
    createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, forEach() {}, get: () => [], has: () => false, dispose() {} }),
    setTextDocumentLanguage: async (doc) => doc,
    onDidChangeDiagnostics: event(),
  });

  const env = {
    appName: 'Mini Code',
    appRoot: path.resolve(__dirname, '..'),
    language: 'es',
    machineId: 'mini-code',
    sessionId: `mini-${process.pid}`,
    uriScheme: 'mini-code',
    uiKind: enums.UIKind.Desktop,
    shell: process.env.ComSpec || process.env.SHELL || '',
    clipboard: {
      readText: () => ctx.ui('clipboardRead', []),
      writeText: (text) => ctx.ui('clipboardWrite', [String(text)]),
    },
    openExternal: (uri) => ctx.ui('openExternal', [uri.toString()]),
    asExternalUri: async (uri) => uri,
  };

  const extensions = {
    getExtension: (id) => ctx.getExtension(id),
    get all() { return ctx.allExtensions(); },
    onDidChange: event(),
  };

  return {
    version: '1.90.0',
    Position,
    Range,
    Selection,
    Uri,
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    SnippetString,
    TextEdit,
    WorkspaceEdit,
    ThemeColor,
    ThemeIcon,
    MarkdownString,
    ...enums,
    commands,
    window,
    workspace,
    languages,
    env,
    extensions,
    debug: stubNamespace('debug', { onDidStartDebugSession: event(), onDidTerminateDebugSession: event() }),
    scm: stubNamespace('scm', {}),
    tasks: stubNamespace('tasks', {}),
    notebooks: stubNamespace('notebooks', {}),
    authentication: stubNamespace('authentication', {}),
    l10n: { t: (msg, ...args) => (typeof msg === 'string' ? msg : msg.message).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? '') },
  };
}

module.exports = { createVscodeApi, createEditor, Range, Position, Selection, Uri };
