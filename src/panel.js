const vscode = require('vscode');
const os = require('os');
const { getWebviewContent } = require('./webview');

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
    this.terminals = new Map(); // id -> { ptyProcess }

    this.panel.webview.html = getWebviewContent(this.panel.webview, context.extensionUri);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      context.subscriptions
    );

    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'createTerminal':
        this.createTerminal(msg.id, msg.cols, msg.rows);
        break;
      case 'input':
        this.sendInput(msg.id, msg.data);
        break;
      case 'resize':
        this.resizeTerminal(msg.id, msg.cols, msg.rows);
        break;
      case 'closeTerminal':
        this.closeTerminal(msg.id);
        break;
    }
  }

  createTerminal(id, cols, rows) {
    let nodePty;
    try {
      nodePty = require('node-pty');
    } catch (e) {
      // node-pty is bundled with VSCode, try to load from there
      const appRoot = vscode.env.appRoot;
      const paths = [
        `${appRoot}/node_modules.asar.unpacked/node-pty`,
        `${appRoot}/node_modules/node-pty`,
      ];
      for (const p of paths) {
        try { nodePty = require(p); break; } catch (_) {}
      }
      if (!nodePty) {
        this.panel.webview.postMessage({
          type: 'error', id,
          message: 'Failed to load node-pty. Terminal cannot start.',
        });
        return;
      }
    }

    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

    const env = { ...process.env };
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';

    const ptyProcess = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });

    this.terminals.set(id, { ptyProcess });

    ptyProcess.onData((data) => {
      if (this.panel?.webview) {
        this.panel.webview.postMessage({ type: 'output', id, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      if (this.panel?.webview) {
        this.panel.webview.postMessage({ type: 'terminated', id, exitCode });
      }
    });
  }

  sendInput(id, data) {
    const entry = this.terminals.get(id);
    if (entry?.ptyProcess) {
      entry.ptyProcess.write(data);
    }
  }

  resizeTerminal(id, cols, rows) {
    const entry = this.terminals.get(id);
    if (entry?.ptyProcess) {
      try {
        entry.ptyProcess.resize(cols, rows);
      } catch (e) {
        // Ignore resize errors
      }
    }
  }

  closeTerminal(id) {
    const entry = this.terminals.get(id);
    if (entry?.ptyProcess) {
      entry.ptyProcess.kill();
    }
    this.terminals.delete(id);
  }

  dispose() {
    TerminalCanvasPanel.currentPanel = undefined;
    for (const [, entry] of this.terminals) {
      if (entry.ptyProcess) entry.ptyProcess.kill();
    }
    this.terminals.clear();
    this.panel.dispose();
  }
}

module.exports = { TerminalCanvasPanel };
