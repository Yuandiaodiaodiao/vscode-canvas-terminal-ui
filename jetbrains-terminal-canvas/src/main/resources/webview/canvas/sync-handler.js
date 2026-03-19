// ─── Sync Handler ────────────────────────────────────
// Webview-side sync logic: send/receive state sync messages with extension host

let _snapshotReceived = false;

// ─── Send sync message to host (skipped during remote state apply) ───
function sendSync(msg) {
  if (_isSyncing) return;
  vscodeApi.postMessage(msg);
}

// ─── Apply full snapshot from host ───────────────────
async function applyFullSnapshot(snapshot) {
  _isSyncing = true;
  try {
    // 1. Set counters and canvas state
    nextId = snapshot.nextId;
    nextImageId = snapshot.nextImageId;
    nextBrowserId = snapshot.nextBrowserId;
    maxZIndex = snapshot.maxZIndex;
    gridSnap = snapshot.gridSnap;
    noOverlap = snapshot.noOverlap;
    swapScrollZoom = snapshot.swapScrollZoom || false;
    _updateToggleButtons();

    // 2. Clear existing windows
    for (const [id] of windows) { _destroyTerminalWindowLocal(id); }
    for (const [id] of imageWindows) { _destroyNonTerminalWindowLocal(id); }

    // 3. Wait for xterm to be ready
    if (!xtermReady) {
      await new Promise(r => {
        const check = setInterval(() => {
          if (xtermReady) { clearInterval(check); r(); }
        }, 50);
      });
    }

    // 4. Recreate terminal windows
    for (const [id, def] of snapshot.terminalWindows) {
      await _createTerminalWindowFromDef(id, def);
      // Replay buffered output
      const bufEntry = snapshot.terminalBuffers.find(([bid]) => bid === id);
      if (bufEntry && bufEntry[1]) {
        const w = windows.get(id);
        if (w) w.xterm.write(bufEntry[1]);
      }
    }

    // 5. Recreate image windows
    for (const [id, def] of snapshot.imageWindows) {
      _createImageWindowFromDef(id, def);
    }

    // 6. Recreate browser windows
    for (const [id, def] of snapshot.browserWindows) {
      _createBrowserWindowFromDef(id, def);
    }

    _snapshotReceived = true;
    updateMinimap();
  } finally {
    _isSyncing = false;
  }
}

// ─── Create terminal window from host definition (no pty creation msg) ───
async function _createTerminalWindowFromDef(id, def) {
  const x = def.x;
  const y = def.y;
  const w = def.w;
  const h = def.h;

  const el = document.createElement('div');
  el.className = 'terminal-window';
  el.dataset.id = id;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.zIndex = def.zIndex || ++maxZIndex;

  let quickBtnsHtml = '';
  quickCommands.forEach((cmd, i) => {
    quickBtnsHtml += '<button class="quick-cmd" data-cmd-index="' + i + '" title="Run: ' + cmd.command.replace('\n', ' ⏎') + '">' + cmd.label + '</button>';
  });

  // Build title: show ownership indicator + cwd
  const isLocal = def.isLocal !== false; // default true for snapshot-restored locals
  const ownerTag = isLocal
    ? '<span class="title-tag local" title="Local process">local</span>'
    : '<span class="title-tag remote" title="Remote process (pid ' + (def.ownerPid || '?') + ')">remote</span>';
  const cwdText = def.cwd || '';
  const cwdHtml = cwdText
    ? '<span class="title-cwd" title="' + cwdText + '">' + cwdText + '</span>'
    : '<span class="title-cwd"></span>';

  el.innerHTML =
    '<div class="title-bar">' +
      ownerTag +
      cwdHtml +
      quickBtnsHtml +
      '<button class="title-btn close" title="Close">×</button>' +
    '</div>' +
    '<div class="terminal-body"><div class="xterm-container"></div></div>' +
    '<div class="resize-handle right"></div>' +
    '<div class="resize-handle bottom"></div>' +
    '<div class="resize-handle corner"></div>' +
    '<div class="resize-handle left"></div>' +
    '<div class="resize-handle top"></div>' +
    '<div class="resize-handle top-left"></div>' +
    '<div class="resize-handle top-right"></div>' +
    '<div class="resize-handle bottom-left"></div>';

  canvas.appendChild(el);

  const xtermContainer = el.querySelector('.xterm-container');
  xtermContainer.style.width = '100%';
  xtermContainer.style.height = '100%';

  // Read terminal theme from CSS variables (set by JetBrains theme), fallback to dark defaults
  const cs = getComputedStyle(document.documentElement);
  const tv = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;

  const xterm = new Terminal({
    fontSize: 13,
    fontFamily: "var(--vscode-editor-fontFamily, 'Courier New', monospace)",
    theme: {
      background: tv('--tc-terminal-background', '#1e1e1e'),
      foreground: tv('--tc-terminal-foreground', '#d4d4d4'),
      cursor: tv('--tc-terminal-cursor', '#d4d4d4'),
      black: tv('--tc-terminal-black', '#000000'),
      red: tv('--tc-terminal-red', '#cd3131'),
      green: tv('--tc-terminal-green', '#0dbc79'),
      yellow: tv('--tc-terminal-yellow', '#e5e510'),
      blue: tv('--tc-terminal-blue', '#2472c8'),
      magenta: tv('--tc-terminal-magenta', '#bc3fbc'),
      cyan: tv('--tc-terminal-cyan', '#11a8cd'),
      white: tv('--tc-terminal-white', '#e5e5e5'),
      brightBlack: tv('--tc-terminal-brightBlack', '#666666'),
      brightRed: tv('--tc-terminal-brightRed', '#f14c4c'),
      brightGreen: tv('--tc-terminal-brightGreen', '#23d18b'),
      brightYellow: tv('--tc-terminal-brightYellow', '#f5f543'),
      brightBlue: tv('--tc-terminal-brightBlue', '#3b8eea'),
      brightMagenta: tv('--tc-terminal-brightMagenta', '#d670d6'),
      brightCyan: tv('--tc-terminal-brightCyan', '#29b8db'),
      brightWhite: tv('--tc-terminal-brightWhite', '#e5e5e5'),
    },
    cursorBlink: true, allowTransparency: true, scrollback: 5000, allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(xtermContainer);

  await new Promise(r => setTimeout(r, 50));
  fitAddon.fit();

  const winData = { el, xterm, fitAddon, x, y, w, h, id };
  windows.set(id, winData);

  // xterm input -> extension host (these are NOT sync messages, they go to TerminalManager)
  xterm.onData((data) => {
    vscodeApi.postMessage({ type: 'input', id, data });
  });
  xterm.onBinary((data) => {
    vscodeApi.postMessage({ type: 'input', id, data });
  });

  // Quick command buttons
  el.querySelectorAll('.quick-cmd').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.cmdIndex);
      const cmd = quickCommands[idx];
      if (cmd) {
        vscodeApi.postMessage({ type: 'input', id, data: cmd.command });
        xterm.focus();
      }
    });
  });

  // ─── Drag (title bar) ─────────────────────────
  _setupTerminalDrag(el, winData, id);

  // ─── Resize handles ────────────────────────────
  _setupTerminalResize(el, winData, id, xterm, fitAddon);

  // ─── Focus management ──────────────────────────
  el.addEventListener('mousedown', () => bringToFront(id));
  el.querySelector('.terminal-body').addEventListener('mousedown', () => {
    bringToFront(id);
    xterm.focus();
  });

  // ─── Close button ──────────────────────────────
  el.querySelector('.close').addEventListener('click', () => closeWindow(id));

  // Ensure nextId stays ahead
  if (id >= nextId) nextId = id + 1;
}

// ─── Update terminal title when info arrives ─────────
function _updateTerminalTitle(id, info) {
  const winData = windows.get(id);
  if (!winData || !winData.el) return;
  const cwdSpan = winData.el.querySelector('.title-cwd');
  if (cwdSpan && info.cwd) {
    cwdSpan.textContent = info.cwd;
    cwdSpan.title = info.cwd;
  }
}

// ─── Drag setup (shared for both sync-created and user-created terminals) ───
function _setupTerminalDrag(el, winData, id) {
  const titleBar = el.querySelector('.title-bar');
  let dragStartX, dragStartY, dragElX, dragElY, isDragging = false;

  titleBar.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('title-btn') || e.target.classList.contains('quick-cmd')) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragElX = winData.x;
    dragElY = winData.y;
    bringToFront(id);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = (e.clientX - dragStartX) / zoom;
    const dy = (e.clientY - dragStartY) / zoom;
    winData.x = snapValue(dragElX + dx);
    winData.y = snapValue(dragElY + dy);
    el.style.left = winData.x + 'px';
    el.style.top = winData.y + 'px';
    updateMinimap();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      if (noOverlap) resolveOverlaps(id);
      sendSync({ type: 'sync:windowMoved', id, x: winData.x, y: winData.y });
    }
    isDragging = false;
  });
}

// ─── Resize setup (shared) ───────────────────────────
function _setupTerminalResize(el, winData, id, xterm, fitAddon) {
  el.querySelectorAll('.resize-handle').forEach(handle => {
    const hasRight = handle.classList.contains('right') || handle.classList.contains('corner') || handle.classList.contains('top-right');
    const hasBottom = handle.classList.contains('bottom') || handle.classList.contains('corner') || handle.classList.contains('bottom-left');
    const hasLeft = handle.classList.contains('left') || handle.classList.contains('top-left') || handle.classList.contains('bottom-left');
    const hasTop = handle.classList.contains('top') || handle.classList.contains('top-left') || handle.classList.contains('top-right');

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const resizeStartX = e.clientX;
      const resizeStartY = e.clientY;
      const resizeElX = winData.x;
      const resizeElY = winData.y;
      const resizeElW = winData.w;
      const resizeElH = winData.h;
      bringToFront(id);

      const onMove = (e) => {
        const dx = (e.clientX - resizeStartX) / zoom;
        const dy = (e.clientY - resizeStartY) / zoom;
        let newX = resizeElX, newY = resizeElY, newW = resizeElW, newH = resizeElH;

        if (hasRight && !hasLeft) newW = Math.max(300, snapValue(resizeElW + dx));
        if (hasBottom && !hasTop) newH = Math.max(200, snapValue(resizeElH + dy));
        if (hasLeft) { newW = Math.max(300, snapValue(resizeElW - dx)); newX = resizeElX + resizeElW - newW; }
        if (hasTop) { newH = Math.max(200, snapValue(resizeElH - dy)); newY = resizeElY + resizeElH - newH; }

        winData.x = newX; winData.y = newY;
        winData.w = newW; winData.h = newH;
        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
        el.style.width = newW + 'px';
        el.style.height = newH + 'px';

        fitAddon.fit();
        vscodeApi.postMessage({ type: 'resize', id, cols: xterm.cols, rows: xterm.rows });
        updateMinimap();
      };

      const onUp = () => {
        if (noOverlap) resolveOverlaps(id);
        sendSync({ type: 'sync:windowResized', id, x: winData.x, y: winData.y, w: winData.w, h: winData.h });
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ─── Create image window from host definition ────────
function _createImageWindowFromDef(id, def) {
  const x = def.x;
  const y = def.y;
  const w = def.w;
  const totalH = def.h;
  const imgSrc = def.imgSrc;
  const sourceW = def.naturalW || 400;
  const sourceH = def.naturalH || 300;
  const aspectRatio = def.aspectRatio || (sourceW / sourceH);

  const el = document.createElement('div');
  el.className = 'image-window';
  el.dataset.id = id;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = totalH + 'px';
  el.style.zIndex = def.zIndex || ++maxZIndex;

  const displayNum = id.replace('img_', '');
  el.innerHTML =
    '<div class="title-bar">' +
      '<span class="title">Image ' + displayNum + ' (' + sourceW + '×' + sourceH + ')</span>' +
      '<button class="title-btn close" title="Close">×</button>' +
    '</div>' +
    '<div class="image-body"></div>' +
    '<div class="resize-handle right"></div>' +
    '<div class="resize-handle bottom"></div>' +
    '<div class="resize-handle corner"></div>' +
    '<div class="resize-handle left"></div>' +
    '<div class="resize-handle top"></div>' +
    '<div class="resize-handle top-left"></div>' +
    '<div class="resize-handle top-right"></div>' +
    '<div class="resize-handle bottom-left"></div>';

  if (imgSrc) {
    const imgEl = document.createElement('img');
    imgEl.src = imgSrc;
    el.querySelector('.image-body').appendChild(imgEl);
  }

  canvas.appendChild(el);

  const winData = { el, x, y, w, h: totalH, id, aspectRatio };
  imageWindows.set(id, winData);

  // Drag
  _setupImageDrag(el, winData, id);
  // Resize
  _setupImageResize(el, winData, id, aspectRatio);
  // Focus
  el.addEventListener('mousedown', () => bringToFront(id));
  // Close
  el.querySelector('.close').addEventListener('click', () => {
    sendSync({ type: 'sync:windowClosed', id });
    el.remove();
    imageWindows.delete(id);
    updateMinimap();
  });

  // Ensure nextImageId stays ahead
  const numPart = parseInt(id.replace('img_', ''));
  if (numPart >= nextImageId) nextImageId = numPart + 1;
}

// ─── Create browser window from host definition ─────
function _createBrowserWindowFromDef(id, def) {
  const x = def.x;
  const y = def.y;
  const w = def.w;
  const totalH = def.h;
  const url = def.url;

  const el = document.createElement('div');
  el.className = 'browser-window';
  el.dataset.id = id;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = totalH + 'px';
  el.style.zIndex = def.zIndex || ++maxZIndex;

  let displayUrl = url;
  try { displayUrl = new URL(url).hostname + new URL(url).pathname; } catch(_) {}

  el.innerHTML =
    '<div class="title-bar">' +
      '<span class="url-label" title="' + url.replace(/"/g, '&quot;') + '">' + displayUrl + '</span>' +
      '<button class="title-btn close" title="Close">×</button>' +
    '</div>' +
    '<div class="browser-body"></div>' +
    '<div class="iframe-overlay"></div>' +
    '<div class="resize-handle right"></div>' +
    '<div class="resize-handle bottom"></div>' +
    '<div class="resize-handle corner"></div>' +
    '<div class="resize-handle left"></div>' +
    '<div class="resize-handle top"></div>' +
    '<div class="resize-handle top-left"></div>' +
    '<div class="resize-handle top-right"></div>' +
    '<div class="resize-handle bottom-left"></div>';

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  iframe.allow = 'fullscreen';
  el.querySelector('.browser-body').appendChild(iframe);

  canvas.appendChild(el);

  const winData = { el, x, y, w, h: totalH, id };
  imageWindows.set(id, winData);

  // Drag
  _setupBrowserDrag(el, winData, id);
  // Resize
  _setupBrowserResize(el, winData, id);
  // Focus
  el.addEventListener('mousedown', () => bringToFront(id));
  // Close
  el.querySelector('.close').addEventListener('click', () => {
    sendSync({ type: 'sync:windowClosed', id });
    el.remove();
    imageWindows.delete(id);
    updateMinimap();
  });

  // Ensure nextBrowserId stays ahead
  const numPart = parseInt(id.replace('browser_', ''));
  if (numPart >= nextBrowserId) nextBrowserId = numPart + 1;
}

// ─── Image drag setup ───────────────────────────────
function _setupImageDrag(el, winData, id) {
  const titleBar = el.querySelector('.title-bar');
  const imageBody = el.querySelector('.image-body');
  let dragStartX, dragStartY, dragElX, dragElY, isDragging = false;

  function startDrag(e) {
    if (e.target.classList.contains('title-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragElX = winData.x;
    dragElY = winData.y;
    bringToFront(id);
  }

  titleBar.addEventListener('mousedown', startDrag);
  if (imageBody) {
    imageBody.addEventListener('mousedown', startDrag);
    imageBody.style.cursor = 'move';
  }

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = (e.clientX - dragStartX) / zoom;
    const dy = (e.clientY - dragStartY) / zoom;
    winData.x = snapValue(dragElX + dx);
    winData.y = snapValue(dragElY + dy);
    el.style.left = winData.x + 'px';
    el.style.top = winData.y + 'px';
    updateMinimap();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      if (noOverlap) resolveOverlaps(id);
      sendSync({ type: 'sync:windowMoved', id, x: winData.x, y: winData.y });
    }
    isDragging = false;
  });
}

// ─── Image resize setup (aspect-ratio locked) ────────
function _setupImageResize(el, winData, id, aspectRatio) {
  const TITLE_H = 28;
  const ar = aspectRatio;

  el.querySelectorAll('.resize-handle').forEach(handle => {
    const hasRight = handle.classList.contains('right') || handle.classList.contains('corner') || handle.classList.contains('top-right');
    const hasBottom = handle.classList.contains('bottom') || handle.classList.contains('corner') || handle.classList.contains('bottom-left');
    const hasLeft = handle.classList.contains('left') || handle.classList.contains('top-left') || handle.classList.contains('bottom-left');
    const hasTop = handle.classList.contains('top') || handle.classList.contains('top-left') || handle.classList.contains('top-right');

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rsX = e.clientX, rsY = e.clientY;
      const rX = winData.x, rY = winData.y, rW = winData.w, rH = winData.h;
      bringToFront(id);

      const onMove = (e) => {
        const dx = (e.clientX - rsX) / zoom;
        const dy = (e.clientY - rsY) / zoom;
        let nW;
        if (hasRight && !hasLeft) {
          nW = Math.max(100, snapValue(rW + dx));
        } else if (hasLeft) {
          nW = Math.max(100, snapValue(rW - dx));
        } else {
          const dH = hasTop ? -dy : dy;
          nW = Math.max(100, rW + dH * ar / (ar + 0.001));
        }
        const nH = Math.max(80, Math.round(nW / ar) + TITLE_H);
        const finalW = Math.round((nH - TITLE_H) * ar);
        let nX = rX, nY = rY;
        if (hasLeft) nX = rX + rW - finalW;
        if (hasTop) nY = rY + rH - nH;

        winData.x = nX; winData.y = nY;
        winData.w = finalW; winData.h = nH;
        el.style.left = nX + 'px';
        el.style.top = nY + 'px';
        el.style.width = finalW + 'px';
        el.style.height = nH + 'px';
        updateMinimap();
      };

      const onUp = () => {
        if (noOverlap) resolveOverlaps(id);
        sendSync({ type: 'sync:windowResized', id, x: winData.x, y: winData.y, w: winData.w, h: winData.h });
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ─── Browser drag setup ─────────────────────────────
function _setupBrowserDrag(el, winData, id) {
  const titleBar = el.querySelector('.title-bar');
  let dragStartX, dragStartY, dragElX, dragElY, isDragging = false;

  titleBar.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('title-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    el.classList.add('dragging');
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragElX = winData.x;
    dragElY = winData.y;
    bringToFront(id);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = (e.clientX - dragStartX) / zoom;
    const dy = (e.clientY - dragStartY) / zoom;
    winData.x = snapValue(dragElX + dx);
    winData.y = snapValue(dragElY + dy);
    el.style.left = winData.x + 'px';
    el.style.top = winData.y + 'px';
    updateMinimap();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      if (noOverlap) resolveOverlaps(id);
      isDragging = false;
      el.classList.remove('dragging');
      sendSync({ type: 'sync:windowMoved', id, x: winData.x, y: winData.y });
    }
  });
}

// ─── Browser resize setup (free aspect) ──────────────
function _setupBrowserResize(el, winData, id) {
  el.querySelectorAll('.resize-handle').forEach(handle => {
    const hasRight = handle.classList.contains('right') || handle.classList.contains('corner') || handle.classList.contains('top-right');
    const hasBottom = handle.classList.contains('bottom') || handle.classList.contains('corner') || handle.classList.contains('bottom-left');
    const hasLeft = handle.classList.contains('left') || handle.classList.contains('top-left') || handle.classList.contains('bottom-left');
    const hasTop = handle.classList.contains('top') || handle.classList.contains('top-left') || handle.classList.contains('top-right');

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rsX = e.clientX, rsY = e.clientY;
      const rX = winData.x, rY = winData.y, rW = winData.w, rH = winData.h;
      el.classList.add('dragging');
      bringToFront(id);

      const onMove = (e) => {
        const dx = (e.clientX - rsX) / zoom;
        const dy = (e.clientY - rsY) / zoom;
        let nX = rX, nY = rY, nW = rW, nH = rH;
        if (hasRight && !hasLeft) nW = Math.max(200, snapValue(rW + dx));
        if (hasBottom && !hasTop) nH = Math.max(150, snapValue(rH + dy));
        if (hasLeft) { nW = Math.max(200, snapValue(rW - dx)); nX = rX + rW - nW; }
        if (hasTop) { nH = Math.max(150, snapValue(rH - dy)); nY = rY + rH - nH; }

        winData.x = nX; winData.y = nY;
        winData.w = nW; winData.h = nH;
        el.style.left = nX + 'px';
        el.style.top = nY + 'px';
        el.style.width = nW + 'px';
        el.style.height = nH + 'px';
        updateMinimap();
      };

      const onUp = () => {
        if (noOverlap) resolveOverlaps(id);
        el.classList.remove('dragging');
        sendSync({ type: 'sync:windowResized', id, x: winData.x, y: winData.y, w: winData.w, h: winData.h });
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ─── Local-only destroy helpers ──────────────────────
function _destroyTerminalWindowLocal(id) {
  const w = windows.get(id);
  if (!w) return;
  try { w.xterm.dispose(); } catch (_) {}
  w.el.remove();
  windows.delete(id);
}

function _destroyNonTerminalWindowLocal(id) {
  const w = imageWindows.get(id);
  if (!w) return;
  w.el.remove();
  imageWindows.delete(id);
}

// ─── Apply individual position/size updates ──────────
function _applyWindowMove(id, x, y) {
  const w = windows.get(id) || imageWindows.get(id);
  if (!w) return;
  w.x = x; w.y = y;
  w.el.style.left = x + 'px';
  w.el.style.top = y + 'px';
  updateMinimap();
}

function _applyWindowResize(id, x, y, w, h) {
  const win = windows.get(id) || imageWindows.get(id);
  if (!win) return;
  win.x = x; win.y = y; win.w = w; win.h = h;
  win.el.style.left = x + 'px';
  win.el.style.top = y + 'px';
  win.el.style.width = w + 'px';
  win.el.style.height = h + 'px';
  if (win.fitAddon) {
    try { win.fitAddon.fit(); } catch (_) {}
  }
  updateMinimap();
}

// ─── Toggle button visual sync ───────────────────────
function _updateToggleButtons() {
  const snapBtn = document.getElementById('btn-snap');
  const overlapBtn = document.getElementById('btn-overlap');
  const swapBtn = document.getElementById('btn-swap-scroll');
  if (snapBtn) {
    snapBtn.style.background = gridSnap ? 'var(--vscode-button-background, #0e639c)' : '';
    snapBtn.style.color = gridSnap ? 'var(--vscode-button-foreground, #fff)' : '';
  }
  if (overlapBtn) {
    overlapBtn.style.background = noOverlap ? 'var(--vscode-button-background, #0e639c)' : '';
    overlapBtn.style.color = noOverlap ? 'var(--vscode-button-foreground, #fff)' : '';
  }
  if (swapBtn) {
    swapBtn.style.background = swapScrollZoom ? 'var(--vscode-button-background, #0e639c)' : '';
    swapBtn.style.color = swapScrollZoom ? 'var(--vscode-button-foreground, #fff)' : '';
  }
  const hint = document.getElementById('hint-text');
  if (hint) {
    hint.textContent = swapScrollZoom
      ? '拖拽平移 | 滚轮缩放 | Shift+滚轮左右 | Cmd/Ctrl+滚轮上下 | Ctrl+V 粘贴图片/网页'
      : '拖拽平移 | 滚轮上下 | Shift+滚轮左右 | Cmd/Ctrl+滚轮缩放 | Ctrl+V 粘贴图片/网页';
  }
}

// ─── Handle sync messages from host ──────────────────
function handleSyncMessage(msg) {
  _isSyncing = true;
  try {
    switch (msg.type) {
      case 'sync:fullSnapshot':
        applyFullSnapshot(msg.payload);
        break;
      case 'sync:terminalCreated':
        _createTerminalWindowFromDef(msg.id, msg);
        break;
      case 'sync:terminalInfo':
        _updateTerminalTitle(msg.id, msg);
        break;
      case 'sync:terminalClosed':
        _destroyTerminalWindowLocal(msg.id);
        updateMinimap();
        break;
      case 'sync:terminalResize': {
        const w = windows.get(msg.id);
        if (w && w.xterm) {
          try { w.xterm.resize(msg.cols, msg.rows); } catch (_) {}
        }
        break;
      }
      case 'sync:windowMoved':
        _applyWindowMove(msg.id, msg.x, msg.y);
        break;
      case 'sync:windowResized':
        _applyWindowResize(msg.id, msg.x, msg.y, msg.w, msg.h);
        break;
      case 'sync:windowFocused':
        bringToFront(msg.id);
        break;
      case 'sync:toggleChanged':
        if (msg.key === 'gridSnap') gridSnap = msg.value;
        if (msg.key === 'noOverlap') noOverlap = msg.value;
        if (msg.key === 'swapScrollZoom') swapScrollZoom = msg.value;
        _updateToggleButtons();
        break;
      case 'sync:imageWindowCreated':
        _createImageWindowFromDef(msg.id, msg);
        updateMinimap();
        break;
      case 'sync:browserWindowCreated':
        _createBrowserWindowFromDef(msg.id, msg);
        updateMinimap();
        break;
      case 'sync:windowClosed':
        _destroyNonTerminalWindowLocal(msg.id);
        updateMinimap();
        break;
      case 'sync:allWindowsMoved':
        if (Array.isArray(msg.updates)) {
          for (const u of msg.updates) {
            _applyWindowMove(u.id, u.x, u.y);
          }
        }
        break;
    }
  } finally {
    _isSyncing = false;
  }
}
