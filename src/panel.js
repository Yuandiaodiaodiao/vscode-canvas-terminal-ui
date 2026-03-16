const vscode = require('vscode');
const { getWebviewContent } = require('./webview');
const { TerminalManager } = require('./terminal-manager');

class TerminalCanvasPanel {
  static currentPanel = undefined;

  static createOrShow(context) {
    const column = vscode.ViewColumn.One;

    if (TerminalCanvasPanel.currentPanel) {
      TerminalCanvasPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'terminalCanvas',
      'Terminal Canvas',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );

    TerminalCanvasPanel.currentPanel = new TerminalCanvasPanel(panel, context);
  }

  constructor(panel, context) {
    this.panel = panel;
    this.context = context;
    this.terminalManager = new TerminalManager();
    this.terminalManager.setWebview(panel.webview);

    this.panel.webview.html = getWebviewContent(this.panel.webview, context.extensionUri);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.terminalManager.handleMessage(msg),
      null,
      context.subscriptions
    );

    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
  }

  readClipboardImage() {
    this.terminalManager.readClipboardImage();
  }

  dispose() {
    TerminalCanvasPanel.currentPanel = undefined;
    this.terminalManager.dispose();
    this.panel.dispose();
  }
}

module.exports = { TerminalCanvasPanel };
