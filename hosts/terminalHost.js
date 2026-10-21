// Host de terminal (equivale a out/vs/platform/terminal/node/ptyHostMain.js).
// VS Code usa node-pty para una pseudo-terminal real; aquí se usa un shell con
// tuberías para no depender de módulos nativos. La edición de línea la hace
// el renderer y este proceso solo ejecuta líneas completas.
const { spawn } = require('node:child_process');

const port = process.parentPort;
let shell = null;

function post(msg) {
  port.postMessage(msg);
}

function promptCommand() {
  return process.platform === 'win32'
    ? '[Console]::Out.Write("PS " + (Get-Location).Path + "> ")\n'
    : 'printf "%s$ " "$PWD"\n';
}

function start(cwd) {
  if (shell) return;
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const args = isWin ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'] : ['-s'];
  shell = spawn(cmd, args, { cwd, env: process.env, windowsHide: true });
  shell.stdout.setEncoding('utf8');
  shell.stderr.setEncoding('utf8');
  shell.stdout.on('data', (data) => post({ type: 'data', data }));
  shell.stderr.on('data', (data) => post({ type: 'data', data: `\x1b[31m${data}\x1b[0m` }));
  shell.on('exit', (code) => {
    shell = null;
    post({ type: 'exit', code });
  });
  if (isWin) shell.stdin.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n');
  shell.stdin.write(promptCommand());
}

port.on('message', ({ data: msg }) => {
  if (msg.type === 'start') start(msg.cwd);
  if (msg.type === 'input' && shell) {
    shell.stdin.write(msg.data + '\n');
    shell.stdin.write(promptCommand());
  }
});
