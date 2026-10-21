// Vigilante de archivos (equivale a out/vs/platform/files/node/watcher/watcherMain.js).
// Agrupa los cambios durante 150 ms y avisa al proceso principal.
const fs = require('node:fs');
const path = require('node:path');

const port = process.parentPort;
const IGNORED = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
let watcher = null;
let pending = new Set();
let timer = null;

function flush() {
  timer = null;
  port.postMessage({ type: 'changed', paths: [...pending] });
  pending = new Set();
}

port.on('message', ({ data: msg }) => {
  if (msg.type !== 'watch') return;
  watcher?.close();
  watcher = fs.watch(msg.root, { recursive: true }, (_event, file) => {
    if (!file || IGNORED.test(file)) return;
    pending.add(path.join(msg.root, file));
    if (!timer) timer = setTimeout(flush, 150);
  });
  watcher.on('error', () => {});
});
