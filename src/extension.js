const vscode = require('vscode');
const { TerminalCanvasPanel } = require('./panel');
const { SidebarProvider } = require('./sidebar');

function activate(context) {
  const sidebarProvider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('terminalCanvas.view', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const openCommand = vscode.commands.registerCommand('terminalCanvas.open', () => {
    TerminalCanvasPanel.createOrShow(context);
  });

  const pasteImageCommand = vscode.commands.registerCommand('terminalCanvas.pasteImage', () => {
    if (TerminalCanvasPanel.currentPanel) {
      TerminalCanvasPanel.currentPanel.readClipboardImage();
    }
  });

  context.subscriptions.push(openCommand, pasteImageCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
