const vscode = require('vscode');
const { TerminalCanvasPanel } = require('./panel');
const { SidebarProvider } = require('./sidebar');
const { getSharedState } = require('./shared-state');

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
    const sharedState = getSharedState();
    // Send to panel if it exists, otherwise sidebar
    if (TerminalCanvasPanel.currentPanel) {
      sharedState.readClipboardImage(TerminalCanvasPanel.currentPanel.webviewId);
    } else if (sidebarProvider.webviewId) {
      sharedState.readClipboardImage(sidebarProvider.webviewId);
    }
  });

  context.subscriptions.push(openCommand, pasteImageCommand);
}

function deactivate() {
  getSharedState().dispose();
}

module.exports = { activate, deactivate };
