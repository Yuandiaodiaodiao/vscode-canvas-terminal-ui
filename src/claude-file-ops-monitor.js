const vscode = require('vscode');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * ClaudeFileOpsMonitor
 *
 * Monitors Claude Code's file operations (Read/Write/Edit) via:
 *   1. Unix Domain Socket — real-time IPC from PostToolUse hook
 *   2. Log file watching — fallback if socket isn't connected
 *
 * Prints all file ops to a dedicated VSCode OutputChannel.
 *
 * Environment variable CLAUDE_FILE_OPS_SOCK is injected into child terminals
 * so the hook script can push events via `nc -U`.
 */
class ClaudeFileOpsMonitor {
  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Claude File Ops');
    this.server = null;
    this.sockPath = null;
    this.logWatcher = null;
    this.lastLogSize = 0;
    this._buffer = new Map(); // client id -> partial line buffer
  }

  start() {
    this._startSocketServer();
    this._startLogWatcher();
    this.outputChannel.appendLine('[ClaudeFileOps] Monitor started');
    this.outputChannel.appendLine(`[ClaudeFileOps] Socket: ${this.sockPath}`);
    this.outputChannel.appendLine(`[ClaudeFileOps] Log: ${this._logFilePath()}`);
  }

  /**
   * Returns env vars to inject into child terminal processes,
   * so the hook script knows where to send events.
   */
  getEnvForTerminal() {
    const env = {};
    if (this.sockPath) {
      env.CLAUDE_FILE_OPS_SOCK = this.sockPath;
    }
    return env;
  }

  // ─── Unix Domain Socket Server ──────────────────────
  _startSocketServer() {
    // Create socket in tmp dir with unique name per VSCode instance
    const sockDir = path.join(os.tmpdir(), 'claude-file-ops');
    try { fs.mkdirSync(sockDir, { recursive: true }); } catch (_) {}

    this.sockPath = path.join(sockDir, `vscode-${process.pid}.sock`);

    // Clean up stale socket
    try { fs.unlinkSync(this.sockPath); } catch (_) {}

    this.server = net.createServer((client) => {
      const clientId = `${Date.now()}-${Math.random()}`;
      this._buffer.set(clientId, '');

      client.on('data', (chunk) => {
        let buf = (this._buffer.get(clientId) || '') + chunk.toString();
        const lines = buf.split('\n');
        // Last element might be incomplete
        this._buffer.set(clientId, lines.pop() || '');

        for (const line of lines) {
          if (line.trim()) {
            this._handleEvent(line.trim());
          }
        }
      });

      client.on('end', () => {
        // Flush remaining buffer
        const remaining = this._buffer.get(clientId) || '';
        if (remaining.trim()) {
          this._handleEvent(remaining.trim());
        }
        this._buffer.delete(clientId);
      });

      client.on('error', () => {
        this._buffer.delete(clientId);
      });
    });

    this.server.on('error', (err) => {
      console.log('[ClaudeFileOps] Socket server error:', err.message);
    });

    this.server.listen(this.sockPath, () => {
      // Make socket accessible
      try { fs.chmodSync(this.sockPath, 0o600); } catch (_) {}
    });
  }

  // ─── Log file watcher (fallback) ───────────────────
  _logFilePath() {
    return path.join(os.homedir(), '.claude-internal', 'file-ops.log');
  }

  _startLogWatcher() {
    const logFile = this._logFilePath();

    // Get current size to avoid replaying old entries
    try {
      const stat = fs.statSync(logFile);
      this.lastLogSize = stat.size;
    } catch (_) {
      this.lastLogSize = 0;
    }

    // Ensure directory exists
    const dir = path.dirname(logFile);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

    // Watch for changes
    try {
      this.logWatcher = fs.watchFile(logFile, { interval: 1000 }, (curr, prev) => {
        if (curr.size > this.lastLogSize) {
          this._readNewLogEntries(logFile, this.lastLogSize, curr.size);
          this.lastLogSize = curr.size;
        } else if (curr.size < this.lastLogSize) {
          // File was truncated, reset
          this.lastLogSize = curr.size;
        }
      });
    } catch (err) {
      console.log('[ClaudeFileOps] Cannot watch log file:', err.message);
    }
  }

  _readNewLogEntries(filePath, from, to) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(to - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);

      const text = buf.toString('utf-8');
      for (const line of text.split('\n')) {
        if (line.trim()) {
          this._handleEvent(line.trim());
        }
      }
    } catch (_) {}
  }

  // ─── Event handling ─────────────────────────────────
  _handleEvent(raw) {
    try {
      const evt = JSON.parse(raw);
      const icon = { Read: '📖', Write: '✏️', Edit: '🔧' }[evt.tool] || '❓';
      const msg = `${icon} [${evt.timestamp}] ${evt.tool} → ${evt.filePath}`;
      this.outputChannel.appendLine(msg);

      // Also fire a VS Code event that other parts of the extension can subscribe to
      if (this.onFileOp) {
        this.onFileOp(evt);
      }
    } catch (_) {
      // Not valid JSON — print raw
      this.outputChannel.appendLine(`[raw] ${raw}`);
    }
  }

  // ─── Cleanup ────────────────────────────────────────
  dispose() {
    if (this.server) {
      this.server.close();
      try { fs.unlinkSync(this.sockPath); } catch (_) {}
    }
    if (this.logWatcher) {
      fs.unwatchFile(this._logFilePath());
    }
    this.outputChannel.dispose();
  }
}

// Singleton
let instance = null;
function getClaudeFileOpsMonitor() {
  if (!instance) instance = new ClaudeFileOpsMonitor();
  return instance;
}

module.exports = { ClaudeFileOpsMonitor, getClaudeFileOpsMonitor };
