const vscode = require('vscode');
const { TerminalCanvasPanel } = require('./panel');
const { SidebarProvider } = require('./sidebar');

function activate(context) {
  const sidebarProvider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('terminalCanvas.view', sidebarProvider)
  );

  const openCommand = vscode.commands.registerCommand('terminalCanvas.open', () => {
    TerminalCanvasPanel.createOrShow(context);
  });

  context.subscriptions.push(openCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
