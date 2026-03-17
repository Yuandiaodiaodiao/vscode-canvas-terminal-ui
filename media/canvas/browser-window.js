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

  // Use shared _createBrowserWindowFromDef for DOM creation
  _createBrowserWindowFromDef(id, { x, y, w, h: totalH, url });

  bringToFront(id);
  updateMinimap();

  // Notify host about creation (sync to other webview)
  sendSync({
    type: 'sync:browserWindowCreated',
    id, x, y, w, h: totalH, url,
  });
}
