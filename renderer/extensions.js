// Extensiones en el workbench: panel con el marketplace (Open VSX), instalación,
// temas de color, atajos que aportan las extensiones y las peticiones que llegan
// del host de extensiones (mensajes, listas, ediciones…). Usa las funciones
// globales de workbench.js.
'use strict';

const extState = {
  installed: [],
  market: [],
  marketTotal: 0,
  query: '',
  busy: new Set(), // ids instalándose o desinstalándose
  statusItems: new Map(),
  searchSeq: 0,
};

// ---- Arranque ----------------------------------------------------------------------
async function initExtensions() {
  const [contrib, installed] = await Promise.all([
    window.mini.invoke('mini:commands:list'),
    window.mini.invoke('mini:extensions:installed'),
  ]);
  extState.installed = installed;
  onContributionsChanged(contrib);

  window.mini.on('mini:commands:changed', onContributionsChanged);
  window.mini.on('mini:extensions:changed', (list) => {
    extState.installed = list;
    renderExtensions();
  });
  window.mini.on('mini:ext:request', handleExtensionRequest);

  let timer = null;
  $('#ext-search').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => searchMarketplace($('#ext-search').value.trim()), 300);
  });
  $('#ext-more').addEventListener('click', () => searchMarketplace(extState.query, extState.market.length));

  let saved = null;
  try {
    saved = localStorage.getItem('mini.theme');
  } catch {}
  await setTheme(saved || 'builtin:dark', { quiet: true });
  renderExtensions();
}

// ---- Comandos y atajos que aportan las extensiones -----------------------------------
const KEY_NAMES = {
  enter: 'Enter', escape: 'Escape', tab: 'Tab', space: ' ', backspace: 'Backspace', delete: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', backquote: '`',
};
function normalizeKey(key) {
  if (/\s/.test(key.trim())) return null; // secuencias tipo "ctrl+k ctrl+u" no soportadas
  const parts = key.toLowerCase().split('+');
  const k = parts.pop();
  const mods = new Set(parts.map((p) => (p === 'cmd' || p === 'meta' || p === 'win' ? 'ctrl' : p)));
  const out = [];
  if (mods.has('ctrl')) out.push('Ctrl');
  if (mods.has('shift')) out.push('Shift');
  if (mods.has('alt')) out.push('Alt');
  out.push(KEY_NAMES[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : k.length === 1 ? k.toUpperCase() : k));
  return out.join('+');
}

function onContributionsChanged({ commands: cmds, keybindings: kbs }) {
  state.extensionCommands = cmds;
  // Quitar los atajos de extensiones anteriores y añadir los nuevos sin pisar los integrados.
  for (let i = keybindings.length - 1; i >= 0; i--) if (keybindings[i].fromExtension) keybindings.splice(i, 1);
  for (const kb of kbs || []) {
    const combo = normalizeKey(kb.key);
    if (!combo || keybindings.some((k) => k.combo === combo)) continue;
    keybindings.push({ combo, id: kb.command, fromExtension: true });
    const cmd = cmds.find((c) => c.id === kb.command);
    if (cmd) cmd.keybinding = combo;
  }
  renderExtensions();
}

// Estado del editor activo, con posiciones empezando en 0 como en la API de VS Code.
function editorSnapshot() {
  const model = monacoEditor?.getModel();
  if (!model || !state.active) return null;
  const opts = model.getOptions();
  return {
    path: state.active.path,
    languageId: model.getLanguageId(),
    text: model.getValue(),
    eol: model.getEOL(),
    version: model.getVersionId(),
    dirty: isDirty(state.active.path),
    tabSize: opts.tabSize,
    insertSpaces: opts.insertSpaces,
    selections: (monacoEditor.getSelections() || []).map((s) => ({
      anchor: { line: s.selectionStartLineNumber - 1, character: s.selectionStartColumn - 1 },
      active: { line: s.positionLineNumber - 1, character: s.positionColumn - 1 },
    })),
  };
}

async function runExtensionCommand(cmd, args = []) {
  try {
    await window.mini.invoke('mini:commands:execute', cmd.id, editorSnapshot(), args);
  } catch (err) {
    notify(`${cmd.title || cmd.id}: ${cleanError(err)}`, 'error');
  }
}

// ---- Peticiones del host de extensiones ------------------------------------------------
const toMonacoRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

const BUILTIN_COMMAND_ALIASES = {
  'workbench.action.files.save': 'file.save',
  'workbench.action.files.saveAll': 'file.saveAll',
  'workbench.action.files.newUntitledFile': 'file.newFile',
  'workbench.action.closeActiveEditor': 'editor.close',
  'workbench.action.closeAllEditors': 'editor.closeAll',
  'workbench.action.showCommands': 'workbench.commandPalette',
  'workbench.action.quickOpen': 'workbench.quickOpen',
  'workbench.action.gotoLine': 'workbench.gotoLine',
  'workbench.action.toggleSidebarVisibility': 'workbench.toggleSidebar',
  'workbench.action.terminal.toggleTerminal': 'workbench.togglePanel',
  'workbench.action.selectTheme': 'theme.select',
  'workbench.view.explorer': 'workbench.view.explorer',
  'workbench.view.search': 'workbench.view.search',
  'workbench.view.extensions': 'workbench.view.extensions',
};

async function runCommandFromExtension(id, args = []) {
  const alias = BUILTIN_COMMAND_ALIASES[id];
  if (alias || commands.has(id)) return commands.get(alias || id).run(...args);
  if (id === 'setContext') return undefined;
  if (id === 'vscode.open' && args[0]) return openFile(args[0].fsPath || args[0].path);
  if (state.extensionCommands.some((c) => c.id === id)) return window.mini.invoke('mini:commands:execute', id, editorSnapshot(), args);
  if (monacoEditor?.getModel()) {
    const action = monacoEditor.getAction(id);
    if (action) return action.run(args[0]);
    monacoEditor.trigger('extension', id, args[0]); // p. ej. "type", "cursorMove", "deleteLeft"
    return undefined;
  }
  throw new Error(`Comando no disponible en Mini Code: ${id}`);
}

const extensionOps = {
  message: async (level, text, items, modal) => {
    const index = await notify(text, level === 'warning' ? 'warning' : level, items);
    return index;
  },
  quickPick: async (items, options) => {
    const res = await quickInput.show({
      placeholder: options.placeHolder || '',
      items: async (q) =>
        items
          .map((it, index) => {
            const m = fuzzy(q, it.label);
            return m && { index, label: it.label, labelHtml: m.html, description: it.description || it.detail || '', score: m.score };
          })
          .filter(Boolean)
          .sort((a, b) => (q ? b.score - a.score : a.index - b.index)),
    });
    if (!res?.item) return null;
    return options.canPickMany ? [res.item.index] : res.item.index;
  },
  inputBox: async (options) => {
    const res = await quickInput.show(
      { placeholder: options.prompt || options.placeHolder || '', freeText: true, items: async () => [], emptyText: options.prompt ? `${options.prompt} (Intro para confirmar, Esc para cancelar)` : 'Intro para confirmar, Esc para cancelar' },
      options.value || '',
    );
    return res ? res.value : null;
  },
  edit: async (edits) => {
    const model = monacoEditor.getModel();
    if (!model) throw new Error('No hay ningún editor activo');
    monacoEditor.pushUndoStop();
    monacoEditor.executeEdits('extension', edits.map((e) => ({ range: toMonacoRange(e.range), text: e.text, forceMoveMarkers: true })));
    monacoEditor.pushUndoStop();
    return editorSnapshot();
  },
  setSelections: async (sels) => {
    if (!monacoEditor.getModel() || !sels.length) return;
    monacoEditor.setSelections(
      sels.map((s) => new monaco.Selection(s.anchor.line + 1, s.anchor.character + 1, s.active.line + 1, s.active.character + 1)),
    );
  },
  reveal: async (range) => monacoEditor.revealRangeInCenterIfOutsideViewport(toMonacoRange(range)),
  executeCommand: (id, args) => runCommandFromExtension(id, args),
  clipboardRead: () => navigator.clipboard.readText(),
  clipboardWrite: (text) => navigator.clipboard.writeText(text),
  save: () => saveEditor(),
  openFile: async (p) => {
    await openFile(p);
    return null;
  },
  readDocument: async (p) => {
    const open = state.editors.find((e) => samePath(e.path, p));
    const text = open ? open.model.getValue() : await window.mini.invoke('mini:readFile', p);
    return { path: p, text, languageId: languageFor(p), eol: text.includes('\r\n') ? '\r\n' : '\n', selections: [] };
  },
  statusBarItem: async (id, item) => {
    if (item && item.text) extState.statusItems.set(id, item);
    else extState.statusItems.delete(id);
    renderStatusItems();
  },
  statusMessage: async (text, timeout) => {
    const elMsg = $('#status-message');
    elMsg.textContent = text;
    clearTimeout(elMsg._timer);
    if (text && timeout) elMsg._timer = setTimeout(() => (elMsg.textContent = ''), timeout);
  },
};

async function handleExtensionRequest({ id, op, args }) {
  try {
    const fn = extensionOps[op];
    if (!fn) throw new Error(`Operación no soportada: ${op}`);
    const result = await fn(...(args || []));
    window.mini.send('mini:ext:response', { id, result: result === undefined ? null : result });
  } catch (err) {
    window.mini.send('mini:ext:response', { id, error: cleanError(err) });
  }
}

function renderStatusItems() {
  const box = $('#status-extensions');
  box.innerHTML = '';
  for (const item of extState.statusItems.values()) {
    // Los iconos tipo $(check) de VS Code se muestran como texto plano.
    const span = el('span', 'item', item.text.replace(/\$\([\w-]+\)\s*/g, ''));
    span.title = item.tooltip || '';
    if (item.command) {
      span.classList.add('clickable');
      span.addEventListener('click', () => executeCommand(item.command));
    }
    box.append(span);
  }
}

// ---- Panel de extensiones -------------------------------------------------------------
function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} K`;
  return String(n);
}

const COMPAT_LABEL = { full: 'Compatible', partial: 'Compatibilidad parcial', none: 'No compatible' };

function compatTooltip(c) {
  const parts = [];
  if (c.supported.length) parts.push(`Funciona: ${c.supported.join(', ')}`);
  if (c.unsupported.length) parts.push(`No disponible en Mini Code: ${c.unsupported.join(', ')}`);
  return parts.join('\n') || 'Esta extensión no aporta nada que Mini Code pueda usar';
}

function extensionIcon(src, name) {
  if (src) {
    const img = el('img', 'ext-icon');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(extensionIcon(null, name));
    return img;
  }
  const ph = el('div', 'ext-icon placeholder', (name || '?').trim()[0]?.toUpperCase() || '?');
  return ph;
}

function installedById(id) {
  return extState.installed.find((e) => e.id === id);
}

function renderItem(ext, { installed }) {
  const item = el('div', 'ext-item');
  item.dataset.id = ext.id;
  item.append(extensionIcon(ext.icon, ext.displayName));
  const body = el('div', 'ext-body');

  const title = el('div', 'ext-title');
  const name = el('span', 'ext-name', ext.displayName);
  title.append(name);
  if (ext.version) title.append(el('span', 'ext-version', `v${ext.version}`));
  body.append(title);
  body.append(el('div', 'ext-desc', ext.description || ''));

  const meta = el('div', 'ext-meta');
  const publisher = el('span', 'ext-publisher', ext.namespace || ext.publisher || '');
  if (ext.verified) {
    const v = el('span', 'verified', '✓');
    v.title = 'Editor verificado en Open VSX';
    publisher.append(v);
  }
  meta.append(publisher);
  if (ext.downloadCount != null) meta.append(el('span', 'ext-downloads', `⤓ ${formatCount(ext.downloadCount)}`));

  const local = installed ? ext : installedById(ext.id);
  if (local?.compatibility) {
    const badge = el('span', `badge ${local.compatibility.level}`, COMPAT_LABEL[local.compatibility.level]);
    badge.title = compatTooltip(local.compatibility);
    meta.append(badge);
  }
  if (local?.builtin) meta.append(el('span', 'badge builtin', 'Integrada'));

  const actions = el('span', 'ext-actions');
  if (ext.url) {
    const info = el('button', 'ext-link', 'ⓘ');
    info.title = 'Ver en Open VSX';
    info.addEventListener('click', () => window.mini.invoke('mini:openExternal', ext.url));
    actions.append(info);
  }
  if (local?.themes?.length) {
    const t = el('button', 'ext-button secondary', 'Tema');
    t.title = 'Elegir uno de sus temas de color';
    t.addEventListener('click', () => showThemePicker(local.id));
    actions.append(t);
  }
  if (extState.busy.has(ext.id)) {
    actions.append(el('button', 'ext-button', local ? 'Desinstalando…' : 'Instalando…'));
    actions.lastChild.disabled = true;
  } else if (local && !local.builtin) {
    const b = el('button', 'ext-button secondary', 'Desinstalar');
    b.addEventListener('click', () => uninstallExtension(local));
    actions.append(b);
  } else if (!local && ext.namespace) {
    const b = el('button', 'ext-button', 'Instalar');
    b.addEventListener('click', () => installExtension(ext));
    actions.append(b);
  }
  meta.append(actions);
  body.append(meta);
  item.append(body);
  return item;
}

function renderExtensions() {
  const q = extState.query.toLowerCase();
  const installedList = $('#ext-installed');
  installedList.innerHTML = '';
  // Todas las palabras de la búsqueda deben aparecer; guiones y puntos cuentan como espacios.
  const words = q.split(/[\s\-_.]+/).filter(Boolean);
  const haystack = (e) => `${e.displayName} ${e.id} ${e.description || ''}`.toLowerCase().replace(/[\-_.]+/g, ' ');
  const shown = extState.installed.filter((e) => words.every((w) => haystack(e).includes(w)));
  $('#ext-installed-title').textContent = `INSTALADAS (${shown.length})`;
  for (const ext of shown) installedList.append(renderItem(ext, { installed: true }));

  const market = $('#ext-market');
  market.innerHTML = '';
  $('#ext-market-title').textContent = q ? `OPEN VSX · ${formatCount(extState.marketTotal)} resultados` : 'POPULARES EN OPEN VSX';
  if (extState.marketError) market.append(el('p', 'muted pad', extState.marketError));
  for (const ext of extState.market) market.append(renderItem(ext, { installed: false }));
  $('#ext-more').classList.toggle('hidden', extState.market.length >= extState.marketTotal || !extState.market.length);
}

async function searchMarketplace(query, offset = 0) {
  const seq = ++extState.searchSeq;
  extState.query = query;
  if (!offset) {
    extState.market = [];
    extState.marketError = 'Buscando…';
    renderExtensions();
  }
  try {
    const res = await window.mini.invoke('mini:marketplace:search', query, offset);
    if (seq !== extState.searchSeq) return; // llegó una búsqueda más nueva
    extState.market = offset ? [...extState.market, ...res.results] : res.results;
    extState.marketTotal = res.total;
    extState.marketError = res.results.length || offset ? null : 'Sin resultados';
  } catch (err) {
    if (seq !== extState.searchSeq) return;
    extState.marketError = `No se pudo conectar con Open VSX: ${cleanError(err)}`;
  }
  renderExtensions();
}

async function installExtension(ext) {
  extState.busy.add(ext.id);
  renderExtensions();
  try {
    const res = await window.mini.invoke('mini:extensions:install', ext.namespace, ext.name);
    extState.installed = await window.mini.invoke('mini:extensions:installed');
    const local = installedById(res.id);
    const c = res.compatibility;
    if (c.level === 'none') {
      notify(`${res.displayName} se instaló, pero no aporta nada que Mini Code pueda usar (${c.unsupported.join(', ') || 'sin contribuciones compatibles'}).`, 'warning');
    } else if (local?.themes?.length) {
      const choice = await notify(`${res.displayName} instalada. Incluye ${local.themes.length} tema(s) de color.`, 'info', ['Elegir tema']);
      if (choice === 0) showThemePicker(local.id);
    } else {
      const extra = c.unsupported.length ? ` Partes no disponibles: ${c.unsupported.join(', ')}.` : '';
      notify(`${res.displayName} instalada. Sus comandos ya están en la paleta (Ctrl+Shift+P).${extra}`, c.level === 'full' ? 'info' : 'warning');
    }
  } catch (err) {
    notify(`No se pudo instalar ${ext.displayName}: ${cleanError(err)}`, 'error');
  } finally {
    extState.busy.delete(ext.id);
    renderExtensions();
  }
}

async function uninstallExtension(ext) {
  extState.busy.add(ext.id);
  renderExtensions();
  try {
    await window.mini.invoke('mini:extensions:uninstall', ext.id);
    extState.installed = await window.mini.invoke('mini:extensions:installed');
    if (currentThemeKey().startsWith(`${ext.id}|`)) await setTheme('builtin:dark');
    notify(`${ext.displayName} desinstalada.`);
  } catch (err) {
    notify(`No se pudo desinstalar ${ext.displayName}: ${cleanError(err)}`, 'error');
  } finally {
    extState.busy.delete(ext.id);
    renderExtensions();
  }
}

// ---- Temas de color --------------------------------------------------------------------
// Variables CSS del workbench ← colores de un tema de VS Code.
const CSS_FROM_THEME = {
  '--bg': ['editor.background'],
  '--sidebar': ['sideBar.background', 'editor.background'],
  '--activity': ['activityBar.background', 'sideBar.background'],
  '--activity-fg': ['activityBar.foreground'],
  '--tabs': ['editorGroupHeader.tabsBackground', 'sideBar.background'],
  '--tab-inactive': ['tab.inactiveBackground', 'editorGroupHeader.tabsBackground'],
  '--tab-active': ['tab.activeBackground', 'editor.background'],
  '--border': ['panel.border', 'editorGroup.border', 'sideBar.border', 'contrastBorder'],
  '--fg': ['foreground', 'editor.foreground', 'sideBar.foreground'],
  '--muted': ['descriptionForeground', 'tab.inactiveForeground'],
  '--accent': ['focusBorder', 'button.background', 'activityBarBadge.background'],
  '--hover': ['list.hoverBackground'],
  '--selected': ['list.inactiveSelectionBackground', 'list.hoverBackground'],
  '--focus': ['list.activeSelectionBackground', 'list.focusBackground'],
  '--input': ['input.background', 'dropdown.background'],
  '--status': ['statusBar.background'],
  '--status-fg': ['statusBar.foreground'],
  '--widget': ['quickInput.background', 'editorWidget.background', 'sideBar.background'],
  '--terminal-bg': ['terminal.background', 'panel.background', 'editor.background'],
  '--terminal-fg': ['terminal.foreground', 'editor.foreground'],
  '--terminal-selection': ['terminal.selectionBackground', 'editor.selectionBackground'],
};

// Tokens de Monaco ← ámbitos TextMate que usan los temas, de más a menos concreto.
const TOKEN_SCOPES = {
  comment: ['comment.line', 'comment'],
  string: ['string.quoted.double', 'string'],
  'string.escape': ['constant.character.escape'],
  regexp: ['string.regexp'],
  number: ['constant.numeric'],
  keyword: ['keyword.control', 'storage.type', 'keyword', 'storage'],
  'keyword.flow': ['keyword.control.flow', 'keyword.control'],
  operator: ['keyword.operator'],
  delimiter: ['punctuation', 'meta.brace'],
  type: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class'],
  'type.identifier': ['entity.name.type', 'entity.name.class', 'support.class'],
  identifier: ['variable.other.readwrite', 'variable.other', 'variable'],
  tag: ['entity.name.tag'],
  'attribute.name': ['entity.other.attribute-name'],
  'attribute.value': ['string.quoted.double', 'string'],
  'metatag': ['meta.tag', 'punctuation.definition.tag'],
  annotation: ['meta.decorator', 'storage.type.annotation'],
  constant: ['constant.language', 'constant'],
};

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function normalizeHex(c) {
  if (typeof c !== 'string' || !HEX.test(c)) return null;
  if (c.length === 4 || c.length === 5) return '#' + [...c.slice(1)].map((x) => x + x).join('');
  return c;
}

function themeRules(tokenColors) {
  // Lista plana [ámbito, ajustes] en orden; los posteriores pisan a los anteriores.
  const entries = [];
  for (const tc of tokenColors || []) {
    if (!tc?.settings) continue;
    const scopes = tc.scope == null ? [''] : Array.isArray(tc.scope) ? tc.scope : String(tc.scope).split(',');
    for (const s of scopes) {
      const scope = s.trim();
      if (!scope.includes(' ')) entries.push([scope, tc.settings]);
    }
  }
  const rules = [];
  for (const [token, candidates] of Object.entries(TOKEN_SCOPES)) {
    for (const representative of candidates) {
      let best = null;
      let bestLen = -1;
      for (const [scope, settings] of entries) {
        if (!scope) continue;
        const matches = representative === scope || representative.startsWith(scope + '.');
        if (matches && scope.length >= bestLen && (settings.foreground || settings.fontStyle !== undefined)) {
          best = settings;
          bestLen = scope.length;
        }
      }
      if (best) {
        const rule = { token };
        const fg = normalizeHex(best.foreground);
        if (fg) rule.foreground = fg.slice(1);
        if (typeof best.fontStyle === 'string') rule.fontStyle = best.fontStyle;
        rules.push(rule);
        break;
      }
    }
  }
  return rules;
}

function availableThemes() {
  const list = [
    { key: 'builtin:dark', label: 'Oscuro (Dark+)', description: 'Integrado' },
    { key: 'builtin:light', label: 'Claro (Light+)', description: 'Integrado' },
  ];
  for (const ext of extState.installed) {
    for (const t of ext.themes || []) list.push({ key: `${ext.id}|${t.path}`, label: t.label, description: ext.displayName, extId: ext.id, uiTheme: t.uiTheme, path: t.path });
  }
  return list;
}

function currentThemeKey() {
  return extState.themeKey || 'builtin:dark';
}

function clearThemeVars() {
  for (const v of Object.keys(CSS_FROM_THEME)) document.body.style.removeProperty(v);
}

function setKind(kind) {
  state.themeKind = kind;
  document.body.classList.toggle('theme-light', kind === 'light');
  document.body.classList.toggle('theme-dark', kind !== 'light');
}

async function setTheme(key, { quiet = false } = {}) {
  const theme = availableThemes().find((t) => t.key === key);
  try {
    if (!theme || theme.key.startsWith('builtin:')) {
      const light = theme?.key === 'builtin:light';
      clearThemeVars();
      setKind(light ? 'light' : 'dark');
      monaco.editor.setTheme(light ? 'vs' : 'vs-dark');
      key = light ? 'builtin:light' : 'builtin:dark';
    } else {
      const data = await window.mini.invoke('mini:themes:load', theme.extId, theme.path);
      const ui = theme.uiTheme || (data.type === 'light' ? 'vs' : 'vs-dark');
      const base = ['vs', 'vs-dark', 'hc-black', 'hc-light'].includes(ui) ? ui : 'vs-dark';
      const colors = {};
      for (const [k, v] of Object.entries(data.colors || {})) {
        const hex = normalizeHex(v);
        if (hex) colors[k] = hex;
      }
      monaco.editor.defineTheme('mini-extension-theme', { base, inherit: true, rules: themeRules(data.tokenColors), colors });
      monaco.editor.setTheme('mini-extension-theme');
      setKind(base === 'vs' || base === 'hc-light' ? 'light' : 'dark');
      clearThemeVars();
      for (const [cssVar, keys] of Object.entries(CSS_FROM_THEME)) {
        const value = keys.map((k) => colors[k]).find(Boolean);
        if (value) document.body.style.setProperty(cssVar, value);
      }
    }
    extState.themeKey = key;
    try {
      localStorage.setItem('mini.theme', key);
    } catch {}
    if (terminal.xterm) terminal.xterm.options.theme = terminalTheme();
  } catch (err) {
    if (!quiet) notify(`No se pudo aplicar el tema: ${cleanError(err)}`, 'error');
    if (key !== 'builtin:dark') await setTheme('builtin:dark', { quiet: true });
  }
}

async function showThemePicker(onlyExtId) {
  const list = availableThemes().filter((t) => !onlyExtId || t.extId === onlyExtId);
  const current = currentThemeKey();
  const res = await quickInput.show({
    placeholder: 'Selecciona un tema de color (instala más desde el panel de Extensiones)',
    items: async (q) =>
      list
        .map((t) => {
          const m = fuzzy(q, t.label);
          return m && { ...t, labelHtml: (t.key === current ? '● ' : '') + m.html, score: m.score };
        })
        .filter(Boolean),
  });
  if (res?.item) await setTheme(res.item.key);
}
