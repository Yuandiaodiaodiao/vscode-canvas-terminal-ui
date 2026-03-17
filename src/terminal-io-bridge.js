const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * TerminalIOBridge — Per-instance IPC server for terminal I/O forwarding.
 *
 * Each extension host instance runs ONE server socket. Remote instances connect
 * to the owner's socket to forward input and receive output, multiplexed by
 * terminalId.
 *
 * Protocol: newline-delimited JSON.
 *   Remote → Owner:  io:input, io:resize, io:subscribe
 *   Owner → Remote:  io:output, io:terminated
 */
class TerminalIOBridge {
  constructor(sharedState) {
    this.sharedState = sharedState;
    this.myPid = process.pid;
    this._disposed = false;

    // ─── Server side (we are the pty owner) ──────────
    this.server = null;
    // terminalId -> Set<socket>  — who wants output for each terminal
    this.subscribers = new Map();

    // ─── Client side (connect to remote owners) ──────
    // ownerPid -> { socket, ready: bool, queue: [] }
    this.clients = new Map();

    this._startServer();
  }

  // ═══════════════════════════════════════════════════
  //  Server side — accept connections from remote instances
  // ═══════════════════════════════════════════════════

  _startServer() {
    const sockPath = TerminalIOBridge.socketPathFor(this.myPid);

    // Clean stale socket (Unix only)
    if (os.platform() !== 'win32') {
      try { fs.unlinkSync(sockPath); } catch {}
    }

    this.server = net.createServer(socket => this._onRemoteConnected(socket));
    this.server.on('error', (err) => {
      console.error('[TerminalIOBridge] Server error:', err.message);
    });
    this.server.listen(sockPath, () => {
      console.log(`[TerminalIOBridge] IO server listening: ${sockPath}`);
    });
  }

  _onRemoteConnected(socket) {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete trailing data
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this._handleRemoteMessage(JSON.parse(line), socket);
        } catch (e) {
          console.error('[TerminalIOBridge] Bad JSON from remote:', e.message);
        }
      }
    });

    socket.on('close', () => this._removeSubscriber(socket));
    socket.on('error', () => this._removeSubscriber(socket));
  }

  _handleRemoteMessage(msg, socket) {
    switch (msg.type) {
      case 'io:input':
        // Forward keystroke to local pty
        this.sharedState.terminalManager.sendInput(msg.terminalId, msg.data);
        break;

      case 'io:resize':
        // Forward resize to local pty
        this.sharedState.terminalManager.resizeTerminal(msg.terminalId, msg.cols, msg.rows);
        // Also update local state
        {
          const tw = this.sharedState.state.terminalWindows.get(msg.terminalId);
          if (tw) { tw.cols = msg.cols; tw.rows = msg.rows; }
        }
        break;

      case 'io:subscribe': {
        // Register this socket as subscriber for the requested terminals
        const ids = msg.terminalIds || [];
        for (const tid of ids) {
          if (!this.subscribers.has(tid)) {
            this.subscribers.set(tid, new Set());
          }
          this.subscribers.get(tid).add(socket);

          // Replay buffered output so remote doesn't see blank screen
          const buf = this.sharedState.terminalBuffers.get(tid);
          if (buf) {
            this._socketWrite(socket, { type: 'io:output', terminalId: tid, data: buf });
          }
        }
        break;
      }
    }
  }

  /** Remove a socket from all subscriber sets */
  _removeSubscriber(socket) {
    for (const [tid, sockets] of this.subscribers) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.subscribers.delete(tid);
      }
    }
  }

  // ═══════════════════════════════════════════════════
  //  Owner push — send pty output to subscribed remotes
  // ═══════════════════════════════════════════════════

  /** Called by SharedStateManager when local pty produces output */
  pushOutput(terminalId, data) {
    const sockets = this.subscribers.get(terminalId);
    if (!sockets || sockets.size === 0) return;
    const msg = { type: 'io:output', terminalId, data };
    for (const s of sockets) {
      this._socketWrite(s, msg);
    }
  }

  /** Called by SharedStateManager when local pty exits */
  pushTerminated(terminalId, exitCode) {
    const sockets = this.subscribers.get(terminalId);
    if (!sockets || sockets.size === 0) return;
    const msg = { type: 'io:terminated', terminalId, exitCode };
    for (const s of sockets) {
      this._socketWrite(s, msg);
    }
    // Clean up subscriber set for this terminal
    this.subscribers.delete(terminalId);
  }

  // ═══════════════════════════════════════════════════
  //  Client side — connect to remote owner for I/O
  // ═══════════════════════════════════════════════════

  /**
   * Get or create a connection to a remote owner's IO server.
   * Returns { socket, ready, queue }.
   */
  _getOrCreateClient(ownerPid) {
    if (this.clients.has(ownerPid)) {
      return this.clients.get(ownerPid);
    }

    const sockPath = TerminalIOBridge.socketPathFor(ownerPid);
    const entry = { socket: null, ready: false, queue: [] };
    this.clients.set(ownerPid, entry);

    const socket = net.createConnection(sockPath, () => {
      entry.ready = true;
      console.log(`[TerminalIOBridge] Connected to owner pid=${ownerPid}`);
      // Flush queued messages
      for (const queued of entry.queue) {
        this._socketWrite(socket, queued);
      }
      entry.queue = [];
    });

    entry.socket = socket;

    // Handle incoming data from owner (io:output, io:terminated)
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this._handleOwnerMessage(JSON.parse(line));
        } catch (e) {
          console.error('[TerminalIOBridge] Bad JSON from owner:', e.message);
        }
      }
    });

    socket.on('close', () => {
      console.log(`[TerminalIOBridge] Owner pid=${ownerPid} disconnected`);
      this.clients.delete(ownerPid);
    });

    socket.on('error', (err) => {
      console.error(`[TerminalIOBridge] Client error (owner pid=${ownerPid}):`, err.message);
      this.clients.delete(ownerPid);
    });

    return entry;
  }

  _handleOwnerMessage(msg) {
    switch (msg.type) {
      case 'io:output':
        this.sharedState._onRemoteTerminalOutput(msg.terminalId, msg.data);
        break;
      case 'io:terminated':
        this.sharedState._onRemoteTerminalTerminated(msg.terminalId, msg.exitCode);
        break;
    }
  }

  /** Send a message to a remote owner (queues if not yet connected) */
  _sendToOwner(ownerPid, msg) {
    const entry = this._getOrCreateClient(ownerPid);
    if (entry.ready) {
      this._socketWrite(entry.socket, msg);
    } else {
      entry.queue.push(msg);
    }
  }

  // ─── Public: forward input to remote pty owner ─────
  forwardInput(ownerPid, terminalId, data) {
    this._sendToOwner(ownerPid, { type: 'io:input', terminalId, data });
  }

  // ─── Public: forward resize to remote pty owner ────
  forwardResize(ownerPid, terminalId, cols, rows) {
    this._sendToOwner(ownerPid, { type: 'io:resize', terminalId, cols, rows });
  }

  // ─── Public: subscribe to output from remote owner ─
  subscribe(ownerPid, terminalIds) {
    if (!terminalIds || terminalIds.length === 0) return;
    this._sendToOwner(ownerPid, { type: 'io:subscribe', terminalIds });
  }

  // ═══════════════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════════════

  static socketPathFor(pid) {
    if (os.platform() === 'win32') {
      return `\\\\.\\pipe\\terminal-canvas-io-${pid}`;
    }
    return path.join(os.tmpdir(), `terminal-canvas-io-${pid}.sock`);
  }

  _socketWrite(socket, msg) {
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      console.error('[TerminalIOBridge] Write error:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════

  dispose() {
    this._disposed = true;

    // Close all client connections
    for (const [, entry] of this.clients) {
      try { entry.socket?.destroy(); } catch {}
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
      if (os.platform() !== 'win32') {
        try { fs.unlinkSync(TerminalIOBridge.socketPathFor(this.myPid)); } catch {}
      }
    }

    this.subscribers.clear();
  }
}

module.exports = { TerminalIOBridge };
