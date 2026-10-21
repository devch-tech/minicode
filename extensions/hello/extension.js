const vscode = require('vscode');

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand('hello.world', () => {
      const editor = vscode.window.activeTextEditor;
      const file = editor ? ` Estás editando ${vscode.workspace.asRelativePath(editor.document.uri)}.` : '';
      vscode.window.showInformationMessage(`¡Hola desde una extensión!${file}`);
    }),
  );
};
