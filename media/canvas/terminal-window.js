// ─── Terminal Window ─────────────────────────────────
// createTerminalWindow() and terminal-specific logic

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
    quickBtnsHtml += '<button class="quick-cmd" data-cmd-index="' + i + '" title="Run: ' + cmd.command.replace('\n', ' ⏎') + '">' + cmd.label + '</button>';
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

    winData.x = newX;
    winData.y = newY;
    el.style.left = winData.x + 'px';
    el.style.top = winData.y + 'px';
    updateMinimap();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging && noOverlap) resolveOverlaps(id);
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

  // Wheel routing is handled by the global document-level wheel listener

  // ─── Close button ──────────────────────────────
  el.querySelector('.close').addEventListener('click', () => {
    closeWindow(id);
  });

  updateMinimap();
  return id;
}
