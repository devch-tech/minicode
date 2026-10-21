// Host de extensiones (equivale a out/vs/workbench/api/node/extensionHostProcess.js).
// Carga extensiones con formato de VS Code, les da require('vscode') y las
// activa cuando hace falta (al ejecutar uno de sus comandos), como VS Code.
// Va en su propio proceso: si una extensión falla o se cuelga, el editor sigue.
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const { createVscodeApi, createEditor, Uri } = require('./vscodeApi');

const port = process.parentPort;

let workspaceRoot = null;
let editorState = null;
let activeEditor = null;
let extensions = []; // { id, dir, manifest, active, activating, exports, failed }
const handlers = new Map(); // id de comando → función
let uiSeq = 0;
const uiWaiters = new Map();
let idSeq = 0;

function log(text) {
  port.postMessage({ type: 'log', text });
}

process.on('uncaughtException', (err) => log(`Error no capturado en una extensión: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log(`Promesa rechazada en una extensión: ${err?.stack || err}`));

// ---- Peticiones a la interfaz -------------------------------------------------
function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
function ui(op, args) {
  const id = ++uiSeq;
  return new Promise((resolve, reject) => {
    uiWaiters.set(id, { resolve, reject });
    port.postMessage({ type: 'uiRequest', id, op, args: plain(args) });
  });
}
function notify(op, args) {
  ui(op, args).catch(() => {});
}

function setEditorState(state) {
  editorState = state;
  activeEditor = state ? createEditor(state, ctx) : null;
}

// ---- Registro de comandos ------------------------------------------------------
const registry = {
  register(id, fn) {
    handlers.set(id, fn);
  },
  unregister(id) {
    handlers.delete(id);
  },
  has: (id) => handlers.has(id),
  run: (id, args) => Promise.resolve(handlers.get(id)(...args)),
  ids: () => handlers.keys(),
};

function configurationDefaults() {
  const out = {};
  for (const ext of extensions) {
    const conf = ext.manifest.contributes?.configuration;
    for (const block of Array.isArray(conf) ? conf : conf ? [conf] : []) {
      for (const [key, spec] of Object.entries(block.properties || {})) {
        if (spec && 'default' in spec) out[key] = spec.default;
      }
    }
  }
  return out;
}

function extensionInfo(ext) {
  return {
    id: ext.id,
    extensionPath: ext.dir,
    extensionUri: Uri.file(ext.dir),
    packageJSON: ext.manifest,
    extensionKind: 2,
    get isActive() { return ext.active; },
    get exports() { return ext.exports; },
    activate: () => activate(ext).then(() => ext.exports),
  };
}

const ctx = {
  ui,
  notify,
  log,
  registry,
  nextId: () => ++idSeq,
  activeEditor: () => activeEditor,
  setEditorState,
  workspaceRoot: () => workspaceRoot,
  configurationDefaults,
  getExtension: (id) => {
    const ext = extensions.find((e) => e.id === String(id).toLowerCase());
    return ext && extensionInfo(ext);
  },
  allExtensions: () => extensions.map(extensionInfo),
};

const vscode = createVscodeApi(ctx);

// Cualquier require('vscode') de una extensión recibe nuestra API.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

// ---- Activación ------------------------------------------------------------------
function memento() {
  const data = new Map();
  return {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    update: async (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
    keys: () => [...data.keys()],
    setKeysForSync() {},
  };
}

async function activate(ext) {
  if (ext.active || ext.failed) return;
  if (ext.activating) return ext.activating;
  ext.activating = (async () => {
    const storage = path.join(os.tmpdir(), 'mini-code-ext', ext.id);
    const context = {
      subscriptions: [],
      extensionPath: ext.dir,
      extensionUri: Uri.file(ext.dir),
      extension: extensionInfo(ext),
      extensionMode: vscode.ExtensionMode.Production,
      globalState: memento(),
      workspaceState: memento(),
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => new vscode.Disposable() },
      globalStorageUri: Uri.file(storage),
      globalStoragePath: storage,
      storageUri: Uri.file(storage),
      storagePath: storage,
      logUri: Uri.file(storage),
      logPath: storage,
      environmentVariableCollection: { replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {} },
      asAbsolutePath: (rel) => path.join(ext.dir, rel),
    };
    try {
      const mod = require(path.join(ext.dir, ext.manifest.main));
      ext.exports = await mod.activate?.(context);
      ext.active = true;
      log(`activada ${ext.id}`);
    } catch (err) {
      ext.failed = true;
      log(`No se pudo activar ${ext.id}: ${err.stack || err.message}`);
      notify('message', ['error', `No se pudo activar la extensión ${ext.manifest.displayName || ext.id}: ${err.message}`, [], false]);
    }
    announce();
  })();
  return ext.activating;
}

function ownerOf(commandId) {
  return extensions.find(
    (e) =>
      (e.manifest.contributes?.commands || []).some((c) => c.command === commandId) ||
      (e.manifest.activationEvents || []).includes(`onCommand:${commandId}`),
  );
}

// ---- Comandos y atajos que se anuncian a la interfaz ---------------------------
function announce() {
  const commands = [];
  const seen = new Set();
  for (const ext of extensions) {
    if (ext.failed) continue;
    const name = ext.manifest.displayName || ext.manifest.name;
    for (const c of ext.manifest.contributes?.commands || []) {
      if (!c.command || seen.has(c.command)) continue;
      seen.add(c.command);
      const title = typeof c.title === 'string' ? c.title : c.title?.value || c.command;
      const category = typeof c.category === 'string' ? c.category : c.category?.value;
      commands.push({ id: c.command, title: category ? `${category}: ${title}` : title, extension: name });
    }
  }
  const keybindings = [];
  for (const ext of extensions) {
    const kbs = ext.manifest.contributes?.keybindings;
    for (const kb of Array.isArray(kbs) ? kbs : kbs ? [kbs] : []) {
      const key = (process.platform === 'darwin' ? kb.mac : process.platform === 'win32' ? kb.win : kb.linux) || kb.key;
      if (kb.command && key && !kb.command.startsWith('-')) keybindings.push({ command: kb.command, key });
    }
  }
  port.postMessage({ type: 'commands', commands, keybindings });
}

async function execute(msg) {
  if (msg.editorState !== undefined) setEditorState(msg.editorState);
  if (!handlers.has(msg.id)) {
    const owner = ownerOf(msg.id);
    if (owner) await activate(owner);
  }
  if (!handlers.has(msg.id)) throw new Error(`Comando desconocido o sin implementar: ${msg.id}`);
  await registry.run(msg.id, msg.args || []);
}

port.on('message', ({ data: msg }) => {
  if (msg.type === 'activate') {
    workspaceRoot = msg.workspace || null;
    extensions = msg.extensions.map((e) => ({ ...e, active: false, failed: false, activating: null, exports: undefined }));
    announce();
    // Las que piden arrancar al inicio ("*" u "onStartupFinished") se activan ya.
    for (const ext of extensions) {
      const events = ext.manifest.activationEvents || [];
      if (events.includes('*') || events.includes('onStartupFinished')) activate(ext);
    }
  } else if (msg.type === 'workspace') {
    workspaceRoot = msg.root;
  } else if (msg.type === 'editorState') {
    setEditorState(msg.state);
  } else if (msg.type === 'uiResponse') {
    const waiter = uiWaiters.get(msg.id);
    uiWaiters.delete(msg.id);
    if (msg.error) waiter?.reject(new Error(msg.error));
    else waiter?.resolve(msg.result);
  } else if (msg.type === 'execute') {
    execute(msg).then(
      () => port.postMessage({ type: 'result', requestId: msg.requestId }),
      (err) => port.postMessage({ type: 'result', requestId: msg.requestId, error: err.message }),
    );
  }
});
