// Prueba del marketplace contra Open VSX real: buscar, instalar una extensión
// de comandos y un tema, usarlos y desinstalar. Necesita conexión a internet.
// Uso: npx electron test/marketplace.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-code-market-'));
fs.writeFileSync(path.join(sample, 'case.txt'), 'hola mundo bonito\n');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mini-code-profile-')));
process.env.MINI_CODE_EXTENSIONS_DIR = path.join(app.getPath('userData'), 'extensions');
process.argv.push(sample);
require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const progressFile = path.join(outDir, 'marketplace.log');
fs.writeFileSync(progressFile, '');
const progress = (line) => fs.appendFileSync(progressFile, line + '\n');
function check(name, ok, detail = '') {
  const line = `${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line);
  progress(line);
}

app.whenReady().then(async () => {
  await wait(500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const logs = [];
  wc.on('console-message', (e) => {
    logs.push(`[${e.level}] ${e.message}`);
    progress(`  consola [${e.level}] ${e.message}`);
  });
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG());
  const until = async (expr, timeout = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await js(expr)) return true;
      await wait(250);
    }
    return false;
  };
  const clickInstall = (id) =>
    js(`(() => {
      const b = [...document.querySelectorAll('#ext-market .ext-item[data-id="${id}"] .ext-button')].find(b => b.textContent === 'Instalar');
      if (b) b.click();
      return !!b;
    })()`);
  const search = async (q) => {
    await js(`(() => { const i = document.querySelector('#ext-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
    return until(`extState.query === ${JSON.stringify(q)} && extState.market.length > 0 && extState.marketError === null`, 20000);
  };

  try {
    await until(`window.monaco && document.querySelector('#tree .row')`);

    // Panel de extensiones: populares
    await js(`document.querySelector('[data-view=extensions]').click()`);
    const popular = await until(`document.querySelectorAll('#ext-market .ext-item').length >= 10`, 20000);
    check('Panel muestra populares de Open VSX', popular, await js(`[...document.querySelectorAll('#ext-market .ext-name')].slice(0,5).map(n=>n.textContent).join(', ')`));

    // Buscar e instalar una extensión de comandos real
    check('Búsqueda "change case"', await search('change case'));
    await shot('5-marketplace-busqueda.png');
    const names = await js(`[...document.querySelectorAll('#ext-market .ext-item')].map(i => i.dataset.id)`);
    progress('  resultados: ' + names.slice(0, 8).join(' | '));
    const wanted = names.includes('wmaurer.change-case');
    check('Encontrada wmaurer.change-case en resultados', wanted, names.slice(0, 8).join(' | '));
    if (wanted) {
      await clickInstall('wmaurer.change-case');
      const installed = await until(`!!document.querySelector('#ext-installed .ext-item[data-id="wmaurer.change-case"]')`, 90000);
      const badge = await js(`document.querySelector('#ext-installed .ext-item[data-id="wmaurer.change-case"] .badge')?.textContent`);
      check('Instalación (descarga + SHA-256 + extracción)', installed, `compatibilidad: ${badge}`);

      // Usar uno de sus comandos sobre una selección
      await js(`(() => { const r = [...document.querySelectorAll('[data-view=explorer]')][0]; r.click(); })()`);
      await js(`[...document.querySelectorAll('#tree .row')].find(r => r.textContent.includes('case.txt')).click()`);
      await until(`monaco.editor.getEditors()[0].getModel()?.getValue().startsWith('hola')`, 5000);
      await js(`(() => { const ed = monaco.editor.getEditors()[0]; ed.setSelection(new monaco.Range(1, 1, 1, 18)); })()`);
      const cmds = await js(`state.extensionCommands.filter(c => /snake/i.test(c.id)).map(c => c.id + ' = ' + c.title)`);
      progress('  comandos snake: ' + cmds.join(' | '));
      const snakeId = cmds[0]?.split(' = ')[0];
      if (snakeId) {
        await js(`executeCommand(${JSON.stringify(snakeId)})`);
        await wait(1500);
      }
      const text = await js(`monaco.editor.getEditors()[0].getModel().getLineContent(1)`);
      check('Comando real de la extensión transforma el texto', text === 'hola_mundo_bonito', `${snakeId} → "${text}"`);
    }

    // Instalar un tema real y aplicarlo
    await js(`document.querySelector('[data-view=extensions]').click()`);
    check('Búsqueda "dracula"', await search('dracula'));
    check('Botón Instalar de Dracula', await clickInstall('dracula-theme.theme-dracula'));
    const themeInstalled = await until(`extState.installed.some(e => e.id === 'dracula-theme.theme-dracula')`, 90000);
    check('Tema Dracula instalado', themeInstalled);
    await wait(500);
    const toast = await js(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
    progress('  avisos: ' + toast);
    await js(`[...document.querySelectorAll('.toast-buttons button')].find(b => b.textContent === 'Elegir tema')?.click()`);
    await wait(300);
    const themeLabels = await js(`[...document.querySelectorAll('.qi-item .label')].map(n => n.textContent)`);
    progress('  temas: ' + themeLabels.join(' | '));
    await js(`(() => { const i = document.querySelector('#quick-input-box'); i.value = 'Dracula'; i.dispatchEvent(new Event('input')); })()`);
    await wait(200);
    await js(`document.querySelector('#quick-input-box').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    await wait(1000);
    const bg = await js(`getComputedStyle(document.body).getPropertyValue('--bg').trim()`);
    const editorBg = await js(`getComputedStyle(document.querySelector('.monaco-editor-background')).backgroundColor`);
    check('Tema aplicado al workbench y al editor', /282a36/i.test(bg) && editorBg === 'rgb(40, 42, 54)', `--bg=${bg}, editor=${editorBg}`);
    await js(`document.querySelector('[data-view=extensions]').click(); document.querySelector('[data-view=extensions]').click();`);
    await wait(300);
    await shot('6-tema-dracula.png');

    // Desinstalar la extensión de comandos (con el buscador vacío se ven todas las instaladas)
    await js(`(() => { const i = document.querySelector('#ext-search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await until(`extState.query === '' && extState.marketError === null`, 20000);
    await js(`[...document.querySelectorAll('#ext-installed .ext-item[data-id="wmaurer.change-case"] .ext-button')].find(b => b.textContent === 'Desinstalar')?.click()`);
    const gone = await until(`!extState.installed.some(e => e.id.startsWith('wmaurer.')) && !state.extensionCommands.some(c => /changeCase/i.test(c.id))`, 20000);
    check('Desinstalar quita la extensión y sus comandos', gone);
  } catch (err) {
    check('Excepción en la prueba', false, err.stack);
  }

  const errors = logs.filter((l) => l.startsWith('[error]'));
  check('Sin errores en consola', errors.length === 0, errors.slice(0, 5).join(' || '));
  console.log(results.join('\n'));
  try { fs.rmSync(sample, { recursive: true, force: true }); } catch {}
  app.exit(0);
});
