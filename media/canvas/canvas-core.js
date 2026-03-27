// ─── Canvas Core ─────────────────────────────────────
// Global state, canvas transform, zoom, pan, grid, minimap, utilities

console.log('[TerminalCanvas] script start');

// ─── Config (injected by webview.js) ──────────────────
const __config = window.__CANVAS_CONFIG || {};
const XTERM_CSS_URI = __config.xtermCssUri || '';
const XTERM_JS_URI = __config.xtermJsUri || '';
const XTERM_FIT_JS_URI = __config.xtermFitJsUri || '';
const NONCE = __config.nonce || '';

// CDN fallback
const XTERM_VERSION = '5.3.0';
const XTERM_BASE = 'https://cdn.jsdelivr.net/npm/xterm@' + XTERM_VERSION;
const XTERM_FIT_BASE = 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0';

// ─── Dynamic script/css loader ───────────────────────
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
    s.nonce = NONCE;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

let xtermReady = false;
let _isSyncing = false;

// ─── State ───────────────────────────────────────────
const vscodeApi = acquireVsCodeApi();
let nextId = 1;
const windows = new Map(); // id -> { el, xterm, fitAddon, x, y, w, h }
const imageWindows = new Map(); // id -> { el, x, y, w, h }

let canvasX = 0, canvasY = 0, zoom = 1;
let isPanning = false, panStartX = 0, panStartY = 0, panStartCX = 0, panStartCY = 0;
let gridSnap = false;
let noOverlap = false;
let swapScrollZoom = false; // when true: plain scroll = zoom, ctrl/cmd+scroll = pan
const SNAP_SIZE = 20;

// Track mouse position for paste target detection
let lastMouseX = 0, lastMouseY = 0;

function updateLastMousePosition(e) {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}

document.addEventListener('mousemove', updateLastMousePosition, true);
document.addEventListener('mousedown', updateLastMousePosition, true);
document.addEventListener('mouseup', updateLastMousePosition, true);

function getTerminalUnderPoint(clientX, clientY) {
  for (const [wid, win] of windows) {
    const termBody = win.el.querySelector('.terminal-body');
    if (!termBody) continue;

    const rect = termBody.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right &&
        clientY >= rect.top && clientY <= rect.bottom) {
      return wid;
    }
  }
  return null;
}

function getTerminalUnderMouse() {
  return getTerminalUnderPoint(lastMouseX, lastMouseY);
}

// Quick command buttons config: { label, command }
const quickCommands = [
  { label: 'claude', command: 'claude\n' },
];

let maxZIndex = 1;
let nextImageId = 1;
let nextBrowserId = 1;

const canvas = document.getElementById('canvas');
const viewport = document.getElementById('canvas-viewport');
const zoomDisplay = document.getElementById('zoom-display');

let lastPasteRequestAt = 0;
let pendingPasteTarget = null;
let canvasContextMenu = null;

function focusCanvasViewport() {
  if (document.activeElement === viewport) return;
  viewport.focus({ preventScroll: true });
}

function closeCanvasContextMenu() {
  if (!canvasContextMenu) return;

  canvasContextMenu.remove();
  canvasContextMenu = null;
}

function openCanvasContextMenu(clientX, clientY) {
  closeCanvasContextMenu();

  const menu = document.createElement('div');
  menu.className = 'canvas-context-menu';
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';

  const newTerminalItem = document.createElement('button');
  newTerminalItem.type = 'button';
  newTerminalItem.className = 'menu-item';
  newTerminalItem.textContent = 'New Terminal';
  newTerminalItem.addEventListener('click', () => {
    closeCanvasContextMenu();
    if (typeof window.createTerminalAtClientPoint === 'function') {
      window.createTerminalAtClientPoint(clientX, clientY);
    }
  });

  menu.appendChild(newTerminalItem);
  document.body.appendChild(menu);
  canvasContextMenu = menu;

  const menuRect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - menuRect.width - 8);
  const top = Math.min(clientY, window.innerHeight - menuRect.height - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(48, top) + 'px';
}

function getCurrentPasteTarget() {
  const terminalId = getTerminalUnderMouse();
  if (terminalId) {
    return { kind: 'terminal', id: terminalId };
  }
  return { kind: 'canvas' };
}

function takePendingPasteTarget() {
  const target = pendingPasteTarget;
  pendingPasteTarget = null;
  return target;
}

function requestClipboardPaste(target) {
  const now = Date.now();
  if (now - lastPasteRequestAt < 150) return;
  lastPasteRequestAt = now;
  pendingPasteTarget = target || getCurrentPasteTarget();
  vscodeApi.postMessage({ type: 'requestPasteData' });
}

function isPasteShortcut(e) {
  if (e.altKey || e.shiftKey) return false;
  if (!e.ctrlKey && !e.metaKey) return false;
  return typeof e.key === 'string' && e.key.toLowerCase() === 'v';
}

document.addEventListener('keydown', (e) => {
  if (!isPasteShortcut(e)) return;
  const target = getCurrentPasteTarget();
  if (target.kind === 'terminal') return;

  e.preventDefault();
  e.stopPropagation();
  requestClipboardPaste(target);
}, true);

document.addEventListener('paste', (e) => {
  const target = getCurrentPasteTarget();
  if (target.kind === 'terminal') return;

  e.preventDefault();
  e.stopPropagation();
  requestClipboardPaste(target);
}, true);

document.addEventListener('contextmenu', (e) => {
  const onBlankCanvas = e.target === viewport || e.target === canvas;
  if (!onBlankCanvas) {
    closeCanvasContextMenu();
    return;
  }

  focusCanvasViewport();
  e.preventDefault();
  e.stopPropagation();
  openCanvasContextMenu(e.clientX, e.clientY);
}, true);

document.addEventListener('mousedown', (e) => {
  if (!canvasContextMenu) return;
  if (canvasContextMenu.contains(e.target)) return;
  closeCanvasContextMenu();
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCanvasContextMenu();
  }
}, true);

window.addEventListener('blur', () => {
  closeCanvasContextMenu();
});

// ─── Global: cancel all drags if mouse returns with no button ──
window.addEventListener('mousemove', (e) => {
  if (e.buttons === 0) {
    if (isPanning) {
      isPanning = false;
      viewport.classList.remove('panning');
    }
    // Dispatch a synthetic mouseup so all window-level listeners clean up
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }
}, true); // capture phase, runs first

// ─── Canvas transform ──────────────────────────────
function updateCanvasTransform() {
  canvas.style.transform = 'translate(' + canvasX + 'px, ' + canvasY + 'px) scale(' + zoom + ')';
  zoomDisplay.textContent = Math.round(zoom * 100) + '%';
  // Update counter-scale on all terminal xterm containers so mouse selection stays accurate
  for (const w of windows.values()) {
    if (w._applyCounterScale) {
      w._applyCounterScale();
      try { w.fitAddon.fit(); } catch (_) {}
    }
  }
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

// Wheel: normal = vertical pan, shift = horizontal pan, cmd/ctrl = zoom
// When swapScrollZoom is true, plain scroll = zoom, cmd/ctrl+scroll = pan
// Use document-level capture to also intercept when mouse is over terminals
document.addEventListener('wheel', (e) => {
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  const shouldZoom = swapScrollZoom ? !ctrlOrMeta && !e.shiftKey : ctrlOrMeta;
  const shouldPan = swapScrollZoom ? ctrlOrMeta : !ctrlOrMeta && !e.shiftKey;

  if (e.shiftKey) {
    // Shift + scroll → horizontal pan (always, even over terminal)
    e.preventDefault();
    e.stopPropagation();
    const scrollAmount = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    canvasX -= scrollAmount;
    updateCanvasTransform();
  } else if (shouldZoom) {
    // Check if over a terminal body — let xterm handle it
    const target = e.target;
    let inTerminal = false;
    let node = target;
    while (node && node !== document) {
      if (node.classList && node.classList.contains('terminal-body')) {
        inTerminal = true;
        break;
      }
      node = node.parentElement;
    }
    if (!inTerminal) {
      // Zoom toward cursor
      e.preventDefault();
      e.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      zoomTo(zoom * delta, cx, cy);
    }
    // Over terminal → don't prevent, let xterm scroll
  } else if (shouldPan) {
    // Check if over a terminal body — let xterm handle it
    const target = e.target;
    let inTerminal = false;
    let node = target;
    while (node && node !== document) {
      if (node.classList && node.classList.contains('terminal-body')) {
        inTerminal = true;
        break;
      }
      node = node.parentElement;
    }
    if (!inTerminal) {
      // Over blank canvas → vertical pan
      e.preventDefault();
      canvasY -= e.deltaY;
      canvasX -= e.deltaX;
      updateCanvasTransform();
    }
    // Over terminal → don't prevent, let xterm scroll
  }
}, { capture: true, passive: false });

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
  focusCanvasViewport();
  e.preventDefault();
  // Unfocus all windows when clicking blank area
  for (const win of windows.values()) win.el.classList.remove('focused');
  for (const win of imageWindows.values()) win.el.classList.remove('focused');
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panStartCX = canvasX;
  panStartCY = canvasY;
  viewport.classList.add('panning');
});

viewport.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (e.target !== viewport && e.target !== canvas) return;
  focusCanvasViewport();
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
function snapValue(v) {
  return gridSnap ? Math.round(v / SNAP_SIZE) * SNAP_SIZE : v;
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
