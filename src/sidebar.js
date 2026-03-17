const vscode = require('vscode');
const { TerminalCanvasPanel } = require('./panel');
const { getWebviewContent } = require('./webview');
const { getSharedState } = require('./shared-state');

class SidebarProvider {
  constructor(context) {
    this.context = context;
    this.webviewId = 'sidebar_' + Date.now();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    console.log('[TerminalCanvas] resolveWebviewView called');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this.context.extensionUri);

    const sharedState = getSharedState();
    sharedState.registerWebview(this.webviewId, webviewView.webview, 'sidebar');

    webviewView.webview.onDidReceiveMessage((msg) => {
      console.log('[TerminalCanvas] sidebar received message:', msg.type, msg);
      if (msg.type === 'openInPanel') {
        TerminalCanvasPanel.createOrShow(this.context);
        return;
      }
      sharedState.handleMessage(msg, this.webviewId);
    });

    webviewView.onDidDispose(() => {
      getSharedState().unregisterWebview(this.webviewId);
    });
  }
}

module.exports = { SidebarProvider };
