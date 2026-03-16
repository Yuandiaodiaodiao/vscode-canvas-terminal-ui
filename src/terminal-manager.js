const vscode = require('vscode');
const os = require('os');

class TerminalManager {
  constructor() {
    this.terminals = new Map(); // id -> { ptyProcess }
    this.webview = null; // set by caller
  }

  setWebview(webview) {
    this.webview = webview;
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'createTerminal':
        this.createTerminal(msg.id, msg.cols, msg.rows);
        break;
      case 'requestPasteData':
        this.readClipboardImage();
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
      const appRoot = vscode.env.appRoot;
      const paths = [
        `${appRoot}/node_modules.asar.unpacked/node-pty`,
        `${appRoot}/node_modules/node-pty`,
      ];
      for (const p of paths) {
        try { nodePty = require(p); break; } catch (_) {}
      }
      if (!nodePty) {
        this.postMessage({
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
      this.postMessage({ type: 'output', id, data });
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      this.postMessage({ type: 'terminated', id, exitCode });
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

  async readClipboardImage() {
    // Read clipboard and send everything to webview in one message.
    // Webview decides what to do based on mouse position.

    // Try to read image first
    let imageData = null, imageWidth = 0, imageHeight = 0;

    // Strategy 1: electron clipboard
    try {
      const electron = require('electron');
      const clipboard = electron.clipboard;
      if (clipboard) {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) {
          const size = img.getSize();
          const png = img.toPNG();
          imageData = 'data:image/png;base64,' + png.toString('base64');
          imageWidth = size.width;
          imageHeight = size.height;
        }
      }
    } catch (e) {
      console.log('[TerminalCanvas] electron clipboard failed:', e.message);
    }

    // Strategy 2: macOS
    if (!imageData && os.platform() === 'darwin') {
      try {
        const path = require('path');
        const fs = require('fs');
        const { execSync } = require('child_process');
        const tmpFile = path.join(os.tmpdir(), 'vscode-tc-paste-' + Date.now() + '.png');
        execSync(
          `osascript -e 'set theFile to POSIX file "${tmpFile}"' -e 'try' -e 'set theImage to the clipboard as «class PNGf»' -e 'set fp to open for access theFile with write permission' -e 'write theImage to fp' -e 'close access fp' -e 'return "ok"' -e 'on error' -e 'return "no image"' -e 'end try'`,
          { timeout: 3000, encoding: 'utf-8' }
        );
        if (fs.existsSync(tmpFile)) {
          const buf = fs.readFileSync(tmpFile);
          fs.unlinkSync(tmpFile);
          if (buf.length > 0) {
            imageData = 'data:image/png;base64,' + buf.toString('base64');
            if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
              imageWidth = buf.readUInt32BE(16);
              imageHeight = buf.readUInt32BE(20);
            }
            imageWidth = imageWidth || 400;
            imageHeight = imageHeight || 300;
          }
        }
      } catch (_) {}
    }

    // Strategy 3: Linux
    if (!imageData && os.platform() === 'linux') {
      try {
        const { execSync } = require('child_process');
        const buf = execSync('xclip -selection clipboard -t image/png -o 2>/dev/null', {
          timeout: 3000, encoding: 'buffer',
        });
        if (buf && buf.length > 0) {
          imageData = 'data:image/png;base64,' + buf.toString('base64');
          if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
            imageWidth = buf.readUInt32BE(16);
            imageHeight = buf.readUInt32BE(20);
          }
          imageWidth = imageWidth || 400;
          imageHeight = imageHeight || 300;
        }
      } catch (_) {}
    }

    // Strategy 4: Windows
    if (!imageData && os.platform() === 'win32') {
      try {
        const path = require('path');
        const fs = require('fs');
        const { execSync } = require('child_process');
        const tmpFile = path.join(os.tmpdir(), 'vscode-tc-paste-' + Date.now() + '.png');
        execSync(
          `powershell -command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if($img){ $img.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png) }"`,
          { timeout: 5000 }
        );
        if (fs.existsSync(tmpFile)) {
          const buf = fs.readFileSync(tmpFile);
          fs.unlinkSync(tmpFile);
          if (buf.length > 0) {
            imageData = 'data:image/png;base64,' + buf.toString('base64');
            if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
              imageWidth = buf.readUInt32BE(16);
              imageHeight = buf.readUInt32BE(20);
            }
            imageWidth = imageWidth || 400;
            imageHeight = imageHeight || 300;
          }
        }
      } catch (_) {}
    }

    // Read text
    let text = '';
    try {
      text = (await vscode.env.clipboard.readText() || '').trim();
    } catch (_) {}

    // Send everything to webview in one shot
    this.postMessage({
      type: 'pasteData',
      image: imageData,
      imageWidth,
      imageHeight,
      text,
    });
  }

  postMessage(msg) {
    if (this.webview) {
      this.webview.postMessage(msg);
    }
  }

  dispose() {
    for (const [, entry] of this.terminals) {
      if (entry.ptyProcess) entry.ptyProcess.kill();
    }
    this.terminals.clear();
  }
}

module.exports = { TerminalManager };
