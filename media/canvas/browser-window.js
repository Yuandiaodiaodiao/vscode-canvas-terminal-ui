// ─── Browser Window (iframe) ─────────────────────────
// createBrowserWindow() - from clipboard paste URL

function createBrowserWindow(url) {
  const id = 'browser_' + nextBrowserId++;
  const w = 800, h = 600;
  const TITLE_H = 32;
  const totalH = h + TITLE_H;

  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  const x = (vw / 2 - canvasX) / zoom - w / 2;
  const y = (vh / 2 - canvasY) / zoom - totalH / 2;

  const el = document.createElement('div');
  el.className = 'browser-window';
  el.dataset.id = id;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = totalH + 'px';
  el.style.zIndex = ++maxZIndex;

  // Truncate URL for display
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

  // Create iframe via DOM API
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  iframe.allow = 'fullscreen';
  el.querySelector('.browser-body').appendChild(iframe);

  canvas.appendChild(el);

  const winData = { el, x, y, w, h: totalH, id };
  imageWindows.set(id, winData);

  // ─── Drag (title bar) ───────────────────────────
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
    }
  });

  // ─── Resize handles (free aspect) ───────────────
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
