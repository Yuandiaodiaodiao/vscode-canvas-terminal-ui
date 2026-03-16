function getWebviewContent(webview, extensionUri) {
  const nonce = getNonce();

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; connect-src https://cdn.jsdelivr.net; img-src blob: data:;">
  <title>Terminal Canvas</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      background: var(--vscode-editor-background, #1e1e1e);
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      user-select: none;
    }

    /* Toolbar */
    #toolbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 40px;
      background: var(--vscode-titleBar-activeBackground, #323233);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 8px;
      z-index: 10000;
    }

    #toolbar button {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 4px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    #toolbar button:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    #toolbar button.secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }

    #toolbar button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #505254);
    }

    #toolbar .separator {
      width: 1px;
      height: 20px;
      background: var(--vscode-panel-border, #444);
    }

    #toolbar .zoom-display {
      color: var(--vscode-foreground, #ccc);
      font-size: 12px;
      min-width: 50px;
      text-align: center;
    }

    #toolbar .spacer { flex: 1; }

    #toolbar .hint {
      color: var(--vscode-descriptionForeground, #888);
      font-size: 11px;
    }

    /* Canvas area */
    #canvas-viewport {
      position: fixed;
      top: 40px;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      cursor: grab;
    }

    #canvas-viewport.panning { cursor: grabbing; }

    #canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      transform-origin: 0 0;
    }

    /* Grid background */
    #grid-bg {
      position: fixed;
      top: 40px;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 0;
      opacity: 0.15;
    }

    /* Terminal Window */
    .terminal-window {
      position: absolute;
      min-width: 300px;
      min-height: 200px;
      background: var(--vscode-terminal-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      display: flex;
      flex-direction: column;
      transition: box-shadow 0.15s ease;
    }

    .terminal-window.focused {
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 4px 24px rgba(0,0,0,0.6), 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }

    .terminal-window .title-bar {
      height: 32px;
      background: var(--vscode-titleBar-activeBackground, #323233);
      display: flex;
      align-items: center;
      padding: 0 8px;
      cursor: move;
      flex-shrink: 0;
    }

    .terminal-window .title-bar .title {
      color: var(--vscode-foreground, #ccc);
      font-size: 12px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .terminal-window .title-bar .title-btn {
      width: 22px;
      height: 22px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground, #ccc);
      cursor: pointer;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    .terminal-window .title-bar .title-btn:hover {
      background: rgba(255,255,255,0.1);
    }

    .terminal-window .title-bar .title-btn.close:hover {
      background: #c42b1c;
      color: #fff;
    }

    .terminal-window .title-bar .quick-cmd {
      padding: 2px 8px;
      border: 1px solid var(--vscode-panel-border, #555);
      background: transparent;
      color: var(--vscode-button-background, #0e639c);
      cursor: pointer;
      border-radius: 3px;
      font-size: 11px;
      margin-right: 4px;
      white-space: nowrap;
    }

    .terminal-window .title-bar .quick-cmd:hover {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }

    .terminal-window .terminal-body {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .terminal-window .terminal-body .xterm {
      height: 100%;
      padding: 4px;
    }

    /* Resize handles */
    .terminal-window .resize-handle {
      position: absolute;
      z-index: 10;
    }

    .resize-handle.right { top: 0; right: -4px; width: 8px; height: 100%; cursor: ew-resize; }
    .resize-handle.bottom { bottom: -4px; left: 0; width: 100%; height: 8px; cursor: ns-resize; }
    .resize-handle.corner { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: nwse-resize; }
    .resize-handle.left { top: 0; left: -4px; width: 8px; height: 100%; cursor: ew-resize; }
    .resize-handle.top { top: -4px; left: 0; width: 100%; height: 8px; cursor: ns-resize; }
    .resize-handle.top-left { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nwse-resize; }
    .resize-handle.top-right { top: -4px; right: -4px; width: 16px; height: 16px; cursor: nesw-resize; }
    .resize-handle.bottom-left { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: nesw-resize; }

    /* Minimap */
    #minimap {
      position: fixed;
      bottom: 12px;
      right: 12px;
      width: 180px;
      height: 120px;
      background: rgba(30, 30, 30, 0.9);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 4px;
      z-index: 9999;
      overflow: hidden;
    }

    #minimap .minimap-viewport {
      position: absolute;
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      background: rgba(0, 127, 212, 0.1);
      pointer-events: none;
    }

    #minimap .minimap-window {
      position: absolute;
      background: var(--vscode-terminal-background, #2d2d2d);
      border: 1px solid #555;
      border-radius: 1px;
    }

    /* Connection line when dragging */
    .drop-indicator {
      position: absolute;
      border: 2px dashed var(--vscode-focusBorder, #007fd4);
      border-radius: 6px;
      pointer-events: none;
      opacity: 0.5;
    }

    /* Layout presets dropdown */
    .dropdown-menu {
      position: absolute;
      top: 100%;
      left: 0;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #444);
      border-radius: 4px;
      padding: 4px 0;
      z-index: 10001;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }

    .dropdown-menu .menu-item {
      padding: 6px 16px;
      color: var(--vscode-menu-foreground, #ccc);
      font-size: 12px;
      cursor: pointer;
    }

    .dropdown-menu .menu-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }

    /* Image Window */
    .image-window {
      position: absolute;
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      display: flex;
      flex-direction: column;
      transition: box-shadow 0.15s ease;
    }

    .image-window.focused {
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 4px 24px rgba(0,0,0,0.6), 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }

    .image-window .title-bar {
      height: 28px;
      background: var(--vscode-titleBar-activeBackground, #323233);
      display: flex;
      align-items: center;
      padding: 0 8px;
      cursor: move;
      flex-shrink: 0;
    }

    .image-window .title-bar .title {
      color: var(--vscode-foreground, #ccc);
      font-size: 11px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .image-window .title-bar .title-btn {
      width: 20px;
      height: 20px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground, #ccc);
      cursor: pointer;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
    }

    .image-window .title-bar .title-btn:hover {
      background: rgba(255,255,255,0.1);
    }

    .image-window .title-bar .title-btn.close:hover {
      background: #c42b1c;
      color: #fff;
    }

    .image-window .image-body {
      flex: 1;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111;
    }

    .image-window .image-body img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
  </style>
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
    <span class="hint">Drag blank area to pan | Scroll to zoom | Shift+Scroll to pan horizontal</span>
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

  <div id="canvas-viewport">
    <div id="canvas"></div>
  </div>

  <div id="minimap">
    <div class="minimap-viewport" id="minimap-viewport"></div>
  </div>

  <script nonce="${nonce}">
    // Load xterm from CDN
    const XTERM_VERSION = '5.3.0';
    const XTERM_BASE = 'https://cdn.jsdelivr.net/npm/xterm@' + XTERM_VERSION;
    const XTERM_FIT_BASE = 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0';
    const XTERM_WEBGL_BASE = 'https://cdn.jsdelivr.net/npm/xterm-addon-webgl@0.16.0';

    // Dynamic script/css loader
    function loadCSS(href) {
      return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = resolve;
        document.head.appendChild(link);
      });
    }

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    // ─── State ───────────────────────────────────────────
    const vscodeApi = acquireVsCodeApi();
    let nextId = 1;
    const windows = new Map(); // id -> { el, xterm, fitAddon, x, y, w, h }
    const imageWindows = new Map(); // id -> { el, x, y, w, h }

    let canvasX = 0, canvasY = 0, zoom = 1;
    let isPanning = false, panStartX = 0, panStartY = 0, panStartCX = 0, panStartCY = 0;
    let gridSnap = false;
    let noOverlap = false;
    const SNAP_SIZE = 20;

    // Quick command buttons config: { label, command }
    const quickCommands = [
      { label: 'claude', command: 'claude-internal\\n' },
    ];

    const canvas = document.getElementById('canvas');
    const viewport = document.getElementById('canvas-viewport');
    const zoomDisplay = document.getElementById('zoom-display');

    // ─── Canvas transform ──────────────────────────────
    function updateCanvasTransform() {
      canvas.style.transform = 'translate(' + canvasX + 'px, ' + canvasY + 'px) scale(' + zoom + ')';
      zoomDisplay.textContent = Math.round(zoom * 100) + '%';
      updateGridBg();
      updateMinimap();
    }

    function updateGridBg() {
      const svg = document.getElementById('grid-bg');
      const smallP = document.getElementById('grid-small');
      const largeP = document.getElementById('grid-large');
      const smallSize = 20 * zoom;
      const largeSize = 100 * zoom;
      smallP.setAttribute('width', smallSize);
      smallP.setAttribute('height', smallSize);
      smallP.querySelector('path').setAttribute('d', 'M ' + smallSize + ' 0 L 0 0 0 ' + smallSize);
      largeP.setAttribute('width', largeSize);
      largeP.setAttribute('height', largeSize);
      largeP.querySelector('path').setAttribute('d', 'M ' + largeSize + ' 0 L 0 0 0 ' + largeSize);

      const ox = canvasX % largeSize;
      const oy = canvasY % largeSize;
      smallP.setAttribute('patternTransform', 'translate(' + ox + ',' + oy + ')');
      largeP.setAttribute('patternTransform', 'translate(' + ox + ',' + oy + ')');
    }

    // ─── Zoom ──────────────────────────────────────────
    function zoomTo(newZoom, cx, cy) {
      const oldZoom = zoom;
      zoom = Math.max(0.1, Math.min(3, newZoom));
      // Zoom toward cursor position
      if (cx !== undefined) {
        canvasX = cx - (cx - canvasX) * (zoom / oldZoom);
        canvasY = cy - (cy - canvasY) * (zoom / oldZoom);
      }
      updateCanvasTransform();
    }

    // Wheel on blank canvas area: scroll = zoom, shift+scroll = horizontal pan
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift + scroll → horizontal pan
        const scrollAmount = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        canvasX -= scrollAmount;
        updateCanvasTransform();
      } else {
        // Normal scroll → zoom toward cursor
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomTo(zoom * delta, cx, cy);
      }
    }, { passive: false });

    document.getElementById('btn-zoom-in').onclick = () => zoomTo(zoom * 1.2);
    document.getElementById('btn-zoom-out').onclick = () => zoomTo(zoom / 1.2);
    document.getElementById('btn-zoom-fit').onclick = fitAll;

    function fitAll() {
      if (windows.size === 0 && imageWindows.size === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const allWindows = [...windows.values(), ...imageWindows.values()];
      for (const w of allWindows) {
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.w);
        maxY = Math.max(maxY, w.y + w.h);
      }
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const pad = 40;
      const contentW = maxX - minX + pad * 2;
      const contentH = maxY - minY + pad * 2;
      zoom = Math.min(vw / contentW, vh / contentH, 2);
      canvasX = (vw - contentW * zoom) / 2 - minX * zoom + pad * zoom;
      canvasY = (vh - contentH * zoom) / 2 - minY * zoom + pad * zoom;
      updateCanvasTransform();
    }

    // ─── Pan (left-click on blank canvas area) ─────────
    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Only pan if clicking directly on viewport/canvas (not on a terminal window)
      if (e.target !== viewport && e.target !== canvas) return;
      e.preventDefault();
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartCX = canvasX;
      panStartCY = canvasY;
      viewport.classList.add('panning');
    });

    window.addEventListener('mousemove', (e) => {
      if (isPanning) {
        canvasX = panStartCX + (e.clientX - panStartX);
        canvasY = panStartCY + (e.clientY - panStartY);
        updateCanvasTransform();
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (isPanning) {
        isPanning = false;
        viewport.classList.remove('panning');
      }
    });

    // ─── Grid snap ─────────────────────────────────────
    document.getElementById('btn-snap').onclick = (e) => {
      gridSnap = !gridSnap;
      e.target.style.background = gridSnap ? 'var(--vscode-button-background, #0e639c)' : '';
      e.target.style.color = gridSnap ? 'var(--vscode-button-foreground, #fff)' : '';
    };

    function snapValue(v) {
      return gridSnap ? Math.round(v / SNAP_SIZE) * SNAP_SIZE : v;
    }

    // ─── No-overlap toggle ───────────────────────────
    document.getElementById('btn-overlap').onclick = (e) => {
      noOverlap = !noOverlap;
      e.target.style.background = noOverlap ? 'var(--vscode-button-background, #0e639c)' : '';
      e.target.style.color = noOverlap ? 'var(--vscode-button-foreground, #fff)' : '';
    };

    // Check if rect (x,y,w,h) overlaps any window except excludeId
    function wouldOverlap(x, y, w, h, excludeId) {
      for (const [wid, win] of windows) {
        if (wid === excludeId) continue;
        if (x < win.x + win.w && x + w > win.x && y < win.y + win.h && y + h > win.y) {
          return true;
        }
      }
      return false;
    }

    // ─── Create Terminal Window ────────────────────────
    let maxZIndex = 1;

    async function createTerminalWindow(x, y) {
      const id = nextId++;

      // Default size
      const w = 600;
      const h = 380;
      x = x !== undefined ? x : (windows.size * 30 + 50);
      y = y !== undefined ? y : (windows.size * 30 + 50);

      const el = document.createElement('div');
      el.className = 'terminal-window';
      el.dataset.id = id;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.zIndex = ++maxZIndex;

      // Build quick command buttons HTML
      let quickBtnsHtml = '';
      quickCommands.forEach((cmd, i) => {
        quickBtnsHtml += '<button class="quick-cmd" data-cmd-index="' + i + '" title="Run: ' + cmd.command.replace('\\n', ' ⏎') + '">' + cmd.label + '</button>';
      });

      el.innerHTML =
        '<div class="title-bar">' +
          '<span class="title">Terminal #' + id + '</span>' +
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

      // Create xterm instance
      const xterm = new Terminal({
        fontSize: 13,
        fontFamily: "var(--vscode-editor-fontFamily, 'Courier New', monospace)",
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          black: '#000000',
          red: '#cd3131',
          green: '#0dbc79',
          yellow: '#e5e510',
          blue: '#2472c8',
          magenta: '#bc3fbc',
          cyan: '#11a8cd',
          white: '#e5e5e5',
          brightBlack: '#666666',
          brightRed: '#f14c4c',
          brightGreen: '#23d18b',
          brightYellow: '#f5f543',
          brightBlue: '#3b8eea',
          brightMagenta: '#d670d6',
          brightCyan: '#29b8db',
          brightWhite: '#e5e5e5',
        },
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 5000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      xterm.loadAddon(fitAddon);

      xterm.open(xtermContainer);

      // Small delay for DOM layout
      await new Promise(r => setTimeout(r, 50));
      fitAddon.fit();

      const winData = { el, xterm, fitAddon, x, y, w, h, id };
      windows.set(id, winData);

      // Tell extension host to create a pty
      vscodeApi.postMessage({ type: 'createTerminal', id, cols: xterm.cols, rows: xterm.rows });

      // xterm input -> extension host
      xterm.onData((data) => {
        vscodeApi.postMessage({ type: 'input', id, data });
      });

      xterm.onBinary((data) => {
        vscodeApi.postMessage({ type: 'input', id, data });
      });

      // ─── Quick command buttons ───────────────────────
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
        const newX = snapValue(dragElX + dx);
        const newY = snapValue(dragElY + dy);

        // If no-overlap enabled, block move when it would overlap
        if (noOverlap && wouldOverlap(newX, newY, winData.w, winData.h, id)) {
          return;
        }

        winData.x = newX;
        winData.y = newY;
        el.style.left = winData.x + 'px';
        el.style.top = winData.y + 'px';
        updateMinimap();
      });

      window.addEventListener('mouseup', () => {
        isDragging = false;
      });

      // ─── Resize handles ────────────────────────────
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
            if (hasLeft) {
              newW = Math.max(300, snapValue(resizeElW - dx));
              newX = resizeElX + resizeElW - newW;
            }
            if (hasTop) {
              newH = Math.max(200, snapValue(resizeElH - dy));
              newY = resizeElY + resizeElH - newH;
            }

            // Block resize if it would cause overlap
            if (noOverlap && wouldOverlap(newX, newY, newW, newH, id)) {
              return;
            }

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
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };

          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
      });

      // ─── Focus management ──────────────────────────
      el.addEventListener('mousedown', (e) => {
        bringToFront(id);
      });

      const termBody = el.querySelector('.terminal-body');

      termBody.addEventListener('mousedown', (e) => {
        bringToFront(id);
        xterm.focus();
      });

      // Wheel inside terminal → let xterm handle scrollback, don't zoom canvas
      termBody.addEventListener('wheel', (e) => {
        e.stopPropagation();
      }, { passive: true });

      // ─── Close button ──────────────────────────────
      el.querySelector('.close').addEventListener('click', () => {
        closeWindow(id);
      });

      updateMinimap();
      return id;
    }

    function bringToFront(id) {
      const w = windows.get(id) || imageWindows.get(id);
      if (!w) return;
      for (const win of windows.values()) win.el.classList.remove('focused');
      for (const win of imageWindows.values()) win.el.classList.remove('focused');
      w.el.classList.add('focused');
      w.el.style.zIndex = ++maxZIndex;
    }

    function closeWindow(id) {
      const w = windows.get(id);
      if (!w) return;
      vscodeApi.postMessage({ type: 'closeTerminal', id });
      w.xterm.dispose();
      w.el.remove();
      windows.delete(id);
      updateMinimap();
    }

    // ─── Messages from extension host ────────────────
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'output': {
          const w = windows.get(msg.id);
          if (w) w.xterm.write(msg.data);
          break;
        }
        case 'terminated': {
          const w = windows.get(msg.id);
          if (w) {
            w.xterm.write('\\r\\n\\x1b[90m[Process exited]\\x1b[0m\\r\\n');
          }
          break;
        }
        case 'error': {
          const w = windows.get(msg.id);
          if (w) {
            w.xterm.write('\\r\\n\\x1b[31m' + msg.message + '\\x1b[0m\\r\\n');
          }
          break;
        }
      }
    });

    // ─── Add terminal button ─────────────────────────
    document.getElementById('btn-add').onclick = () => {
      // Place new terminal in center of current viewport
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const x = (vw / 2 - canvasX) / zoom - 300;
      const y = (vh / 2 - canvasY) / zoom - 190;
      createTerminalWindow(x, y);
    };

    // ─── Layout presets ──────────────────────────────
    let layoutMenuOpen = false;
    const btnLayout = document.getElementById('btn-layout');

    btnLayout.onclick = () => {
      if (layoutMenuOpen) {
        document.querySelector('.dropdown-menu')?.remove();
        layoutMenuOpen = false;
        return;
      }
      const menu = document.createElement('div');
      menu.className = 'dropdown-menu';
      const layouts = [
        { label: 'Grid 2×2 (4 terminals)', fn: () => layoutGrid(2, 2) },
        { label: 'Grid 3×2 (6 terminals)', fn: () => layoutGrid(3, 2) },
        { label: 'Grid 4×3 (12 terminals)', fn: () => layoutGrid(4, 3) },
        { label: 'Stack Vertical', fn: () => layoutStack('vertical') },
        { label: 'Stack Horizontal', fn: () => layoutStack('horizontal') },
      ];
      layouts.forEach(l => {
        const item = document.createElement('div');
        item.className = 'menu-item';
        item.textContent = l.label;
        item.onclick = () => { l.fn(); menu.remove(); layoutMenuOpen = false; };
        menu.appendChild(item);
      });
      btnLayout.parentElement.appendChild(menu);
      layoutMenuOpen = true;

      setTimeout(() => {
        const closeMenu = (e) => {
          if (!menu.contains(e.target) && e.target !== btnLayout) {
            menu.remove();
            layoutMenuOpen = false;
            window.removeEventListener('click', closeMenu);
          }
        };
        window.addEventListener('click', closeMenu);
      }, 10);
    };

    async function layoutGrid(cols, rows) {
      // Close existing terminals
      for (const [id] of windows) closeWindow(id);

      const gap = 20;
      const termW = 550;
      const termH = 350;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * (termW + gap);
          const y = row * (termH + gap);
          await createTerminalWindow(x, y);
          await new Promise(r => setTimeout(r, 100));
        }
      }

      setTimeout(fitAll, 300);
    }

    async function layoutStack(dir) {
      const count = windows.size || 4;
      for (const [id] of windows) closeWindow(id);

      for (let i = 0; i < count; i++) {
        const x = dir === 'horizontal' ? i * 620 : 0;
        const y = dir === 'vertical' ? i * 400 : 0;
        await createTerminalWindow(x, y);
        await new Promise(r => setTimeout(r, 100));
      }
      setTimeout(fitAll, 300);
    }

    // ─── Minimap ─────────────────────────────────────
    function updateMinimap() {
      const minimap = document.getElementById('minimap');
      const mvp = document.getElementById('minimap-viewport');

      // Remove old window markers
      minimap.querySelectorAll('.minimap-window').forEach(el => el.remove());

      const allWindows = [...windows.values(), ...imageWindows.values()];

      if (allWindows.length === 0) {
        mvp.style.display = 'none';
        return;
      }

      // Calculate bounds of all windows
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of allWindows) {
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.w);
        maxY = Math.max(maxY, w.y + w.h);
      }

      const pad = 100;
      minX -= pad; minY -= pad;
      maxX += pad; maxY += pad;

      const contentW = maxX - minX;
      const contentH = maxY - minY;
      const mmW = 180, mmH = 120;
      const scale = Math.min(mmW / contentW, mmH / contentH);

      // Draw window markers
      for (const w of allWindows) {
        const marker = document.createElement('div');
        marker.className = 'minimap-window';
        marker.style.left = ((w.x - minX) * scale) + 'px';
        marker.style.top = ((w.y - minY) * scale) + 'px';
        marker.style.width = (w.w * scale) + 'px';
        marker.style.height = (w.h * scale) + 'px';
        if (w.el.classList.contains('focused')) {
          marker.style.borderColor = 'var(--vscode-focusBorder, #007fd4)';
        }
        minimap.appendChild(marker);
      }

      // Draw viewport indicator
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const vpLeft = (-canvasX / zoom);
      const vpTop = (-canvasY / zoom);
      const vpW = vw / zoom;
      const vpH = vh / zoom;

      mvp.style.display = 'block';
      mvp.style.left = ((vpLeft - minX) * scale) + 'px';
      mvp.style.top = ((vpTop - minY) * scale) + 'px';
      mvp.style.width = (vpW * scale) + 'px';
      mvp.style.height = (vpH * scale) + 'px';
    }

    // ─── Fit terminals on window resize ──────────────
    window.addEventListener('resize', () => {
      for (const w of windows.values()) {
        w.fitAddon.fit();
        vscodeApi.postMessage({ type: 'resize', id: w.id, cols: w.xterm.cols, rows: w.xterm.rows });
      }
      updateMinimap();
    });

    // ─── Create Image Window (from clipboard paste) ───
    let nextImageId = 1;

    function createImageWindow(blobUrl, naturalW, naturalH) {
      const id = 'img_' + nextImageId++;

      // Scale down if image is larger than 600px
      const maxDim = 600;
      let w = naturalW, h = naturalH;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      // Add title bar height
      const totalH = h + 28;

      // Place in center of current viewport
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const x = (vw / 2 - canvasX) / zoom - w / 2;
      const y = (vh / 2 - canvasY) / zoom - totalH / 2;

      const el = document.createElement('div');
      el.className = 'image-window';
      el.dataset.id = id;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = w + 'px';
      el.style.height = totalH + 'px';
      el.style.zIndex = ++maxZIndex;

      el.innerHTML =
        '<div class="title-bar">' +
          '<span class="title">Image ' + (nextImageId - 1) + ' (' + naturalW + '×' + naturalH + ')</span>' +
          '<button class="title-btn close" title="Close">×</button>' +
        '</div>' +
        '<div class="image-body"><img src="' + blobUrl + '"></div>' +
        '<div class="resize-handle right"></div>' +
        '<div class="resize-handle bottom"></div>' +
        '<div class="resize-handle corner"></div>' +
        '<div class="resize-handle left"></div>' +
        '<div class="resize-handle top"></div>' +
        '<div class="resize-handle top-left"></div>' +
        '<div class="resize-handle top-right"></div>' +
        '<div class="resize-handle bottom-left"></div>';

      canvas.appendChild(el);

      const winData = { el, x, y, w, h: totalH, id };
      imageWindows.set(id, winData);

      // ─── Drag ──────────────────────────────────────
      const titleBar = el.querySelector('.title-bar');
      let dragStartX, dragStartY, dragElX, dragElY, isDragging = false;

      titleBar.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('title-btn')) return;
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

      window.addEventListener('mouseup', () => { isDragging = false; });

      // ─── Resize handles ────────────────────────────
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
            let nX = rX, nY = rY, nW = rW, nH = rH;

            if (hasRight && !hasLeft) nW = Math.max(100, snapValue(rW + dx));
            if (hasBottom && !hasTop) nH = Math.max(80, snapValue(rH + dy));
            if (hasLeft) { nW = Math.max(100, snapValue(rW - dx)); nX = rX + rW - nW; }
            if (hasTop) { nH = Math.max(80, snapValue(rH - dy)); nY = rY + rH - nH; }

            winData.x = nX; winData.y = nY;
            winData.w = nW; winData.h = nH;
            el.style.left = nX + 'px';
            el.style.top = nY + 'px';
            el.style.width = nW + 'px';
            el.style.height = nH + 'px';
            updateMinimap();
          };

          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };

          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
      });

      // ─── Focus ─────────────────────────────────────
      el.addEventListener('mousedown', () => bringToFront(id));

      // ─── Close ─────────────────────────────────────
      el.querySelector('.close').addEventListener('click', () => {
        el.remove();
        imageWindows.delete(id);
        URL.revokeObjectURL(blobUrl);
        updateMinimap();
      });

      bringToFront(id);
      updateMinimap();
    }

    // ─── Ctrl+V paste image from clipboard ───────────
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          const blobUrl = URL.createObjectURL(blob);

          // Load image to get natural dimensions
          const img = new Image();
          img.onload = () => {
            createImageWindow(blobUrl, img.naturalWidth, img.naturalHeight);
          };
          img.src = blobUrl;
          return; // Only handle first image
        }
      }
    });

    // ─── Init: load xterm and create first terminal ──
    async function init() {
      await loadCSS(XTERM_BASE + '/css/xterm.css');
      await loadScript(XTERM_BASE + '/lib/xterm.js');
      await loadScript(XTERM_FIT_BASE + '/lib/xterm-addon-fit.js');

      // Create initial terminal
      createTerminalWindow(50, 50);
    }

    init();
  </script>
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
