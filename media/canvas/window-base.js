// ─── Window Base ─────────────────────────────────────
// Shared window management: bringToFront, closeWindow, resolveOverlaps

function bringToFront(id) {
  const w = windows.get(id) || imageWindows.get(id);
  if (!w) return;
  for (const win of windows.values()) win.el.classList.remove('focused');
  for (const win of imageWindows.values()) win.el.classList.remove('focused');
  w.el.classList.add('focused');
  w.el.style.zIndex = ++maxZIndex;
  sendSync({ type: 'sync:windowFocused', id });
}

function closeWindow(id) {
  const w = windows.get(id);
  if (!w) return;
  sendSync({ type: 'sync:terminalClosed', id });
  vscodeApi.postMessage({ type: 'closeTerminal', id });
  w.xterm.dispose();
  w.el.remove();
  windows.delete(id);
  updateMinimap();
}

// ─── Resolve overlaps after drag/resize ──────────
function resolveOverlaps(draggedId) {
  // Collect all window rects
  const allWins = [];
  for (const [wid, win] of windows) {
    allWins.push({ id: wid, x: win.x, y: win.y, w: win.w, h: win.h, src: 'windows', ref: win });
  }
  for (const [wid, win] of imageWindows) {
    allWins.push({ id: wid, x: win.x, y: win.y, w: win.w, h: win.h, src: 'imageWindows', ref: win });
  }
  if (allWins.length < 2) return;

  const GAP = 8; // small gap between separated windows
  const MAX_ITER = 50;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;
    for (let i = 0; i < allWins.length; i++) {
      for (let j = i + 1; j < allWins.length; j++) {
        const a = allWins[i];
        const b = allWins[j];

        // AABB overlap test
        if (a.x >= b.x + b.w || a.x + a.w <= b.x ||
            a.y >= b.y + b.h || a.y + a.h <= b.y) continue;

        // Overlap amounts
        const overlapX = Math.min(a.x + a.w - b.x, b.x + b.w - a.x);
        const overlapY = Math.min(a.y + a.h - b.y, b.y + b.h - a.y);

        let dx = 0, dy = 0;
        if (overlapX < overlapY) {
          dx = overlapX + GAP;
          // Push in direction of center offset
          if ((a.x + a.w / 2) > (b.x + b.w / 2)) dx = -dx;
        } else {
          dy = overlapY + GAP;
          if ((a.y + a.h / 2) > (b.y + b.h / 2)) dy = -dy;
        }

        // The dragged window stays fixed, push the other one
        const aFixed = (a.id === draggedId);
        const bFixed = (b.id === draggedId);

        if (aFixed && !bFixed) {
          b.x -= dx; b.y -= dy;
        } else if (bFixed && !aFixed) {
          a.x += dx; a.y += dy;
        } else {
          // Neither is the dragged one — split evenly
          a.x += dx / 2; a.y += dy / 2;
          b.x -= dx / 2; b.y -= dy / 2;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Write positions back and collect updates for sync
  const syncUpdates = [];
  for (const rect of allWins) {
    rect.ref.x = Math.round(rect.x);
    rect.ref.y = Math.round(rect.y);
    rect.ref.el.style.left = rect.ref.x + 'px';
    rect.ref.el.style.top = rect.ref.y + 'px';

    syncUpdates.push({ id: rect.id, x: rect.ref.x, y: rect.ref.y });

    // If terminal, refit
    if (rect.src === 'windows' && rect.ref.fitAddon) {
      try {
        rect.ref.fitAddon.fit();
        vscodeApi.postMessage({ type: 'resize', id: rect.ref.id, cols: rect.ref.xterm.cols, rows: rect.ref.xterm.rows });
      } catch (_) {}
    }
  }
  updateMinimap();

  // Batch sync all moved windows
  sendSync({ type: 'sync:allWindowsMoved', updates: syncUpdates });
}
