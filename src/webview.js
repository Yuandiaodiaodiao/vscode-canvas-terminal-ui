function getWebviewContent(webview, extensionUri) {
  const vscode = require('vscode');
  const nonce = getNonce();

  // xterm URIs
  const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'xterm', 'xterm.css'));
  const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'xterm', 'xterm.js'));
  const xtermFitJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'xterm', 'xterm-addon-fit.js'));

  // Canvas module URIs
  const stylesCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'styles.css'));
  const canvasCoreJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'canvas-core.js'));
  const windowBaseJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'window-base.js'));
  const terminalWindowJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'terminal-window.js'));
  const imageWindowJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'image-window.js'));
  const browserWindowJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'browser-window.js'));
  const syncHandlerJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'sync-handler.js'));
  const initJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'canvas', 'init.js'));

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' ${webview.cspSource} https://cdn.jsdelivr.net; font-src ${webview.cspSource} https://cdn.jsdelivr.net data:; connect-src https://cdn.jsdelivr.net; img-src blob: data:; frame-src https: http:;">
  <title>Terminal Canvas</title>
  <link rel="stylesheet" href="${stylesCssUri}">
</head>
<body>
  <div id="toolbar">
    <button id="btn-add">+ Terminal</button>
    <div class="separator"></div>
    <div style="position:relative">
      <button id="btn-layout" class="secondary">Layout</button>
    </div>
    <div class="separator"></div>
    <button id="btn-zoom-out" class="secondary">-</button>
    <span class="zoom-display" id="zoom-display">100%</span>
    <button id="btn-zoom-in" class="secondary">+</button>
    <button id="btn-zoom-fit" class="secondary">Fit</button>
    <div class="separator"></div>
    <button id="btn-snap" class="secondary" title="Toggle grid snap">Grid</button>
    <button id="btn-overlap" class="secondary" title="Toggle overlap prevention">No Overlap</button>
    <div class="spacer"></div>
    <span class="hint">拖拽平移 | 滚轮上下 | Shift+滚轮左右 | Cmd/Ctrl+滚轮缩放 | Ctrl+V 粘贴图片/网页</span>
    <button id="btn-pop-out" class="secondary" title="Open in separate panel" style="font-size:14px;padding:4px 6px;">&#8599;</button>
  </div>

  <svg id="grid-bg">
    <defs>
      <pattern id="grid-small" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" stroke-width="0.5"/>
      </pattern>
      <pattern id="grid-large" width="100" height="100" patternUnits="userSpaceOnUse">
        <rect width="100" height="100" fill="url(#grid-small)"/>
        <path d="M 100 0 L 0 0 0 100" fill="none" stroke="currentColor" stroke-width="1"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#grid-large)"/>
  </svg>

  <div id="canvas-viewport" tabindex="0" aria-label="Terminal Canvas">
    <div id="canvas"></div>
  </div>

  <div id="minimap">
    <div class="minimap-viewport" id="minimap-viewport"></div>
  </div>

  <script nonce="${nonce}">
    window.__CANVAS_CONFIG = {
      xtermCssUri: '${xtermCssUri}',
      xtermJsUri: '${xtermJsUri}',
      xtermFitJsUri: '${xtermFitJsUri}',
      nonce: '${nonce}'
    };
  </script>
  <script nonce="${nonce}" src="${canvasCoreJsUri}"></script>
  <script nonce="${nonce}" src="${windowBaseJsUri}"></script>
  <script nonce="${nonce}" src="${terminalWindowJsUri}"></script>
  <script nonce="${nonce}" src="${imageWindowJsUri}"></script>
  <script nonce="${nonce}" src="${browserWindowJsUri}"></script>
  <script nonce="${nonce}" src="${syncHandlerJsUri}"></script>
  <script nonce="${nonce}" src="${initJsUri}"></script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = { getWebviewContent };
