// ─── Init ────────────────────────────────────────────
// Initialization, toolbar bindings, message handler, layout presets

// ─── Zoom buttons ────────────────────────────────
document.getElementById('btn-zoom-in').onclick = () => zoomTo(zoom * 1.2);
document.getElementById('btn-zoom-out').onclick = () => zoomTo(zoom / 1.2);
document.getElementById('btn-zoom-fit').onclick = fitAll;

// ─── Grid snap toggle ────────────────────────────
document.getElementById('btn-snap').onclick = (e) => {
  gridSnap = !gridSnap;
  e.target.style.background = gridSnap ? 'var(--vscode-button-background, #0e639c)' : '';
  e.target.style.color = gridSnap ? 'var(--vscode-button-foreground, #fff)' : '';
  sendSync({ type: 'sync:toggleChanged', key: 'gridSnap', value: gridSnap });
};

// ─── No-overlap toggle ───────────────────────────
document.getElementById('btn-overlap').onclick = (e) => {
  noOverlap = !noOverlap;
  e.target.style.background = noOverlap ? 'var(--vscode-button-background, #0e639c)' : '';
  e.target.style.color = noOverlap ? 'var(--vscode-button-foreground, #fff)' : '';
  sendSync({ type: 'sync:toggleChanged', key: 'noOverlap', value: noOverlap });
};

// ─── Pop-out to separate panel ─────────────────
document.getElementById('btn-pop-out').onclick = () => {
  vscodeApi.postMessage({ type: 'openInPanel' });
};

// ─── Add terminal button ─────────────────────────
const NEW_TERMINAL_W = 600;
const NEW_TERMINAL_H = 380;

async function createTerminalAtClientPoint(clientX, clientY) {
  console.log('[TerminalCanvas] create terminal at point, xtermReady:', xtermReady);
  if (!xtermReady) {
    console.error('[TerminalCanvas] xterm not loaded yet, retrying init...');
    init().catch(err => console.error('[TerminalCanvas] init retry failed:', err));
    return;
  }

  const rect = viewport.getBoundingClientRect();
  const canvasCenterX = (clientX - rect.left - canvasX) / zoom;
  const canvasCenterY = (clientY - rect.top - canvasY) / zoom;
  const x = canvasCenterX - NEW_TERMINAL_W / 2;
  const y = canvasCenterY - NEW_TERMINAL_H / 2;

  try {
    await createTerminalWindow(x, y);
  } catch (err) {
    console.error('[TerminalCanvas] createTerminalWindow failed:', err);
  }
}

async function createCenteredTerminal() {
  const rect = viewport.getBoundingClientRect();
  await createTerminalAtClientPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
}

window.createCenteredTerminal = createCenteredTerminal;
window.createTerminalAtClientPoint = createTerminalAtClientPoint;

document.getElementById('btn-add').addEventListener('click', (e) => {
  e.stopPropagation();
  createCenteredTerminal();
});

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
      await new Promise(r => setTimeout(r, 200));
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
    await new Promise(r => setTimeout(r, 200));
  }
  setTimeout(fitAll, 300);
}

// ─── Messages from extension host ────────────────
window.addEventListener('message', (e) => {
  const msg = e.data;

  // Handle sync messages from host
  if (msg.type && msg.type.startsWith('sync:')) {
    handleSyncMessage(msg);
    return;
  }

  switch (msg.type) {
    case 'output': {
      const w = windows.get(msg.id);
      if (w) w.xterm.write(msg.data);
      break;
    }
    case 'terminated': {
      const w = windows.get(msg.id);
      if (w) {
        w.xterm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      }
      break;
    }
    case 'error': {
      const w = windows.get(msg.id);
      if (w) {
        w.xterm.write('\r\n\x1b[31m' + msg.message + '\x1b[0m\r\n');
      }
      break;
    }
    case 'pasteData': {
      // Extension host sends all clipboard data at once.
      // Webview decides based on the paste target captured at trigger time.
      const pasteTarget = takePendingPasteTarget() || getCurrentPasteTarget();
      if (pasteTarget.kind === 'terminal' && pasteTarget.id) {
        // Mouse is on terminal → paste text into terminal
        if (msg.text) {
          vscodeApi.postMessage({ type: 'input', id: pasteTarget.id, data: msg.text });
        }
      } else {
        // Mouse is NOT on terminal → create image/browser/ignore
        if (msg.image) {
          createImageWindow(msg.image, msg.imageWidth, msg.imageHeight);
        } else if (msg.text && /^https?:\/\//i.test(msg.text)) {
          createBrowserWindow(msg.text);
        }
        // plain text with no terminal under mouse → do nothing
      }
      break;
    }
  }
});

// ─── Init: load xterm and wait for snapshot ──────
async function init() {
  try {
    // Load from local bundled files
    await loadCSS(XTERM_CSS_URI);
    await loadScript(XTERM_JS_URI);
    await loadScript(XTERM_FIT_JS_URI);
    xtermReady = true;
    console.log('[TerminalCanvas] xterm loaded from local');
  } catch (e) {
    console.warn('[TerminalCanvas] local load failed, trying CDN...', e);
    try {
      await loadCSS(XTERM_BASE + '/css/xterm.css');
      await loadScript(XTERM_BASE + '/lib/xterm.js');
      await loadScript(XTERM_FIT_BASE + '/lib/xterm-addon-fit.js');
      xtermReady = true;
      console.log('[TerminalCanvas] xterm loaded from CDN');
    } catch (e2) {
      console.error('[TerminalCanvas] Failed to load xterm from both local and CDN:', e2);
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:40px;left:0;right:0;padding:12px;background:#3a1515;color:#f88;font-size:12px;z-index:9998;text-align:center;';
      banner.textContent = 'Failed to load xterm.js. Check network/CSP.';
      document.body.appendChild(banner);
      return;
    }
  }

  // Wait a moment for potential snapshot from host
  await new Promise(r => setTimeout(r, 300));

  // Only create initial terminal if no snapshot provided existing state
  if (!_snapshotReceived && windows.size === 0) {
    createTerminalWindow(50, 50);
  }
}

init().catch(e => console.error('[TerminalCanvas] init failed:', e));
