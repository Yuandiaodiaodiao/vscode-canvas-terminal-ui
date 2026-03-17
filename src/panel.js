const vscode = require('vscode');
const { getWebviewContent } = require('./webview');
const { getSharedState } = require('./shared-state');

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
    this.webviewId = 'panel_' + Date.now();

    this.panel.webview.html = getWebviewContent(this.panel.webview, context.extensionUri);

    const sharedState = getSharedState();
    sharedState.registerWebview(this.webviewId, panel.webview, 'panel');

    this.panel.webview.onDidReceiveMessage(
      (msg) => sharedState.handleMessage(msg, this.webviewId),
      null,
      context.subscriptions
    );

    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
  }

  readClipboardImage() {
    getSharedState().readClipboardImage(this.webviewId);
  }

  dispose() {
    TerminalCanvasPanel.currentPanel = undefined;
    getSharedState().unregisterWebview(this.webviewId);
    this.panel.dispose();
  }
}

module.exports = { TerminalCanvasPanel };
