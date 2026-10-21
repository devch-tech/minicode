// Marketplace de extensiones (equivale a la galería de VS Code en
// vs/platform/extensionManagement). Usa Open VSX, el catálogo abierto que usan
// VSCodium, Cursor o Gitpod: el Marketplace de Microsoft solo permite su uso
// desde productos de Microsoft.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const API = 'https://open-vsx.org/api';
const MAX_VSIX_BYTES = 200 * 1024 * 1024;

// Contribuciones que Mini Code sabe usar y las que ignora.
const SUPPORTED = { commands: 'comandos', themes: 'temas de color', keybindings: 'atajos', configuration: 'ajustes' };
const UNSUPPORTED = {
  languages: 'lenguajes',
  grammars: 'gramáticas de resaltado',
  snippets: 'fragmentos',
  debuggers: 'depurador',
  views: 'vistas propias',
  viewsContainers: 'paneles propios',
  customEditors: 'editores personalizados',
  notebooks: 'notebooks',
  iconThemes: 'temas de iconos',
  productIconThemes: 'iconos del producto',
  taskDefinitions: 'tareas',
  jsonValidation: 'validación JSON',
  terminal: 'perfiles de terminal',
  walkthroughs: 'guías',
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open VSX respondió ${res.status} para ${url}`);
  return res.json();
}

function summarize(e) {
  return {
    id: `${e.namespace}.${e.name}`.toLowerCase(),
    namespace: e.namespace,
    name: e.name,
    displayName: e.displayName || e.name,
    description: e.description || '',
    version: e.version,
    downloadCount: e.downloadCount || 0,
    verified: !!e.verified,
    icon: e.files?.icon || null,
    url: `https://open-vsx.org/extension/${e.namespace}/${e.name}`,
  };
}

async function search(query, offset = 0) {
  const params = new URLSearchParams({ size: '30', offset: String(offset) });
  if (query) params.set('query', query);
  else {
    params.set('sortBy', 'downloadCount');
    params.set('sortOrder', 'desc');
  }
  const data = await getJson(`${API}/-/search?${params}`);
  return { total: data.totalSize, results: data.extensions.filter((e) => !e.deprecated).map(summarize) };
}

// ---- JSON con comentarios (package.json de temas, archivos de tema) ----------
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^﻿/, ''));
}

// Sustituye los "%clave%" del manifiesto por los textos de package.nls.json.
function localize(value, nls) {
  if (typeof value === 'string') {
    const m = /^%(.+)%$/.exec(value);
    if (!m) return value;
    const entry = nls[m[1]];
    return typeof entry === 'string' ? entry : entry?.message ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => localize(v, nls));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = localize(v, nls);
    return out;
  }
  return value;
}

function readManifest(dir) {
  const manifest = parseJsonc(fsSync.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let nls = {};
  for (const name of ['package.nls.es.json', 'package.nls.json']) {
    const file = path.join(dir, name);
    if (fsSync.existsSync(file)) {
      try {
        nls = { ...parseJsonc(fsSync.readFileSync(file, 'utf8')), ...nls };
      } catch {}
    }
  }
  return localize(manifest, nls);
}

function analyze(manifest) {
  const contributes = manifest.contributes || {};
  const supported = [];
  const unsupported = [];
  if (manifest.main) supported.push('código de extensión');
  for (const key of Object.keys(contributes)) {
    if (SUPPORTED[key] && (key !== 'commands' || manifest.main)) supported.push(SUPPORTED[key]);
    if (UNSUPPORTED[key]) unsupported.push(UNSUPPORTED[key]);
  }
  if (!manifest.main && manifest.browser) unsupported.push('versión solo para navegador');
  if (manifest.extensionPack?.length) unsupported.push('paquete de extensiones');
  const useful = manifest.main || contributes.themes?.length;
  const level = !useful ? 'none' : unsupported.length ? 'partial' : 'full';
  return { level, supported: [...new Set(supported)], unsupported: [...new Set(unsupported)] };
}

// ---- Extensiones instaladas -------------------------------------------------
function listInstalled(builtinDir, userDir) {
  const result = [];
  for (const [dir, builtin] of [[builtinDir, true], [userDir, false]]) {
    if (!fsSync.existsSync(dir)) continue;
    for (const folder of fsSync.readdirSync(dir)) {
      const extDir = path.join(dir, folder);
      if (!fsSync.existsSync(path.join(extDir, 'package.json'))) continue;
      try {
        const manifest = readManifest(extDir);
        const id = `${manifest.publisher || 'mini'}.${manifest.name}`.toLowerCase();
        let icon = null;
        if (manifest.icon) {
          const iconPath = path.join(extDir, manifest.icon);
          if (iconPath.startsWith(extDir) && fsSync.existsSync(iconPath) && fsSync.statSync(iconPath).size < 512 * 1024) {
            const ext = path.extname(iconPath).slice(1).toLowerCase();
            const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            icon = `data:${mime};base64,${fsSync.readFileSync(iconPath).toString('base64')}`;
          }
        }
        result.push({
          id,
          dir: extDir,
          builtin,
          manifest,
          displayName: manifest.displayName || manifest.name,
          description: manifest.description || '',
          version: manifest.version,
          publisher: manifest.publisher || 'mini',
          icon,
          compatibility: analyze(manifest),
        });
      } catch (err) {
        console.error(`No se pudo leer la extensión en ${extDir}: ${err.message}`);
      }
    }
  }
  return result;
}

// ---- Instalación --------------------------------------------------------------
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga fallida (${res.status})`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_VSIX_BYTES) throw new Error('La extensión es demasiado grande');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_VSIX_BYTES) throw new Error('La extensión es demasiado grande');
  return buf;
}

async function install(namespace, name, userDir) {
  const meta = await getJson(`${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
  if (!meta.files?.download) throw new Error('Open VSX no ofrece descarga para esta extensión');
  const vsix = await download(meta.files.download);

  // Comprobar la huella SHA-256 que publica Open VSX.
  if (meta.files.sha256) {
    const expected = (await (await fetch(meta.files.sha256)).text()).trim().split(/\s+/)[0].toLowerCase();
    const actual = crypto.createHash('sha256').update(vsix).digest('hex');
    if (expected && expected !== actual) throw new Error('La huella SHA-256 no coincide; se canceló la instalación');
  }

  const id = `${meta.namespace}.${meta.name}`.toLowerCase();
  const target = path.join(userDir, `${id}-${meta.version}`);
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  // Un .vsix es un zip; el contenido de la extensión está bajo "extension/".
  const zip = new AdmZip(vsix);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('extension/')) continue;
    const rel = entry.entryName.slice('extension/'.length);
    const dest = path.resolve(tmp, rel);
    if (!dest.startsWith(path.resolve(tmp) + path.sep)) continue; // evita rutas que salgan de la carpeta
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, entry.getData());
  }
  if (!fsSync.existsSync(path.join(tmp, 'package.json'))) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error('El paquete no contiene package.json');
  }

  // Quitar versiones anteriores de la misma extensión y mover la nueva a su sitio.
  await removeInstalled(id, userDir);
  await fs.rename(tmp, target);
  const manifest = readManifest(target);
  return { id, version: meta.version, displayName: manifest.displayName || manifest.name, compatibility: analyze(manifest), manifest };
}

async function removeInstalled(id, userDir) {
  if (!fsSync.existsSync(userDir)) return;
  for (const folder of await fs.readdir(userDir)) {
    if (folder.toLowerCase().startsWith(`${id}-`) && !folder.includes('.tmp-')) {
      await fs.rm(path.join(userDir, folder), { recursive: true, force: true });
    }
  }
}

// ---- Temas de color ---------------------------------------------------------
function loadTheme(extDir, relPath) {
  const seen = new Set();
  const read = (file) => {
    const resolved = path.resolve(extDir, file);
    if (!resolved.startsWith(path.resolve(extDir) + path.sep)) throw new Error('Ruta de tema no válida');
    if (seen.has(resolved)) return { colors: {}, tokenColors: [] };
    seen.add(resolved);
    if (!resolved.endsWith('.json')) throw new Error('Solo se admiten temas en formato JSON');
    const theme = parseJsonc(fsSync.readFileSync(resolved, 'utf8'));
    let base = { colors: {}, tokenColors: [] };
    if (theme.include) base = read(path.join(path.dirname(path.relative(extDir, resolved)), theme.include));
    const tokenColors = Array.isArray(theme.tokenColors) ? theme.tokenColors : [];
    return {
      type: theme.type || base.type,
      colors: { ...base.colors, ...(theme.colors || {}) },
      tokenColors: [...base.tokenColors, ...tokenColors],
    };
  };
  return read(relPath);
}

module.exports = { search, install, removeInstalled, listInstalled, loadTheme, analyze };
