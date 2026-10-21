const vscode = require('vscode');

function transformSelections(fn) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  if (editor.selections.every((s) => s.isEmpty)) {
    return vscode.window.showErrorMessage('Selecciona algo de texto primero');
  }
  return editor.edit((edit) => {
    for (const sel of editor.selections) edit.replace(sel, fn(editor.document.getText(sel)));
  });
}

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('textTools.upper', () => transformSelections((t) => t.toUpperCase()));
  register('textTools.lower', () => transformSelections((t) => t.toLowerCase()));

  register('textTools.wordCount', () => {
    const editor = vscode.window.activeTextEditor;
    const text = editor ? editor.document.getText() : '';
    const words = text.split(/\s+/).filter(Boolean).length;
    vscode.window.showInformationMessage(`${words} palabras · ${editor ? editor.document.lineCount : 0} líneas · ${text.length} caracteres`);
  });

  register('textTools.sortLines', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const order = await vscode.window.showQuickPick(['A → Z', 'Z → A'], { placeHolder: 'Orden' });
    if (!order) return;
    const lines = doc.getText().split(/\r?\n/).sort((a, b) => a.localeCompare(b));
    if (order === 'Z → A') lines.reverse();
    const all = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
    await editor.edit((edit) => edit.replace(all, lines.join(doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')));
  });
};
