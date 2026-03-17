const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SOCKET_PATH = path.join(os.tmpdir(), 'terminal-canvas-sync.sock');

// Windows uses named pipes instead of Unix sockets
const IPC_PATH = os.platform() === 'win32'
  ? '\\\\.\\pipe\\terminal-canvas-sync'
  : SOCKET_PATH;

/**
 * SyncBridge — Leader/Follower IPC for syncing SharedStateManager across
 * multiple VSCode extension host instances.
 *
 * Protocol: newline-delimited JSON over Unix socket (or Windows named pipe).
 * Leader keeps canonical state; followers forward mutations to leader;
 * leader broadcasts to all followers.
 */
class SyncBridge {
  constructor(sharedState) {
    this.sharedState = sharedState;
    this.role = null;       // 'leader' | 'follower'
    this.server = null;
    this.followers = [];    // leader: connected follower sockets
    this.connection = null; // follower: socket to leader
    this._disposed = false;
    this._reconnectTimer = null;
  }

  // ─── Startup ───────────────────────────────────────
  async start() {
    if (this._disposed) return;
    try {
      await this._tryBecomeLeader();
    } catch {
      await this._connectAsFollower();
    }
  }

  // ─── Leader: create IPC server ─────────────────────
  _tryBecomeLeader() {
    return new Promise((resolve, reject) => {
      // Clean up stale socket file (Unix only)
      if (os.platform() !== 'win32') {
        try {
          // Test if something is actually listening
          const testConn = net.createConnection(IPC_PATH);
          testConn.on('connect', () => {
            // Something is listening → we can't be leader
            testConn.destroy();
            reject(new Error('leader exists'));
          });
          testConn.on('error', () => {
            // Nothing listening → stale socket, remove it
            try { fs.unlinkSync(IPC_PATH); } catch {}
            this._createServer(resolve, reject);
          });
          // Timeout for the test connection
          testConn.setTimeout(500, () => {
            testConn.destroy();
            try { fs.unlinkSync(IPC_PATH); } catch {}
            this._createServer(resolve, reject);
          });
        } catch {
          this._createServer(resolve, reject);
        }
      } else {
        this._createServer(resolve, reject);
      }
    });
  }

  _createServer(resolve, reject) {
    this.server = net.createServer(socket => this._onFollowerConnected(socket));
    this.server.on('error', reject);
    this.server.listen(IPC_PATH, () => {
      this.role = 'leader';
      console.log('[SyncBridge] Role: Leader');
      resolve();
    });
  }

  // ─── Leader: handle new follower ───────────────────
  _onFollowerConnected(socket) {
    this.followers.push(socket);
    console.log(`[SyncBridge] Follower connected (total: ${this.followers.length})`);

    // Send full snapshot so follower can reconstruct state
    const snapshot = this.sharedState.getFullSnapshot();
    this._socketWrite(socket, { type: 'ipc:fullSnapshot', payload: snapshot });

    // Accumulate data for newline-delimited JSON parsing
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this._onMessageFromFollower(msg, socket);
        } catch (e) {
          console.error('[SyncBridge] Bad JSON from follower:', e.message);
        }
      }
    });

    socket.on('close', () => {
      this.followers = this.followers.filter(s => s !== socket);
      console.log(`[SyncBridge] Follower disconnected (total: ${this.followers.length})`);
    });

    socket.on('error', () => {
      this.followers = this.followers.filter(s => s !== socket);
    });
  }

  // ─── Leader: received mutation from a follower ─────
  _onMessageFromFollower(msg, sourceSocket) {
    // Apply to leader's own state
    this.sharedState._applyRemoteChange(msg);
    // Broadcast to all OTHER followers
    for (const s of this.followers) {
      if (s !== sourceSocket) {
        this._socketWrite(s, msg);
      }
    }
  }

  // ─── Follower: connect to leader ───────────────────
  _connectAsFollower() {
    return new Promise((resolve) => {
      this.connection = net.createConnection(IPC_PATH, () => {
        this.role = 'follower';
        console.log('[SyncBridge] Role: Follower');
        resolve();
      });

      let buffer = '';
      this.connection.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._onMessageFromLeader(msg);
          } catch (e) {
            console.error('[SyncBridge] Bad JSON from leader:', e.message);
          }
        }
      });

      this.connection.on('close', () => {
        console.log('[SyncBridge] Leader disconnected, attempting promotion...');
        this.connection = null;
        this.role = null;
        this._scheduleReconnect();
      });

      this.connection.on('error', (err) => {
        console.error('[SyncBridge] Follower connection error:', err.message);
        this.connection = null;
        this.role = null;
        this._scheduleReconnect();
      });
    });
  }

  // ─── Follower: received message from leader ────────
  _onMessageFromLeader(msg) {
    if (msg.type === 'ipc:fullSnapshot') {
      this.sharedState._restoreFromSnapshot(msg.payload);
    } else {
      this.sharedState._applyRemoteChange(msg);
    }
  }

  // ─── Follower: try to become leader after disconnect
  _scheduleReconnect() {
    if (this._disposed) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.start();
    }, 200 + Math.random() * 300); // jitter to avoid race
  }

  // ─── Public: broadcast a local state change ────────
  broadcastChange(msg) {
    if (this._disposed) return;
    if (this.role === 'leader') {
      // Leader → send to all followers
      for (const s of this.followers) {
        this._socketWrite(s, msg);
      }
    } else if (this.role === 'follower' && this.connection) {
      // Follower → forward to leader
      this._socketWrite(this.connection, msg);
    }
  }

  // ─── Utility: write newline-delimited JSON ─────────
  _socketWrite(socket, msg) {
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      console.error('[SyncBridge] Write error:', e.message);
    }
  }

  // ─── Cleanup ───────────────────────────────────────
  dispose() {
    this._disposed = true;
    clearTimeout(this._reconnectTimer);
    for (const s of this.followers) {
      try { s.destroy(); } catch {}
    }
    this.followers = [];
    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
      // Clean up socket file
      if (os.platform() !== 'win32') {
        try { fs.unlinkSync(IPC_PATH); } catch {}
      }
    }
  }
}

module.exports = { SyncBridge };
