// ─── Terminal Window ─────────────────────────────────
// createTerminalWindow() — requests terminal creation from host (ID assigned by host)

async function createTerminalWindow(x, y) {
  // Request host to create terminal (host assigns ID and broadcasts sync:terminalCreated)
  vscodeApi.postMessage({
    type: 'sync:requestTerminal',
    x: x !== undefined ? x : (windows.size * 30 + 50),
    y: y !== undefined ? y : (windows.size * 30 + 50),
    w: 900,
    h: 380,
    cols: 80,
    rows: 24,
  });
  // The actual window creation happens when we receive sync:terminalCreated back
}
