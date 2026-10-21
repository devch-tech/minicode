// Prueba de humo: arranca la app real con una carpeta de ejemplo, ejecuta
// acciones en la interfaz y guarda capturas en test/out/.
// Uso: npx electron test/smoke.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-code-smoke-'));
fs.mkdirSync(path.join(sample, 'src'));
fs.writeFileSync(path.join(sample, 'src', 'app.js'), 'function saludar(nombre) {\n  return `Hola, ${nombre}`;\n}\n\nconsole.log(saludar("mundo"));\n');
fs.writeFileSync(path.join(sample, 'README.md'), '# Proyecto de prueba\n\nuno dos tres\n');
fs.writeFileSync(path.join(sample, 'package.json'), '{\n  "name": "demo"\n}\n');

// Perfil y extensiones aislados para no tocar la instalación real.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mini-code-profile-')));
process.env.MINI_CODE_EXTENSIONS_DIR = path.join(app.getPath('userData'), 'extensions');

process.argv.push(sample);
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const progressFile = path.join(outDir, 'progress.log');
fs.writeFileSync(progressFile, '');
const progress = (line) => fs.appendFileSync(progressFile, line + '\n');
function check(name, ok, detail = '') {
  const line = `${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line);
  progress(line);
}

app.whenReady().then(async () => {
  await wait(500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const logs = [];
  wc.on('console-message', (e) => {
    logs.push(`[${e.level}] ${e.message}`);
    progress(`  consola [${e.level}] ${e.message}`);
  });
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG());

  try {
    await js(`new Promise(r => { const t = setInterval(() => { if (window.monaco && document.querySelector('#tree .row')) { clearInterval(t); r(); } }, 100); })`);
    check('Monaco cargado y explorador con archivos', true, await js(`[...document.querySelectorAll('#tree .row .label')].map(n => n.textContent).join(', ')`));

    // Expandir src y abrir app.js con un clic en el árbol
    await js(`[...document.querySelectorAll('#tree .row')].find(r => r.textContent.includes('src')).click()`);
    await wait(300);
    await js(`[...document.querySelectorAll('#tree .row')].find(r => r.textContent.includes('app.js')).click()`);
    await wait(500);
    const lang = await js(`monaco.editor.getModels()[0]?.getLanguageId()`);
    check('Abrir archivo desde el explorador', lang === 'javascript', `lenguaje=${lang}`);
    await shot('1-editor.png');

    // Editar y comprobar marca de "sin guardar"
    await js(`(() => { const m = monaco.editor.getModels()[0]; m.pushEditOperations([], [{ range: new monaco.Range(1,1,1,1), text: '// editado\\n' }], () => null); })()`);
    await wait(200);
    const dirty = await js(`document.querySelector('.tab.active').classList.contains('dirty')`);
    check('Pestaña marcada como modificada', dirty);

    // Guardar con Ctrl+S (por el sistema de atajos)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['control'] });
    await wait(500);
    const saved = fs.readFileSync(path.join(sample, 'src', 'app.js'), 'utf8').startsWith('// editado');
    check('Ctrl+S guarda en disco', saved);

    // Paleta de comandos
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'p', modifiers: ['control', 'shift'] });
    await wait(300);
    await js(`(() => { const i = document.querySelector('#quick-input-box'); i.value = '>contar'; i.dispatchEvent(new Event('input')); })()`);
    await wait(300);
    const paletteItems = await js(`[...document.querySelectorAll('.qi-item .label')].map(n => n.textContent)`);
    check('Paleta muestra comandos de extensión', paletteItems.some((t) => /contar palabras/i.test(t)), paletteItems.join(' | '));
    await shot('2-paleta.png');
    await js(`document.querySelector('#quick-input-box').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    await wait(600);
    const toast = await js(`document.querySelector('.toast')?.textContent || ''`);
    check('Extensión ejecutada en su proceso y respuesta mostrada', /palabras/.test(toast), toast);

    // Extensión que modifica el texto: seleccionar y pasar a mayúsculas
    // (con el atajo que declara la propia extensión, Ctrl+Shift+U)
    await js(`(() => { const ed = monaco.editor.getEditors()[0]; ed.focus(); ed.setSelection(new monaco.Range(2, 10, 2, 17)); })()`);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'u', modifiers: ['control', 'shift'] });
    await wait(800);
    const line2 = await js(`monaco.editor.getEditors()[0].getModel().getLineContent(2)`);
    check('Extensión edita el texto vía API vscode (atajo de la extensión)', line2.includes('SALUDAR'), line2);
    await js(`monaco.editor.getEditors()[0].trigger('test', 'undo')`);

    // Ir a archivo (Ctrl+P)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'p', modifiers: ['control'] });
    await wait(300);
    await js(`(() => { const i = document.querySelector('#quick-input-box'); i.value = 'readme'; i.dispatchEvent(new Event('input')); })()`);
    await wait(500);
    await js(`document.querySelector('#quick-input-box').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    await wait(500);
    const tabs = await js(`[...document.querySelectorAll('.tab .label')].map(n => n.textContent)`);
    check('Ctrl+P abre README.md', tabs.includes('README.md'), tabs.join(', '));

    // Búsqueda en archivos
    await js(`document.querySelector('[data-view=search]').click()`);
    await js(`(() => { const i = document.querySelector('#search-input'); i.value = 'saludar'; i.dispatchEvent(new Event('input')); })()`);
    await wait(1200);
    const summary = await js(`document.querySelector('#search-summary').textContent`);
    check('Búsqueda en archivos', /resultados/.test(summary), summary);
    await shot('3-busqueda.png');

    // Archivo creado fuera del editor aparece gracias al watcher
    await js(`document.querySelector('[data-view=explorer]').click()`);
    fs.writeFileSync(path.join(sample, 'nuevo.txt'), 'creado desde fuera');
    await wait(1500);
    const hasNew = await js(`[...document.querySelectorAll('#tree .label')].some(n => n.textContent === 'nuevo.txt')`);
    check('El watcher refresca el explorador', hasNew);

    // Terminal
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'j', modifiers: ['control'] });
    await wait(2500);
    for (const ch of 'echo hola-terminal') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
      wc.sendInputEvent({ type: 'char', keyCode: ch });
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await wait(20);
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait(2500);
    const termText = await js(`[...document.querySelectorAll('#terminal .xterm-rows > div')].map(d => d.textContent).join('\\n')`);
    check('Terminal ejecuta comandos', /^hola-terminal$/m.test(termText), termText.split('\n').filter((l) => l.trim()).slice(-3).join(' / '));
    await shot('4-terminal.png');
  } catch (err) {
    check('Excepción en la prueba', false, err.stack);
  }

  const errors = logs.filter((l) => l.startsWith('[error]'));
  check('Sin errores en consola', errors.length === 0, errors.slice(0, 5).join(' || '));
  fs.writeFileSync(path.join(outDir, 'results.txt'), results.join('\n') + '\n\nCONSOLA:\n' + logs.join('\n'));
  console.log(results.join('\n'));
  try { fs.rmSync(sample, { recursive: true, force: true }); } catch {}
  app.exit(0);
});
