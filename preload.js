// Preload (equivale a out/vs/base/parts/sandbox/electron-browser/preload.js).
// Se ejecuta en el renderer aislado y expone un puente mínimo y validado
// como window.mini, del mismo modo que VS Code expone window.vscode.
const { contextBridge, ipcRenderer } = require('electron');

function validate(channel) {
  if (typeof channel !== 'string' || !channel.startsWith('mini:')) {
    throw new Error(`Canal IPC no permitido '${channel}'`);
  }
  return true;
}

contextBridge.exposeInMainWorld('mini', {
  invoke(channel, ...args) {
    validate(channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    validate(channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel, listener) {
    validate(channel);
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
