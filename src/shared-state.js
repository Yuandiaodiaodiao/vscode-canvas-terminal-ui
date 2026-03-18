const { TerminalManager } = require('./terminal-manager');
const { SyncBridge } = require('./sync-bridge');
const { TerminalIOBridge } = require('./terminal-io-bridge');

const BUFFER_MAX = 512 * 1024;

class SharedStateManager {
  constructor() {
    this.terminalManager = new TerminalManager();
    this.webviews = new Map(); // webviewId -> { webview, type: 'sidebar'|'panel' }
    this.myPid = process.pid;

    // Canonical canvas state (pure data, no DOM)
    this.state = {
      nextId: 1,
      nextImageId: 1,
      nextBrowserId: 1,
      maxZIndex: 1,
      gridSnap: false,
      noOverlap: false,
      swapScrollZoom: false,
      terminalWindows: new Map(),  // id -> { x, y, w, h, zIndex, cols, rows, ownerPid }
      imageWindows: new Map(),     // id -> { x, y, w, h, zIndex, imgSrc, naturalW, naturalH, aspectRatio }
      browserWindows: new Map(),   // id -> { x, y, w, h, zIndex, url }
    };

    // Terminal output buffer for late-joining webviews
    this.terminalBuffers = new Map(); // id -> string

    // Override TerminalManager.postMessage to intercept all output
    this.terminalManager.postMessage = (msg) => this._onTerminalMessage(msg);

    // IPC bridge for multi-instance canvas state sync
    this.syncBridge = new SyncBridge(this);
    this.syncBridge.start();

    // IPC bridge for multi-instance terminal I/O forwarding
    this.terminalIOBridge = new TerminalIOBridge(this);
  }

  // ─── Webview registration ───────────────────────────
  registerWebview(webviewId, webview, type) {
    this.webviews.set(webviewId, { webview, type });
    // Send full snapshot so the new webview can reconstruct everything
    const snapshot = this.getFullSnapshot();
    webview.postMessage({ type: 'sync:fullSnapshot', payload: snapshot });
  }

  unregisterWebview(webviewId) {
    this.webviews.delete(webviewId);
    // Do NOT dispose TerminalManager — state persists
  }

  // ─── Handle messages from any webview ───────────────
  handleMessage(msg, sourceWebviewId) {
    switch (msg.type) {
      // Terminal messages → route to local or remote pty
      case 'input': {
        const tw = this.state.terminalWindows.get(msg.id);
        if (!tw) break;
        if (tw.ownerPid === this.myPid) {
          // Local pty — direct write
          this.terminalManager.sendInput(msg.id, msg.data);
        } else {
          // Remote pty — forward via IO bridge
          this.terminalIOBridge.forwardInput(tw.ownerPid, msg.id, msg.data);
        }
        break;
      }
      case 'resize': {
        const tw = this.state.terminalWindows.get(msg.id);
        if (tw) { tw.cols = msg.cols; tw.rows = msg.rows; }
        if (tw && tw.ownerPid === this.myPid) {
          // Local pty — direct resize
          this.terminalManager.resizeTerminal(msg.id, msg.cols, msg.rows);
        } else if (tw) {
          // Remote pty — forward via IO bridge
          this.terminalIOBridge.forwardResize(tw.ownerPid, msg.id, msg.cols, msg.rows);
        }
        // Broadcast resize to local webviews + other instances
        this._broadcast({ type: 'sync:terminalResize', id: msg.id, cols: msg.cols, rows: msg.rows }, sourceWebviewId);
        this.syncBridge.broadcastChange({ type: 'sync:terminalResize', id: msg.id, cols: msg.cols, rows: msg.rows });
        break;
      }
      case 'closeTerminal': {
        const tw = this.state.terminalWindows.get(msg.id);
        if (tw && tw.ownerPid === this.myPid) {
          // Local pty — kill it
          this.terminalManager.closeTerminal(msg.id);
        }
        // Always clean up state regardless of ownership
        this.state.terminalWindows.delete(msg.id);
        this.terminalBuffers.delete(msg.id);
        this._broadcast({ type: 'sync:terminalClosed', id: msg.id }, sourceWebviewId);
        this.syncBridge.broadcastChange({ type: 'sync:terminalClosed', id: msg.id });
        break;
      }
      case 'requestPasteData':
        this._handlePaste(sourceWebviewId);
        break;

      // Canvas state sync messages
      case 'sync:requestTerminal':
        this._handleRequestTerminal(msg, sourceWebviewId);
        break;
      case 'sync:windowMoved':
        this._updateWindowPosition(msg.id, msg.x, msg.y);
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:windowResized':
        this._updateWindowRect(msg.id, msg.x, msg.y, msg.w, msg.h);
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:windowFocused':
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:toggleChanged':
        if (msg.key === 'gridSnap') this.state.gridSnap = msg.value;
        if (msg.key === 'noOverlap') this.state.noOverlap = msg.value;
        if (msg.key === 'swapScrollZoom') this.state.swapScrollZoom = msg.value;
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:imageWindowCreated':
        this.state.imageWindows.set(msg.id, {
          x: msg.x, y: msg.y, w: msg.w, h: msg.h,
          zIndex: ++this.state.maxZIndex,
          imgSrc: msg.imgSrc, naturalW: msg.naturalW, naturalH: msg.naturalH,
          aspectRatio: msg.aspectRatio,
        });
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:browserWindowCreated':
        this.state.browserWindows.set(msg.id, {
          x: msg.x, y: msg.y, w: msg.w, h: msg.h,
          zIndex: ++this.state.maxZIndex,
          url: msg.url,
        });
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:windowClosed':
        this.state.imageWindows.delete(msg.id);
        this.state.browserWindows.delete(msg.id);
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      case 'sync:terminalClosed': {
        const tw = this.state.terminalWindows.get(msg.id);
        if (tw && tw.ownerPid === this.myPid) {
          this.terminalManager.closeTerminal(msg.id);
        }
        this.state.terminalWindows.delete(msg.id);
        this.terminalBuffers.delete(msg.id);
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
      }
      case 'sync:allWindowsMoved':
        // Batch update multiple window positions (from resolveOverlaps)
        if (Array.isArray(msg.updates)) {
          for (const u of msg.updates) {
            this._updateWindowPosition(u.id, u.x, u.y);
          }
        }
        this._broadcast(msg, sourceWebviewId);
        this.syncBridge.broadcastChange(msg);
        break;
    }
  }

  // ─── Internal: create terminal (host assigns ID) ────
  _handleRequestTerminal(msg, sourceWebviewId) {
    const id = this.state.nextId++;
    const x = msg.x ?? 50;
    const y = msg.y ?? 50;
    const w = msg.w ?? 600;
    const h = msg.h ?? 380;
    const cols = msg.cols || 80;
    const rows = msg.rows || 24;
    const zIndex = ++this.state.maxZIndex;
    const ownerPid = this.myPid;

    this.state.terminalWindows.set(id, { x, y, w, h, zIndex, cols, rows, ownerPid, cwd: null });

    // Notify all local webviews to create the terminal window UI
    this._broadcastAll({ type: 'sync:terminalCreated', id, x, y, w, h, zIndex, ownerPid, isLocal: true });

    // Notify other instances (they create UI + subscribe for I/O)
    this.syncBridge.broadcastChange({ type: 'sync:terminalCreated', id, x, y, w, h, zIndex, ownerPid });

    // Create actual pty (small delay so webviews set up xterm first)
    setTimeout(() => {
      this.terminalManager.createTerminal(id, cols, rows);
    }, 100);
  }

  // ─── Internal: update window position in state ──────
  _updateWindowPosition(id, x, y) {
    const tw = this.state.terminalWindows.get(id);
    if (tw) { tw.x = x; tw.y = y; return; }
    const iw = this.state.imageWindows.get(id);
    if (iw) { iw.x = x; iw.y = y; return; }
    const bw = this.state.browserWindows.get(id);
    if (bw) { bw.x = x; bw.y = y; }
  }

  // ─── Internal: update window rect in state ──────────
  _updateWindowRect(id, x, y, w, h) {
    const tw = this.state.terminalWindows.get(id);
    if (tw) { tw.x = x; tw.y = y; tw.w = w; tw.h = h; return; }
    const iw = this.state.imageWindows.get(id);
    if (iw) { iw.x = x; iw.y = y; iw.w = w; iw.h = h; return; }
    const bw = this.state.browserWindows.get(id);
    if (bw) { bw.x = x; bw.y = y; bw.w = w; bw.h = h; }
  }

  // ─── Internal: intercept TerminalManager output ─────
  _onTerminalMessage(msg) {
    if (msg.type === 'output') {
      // Buffer for late joiners
      let buf = this.terminalBuffers.get(msg.id) || '';
      buf += msg.data;
      if (buf.length > BUFFER_MAX) buf = buf.slice(-BUFFER_MAX);
      this.terminalBuffers.set(msg.id, buf);
      // Push to remote subscribers via IO bridge
      this.terminalIOBridge.pushOutput(msg.id, msg.data);
    }
    if (msg.type === 'terminated') {
      this.state.terminalWindows.delete(msg.id);
      this.terminalBuffers.delete(msg.id);
      // Notify remote subscribers
      this.terminalIOBridge.pushTerminated(msg.id, msg.exitCode);
    }
    if (msg.type === 'terminalInfo') {
      // pty reported its cwd — update state and notify all webviews + instances
      const tw = this.state.terminalWindows.get(msg.id);
      if (tw) { tw.cwd = msg.cwd; }
      const infoMsg = { type: 'sync:terminalInfo', id: msg.id, cwd: msg.cwd };
      this._broadcastAll(infoMsg);
      this.syncBridge.broadcastChange(infoMsg);
      return; // don't re-broadcast as raw terminalInfo
    }
    // Terminal output goes to ALL local webviews
    this._broadcastAll(msg);
  }

  // ─── Remote terminal output (from TerminalIOBridge) ─
  _onRemoteTerminalOutput(id, data) {
    // Buffer it (same as local)
    let buf = this.terminalBuffers.get(id) || '';
    buf += data;
    if (buf.length > BUFFER_MAX) buf = buf.slice(-BUFFER_MAX);
    this.terminalBuffers.set(id, buf);
    // Push to local webviews
    this._broadcastAll({ type: 'output', id, data });
  }

  // ─── Remote terminal terminated (from TerminalIOBridge)
  _onRemoteTerminalTerminated(id, exitCode) {
    this.state.terminalWindows.delete(id);
    this.terminalBuffers.delete(id);
    this._broadcastAll({ type: 'terminated', id, exitCode });
  }

  // ─── Internal: paste (result goes to requester only) ─
  async _handlePaste(sourceWebviewId) {
    const origPost = this.terminalManager.postMessage;
    const srcWv = this.webviews.get(sourceWebviewId);
    this.terminalManager.postMessage = (msg) => {
      if (srcWv) srcWv.webview.postMessage(msg);
    };
    await this.terminalManager.readClipboardImage();
    this.terminalManager.postMessage = origPost;
  }

  // ─── Broadcast to all webviews EXCEPT source ────────
  _broadcast(msg, excludeWebviewId) {
    for (const [id, { webview }] of this.webviews) {
      if (id !== excludeWebviewId) {
        webview.postMessage(msg);
      }
    }
  }

  // ─── Broadcast to ALL webviews ──────────────────────
  _broadcastAll(msg) {
    for (const [, { webview }] of this.webviews) {
      webview.postMessage(msg);
    }
  }

  // ─── Full state snapshot for new webview ────────────
  getFullSnapshot() {
    // Annotate terminal windows with isLocal for webview title display
    const terminalWindows = Array.from(this.state.terminalWindows.entries()).map(
      ([id, tw]) => [id, { ...tw, isLocal: tw.ownerPid === this.myPid }]
    );
    return {
      nextId: this.state.nextId,
      nextImageId: this.state.nextImageId,
      nextBrowserId: this.state.nextBrowserId,
      maxZIndex: this.state.maxZIndex,
      gridSnap: this.state.gridSnap,
      noOverlap: this.state.noOverlap,
      swapScrollZoom: this.state.swapScrollZoom,
      terminalWindows,
      imageWindows: Array.from(this.state.imageWindows.entries()),
      browserWindows: Array.from(this.state.browserWindows.entries()),
      terminalBuffers: Array.from(this.terminalBuffers.entries()),
    };
  }

  // ─── Restore state from a remote snapshot ───────────
  _restoreFromSnapshot(payload) {
    this.state.nextId = Math.max(this.state.nextId, payload.nextId || 1);
    this.state.nextImageId = Math.max(this.state.nextImageId, payload.nextImageId || 1);
    this.state.nextBrowserId = Math.max(this.state.nextBrowserId, payload.nextBrowserId || 1);
    this.state.maxZIndex = Math.max(this.state.maxZIndex, payload.maxZIndex || 1);
    this.state.gridSnap = payload.gridSnap ?? this.state.gridSnap;
    this.state.noOverlap = payload.noOverlap ?? this.state.noOverlap;
    this.state.swapScrollZoom = payload.swapScrollZoom ?? this.state.swapScrollZoom;

    // Merge window maps (remote wins for shared keys)
    if (payload.terminalWindows) {
      for (const [id, data] of payload.terminalWindows) {
        this.state.terminalWindows.set(id, data);
      }
    }
    if (payload.imageWindows) {
      for (const [id, data] of payload.imageWindows) {
        this.state.imageWindows.set(id, data);
      }
    }
    if (payload.browserWindows) {
      for (const [id, data] of payload.browserWindows) {
        this.state.browserWindows.set(id, data);
      }
    }
    if (payload.terminalBuffers) {
      for (const [id, data] of payload.terminalBuffers) {
        this.terminalBuffers.set(id, data);
      }
    }

    // Push full snapshot to all local webviews so they rebuild UI
    const snapshot = this.getFullSnapshot();
    this._broadcastAll({ type: 'sync:fullSnapshot', payload: snapshot });

    // Subscribe to I/O for all remote terminals
    this._subscribeToRemoteTerminals();
  }

  // ─── Subscribe to all remote terminal I/O ───────────
  _subscribeToRemoteTerminals() {
    // Group remote terminals by ownerPid
    const byOwner = new Map(); // ownerPid -> [terminalId, ...]
    for (const [id, tw] of this.state.terminalWindows) {
      if (tw.ownerPid && tw.ownerPid !== this.myPid) {
        if (!byOwner.has(tw.ownerPid)) byOwner.set(tw.ownerPid, []);
        byOwner.get(tw.ownerPid).push(id);
      }
    }
    // Subscribe to each owner
    for (const [ownerPid, terminalIds] of byOwner) {
      this.terminalIOBridge.subscribe(ownerPid, terminalIds);
    }
  }

  // ─── Apply a single remote change (from SyncBridge) ─
  _applyRemoteChange(msg) {
    switch (msg.type) {
      case 'sync:terminalCreated':
        // Remote instance created a terminal — add window UI only (no local pty)
        if (!this.state.terminalWindows.has(msg.id)) {
          this.state.terminalWindows.set(msg.id, {
            x: msg.x, y: msg.y, w: msg.w, h: msg.h,
            zIndex: msg.zIndex, cols: 80, rows: 24,
            ownerPid: msg.ownerPid, cwd: msg.cwd || null,
          });
          if (msg.zIndex > this.state.maxZIndex) this.state.maxZIndex = msg.zIndex;
          if (msg.id >= this.state.nextId) this.state.nextId = msg.id + 1;
        }
        // Mark as remote for webview title display
        this._broadcastAll({ ...msg, isLocal: false });
        // Subscribe to this terminal's I/O from the owner
        if (msg.ownerPid && msg.ownerPid !== this.myPid) {
          this.terminalIOBridge.subscribe(msg.ownerPid, [msg.id]);
        }
        break;

      case 'sync:terminalInfo': {
        // Remote terminal reported its cwd
        const tw = this.state.terminalWindows.get(msg.id);
        if (tw) { tw.cwd = msg.cwd; }
        this._broadcastAll(msg);
        break;
      }

      case 'sync:terminalResize':
        {
          const tw = this.state.terminalWindows.get(msg.id);
          if (tw) { tw.cols = msg.cols; tw.rows = msg.rows; }
        }
        this._broadcastAll(msg);
        break;

      case 'sync:terminalClosed':
        this.state.terminalWindows.delete(msg.id);
        this.terminalBuffers.delete(msg.id);
        this._broadcastAll(msg);
        break;

      case 'sync:windowMoved':
        this._updateWindowPosition(msg.id, msg.x, msg.y);
        this._broadcastAll(msg);
        break;

      case 'sync:windowResized':
        this._updateWindowRect(msg.id, msg.x, msg.y, msg.w, msg.h);
        this._broadcastAll(msg);
        break;

      case 'sync:windowFocused':
        this._broadcastAll(msg);
        break;

      case 'sync:toggleChanged':
        if (msg.key === 'gridSnap') this.state.gridSnap = msg.value;
        if (msg.key === 'noOverlap') this.state.noOverlap = msg.value;
        if (msg.key === 'swapScrollZoom') this.state.swapScrollZoom = msg.value;
        this._broadcastAll(msg);
        break;

      case 'sync:imageWindowCreated':
        this.state.imageWindows.set(msg.id, {
          x: msg.x, y: msg.y, w: msg.w, h: msg.h,
          zIndex: ++this.state.maxZIndex,
          imgSrc: msg.imgSrc, naturalW: msg.naturalW, naturalH: msg.naturalH,
          aspectRatio: msg.aspectRatio,
        });
        this._broadcastAll(msg);
        break;

      case 'sync:browserWindowCreated':
        this.state.browserWindows.set(msg.id, {
          x: msg.x, y: msg.y, w: msg.w, h: msg.h,
          zIndex: ++this.state.maxZIndex,
          url: msg.url,
        });
        this._broadcastAll(msg);
        break;

      case 'sync:windowClosed':
        this.state.imageWindows.delete(msg.id);
        this.state.browserWindows.delete(msg.id);
        this._broadcastAll(msg);
        break;

      case 'sync:allWindowsMoved':
        if (Array.isArray(msg.updates)) {
          for (const u of msg.updates) {
            this._updateWindowPosition(u.id, u.x, u.y);
          }
        }
        this._broadcastAll(msg);
        break;
    }
  }

  // ─── Clipboard image for a specific webview ─────────
  readClipboardImage(sourceWebviewId) {
    this._handlePaste(sourceWebviewId);
  }

  // ─── Dispose everything ─────────────────────────────
  dispose() {
    this.terminalIOBridge.dispose();
    this.syncBridge.dispose();
    this.terminalManager.dispose();
    this.webviews.clear();
  }
}

// Singleton
let instance = null;
function getSharedState() {
  if (!instance) instance = new SharedStateManager();
  return instance;
}

module.exports = { getSharedState };
