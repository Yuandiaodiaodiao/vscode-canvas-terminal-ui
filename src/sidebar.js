const vscode = require('vscode');
const { TerminalCanvasPanel } = require('./panel');

class SidebarProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'openCanvas') {
        TerminalCanvasPanel.createOrShow(this.context);
      }
    });
  }

  getHtml() {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      padding: 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 8px 12px;
      margin-bottom: 10px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
      margin-top: 8px;
    }
    kbd {
      display: inline-block;
      padding: 1px 5px;
      font-size: 11px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
  </style>
</head>
<body>
  <button class="btn" id="open">Open Terminal Canvas</button>
  <div class="desc">
    Create a free-form canvas with multiple terminal windows you can drag, resize, and zoom.
    <br><br>
    Shortcut: <kbd>Cmd+Shift+T</kbd>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => {
      vscode.postMessage({ type: 'openCanvas' });
    });
  </script>
</body>
</html>`;
  }
}

module.exports = { SidebarProvider };
