// ─── Image Window ────────────────────────────────────
// createImageWindow() - from clipboard paste

function createImageWindow(imgSrc, naturalW, naturalH) {
  const id = 'img_' + nextImageId++;
  const TITLE_H = 28;
  const sourceW = Math.max(1, naturalW || 1);
  const sourceH = Math.max(1, naturalH || 1);

  // Start from the source pixel size and only scale down enough to fit the view.
  const maxScreenW = Math.max(240, viewport.clientWidth - 80);
  const maxScreenH = Math.max(180, viewport.clientHeight - 80);
  const maxCanvasW = maxScreenW / zoom;
  const maxCanvasH = Math.max(1, maxScreenH / zoom - TITLE_H);
  const scale = Math.min(1, maxCanvasW / sourceW, maxCanvasH / sourceH);

  const w = Math.max(1, Math.round(sourceW * scale));
  const h = Math.max(1, Math.round(sourceH * scale));
  const totalH = h + TITLE_H;

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
      '<span class="title">Image ' + (nextImageId - 1) + ' (' + sourceW + '×' + sourceH + ')</span>' +
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

  // Set image src via DOM to avoid innerHTML base64 corruption
  const imgEl = document.createElement('img');
  imgEl.onload = () => console.log('[Canvas] img loaded OK, natural:', imgEl.naturalWidth, 'x', imgEl.naturalHeight);
  imgEl.onerror = (e) => console.error('[Canvas] img FAILED to load', e);
  imgEl.src = imgSrc;
  el.querySelector('.image-body').appendChild(imgEl);

  canvas.appendChild(el);

  const winData = { el, x, y, w, h: totalH, id, aspectRatio: sourceW / sourceH };
  imageWindows.set(id, winData);

  // ─── Drag (title bar + image body both draggable) ──
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
  imageBody.addEventListener('mousedown', startDrag);
  imageBody.style.cursor = 'move';

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
    if (isDragging && noOverlap) resolveOverlaps(id);
    isDragging = false;
  });

  // ─── Resize handles (aspect-ratio locked) ─────────
  const ar = winData.aspectRatio; // naturalW / naturalH

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

        // Calculate new width from the dominant drag axis
        let nW;
        if (hasRight && !hasLeft) {
          nW = Math.max(100, snapValue(rW + dx));
        } else if (hasLeft) {
          nW = Math.max(100, snapValue(rW - dx));
        } else {
          // Vertical-only handle: derive width from height change
          const dH = hasTop ? -dy : dy;
          nW = Math.max(100, rW + dH * ar / (ar + 0.001));
        }

        // Enforce aspect ratio: imageH = nW / ar, totalH = imageH + titleBar
        const nH = Math.max(80, Math.round(nW / ar) + TITLE_H);
        // Re-derive nW from nH to keep it exact
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
    updateMinimap();
  });

  bringToFront(id);
  updateMinimap();
}
