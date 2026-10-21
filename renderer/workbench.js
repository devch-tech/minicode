// Workbench (equivale a out/vs/workbench/workbench.desktop.main.js).
// Todo lo que se ve: explorador, pestañas, editor Monaco, búsqueda, paleta de
// comandos, terminal y barra de estado. No tiene acceso a Node: habla con el
// proceso principal solo a través de window.mini (el puente del preload).
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  platform: 'win32',
  workspace: null,
  expanded: new Set(),
  selectedPath: null,
  editors: [], // { path, model, savedVersion, viewState }
  active: null,
  extensionCommands: [],
  themeKind: 'dark',
};

let monacoEditor = null;

// ---- Rutas (el renderer no tiene el módulo path de Node) ------------------
const sep = () => (state.platform === 'win32' ? '\\' : '/');
const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
const join = (a, b) => (a.endsWith(sep()) ? a + b : a + sep() + b);
const relative = (p) => (state.workspace && p.startsWith(state.workspace.root) ? p.slice(state.workspace.root.length + 1) : p);
const samePath = (a, b) => (state.platform === 'win32' ? a?.toLowerCase() === b?.toLowerCase() : a === b);

// ---- Notificaciones -------------------------------------------------------
// Devuelve una promesa con el índice del botón pulsado (o undefined al cerrarse).
function notify(text, level = 'info', buttons = []) {
  return new Promise((resolve) => {
    const t = el('div', `toast ${level}`);
    t.append(el('div', 'toast-text', text));
    let timer = null;
    const close = (value) => {
      clearTimeout(timer);
      t.remove();
      resolve(value);
    };
    if (buttons.length) {
      const row = el('div', 'toast-buttons');
      buttons.forEach((label, i) => {
        const b = el('button', i === 0 ? 'primary' : '', label);
        b.addEventListener('click', () => close(i));
        row.append(b);
      });
      t.append(row);
    }
    const x = el('button', 'toast-close', '✕');
    x.addEventListener('click', () => close(undefined));
    t.append(x);
    $('#notifications').append(t);
    timer = setTimeout(() => close(undefined), buttons.length ? 20000 : level === 'error' ? 8000 : 4500);
  });
}

// ---- Entrada rápida (paleta de comandos, ir a archivo, preguntas) ---------
const quickInput = (() => {
  const box = $('#quick-input');
  const input = $('#quick-input-box');
  const list = $('#quick-input-list');
  let provider = null;
  let items = [];
  let activeIndex = 0;
  let onAccept = null;
  let onCancel = null;

  function render() {
    list.innerHTML = '';
    if (!items.length) {
      list.append(el('div', 'qi-empty', provider?.emptyText || 'No hay resultados'));
      return;
    }
    items.slice(0, 200).forEach((item, i) => {
      const row = el('div', 'qi-item' + (i === activeIndex ? ' active' : ''));
      const label = el('span', 'label');
      label.innerHTML = item.labelHtml || escapeHtml(item.label);
      row.append(label);
      if (item.description) row.append(el('span', 'desc', item.description));
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        accept(item);
      });
      list.append(row);
    });
    list.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  async function refresh() {
    items = provider ? await provider.items(input.value) : [];
    activeIndex = 0;
    render();
  }

  function close() {
    box.classList.add('hidden');
    provider = null;
    if (onCancel) onCancel();
    onCancel = onAccept = null;
    monacoEditor?.focus();
  }

  function accept(item) {
    const fn = onAccept;
    onCancel = null;
    close();
    fn?.(item, input.value);
  }

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      activeIndex = Math.min(items.length - 1, activeIndex + 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      activeIndex = Math.max(0, activeIndex - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (provider?.freeText) accept(items[activeIndex] || null);
      else if (items[activeIndex]) accept(items[activeIndex]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => !box.classList.contains('hidden') && close(), 100));

  return {
    show(p, initial = '') {
      provider = p;
      input.value = initial;
      input.placeholder = p.placeholder || '';
      box.classList.remove('hidden');
      input.focus();
      input.setSelectionRange(initial.length, initial.length);
      refresh();
      return new Promise((resolve) => {
        onAccept = (item, value) => resolve({ item, value });
        onCancel = () => resolve(null);
      });
    },
    // Equivalente a showInputBox: devuelve el texto escrito o null.
    async ask(placeholder, value = '') {
      const res = await this.show({ placeholder, freeText: true, items: async () => [], emptyText: 'Pulsa Intro para confirmar o Esc para cancelar' }, value);
      return res ? res.value.trim() || null : null;
    },
  };
})();

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Búsqueda difusa sencilla: letras en orden, puntúa contigüidad y comienzo de palabra.
function fuzzy(query, text) {
  if (!query) return { score: 0, html: escapeHtml(text) };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  const hits = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += last === i - 1 ? 5 : 1;
      if (i === 0 || /[\\/._\-\s]/.test(t[i - 1])) score += 3;
      hits.push(i);
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  let html = '';
  for (let i = 0; i < text.length; i++) {
    const c = escapeHtml(text[i]);
    html += hits.includes(i) ? `<b>${c}</b>` : c;
  }
  return { score: score - text.length * 0.01, html };
}

// ---- Comandos -------------------------------------------------------------
const commands = new Map();
function registerCommand(id, title, run, keybinding) {
  commands.set(id, { id, title, run, keybinding });
}
async function executeCommand(id, ...args) {
  const cmd = commands.get(id);
  if (cmd) return cmd.run(...args);
  const ext = state.extensionCommands.find((c) => c.id === id);
  if (ext) return runExtensionCommand(ext);
  notify(`Comando no encontrado: ${id}`, 'error');
}

function allCommands() {
  return [
    ...[...commands.values()].filter((c) => c.title),
    ...state.extensionCommands.map((c) => ({ ...c, description: c.extension })),
  ];
}

async function showCommandPalette(initial = '>') {
  const res = await quickInput.show(
    {
      placeholder: 'Escribe > para comandos, : para ir a una línea o un nombre de archivo',
      items: async (value) => {
        if (value.startsWith('>')) {
          const q = value.slice(1).trim();
          return allCommands()
            .map((c) => {
              const m = fuzzy(q, c.title);
              return m && { id: c.id, label: c.title, labelHtml: m.html, description: c.keybinding || c.description, score: m.score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
        }
        if (value.startsWith(':')) {
          const line = parseInt(value.slice(1), 10);
          const max = monacoEditor?.getModel()?.getLineCount() || 0;
          if (!state.active) return [];
          return [{ kind: 'line', line, label: Number.isFinite(line) ? `Ir a la línea ${line}` : `Escribe un número de línea entre 1 y ${max}` }];
        }
        return fileItems(value);
      },
    },
    initial,
  );
  if (!res?.item) return;
  const { item } = res;
  if (item.kind === 'file') openFile(item.path);
  else if (item.kind === 'line' && Number.isFinite(item.line)) revealLine(item.line, 1);
  else if (item.id) executeCommand(item.id);
}

let fileCache = null;
async function fileItems(query) {
  if (!state.workspace) return [];
  if (!fileCache) fileCache = await window.mini.invoke('mini:listFiles');
  const q = query.replace(/\s/g, '');
  const recent = state.editors.map((e) => e.path);
  return fileCache
    .map((p) => {
      const rel = relative(p);
      const m = fuzzy(q, rel);
      if (!m) return null;
      const nameMatch = fuzzy(q, basename(p));
      return {
        kind: 'file',
        path: p,
        label: basename(p),
        labelHtml: nameMatch ? nameMatch.html : escapeHtml(basename(p)),
        description: dirname(rel),
        score: m.score + (nameMatch ? nameMatch.score * 2 : 0) + (recent.some((r) => samePath(r, p)) ? 20 : 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
}

// ---- Explorador -----------------------------------------------------------
const FILE_ICONS = {
  js: ['JS', '#f1e05a'], mjs: ['JS', '#f1e05a'], cjs: ['JS', '#f1e05a'], jsx: ['⚛', '#61dafb'],
  ts: ['TS', '#3178c6'], tsx: ['⚛', '#3178c6'], json: ['{}', '#cbcb41'], md: ['M↓', '#519aba'],
  html: ['<>', '#e34c26'], css: ['#', '#563d7c'], scss: ['#', '#c6538c'], py: ['py', '#3572a5'],
  go: ['go', '#00add8'], rs: ['rs', '#dea584'], java: ['J', '#b07219'], cs: ['C#', '#178600'],
  c: ['C', '#555555'], cpp: ['C+', '#f34b7d'], h: ['h', '#a074c4'], sh: ['$', '#89e051'],
  ps1: ['PS', '#012456'], yml: ['y', '#cb171e'], yaml: ['y', '#cb171e'], xml: ['<>', '#0060ac'],
  svg: ['◐', '#ffb13b'], png: ['▣', '#a074c4'], jpg: ['▣', '#a074c4'], txt: ['≡', '#8b8b8b'],
};
function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return FILE_ICONS[ext] || ['•', '#8b8b8b'];
}

const childrenCache = new Map();

async function loadChildren(dir) {
  try {
    const items = await window.mini.invoke('mini:readDir', dir);
    childrenCache.set(dir, items);
  } catch (err) {
    childrenCache.set(dir, []);
  }
}

async function renderTree() {
  const tree = $('#tree');
  const ws = state.workspace;
  document.body.classList.toggle('no-folder', !ws);
  $('#no-folder').classList.toggle('hidden', !!ws);
  $('#workspace-title').textContent = ws ? ws.name : '';
  $('#status-folder').textContent = ws ? `⌂ ${ws.name}` : '';
  tree.innerHTML = '';
  if (!ws) return;
  if (!childrenCache.has(ws.root)) await loadChildren(ws.root);

  const frag = document.createDocumentFragment();
  const walk = async (dir, depth) => {
    for (const item of childrenCache.get(dir) || []) {
      const row = el('div', 'row');
      row.dataset.path = item.path;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      if (samePath(item.path, state.selectedPath)) row.classList.add('selected');
      const open = state.expanded.has(item.path);
      row.append(el('span', 'twistie', item.isDir ? (open ? '▾' : '▸') : ''));
      if (!item.isDir) {
        const [glyph, color] = fileIcon(item.name);
        const icon = el('span', 'icon', glyph);
        icon.style.color = color;
        row.append(icon);
      }
      row.append(el('span', 'label', item.name));
      if (!item.isDir && isDirty(item.path)) row.classList.add('dirty');
      row.addEventListener('click', () => onTreeClick(item));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        state.selectedPath = item.path;
        showTreeMenu(item);
      });
      frag.append(row);
      if (item.isDir && open) {
        if (!childrenCache.has(item.path)) await loadChildren(item.path);
        await walk(item.path, depth + 1);
      }
    }
  };
  await walk(ws.root, 0);
  tree.innerHTML = '';
  tree.append(frag);
}

async function onTreeClick(item) {
  state.selectedPath = item.path;
  if (item.isDir) {
    if (state.expanded.has(item.path)) state.expanded.delete(item.path);
    else state.expanded.add(item.path);
  } else {
    openFile(item.path);
  }
  renderTree();
}

async function showTreeMenu(item) {
  renderTree();
  const options = [
    { id: 'newFile', label: 'Nuevo archivo…' },
    { id: 'newFolder', label: 'Nueva carpeta…' },
    { id: 'rename', label: 'Cambiar nombre…' },
    { id: 'delete', label: 'Eliminar' },
    { id: 'copyPath', label: 'Copiar ruta' },
  ];
  const res = await quickInput.show({ placeholder: item.name, items: async () => options });
  if (!res?.item) return;
  const parent = item.isDir ? item.path : dirname(item.path);
  switch (res.item.id) {
    case 'newFile': return createEntry(parent, false);
    case 'newFolder': return createEntry(parent, true);
    case 'rename': return renameEntry(item);
    case 'delete': return deleteEntry(item);
    case 'copyPath': return navigator.clipboard.writeText(item.path).then(() => notify('Ruta copiada'));
  }
}

function targetFolder() {
  if (!state.workspace) return null;
  const sel = state.selectedPath;
  if (!sel) return state.workspace.root;
  const parentItems = childrenCache.get(dirname(sel)) || [];
  const item = parentItems.find((i) => samePath(i.path, sel));
  return item?.isDir ? sel : dirname(sel);
}

async function createEntry(parent, isDir) {
  if (!parent) return notify('Abre una carpeta primero', 'error');
  const name = await quickInput.ask(isDir ? 'Nombre de la nueva carpeta' : 'Nombre del nuevo archivo');
  if (!name) return;
  const target = join(parent, name);
  try {
    if (isDir) await window.mini.invoke('mini:createFolder', target);
    else await window.mini.invoke('mini:createFile', target);
    state.expanded.add(parent);
    await refreshExplorer();
    if (!isDir) openFile(target);
  } catch (err) {
    notify(cleanError(err), 'error');
  }
}

async function renameEntry(item) {
  const name = await quickInput.ask('Nuevo nombre', item.name);
  if (!name || name === item.name) return;
  const target = join(dirname(item.path), name);
  try {
    await window.mini.invoke('mini:rename', item.path, target);
    for (const ed of state.editors) {
      if (samePath(ed.path, item.path)) ed.path = target;
    }
    await refreshExplorer();
    renderTabs();
  } catch (err) {
    notify(cleanError(err), 'error');
  }
}

async function deleteEntry(item) {
  const res = await quickInput.show({
    placeholder: `¿Eliminar "${item.name}"${item.isDir ? ' y todo su contenido' : ''}? No se puede deshacer.`,
    items: async () => [{ id: 'yes', label: 'Eliminar' }, { id: 'no', label: 'Cancelar' }],
  });
  if (res?.item?.id !== 'yes') return;
  try {
    await window.mini.invoke('mini:delete', item.path);
    for (const ed of [...state.editors]) {
      if (samePath(ed.path, item.path) || ed.path.startsWith(item.path + sep())) closeEditor(ed, true);
    }
    await refreshExplorer();
  } catch (err) {
    notify(cleanError(err), 'error');
  }
}

async function refreshExplorer() {
  fileCache = null;
  const dirs = [...childrenCache.keys()];
  childrenCache.clear();
  if (state.workspace) {
    await Promise.all(dirs.filter((d) => samePath(d, state.workspace.root) || state.expanded.has(d)).map(loadChildren));
  }
  renderTree();
}

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function openFolder(folder) {
  const ws = folder ? await window.mini.invoke('mini:openFolderPath', folder) : await window.mini.invoke('mini:openFolder');
  if (!ws) return;
  for (const ed of [...state.editors]) closeEditor(ed, true);
  state.workspace = ws;
  state.expanded.clear();
  childrenCache.clear();
  fileCache = null;
  state.selectedPath = null;
  renderTree();
  restartTerminal();
}

// ---- Editores y pestañas ---------------------------------------------------
function languageFor(file) {
  const name = basename(file).toLowerCase();
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  const langs = monaco.languages.getLanguages();
  const byName = langs.find((l) => l.filenames?.some((f) => f.toLowerCase() === name));
  const byExt = langs.find((l) => l.extensions?.includes(ext));
  return (byName || byExt)?.id || 'plaintext';
}

function isDirty(file) {
  const ed = state.editors.find((e) => samePath(e.path, file));
  return !!ed && ed.model.getAlternativeVersionId() !== ed.savedVersion;
}

async function openFile(file, position) {
  let ed = state.editors.find((e) => samePath(e.path, file));
  if (!ed) {
    let content;
    try {
      content = await window.mini.invoke('mini:readFile', file);
    } catch (err) {
      return notify(cleanError(err), 'error');
    }
    const uri = monaco.Uri.file(file);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, languageFor(file), uri);
    ed = { path: file, model, savedVersion: model.getAlternativeVersionId(), viewState: null };
    model.onDidChangeContent(() => {
      renderTabs();
      markTreeDirty();
    });
    state.editors.push(ed);
  }
  activate(ed);
  if (position) revealLine(position.line, position.column);
}

function activate(ed) {
  if (state.active && state.active !== ed) state.active.viewState = monacoEditor.saveViewState();
  state.active = ed;
  monacoEditor.setModel(ed.model);
  if (ed.viewState) monacoEditor.restoreViewState(ed.viewState);
  $('#welcome').classList.add('hidden');
  state.selectedPath = ed.path;
  renderTabs();
  renderBreadcrumbs();
  updateStatus();
  monacoEditor.focus();
}

function revealLine(line, column = 1) {
  monacoEditor.setPosition({ lineNumber: line, column });
  monacoEditor.revealLineInCenter(line);
  monacoEditor.focus();
}

async function closeEditor(ed, force = false) {
  if (!ed) return;
  if (!force && isDirty(ed.path)) {
    const res = await quickInput.show({
      placeholder: `"${basename(ed.path)}" tiene cambios sin guardar`,
      items: async () => [
        { id: 'save', label: 'Guardar y cerrar' },
        { id: 'discard', label: 'Cerrar sin guardar' },
        { id: 'cancel', label: 'Cancelar' },
      ],
    });
    const choice = res?.item?.id;
    if (!choice || choice === 'cancel') return;
    if (choice === 'save' && !(await saveEditor(ed))) return;
  }
  const idx = state.editors.indexOf(ed);
  state.editors.splice(idx, 1);
  ed.model.dispose();
  if (state.active === ed) {
    state.active = null;
    const next = state.editors[idx] || state.editors[idx - 1];
    if (next) activate(next);
    else {
      monacoEditor.setModel(null);
      $('#welcome').classList.remove('hidden');
      renderBreadcrumbs();
      updateStatus();
    }
  }
  renderTabs();
  markTreeDirty();
}

async function saveEditor(ed = state.active) {
  if (!ed) return false;
  try {
    await window.mini.invoke('mini:writeFile', ed.path, ed.model.getValue());
    ed.savedVersion = ed.model.getAlternativeVersionId();
    renderTabs();
    markTreeDirty();
    return true;
  } catch (err) {
    notify(`No se pudo guardar: ${cleanError(err)}`, 'error');
    return false;
  }
}

function markTreeDirty() {
  document.querySelectorAll('#tree .row').forEach((row) => {
    row.classList.toggle('dirty', isDirty(row.dataset.path));
  });
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const ed of state.editors) {
    const tab = el('div', 'tab');
    if (ed === state.active) tab.classList.add('active');
    if (isDirty(ed.path)) tab.classList.add('dirty');
    const [glyph, color] = fileIcon(basename(ed.path));
    const icon = el('span', 'icon', glyph);
    icon.style.cssText = `color:${color};font-size:11px;font-weight:700`;
    tab.title = ed.path;
    tab.append(icon, el('span', 'label', basename(ed.path)));
    const close = el('span', 'close');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeEditor(ed);
    });
    tab.append(close);
    tab.addEventListener('click', () => activate(ed));
    tab.addEventListener('auxclick', (e) => e.button === 1 && closeEditor(ed));
    tabs.append(tab);
    if (ed === state.active) tab.scrollIntoView({ inline: 'nearest' });
  }
}

function renderBreadcrumbs() {
  const bc = $('#breadcrumbs');
  bc.innerHTML = '';
  if (!state.active) return;
  relative(state.active.path)
    .split(/[\\/]/)
    .forEach((part, i, arr) => {
      if (i) bc.append(el('span', 'sep', '›'));
      bc.append(el('span', i === arr.length - 1 ? 'current' : '', part));
    });
}

function updateStatus() {
  const model = monacoEditor?.getModel();
  if (!model) {
    for (const id of ['position', 'indent', 'eol', 'language']) $(`#status-${id}`).textContent = '';
    return;
  }
  const pos = monacoEditor.getPosition();
  const sel = monacoEditor.getSelection();
  const selected = sel && !sel.isEmpty() ? ` (${model.getValueInRange(sel).length} seleccionados)` : '';
  $('#status-position').textContent = `Lín. ${pos.lineNumber}, col. ${pos.column}${selected}`;
  const opts = model.getOptions();
  $('#status-indent').textContent = opts.insertSpaces ? `Espacios: ${opts.tabSize}` : `Tamaño de tabulación: ${opts.tabSize}`;
  $('#status-eol').textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  const lang = monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId());
  $('#status-language').textContent = lang?.aliases?.[0] || model.getLanguageId();
}

function updateProblems() {
  const markers = monaco.editor.getModelMarkers({});
  const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
  const warnings = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length;
  $('#status-problems').textContent = `⊗ ${errors}  ⚠ ${warnings}`;
}

// ---- Búsqueda en archivos --------------------------------------------------
let searchTimer = null;
async function runSearch() {
  const query = $('#search-input').value;
  const caseSensitive = $('#search-case').checked;
  const out = $('#search-results');
  out.innerHTML = '';
  $('#search-summary').textContent = '';
  if (!query || !state.workspace) return;
  $('#search-summary').textContent = 'Buscando…';
  const results = await window.mini.invoke('mini:search', query, { caseSensitive });
  if ($('#search-input').value !== query) return; // llegó una búsqueda más nueva
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  $('#search-summary').textContent = total ? `${total} resultados en ${results.length} archivos` : 'Sin resultados';
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  for (const r of results) {
    const head = el('div', 'search-file', basename(r.file));
    head.append(el('span', 'muted', dirname(relative(r.file))));
    head.addEventListener('click', () => openFile(r.file));
    out.append(head);
    for (const m of r.matches) {
      const row = el('div', 'search-match');
      row.innerHTML = escapeHtml(m.preview).replace(new RegExp(re.source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), re.flags), (s) => `<mark>${s}</mark>`);
      row.title = `Línea ${m.line}`;
      row.addEventListener('click', () => openFile(r.file, { line: m.line, column: m.column }));
      out.append(row);
    }
  }
}

// ---- Vistas de la barra lateral -------------------------------------------
function showView(view) {
  const sidebar = $('#sidebar');
  const current = document.querySelector('.activity.active')?.dataset.view;
  if (current === view && !sidebar.classList.contains('hidden')) {
    toggleSidebar(false);
    return;
  }
  toggleSidebar(true);
  document.querySelectorAll('.activity').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  document.querySelectorAll('#sidebar .view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view === 'search') {
    $('#search-input').focus();
    $('#search-input').select();
  }
  if (view === 'extensions') {
    renderExtensions();
    if (!extState.market.length && !extState.query && !extState.marketError) searchMarketplace('');
    $('#ext-search').focus();
  }
}

function toggleSidebar(force) {
  const show = force ?? $('#sidebar').classList.contains('hidden');
  $('#sidebar').classList.toggle('hidden', !show);
  $('#sash-sidebar').classList.toggle('hidden', !show);
}

// La vista de extensiones, el marketplace y los temas están en extensions.js.

// ---- Terminal --------------------------------------------------------------
const terminal = {
  xterm: null,
  fit: null,
  started: false,
  line: '',
  history: [],
  historyIndex: 0,
};

function initTerminal() {
  const xterm = new Terminal({
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    convertEol: true,
    theme: terminalTheme(),
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open($('#terminal'));
  terminal.xterm = xterm;
  terminal.fit = fit;

  window.mini.on('mini:terminal:data', (data) => xterm.write(data));
  window.mini.on('mini:terminal:exit', () => {
    terminal.started = false;
    xterm.writeln('\r\n\x1b[90m[el proceso del terminal ha terminado; se reiniciará al escribir]\x1b[0m');
  });

  // Edición de línea local: el shell recibe la línea completa al pulsar Intro.
  xterm.onData((data) => {
    if (!terminal.started) startTerminal();
    for (const ch of splitInput(data)) handleTerminalKey(ch);
  });
}

function splitInput(data) {
  if (data.startsWith('\x1b')) return [data];
  return [...data];
}

function handleTerminalKey(key) {
  const xterm = terminal.xterm;
  if (key === '\r') {
    xterm.write('\r\n');
    const line = terminal.line;
    if (line.trim()) terminal.history.push(line);
    terminal.historyIndex = terminal.history.length;
    terminal.line = '';
    if (line.trim() === 'clear' || line.trim() === 'cls') {
      xterm.clear();
    }
    window.mini.send('mini:terminal:input', line);
  } else if (key === '\x7f' || key === '\b') {
    if (terminal.line.length) {
      terminal.line = terminal.line.slice(0, -1);
      xterm.write('\b \b');
    }
  } else if (key === '\x03') {
    xterm.write('^C\r\n');
    terminal.line = '';
    window.mini.send('mini:terminal:input', '');
  } else if (key === '\x1b[A' || key === '\x1b[B') {
    if (!terminal.history.length) return;
    terminal.historyIndex += key === '\x1b[A' ? -1 : 1;
    terminal.historyIndex = Math.max(0, Math.min(terminal.history.length, terminal.historyIndex));
    const next = terminal.history[terminal.historyIndex] || '';
    xterm.write('\b \b'.repeat(terminal.line.length) + next);
    terminal.line = next;
  } else if (key.startsWith('\x1b')) {
    // Otras teclas de control (flechas laterales, etc.) no se admiten sin pty.
  } else if (key >= ' ') {
    terminal.line += key;
    xterm.write(key);
  }
}

function startTerminal() {
  if (terminal.started) return;
  terminal.started = true;
  window.mini.send('mini:terminal:start');
}

function restartTerminal() {
  if (!terminal.xterm) return;
  if (terminal.started) window.mini.send('mini:terminal:input', `cd "${state.workspace.root}"`);
}

function togglePanel(force) {
  const panel = $('#panel');
  const show = force ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  $('#sash-panel').classList.toggle('hidden', !show);
  if (show) {
    if (!terminal.xterm) initTerminal();
    startTerminal();
    requestAnimationFrame(() => {
      terminal.fit.fit();
      terminal.xterm.focus();
    });
  } else {
    monacoEditor?.focus();
  }
}

// El terminal toma los colores del tema activo (variables CSS del workbench).
function terminalTheme() {
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    background: v('--terminal-bg') || v('--bg'),
    foreground: v('--terminal-fg') || v('--fg'),
    cursor: v('--fg'),
    selectionBackground: v('--terminal-selection') || (state.themeKind === 'light' ? '#add6ff' : '#264f78'),
  };
}

// ---- Separadores ------------------------------------------------------------
function makeSash(sash, onMove) {
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sash.classList.add('active');
    const move = (ev) => onMove(ev);
    const up = () => {
      sash.classList.remove('active');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// ---- Atajos de teclado -------------------------------------------------------
const keybindings = [];
function bindKey(combo, id) {
  keybindings.push({ combo, id });
  const cmd = commands.get(id);
  if (cmd) cmd.keybinding = combo;
}
function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.code === 'Backquote') key = '`';
  parts.push(key);
  return parts.join('+');
}

// ---- Arranque ------------------------------------------------------------------
function registerBuiltins() {
  registerCommand('workbench.openFolder', 'Archivo: Abrir carpeta…', () => openFolder());
  registerCommand('workbench.quickOpen', 'Ir a archivo…', () => showCommandPalette(''));
  registerCommand('workbench.commandPalette', 'Mostrar todos los comandos', () => showCommandPalette('>'));
  registerCommand('workbench.gotoLine', 'Ir a la línea…', () => showCommandPalette(':'));
  registerCommand('file.save', 'Archivo: Guardar', () => saveEditor());
  registerCommand('file.saveAll', 'Archivo: Guardar todo', async () => {
    for (const ed of state.editors) if (isDirty(ed.path)) await saveEditor(ed);
  });
  registerCommand('file.newFile', 'Archivo: Nuevo archivo…', () => createEntry(targetFolder(), false));
  registerCommand('file.newFolder', 'Archivo: Nueva carpeta…', () => createEntry(targetFolder(), true));
  registerCommand('editor.close', 'Ver: Cerrar editor', () => closeEditor(state.active));
  registerCommand('editor.closeAll', 'Ver: Cerrar todos los editores', async () => {
    for (const ed of [...state.editors]) await closeEditor(ed);
  });
  registerCommand('editor.nextTab', 'Ver: Siguiente editor', () => cycleTab(1));
  registerCommand('editor.prevTab', 'Ver: Editor anterior', () => cycleTab(-1));
  registerCommand('editor.format', 'Dar formato al documento', () => monacoEditor.getAction('editor.action.formatDocument')?.run());
  registerCommand('editor.toggleWordWrap', 'Ver: Alternar ajuste de línea', () => {
    const wrap = monacoEditor.getOption(monaco.editor.EditorOption.wordWrap);
    monacoEditor.updateOptions({ wordWrap: wrap === 'off' ? 'on' : 'off' });
  });
  registerCommand('editor.toggleMinimap', 'Ver: Alternar minimapa', () => {
    const on = monacoEditor.getOption(monaco.editor.EditorOption.minimap).enabled;
    monacoEditor.updateOptions({ minimap: { enabled: !on } });
  });
  registerCommand('workbench.toggleSidebar', 'Ver: Alternar barra lateral', () => toggleSidebar());
  registerCommand('workbench.togglePanel', 'Ver: Alternar terminal', () => togglePanel());
  registerCommand('workbench.view.explorer', 'Ver: Mostrar explorador', () => showView('explorer'));
  registerCommand('workbench.view.search', 'Buscar: Buscar en archivos', () => showView('search'));
  registerCommand('workbench.view.extensions', 'Ver: Mostrar extensiones', () => showView('extensions'));
  registerCommand('explorer.refresh', 'Explorador: Actualizar', () => refreshExplorer());
  registerCommand('explorer.collapse', 'Explorador: Contraer carpetas', () => {
    state.expanded.clear();
    renderTree();
  });
  registerCommand('terminal.clear', 'Terminal: Limpiar', () => terminal.xterm?.clear());
  registerCommand('theme.select', 'Preferencias: Tema de color', () => showThemePicker());
  registerCommand('theme.toggle', 'Preferencias: Alternar tema claro/oscuro', () => setTheme(state.themeKind === 'light' ? 'builtin:dark' : 'builtin:light'));
  registerCommand('extensions.search', 'Extensiones: Buscar en el marketplace', () => {
    showView('extensions');
    $('#ext-search').focus();
  });
  registerCommand('editor.zoomIn', 'Ver: Aumentar fuente del editor', () => {
    monacoEditor.updateOptions({ fontSize: monacoEditor.getOption(monaco.editor.EditorOption.fontSize) + 1 });
  });
  registerCommand('editor.zoomOut', 'Ver: Reducir fuente del editor', () => {
    monacoEditor.updateOptions({ fontSize: Math.max(8, monacoEditor.getOption(monaco.editor.EditorOption.fontSize) - 1) });
  });

  bindKey('Ctrl+O', 'workbench.openFolder');
  bindKey('Ctrl+P', 'workbench.quickOpen');
  bindKey('Ctrl+Shift+P', 'workbench.commandPalette');
  bindKey('F1', 'workbench.commandPalette');
  bindKey('Ctrl+G', 'workbench.gotoLine');
  bindKey('Ctrl+S', 'file.save');
  bindKey('Ctrl+Alt+S', 'file.saveAll');
  bindKey('Ctrl+N', 'file.newFile');
  bindKey('Ctrl+W', 'editor.close');
  bindKey('Ctrl+Tab', 'editor.nextTab');
  bindKey('Ctrl+Shift+Tab', 'editor.prevTab');
  bindKey('Shift+Alt+F', 'editor.format');
  bindKey('Alt+Z', 'editor.toggleWordWrap');
  bindKey('Ctrl+B', 'workbench.toggleSidebar');
  bindKey('Ctrl+`', 'workbench.togglePanel');
  bindKey('Ctrl+J', 'workbench.togglePanel');
  bindKey('Ctrl+Shift+E', 'workbench.view.explorer');
  bindKey('Ctrl+Shift+F', 'workbench.view.search');
  bindKey('Ctrl+Shift+X', 'workbench.view.extensions');
  bindKey('Ctrl+=', 'editor.zoomIn');
  bindKey('Ctrl+-', 'editor.zoomOut');
}

function cycleTab(dir) {
  if (state.editors.length < 2) return;
  const i = state.editors.indexOf(state.active);
  activate(state.editors[(i + dir + state.editors.length) % state.editors.length]);
}

function wireUi() {
  // Captura en fase de captura para adelantarse a Monaco y a xterm.
  window.addEventListener(
    'keydown',
    (e) => {
      const combo = comboOf(e);
      const kb = keybindings.find((k) => k.combo === combo);
      if (!kb) return;
      // Dentro del terminal, Ctrl+C/Ctrl+V etc. no se interceptan; solo los atajos globales.
      e.preventDefault();
      e.stopPropagation();
      executeCommand(kb.id);
    },
    true,
  );

  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => executeCommand(b.dataset.cmd)));
  document.querySelectorAll('.activity').forEach((a) => a.addEventListener('click', () => showView(a.dataset.view)));

  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  $('#search-case').addEventListener('change', runSearch);

  makeSash($('#sash-sidebar'), (e) => {
    $('#sidebar').style.width = `${Math.max(170, Math.min(e.clientX - 48, window.innerWidth - 300))}px`;
  });
  makeSash($('#sash-panel'), (e) => {
    const h = window.innerHeight - 22 - e.clientY;
    $('#panel').style.height = `${Math.max(80, Math.min(h, window.innerHeight - 200))}px`;
    terminal.fit?.fit();
  });
  new ResizeObserver(() => terminal.fit && !$('#panel').classList.contains('hidden') && terminal.fit.fit()).observe($('#panel'));

  window.mini.on('mini:fs:changed', (paths) => {
    fileCache = null;
    const dirs = new Set(paths.map(dirname));
    if ([...dirs].some((d) => childrenCache.has(d))) refreshExplorer();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.editors.some((ed) => isDirty(ed.path))) {
      e.returnValue = false;
      notify('Hay archivos sin guardar. Guárdalos (Ctrl+Alt+S) o ciérralos antes de salir.', 'error');
    }
  });
}

function createEditor() {
  monacoEditor = monaco.editor.create($('#editor'), {
    model: null,
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 14,
    minimap: { enabled: true },
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    renderWhitespace: 'selection',
    stickyScroll: { enabled: true },
  });
  monacoEditor.onDidChangeCursorSelection(updateStatus);
  monacoEditor.onDidChangeModel(updateStatus);
  monaco.editor.onDidChangeMarkers(updateProblems);
  updateProblems();
}

async function boot() {
  const initial = await window.mini.invoke('mini:getInitialState');
  state.platform = initial.platform;
  state.workspace = initial.workspace;

  registerBuiltins();
  wireUi();
  createEditor();
  renderTree();
  await initExtensions();
}

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], () => {
  boot().catch((err) => notify(`Error al arrancar: ${err.message}`, 'error'));
});
