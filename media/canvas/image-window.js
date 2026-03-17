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

  const aspectRatio = sourceW / sourceH;

  // Use shared _createImageWindowFromDef for DOM creation
  _createImageWindowFromDef(id, {
    x, y, w, h: totalH,
    imgSrc, naturalW: sourceW, naturalH: sourceH, aspectRatio,
  });

  bringToFront(id);
  updateMinimap();

  // Notify host about creation (sync to other webview)
  sendSync({
    type: 'sync:imageWindowCreated',
    id, x, y, w, h: totalH,
    imgSrc, naturalW: sourceW, naturalH: sourceH, aspectRatio,
  });
}
