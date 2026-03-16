const vscode = require('vscode');
const { TerminalCanvasPanel } = require('./panel');
const { getWebviewContent } = require('./webview');
const { TerminalManager } = require('./terminal-manager');

class SidebarProvider {
  constructor(context) {
    this.context = context;
    this.terminalManager = new TerminalManager();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    console.log('[TerminalCanvas] resolveWebviewView called');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this.context.extensionUri);

    this.terminalManager.setWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      console.log('[TerminalCanvas] sidebar received message:', msg.type, msg);
      if (msg.type === 'openInPanel') {
        TerminalCanvasPanel.createOrShow(this.context);
        return;
      }
      this.terminalManager.handleMessage(msg);
    });

    webviewView.onDidDispose(() => {
      this.terminalManager.dispose();
    });
  }
}

module.exports = { SidebarProvider };
