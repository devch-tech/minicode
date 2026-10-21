// Proceso principal (equivale a out/main.js + out/mainImpl.js de VS Code).
// Crea la ventana, atiende las peticiones del renderer por IPC y lanza los
// procesos auxiliares: terminal (ptyHost), extensiones (extensionHost) y
// vigilante de archivos (watcher), cada uno en su propio utilityProcess.
const { app, BrowserWindow, ipcMain, dialog, utilityProcess, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const marketplace = require('./marketplace');

const IGNORED = new Set(['node_modules', '.git', 'out', 'dist', '.next']);
const MAX_FILES = 5000;

let win = null;
let workspaceRoot = null;
const hosts = {};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startHost(name, file, onMessage) {
  const child = utilityProcess.fork(path.join(__dirname, 'hosts', file), [], {
    serviceName: `mini-code-${name}`,
    stdio: 'pipe',
  });
  child.on('message', onMessage);
  child.stderr?.on('data', (d) => console.error(`[${name}]`, d.toString()));
  child.on('exit', (code) => {
    console.log(`[${name}] terminó con código ${code}`);
    if (hosts[name] === child) delete hosts[name];
  });
  hosts[name] = child;
  return child;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    title: 'Mini Code',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

// ---- Sistema de archivos ------------------------------------------------

function insideWorkspace(p) {
  if (!workspaceRoot) throw new Error('No hay ninguna carpeta abierta');
  const resolved = path.resolve(p);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Ruta fuera de la carpeta abierta: ${p}`);
  }
  return resolved;
}

async function readDir(dir) {
  const entries = await fs.readdir(insideWorkspace(dir), { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith('.git') || e.name === '.gitignore')
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name)) await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function searchText(query, { caseSensitive = false } = {}) {
  if (!query) return [];
  const files = await listFiles(workspaceRoot);
  const needle = caseSensitive ? query : query.toLowerCase();
  const results = [];
  for (const file of files) {
    let text;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 1024 * 1024) continue;
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binario
    const lines = text.split(/\r?\n/);
    const matches = [];
    lines.forEach((line, i) => {
      const hay = caseSensitive ? line : line.toLowerCase();
      const col = hay.indexOf(needle);
      if (col !== -1) matches.push({ line: i + 1, column: col + 1, preview: line.trim().slice(0, 200) });
    });
    if (matches.length) results.push({ file, matches: matches.slice(0, 50) });
    if (results.length >= 200) break;
  }
  return results;
}

function setWorkspace(folder) {
  workspaceRoot = folder;
  hosts.watcher?.postMessage({ type: 'watch', root: folder });
  hosts.extensions?.postMessage({ type: 'workspace', root: folder });
  win?.setTitle(`${path.basename(folder)} — Mini Code`);
  return { root: folder, name: path.basename(folder) };
}

// ---- IPC ----------------------------------------------------------------
// Todos los canales empiezan por "mini:"; el preload rechaza cualquier otro,
// igual que VS Code exige el prefijo "vscode:".

ipcMain.handle('mini:openFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return setWorkspace(res.filePaths[0]);
});
ipcMain.handle('mini:openFolderPath', (_e, folder) => setWorkspace(path.resolve(folder)));
ipcMain.handle('mini:readDir', (_e, dir) => readDir(dir));
ipcMain.handle('mini:readFile', async (_e, file) => {
  const buf = await fs.readFile(insideWorkspace(file));
  if (buf.includes(0)) throw new Error('El archivo parece binario');
  return buf.toString('utf8');
});
ipcMain.handle('mini:writeFile', (_e, file, content) => fs.writeFile(insideWorkspace(file), content, 'utf8'));
ipcMain.handle('mini:createFile', async (_e, file) => {
  const target = insideWorkspace(file);
  await fs.writeFile(target, '', { flag: 'wx' });
  return target;
});
ipcMain.handle('mini:createFolder', (_e, dir) => fs.mkdir(insideWorkspace(dir), { recursive: false }));
ipcMain.handle('mini:delete', (_e, p) => fs.rm(insideWorkspace(p), { recursive: true }));
ipcMain.handle('mini:rename', (_e, from, to) => fs.rename(insideWorkspace(from), insideWorkspace(to)));
ipcMain.handle('mini:listFiles', () => (workspaceRoot ? listFiles(workspaceRoot) : []));
ipcMain.handle('mini:search', (_e, query, opts) => (workspaceRoot ? searchText(query, opts) : []));
ipcMain.handle('mini:getInitialState', () => ({
  platform: process.platform,
  workspace: workspaceRoot ? { root: workspaceRoot, name: path.basename(workspaceRoot) } : null,
}));

// Terminal
ipcMain.on('mini:terminal:start', () => {
  hosts.pty?.postMessage({ type: 'start', cwd: workspaceRoot || app.getPath('home') });
});
ipcMain.on('mini:terminal:input', (_e, data) => hosts.pty?.postMessage({ type: 'input', data }));

// ---- Extensiones ------------------------------------------------------------
const BUILTIN_EXT_DIR = path.join(__dirname, 'extensions');
const userExtDir = () => process.env.MINI_CODE_EXTENSIONS_DIR || path.join(app.getPath('userData'), 'extensions');

let installed = [];
let contributions = { commands: [], keybindings: [] };
let pendingExec = 0;
const execWaiters = new Map();

function publicExtension(e) {
  return {
    id: e.id,
    builtin: e.builtin,
    displayName: e.displayName,
    description: e.description,
    version: e.version,
    publisher: e.publisher,
    icon: e.icon,
    compatibility: e.compatibility,
    themes: (e.manifest.contributes?.themes || []).map((t) => ({ label: t.label || t.id, uiTheme: t.uiTheme, path: t.path })),
  };
}

function onExtensionHostMessage(msg) {
  if (msg.type === 'commands') {
    contributions = { commands: msg.commands, keybindings: msg.keybindings };
    send('mini:commands:changed', contributions);
  } else if (msg.type === 'result') {
    const waiter = execWaiters.get(msg.requestId);
    execWaiters.delete(msg.requestId);
    if (msg.error) waiter?.reject(new Error(msg.error));
    else waiter?.resolve(msg.value);
  } else if (msg.type === 'uiRequest') {
    if (msg.op === 'openExternal') {
      openExternal(msg.args[0])
        .then((result) => hosts.extensions?.postMessage({ type: 'uiResponse', id: msg.id, result }))
        .catch((err) => hosts.extensions?.postMessage({ type: 'uiResponse', id: msg.id, error: err.message }));
    } else {
      send('mini:ext:request', { id: msg.id, op: msg.op, args: msg.args });
    }
  } else if (msg.type === 'log') {
    console.log('[extensiones]', msg.text);
  }
}

// Como "Recargar ventana" en VS Code: se descarta el proceso de extensiones y
// se arranca otro con la lista nueva.
function startExtensionHost() {
  installed = marketplace.listInstalled(BUILTIN_EXT_DIR, userExtDir());
  hosts.extensions?.kill();
  for (const waiter of execWaiters.values()) waiter.reject(new Error('Se reinició el host de extensiones'));
  execWaiters.clear();
  const host = startHost('extensions', 'extensionHost.js', onExtensionHostMessage);
  host.postMessage({
    type: 'activate',
    workspace: workspaceRoot,
    extensions: installed
      .filter((e) => e.manifest.main)
      .map((e) => ({ id: e.id, dir: e.dir, manifest: e.manifest })),
  });
  send('mini:extensions:changed', installed.map(publicExtension));
}

async function openExternal(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Solo se pueden abrir enlaces web');
  await shell.openExternal(parsed.toString());
  return true;
}

ipcMain.handle('mini:commands:execute', (_e, id, editorState, args = []) => {
  const ext = hosts.extensions;
  if (!ext) throw new Error('El host de extensiones no está activo');
  const requestId = ++pendingExec;
  return new Promise((resolve, reject) => {
    execWaiters.set(requestId, { resolve, reject });
    ext.postMessage({ type: 'execute', requestId, id, editorState, args });
  });
});
ipcMain.handle('mini:commands:list', () => contributions);
ipcMain.on('mini:ext:response', (_e, { id, result, error }) => {
  hosts.extensions?.postMessage({ type: 'uiResponse', id, result, error });
});
ipcMain.on('mini:ext:editorState', (_e, state) => hosts.extensions?.postMessage({ type: 'editorState', state }));

ipcMain.handle('mini:extensions:installed', () => installed.map(publicExtension));
ipcMain.handle('mini:marketplace:search', (_e, query, offset) => marketplace.search(query, offset));
ipcMain.handle('mini:extensions:install', async (_e, namespace, name) => {
  const result = await marketplace.install(namespace, name, userExtDir());
  startExtensionHost();
  return { id: result.id, version: result.version, displayName: result.displayName, compatibility: result.compatibility };
});
ipcMain.handle('mini:extensions:uninstall', async (_e, id) => {
  const ext = installed.find((e) => e.id === id);
  if (!ext) throw new Error('Extensión no encontrada');
  if (ext.builtin) throw new Error('Las extensiones integradas no se pueden desinstalar');
  await marketplace.removeInstalled(id, userExtDir());
  startExtensionHost();
});
ipcMain.handle('mini:themes:load', (_e, extId, relPath) => {
  const ext = installed.find((e) => e.id === extId);
  if (!ext) throw new Error('Extensión no encontrada');
  return marketplace.loadTheme(ext.dir, relPath);
});
ipcMain.handle('mini:openExternal', (_e, url) => openExternal(url));

function startHosts() {
  startHost('pty', 'terminalHost.js', (msg) => {
    if (msg.type === 'data') send('mini:terminal:data', msg.data);
    if (msg.type === 'exit') send('mini:terminal:exit', msg.code);
  });

  startExtensionHost();

  startHost('watcher', 'watcherHost.js', (msg) => {
    if (msg.type === 'changed') send('mini:fs:changed', msg.paths);
  });
}

app.whenReady().then(() => {
  startHosts();
  const folderArg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  if (folderArg) {
    try {
      setWorkspace(path.resolve(folderArg));
    } catch {}
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const h of Object.values(hosts)) h.kill();
  if (process.platform !== 'darwin') app.quit();
});
