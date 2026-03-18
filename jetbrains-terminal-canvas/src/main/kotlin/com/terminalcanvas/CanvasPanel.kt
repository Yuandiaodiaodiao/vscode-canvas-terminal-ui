package com.terminalcanvas

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.handler.CefKeyboardHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.misc.BoolRef
import java.awt.KeyboardFocusManager
import java.awt.KeyEventDispatcher
import java.awt.event.KeyEvent
import javax.swing.JComponent
import javax.swing.SwingUtilities

class CanvasPanel(private val project: Project) : Disposable {

    companion object {
        private val LOG = Logger.getInstance(CanvasPanel::class.java)
    }

    private val browser: JBCefBrowser = JBCefBrowser()
    private val jsQuery: JBCefJSQuery = JBCefJSQuery.create(browser as com.intellij.ui.jcef.JBCefBrowserBase)
    private val gson = Gson()
    private val terminalManager = TerminalManager(project)
    private val sharedState = SharedState()
    private val syncBridge = SyncBridge(sharedState)
    private val terminalIOBridge = TerminalIOBridge(sharedState)
    private val myPid = ProcessHandle.current().pid()
    @Volatile
    private var bridgeReady = false
    @Volatile
    private var pageLoaded = false
    @Volatile
    private var disposed = false
    private var keyDispatcher: KeyEventDispatcher? = null
    private val pendingMessages = mutableListOf<JsonObject>()

    val component: JComponent
        get() = browser.component

    init {
        LOG.info("[TC] CanvasPanel init")

        // JS→Kotlin: handle messages from webview
        jsQuery.addHandler { jsonStr ->
            LOG.info("[TC] JS→Kotlin raw: ${jsonStr.take(200)}")
            handleWebviewMessage(jsonStr)
            null
        }

        // Terminal output → webview + IO bridge for remote subscribers
        terminalManager.onOutput = { id, data ->
            sharedState.bufferOutput(id, data)
            postMessageToWebview(buildJsonObject("type" to "output", "id" to id, "data" to data))
            terminalIOBridge.pushOutput(id, data)
        }
        terminalManager.onTerminated = { id, exitCode ->
            LOG.info("[TC] Terminal $id terminated with exitCode=$exitCode")
            sharedState.removeTerminal(id)
            postMessageToWebview(buildJsonObject("type" to "terminated", "id" to id, "exitCode" to exitCode))
            terminalIOBridge.pushTerminated(id, exitCode)
        }
        terminalManager.onTerminalInfo = { id, cwd ->
            LOG.info("[TC] Terminal $id info: cwd=$cwd")
            sharedState.updateTerminalCwd(id, cwd)
            postMessageToWebview(buildJsonObject("type" to "sync:terminalInfo", "id" to id, "cwd" to cwd))
            syncBridge.broadcastChange(buildJsonObject("type" to "sync:terminalInfo", "id" to id, "cwd" to cwd))
        }
        terminalManager.onError = { id, message ->
            LOG.warn("[TC] Terminal $id error: $message")
            postMessageToWebview(buildJsonObject("type" to "error", "id" to id, "message" to message))
        }

        // Load webview HTML when JCEF is ready
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser?, frame: org.cef.browser.CefFrame?, httpStatusCode: Int) {
                if (frame?.isMain == true) {
                    LOG.info("[TC] onLoadEnd (main frame), httpStatus=$httpStatusCode, url=${cefBrowser?.url?.take(80)}")
                    injectBridge()
                }
            }
        }, browser.cefBrowser)

        // Intercept Ctrl+key at native level before Chromium consumes them.
        // Chromium eats Ctrl+C/V/X/A/Z as browser clipboard/undo shortcuts at the
        // native layer — JS keydown never fires. We must intercept here and inject
        // the control character into the focused terminal ourselves.
        browser.jbCefClient.addKeyboardHandler(object : CefKeyboardHandler {
            override fun onPreKeyEvent(
                cefBrowser: CefBrowser?,
                event: CefKeyboardHandler.CefKeyEvent?,
                is_keyboard_shortcut: BoolRef?
            ): Boolean {
                if (event == null) return false
                if (event.type != CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_RAWKEYDOWN) return false
                val modifiers = event.modifiers
                val hasCtrl = (modifiers and 0x04) != 0
                val hasMeta = (modifiers and 0x08) != 0
                val hasAlt  = (modifiers and 0x10) != 0
                if (!hasCtrl || hasMeta || hasAlt) return false

                val ch = event.character.lowercaseChar()
                if (ch !in 'a'..'z') return false

                val ctrlCode = ch.code - 'a'.code + 1
                LOG.info("[TC] CEF onPreKeyEvent Ctrl+$ch → 0x${ctrlCode.toString(16).padStart(2, '0')}")
                sendCtrlCharToFocusedTerminal(cefBrowser, ctrlCode)
                is_keyboard_shortcut?.set(false)
                return true
            }

            override fun onKeyEvent(cefBrowser: CefBrowser?, event: CefKeyboardHandler.CefKeyEvent?): Boolean {
                return false
            }
        }, browser.cefBrowser)

        // Swing-level KeyEventDispatcher: catches Ctrl+key BEFORE Swing focus traversal
        // and IntelliJ keymaps consume them. This is needed because Ctrl+Tab, Ctrl+C etc
        // get intercepted by Swing/IDE before they ever reach CEF's onPreKeyEvent.
        keyDispatcher = KeyEventDispatcher { e ->
            if (disposed) return@KeyEventDispatcher false
            if (e.id != KeyEvent.KEY_PRESSED) return@KeyEventDispatcher false
            if (!e.isControlDown || e.isMetaDown || e.isAltDown) return@KeyEventDispatcher false

            // Only intercept when our JCEF browser component has focus
            val focusOwner = KeyboardFocusManager.getCurrentKeyboardFocusManager().focusOwner
            if (focusOwner == null || !SwingUtilities.isDescendingFrom(focusOwner, browser.component)) {
                return@KeyEventDispatcher false
            }

            val ch = e.keyChar
            val keyCode = e.keyCode

            // Map Ctrl+letter keys
            val letter: Char? = when {
                keyCode in KeyEvent.VK_A..KeyEvent.VK_Z -> ('a' + (keyCode - KeyEvent.VK_A))
                ch in 'a'..'z' -> ch
                ch in '\u0001'..'\u001a' -> ('a' + (ch.code - 1))  // control chars map back
                else -> null
            }

            if (letter == null) return@KeyEventDispatcher false

            val ctrlCode = letter.code - 'a'.code + 1
            LOG.info("[TC] Swing KeyEventDispatcher Ctrl+$letter → 0x${ctrlCode.toString(16).padStart(2, '0')}")
            sendCtrlCharToFocusedTerminal(browser.cefBrowser, ctrlCode)
            e.consume()
            true  // consumed — don't let Swing/IDE process it
        }
        KeyboardFocusManager.getCurrentKeyboardFocusManager().addKeyEventDispatcher(keyDispatcher)

        // TerminalIOBridge: handle remote terminal I/O
        terminalIOBridge.onRemoteOutput = { terminalId, data ->
            sharedState.bufferOutput(terminalId, data)
            postMessageToWebview(buildJsonObject("type" to "output", "id" to terminalId, "data" to data))
        }
        terminalIOBridge.onRemoteTerminated = { terminalId, exitCode ->
            sharedState.removeTerminal(terminalId)
            postMessageToWebview(buildJsonObject("type" to "terminated", "id" to terminalId, "exitCode" to exitCode))
        }
        terminalIOBridge.onRemoteInput = { terminalId, data ->
            terminalManager.sendInput(terminalId, data)
        }
        terminalIOBridge.onRemoteResize = { terminalId, cols, rows ->
            sharedState.state.terminalWindows[terminalId]?.let { it.cols = cols; it.rows = rows }
            terminalManager.resize(terminalId, cols, rows)
        }

        // SyncBridge: forward remote changes to local webview
        syncBridge.onRemoteChange = { msg ->
            postMessageToWebview(msg)
        }
        // SyncBridge: subscribe to remote terminal I/O when a remote terminal is discovered
        syncBridge.onSubscribeRemoteTerminal = { ownerPid, terminalId ->
            terminalIOBridge.subscribe(ownerPid, listOf(terminalId))
        }

        // Start IPC bridges in background
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            try {
                terminalIOBridge.startServer()
            } catch (e: Exception) {
                LOG.warn("[TC] TerminalIOBridge start failed: ${e.message}")
            }
            try {
                syncBridge.start()
            } catch (e: Exception) {
                LOG.warn("[TC] SyncBridge start failed: ${e.message}")
            }
        }

        loadHtml()

        Disposer.register(this, browser)
    }

    private fun loadHtml() {
        val html = buildHtml()
        LOG.info("[TC] Loading HTML (${html.length} chars)")
        browser.loadHTML(html)
    }

    private fun buildHtml(): String {
        val stylesCss = loadResource("/webview/canvas/styles.css")
        val xtermCss = loadResource("/webview/xterm/xterm.css")

        // Verify resources loaded
        LOG.info("[TC] styles.css: ${stylesCss.length} chars, xterm.css: ${xtermCss.length} chars")

        // Read colors from the current JetBrains theme
        val themeVars = buildThemeCssVars()

        return """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal Canvas</title>
  <style>
    :root {
$themeVars
    }
  </style>
  <style>${stylesCss}</style>
  <style>${xtermCss}</style>
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
    <span class="hint">拖拽平移 | 滚轮上下 | Shift+滚轮左右 | Cmd/Ctrl+滚轮缩放 | Ctrl+V 粘贴图片/网页</span>
    <button id="btn-pop-out" class="secondary" style="display:none;">&#8599;</button>
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

  <div id="canvas-viewport" tabindex="0" aria-label="Terminal Canvas">
    <div id="canvas"></div>
  </div>

  <div id="minimap">
    <div class="minimap-viewport" id="minimap-viewport"></div>
  </div>

  <script>
    // ─── Debug logging ──────────────────────────────
    window._tcLog = function(msg) {
      console.log('[TC-JS] ' + msg);
    };
    window._tcLog('Bridge shim loading...');

    window.__CANVAS_CONFIG = {
      xtermCssUri: '',
      xtermJsUri: '',
      xtermFitJsUri: '',
      nonce: ''
    };

    // Message queue for before bridge is ready
    window._jbMsgQueue = [];
    window._jbBridgeReady = false;

    // Polyfill acquireVsCodeApi() for JetBrains JCEF
    window.acquireVsCodeApi = function() {
      window._tcLog('acquireVsCodeApi() called');
      return {
        postMessage: function(msg) {
          var jsonStr = JSON.stringify(msg);
          window._tcLog('postMessage: ' + jsonStr.substring(0, 120));
          if (window._jbBridgeReady && window._jbBridge) {
            try {
              window._jbBridge(jsonStr);
            } catch(e) {
              window._tcLog('ERROR calling _jbBridge: ' + e);
            }
          } else {
            window._tcLog('Bridge not ready, queueing (queue size: ' + window._jbMsgQueue.length + ')');
            window._jbMsgQueue.push(jsonStr);
          }
        },
        getState: function() { return null; },
        setState: function() {}
      };
    };

    // Host→JS message callback
    window._onHostMessage = function(msg) {
      window._tcLog('Host→JS: type=' + (msg && msg.type || 'unknown'));
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    };

    window._xtermPreloaded = true;
    window._tcLog('Bridge shim loaded');
  </script>
  ${inlineScript("/webview/xterm/xterm.js")}
  ${inlineScript("/webview/xterm/xterm-addon-fit.js")}
  ${inlineScript("/webview/canvas/canvas-core.js")}
  ${inlineScript("/webview/canvas/window-base.js")}
  ${inlineScript("/webview/canvas/terminal-window.js")}
  ${inlineScript("/webview/canvas/image-window.js")}
  ${inlineScript("/webview/canvas/browser-window.js")}
  ${inlineScript("/webview/canvas/sync-handler.js")}
  ${inlineScript("/webview/canvas/init.js")}
</body>
</html>
"""
    }

    private fun inlineScript(resourcePath: String): String {
        val content = loadResource(resourcePath)
        if (content.isEmpty()) {
            LOG.warn("[TC] Resource is EMPTY: $resourcePath")
        }
        return "<script>$content</script>"
    }

    private fun loadResource(path: String): String {
        val stream = this::class.java.getResourceAsStream(path)
        if (stream == null) {
            LOG.error("[TC] Resource NOT FOUND: $path")
            return ""
        }
        return stream.bufferedReader().readText()
    }

    /** Read colors from JetBrains UI theme and map to --vscode-* CSS variables */
    private fun buildThemeCssVars(): String {
        val editorScheme = try {
            com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme
        } catch (_: Exception) { null }

        fun colorToHex(c: java.awt.Color): String = "#${"%02x%02x%02x".format(c.red, c.green, c.blue)}"

        fun darken(c: java.awt.Color, factor: Double): java.awt.Color {
            return java.awt.Color(
                (c.red * factor).toInt().coerceIn(0, 255),
                (c.green * factor).toInt().coerceIn(0, 255),
                (c.blue * factor).toInt().coerceIn(0, 255)
            )
        }
        fun lighten(c: java.awt.Color, factor: Double): java.awt.Color {
            return java.awt.Color(
                (c.red + (255 - c.red) * factor).toInt().coerceIn(0, 255),
                (c.green + (255 - c.green) * factor).toInt().coerceIn(0, 255),
                (c.blue + (255 - c.blue) * factor).toInt().coerceIn(0, 255)
            )
        }

        // Detect if the current theme is dark
        @Suppress("DEPRECATION")
        val isDark = com.intellij.util.ui.UIUtil.isUnderDarcula() ||
            (try {
                javax.swing.UIManager.getLookAndFeel().name.lowercase().let {
                    it.contains("dark") || it.contains("darcula")
                }
            } catch (_: Exception) { false })

        // Editor/terminal background
        val editorBg = editorScheme?.defaultBackground
            ?: javax.swing.UIManager.getColor("EditorPane.background")
            ?: if (isDark) java.awt.Color(0x1e, 0x1e, 0x1e) else java.awt.Color(0xff, 0xff, 0xff)

        // Panel/toolbar background (titleBar)
        val panelBg = javax.swing.UIManager.getColor("Panel.background")
            ?: if (isDark) java.awt.Color(0x3c, 0x3f, 0x41) else java.awt.Color(0xf2, 0xf2, 0xf2)

        // Foreground
        val fg = editorScheme?.defaultForeground
            ?: javax.swing.UIManager.getColor("Label.foreground")
            ?: if (isDark) java.awt.Color(0xbb, 0xbb, 0xbb) else java.awt.Color(0x00, 0x00, 0x00)

        // Border color
        val borderColor = javax.swing.UIManager.getColor("Component.borderColor")
            ?: javax.swing.UIManager.getColor("Borders.color")
            ?: if (isDark) java.awt.Color(0x44, 0x44, 0x44) else java.awt.Color(0xc4, 0xc4, 0xc4)

        // Button colors
        val buttonBg = javax.swing.UIManager.getColor("Button.default.startBackground")
            ?: javax.swing.UIManager.getColor("Button.startBackground")
            ?: if (isDark) java.awt.Color(0x36, 0x58, 0x80) else java.awt.Color(0x52, 0x8b, 0xcc)
        val buttonFg = javax.swing.UIManager.getColor("Button.default.foreground")
            ?: java.awt.Color.WHITE
        val buttonHoverBg = if (isDark) lighten(buttonBg, 0.15) else darken(buttonBg, 0.1)

        // Secondary button
        val secondaryBg = javax.swing.UIManager.getColor("Button.startBackground")
            ?: if (isDark) java.awt.Color(0x3a, 0x3d, 0x41) else java.awt.Color(0xe8, 0xe8, 0xe8)
        val secondaryFg = fg
        val secondaryHoverBg = if (isDark) lighten(secondaryBg, 0.1) else darken(secondaryBg, 0.08)

        // Description / muted foreground
        val descFg = javax.swing.UIManager.getColor("Component.infoForeground")
            ?: javax.swing.UIManager.getColor("Label.disabledForeground")
            ?: if (isDark) java.awt.Color(0x88, 0x88, 0x88) else java.awt.Color(0x78, 0x78, 0x78)

        // Focus border
        val focusBorder = javax.swing.UIManager.getColor("Component.focusColor")
            ?: javax.swing.UIManager.getColor("Focus.color")
            ?: if (isDark) java.awt.Color(0x35, 0x74, 0xf0) else java.awt.Color(0x35, 0x74, 0xf0)

        // Menu colors
        val menuBg = javax.swing.UIManager.getColor("PopupMenu.background")
            ?: javax.swing.UIManager.getColor("Menu.background")
            ?: if (isDark) java.awt.Color(0x2b, 0x2d, 0x30) else java.awt.Color(0xf2, 0xf2, 0xf2)
        val menuFg = javax.swing.UIManager.getColor("PopupMenu.foreground")
            ?: javax.swing.UIManager.getColor("Menu.foreground")
            ?: fg
        val menuSelBg = javax.swing.UIManager.getColor("MenuItem.selectionBackground")
            ?: javax.swing.UIManager.getColor("List.selectionBackground")
            ?: if (isDark) java.awt.Color(0x2e, 0x43, 0x6e) else java.awt.Color(0xd4, 0xe2, 0xfc)
        val menuSelFg = javax.swing.UIManager.getColor("MenuItem.selectionForeground")
            ?: javax.swing.UIManager.getColor("List.selectionForeground")
            ?: if (isDark) java.awt.Color.WHITE else java.awt.Color.BLACK
        val menuBorder = javax.swing.UIManager.getColor("Popup.borderColor")
            ?: borderColor

        // Font family
        val fontFamily = "'JetBrains Mono', 'Consolas', 'Courier New', monospace"

        val vars = mapOf(
            "--vscode-editor-background" to colorToHex(editorBg),
            "--vscode-font-family" to fontFamily,
            "--vscode-titleBar-activeBackground" to colorToHex(panelBg),
            "--vscode-panel-border" to colorToHex(borderColor),
            "--vscode-button-background" to colorToHex(buttonBg),
            "--vscode-button-foreground" to colorToHex(buttonFg),
            "--vscode-button-hoverBackground" to colorToHex(buttonHoverBg),
            "--vscode-button-secondaryBackground" to colorToHex(secondaryBg),
            "--vscode-button-secondaryForeground" to colorToHex(secondaryFg),
            "--vscode-button-secondaryHoverBackground" to colorToHex(secondaryHoverBg),
            "--vscode-foreground" to colorToHex(fg),
            "--vscode-descriptionForeground" to colorToHex(descFg),
            "--vscode-focusBorder" to colorToHex(focusBorder),
            "--vscode-terminal-background" to colorToHex(editorBg),
            "--vscode-editor-fontFamily" to fontFamily,
            "--vscode-menu-background" to colorToHex(menuBg),
            "--vscode-menu-border" to colorToHex(menuBorder),
            "--vscode-menu-foreground" to colorToHex(menuFg),
            "--vscode-menu-selectionBackground" to colorToHex(menuSelBg),
            "--vscode-menu-selectionForeground" to colorToHex(menuSelFg),
        )

        return vars.entries.joinToString("\n") { (k, v) ->
            if (k.contains("fontFamily") || k.contains("font-family")) {
                "      $k: $v;"
            } else {
                "      $k: $v;"
            }
        }
    }

    private fun injectBridge() {
        val queryFunc = jsQuery.inject("msg")
        LOG.info("[TC] Injecting bridge, queryFunc template: ${queryFunc.take(100)}...")

        // The bridge function + flush logic
        val js = """
            (function() {
                window._tcLog('Injecting _jbBridge...');

                window._jbBridge = function(msg) {
                    $queryFunc
                };
                window._jbBridgeReady = true;

                // Flush queued messages
                var queue = window._jbMsgQueue || [];
                window._jbMsgQueue = [];
                window._tcLog('Flushing ' + queue.length + ' queued messages');
                for (var i = 0; i < queue.length; i++) {
                    try {
                        window._tcLog('Flush msg: ' + queue[i].substring(0, 100));
                        window._jbBridge(queue[i]);
                    } catch(e) {
                        window._tcLog('ERROR flushing msg ' + i + ': ' + e);
                    }
                }
                window._tcLog('Bridge ready!');
            })();
        """.trimIndent()
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
        bridgeReady = true
        pageLoaded = true
        LOG.info("[TC] Bridge injection JS sent")

        // Flush any messages that arrived before the page was loaded
        flushPendingMessages()
    }

    private fun flushPendingMessages() {
        val toFlush: List<JsonObject>
        synchronized(pendingMessages) {
            toFlush = pendingMessages.toList()
            pendingMessages.clear()
        }
        if (toFlush.isNotEmpty()) {
            LOG.info("[TC] Flushing ${toFlush.size} pending messages to webview")
            for (msg in toFlush) {
                doPostMessageToWebview(msg)
            }
        }
    }

    private fun handleWebviewMessage(jsonStr: String) {
        if (disposed) return
        try {
            val msg = gson.fromJson(jsonStr, JsonObject::class.java)
            val type = msg.get("type")?.asString ?: run {
                LOG.warn("[TC] Message has no type: ${jsonStr.take(200)}")
                return
            }

            LOG.info("[TC] handleMessage: type=$type")

            when {
                type.startsWith("sync:") -> handleSyncMessage(msg, type)
                type == "input" -> {
                    val id = msg.get("id")?.asInt ?: run {
                        LOG.warn("[TC] input: missing id"); return
                    }
                    val data = msg.get("data")?.asString ?: run {
                        LOG.warn("[TC] input: missing data"); return
                    }
                    val tw = sharedState.state.terminalWindows[id]
                    if (tw != null) {
                        val ownerPid = tw.ownerPid
                        if (ownerPid == null || ownerPid == myPid) {
                            // Local terminal
                            terminalManager.sendInput(id, data)
                        } else {
                            // Remote terminal — forward input to owner
                            terminalIOBridge.forwardInput(ownerPid, id, data)
                        }
                    } else {
                        LOG.warn("[TC] input: terminal $id not found in sharedState (keys=${sharedState.state.terminalWindows.keys})")
                    }
                }
                type == "resize" -> {
                    val id = msg.get("id")?.asInt ?: return
                    val cols = msg.get("cols")?.asInt ?: return
                    val rows = msg.get("rows")?.asInt ?: return
                    LOG.info("[TC] resize: id=$id cols=$cols rows=$rows")
                    val tw = sharedState.state.terminalWindows[id]
                    if (tw != null) {
                        tw.cols = cols
                        tw.rows = rows
                        val ownerPid = tw.ownerPid
                        if (ownerPid == null || ownerPid == myPid) {
                            terminalManager.resize(id, cols, rows)
                        } else {
                            terminalIOBridge.forwardResize(ownerPid, id, cols, rows)
                        }
                        syncBridge.broadcastChange(buildJsonObject(
                            "type" to "sync:terminalResize", "id" to id, "cols" to cols, "rows" to rows
                        ))
                    } else {
                        LOG.warn("[TC] resize: terminal $id not found")
                    }
                }
                type == "closeTerminal" -> {
                    val id = msg.get("id")?.asInt ?: return
                    LOG.info("[TC] closeTerminal: id=$id")
                    terminalManager.close(id)
                    sharedState.removeTerminal(id)
                    syncBridge.broadcastChange(buildJsonObject(
                        "type" to "sync:terminalClosed", "id" to id
                    ))
                }
                type == "requestPasteData" -> {
                    handlePaste()
                }
                type == "openInPanel" -> {
                    // No-op in JetBrains
                }
                else -> {
                    LOG.info("[TC] Unhandled message type: $type")
                }
            }
        } catch (e: Exception) {
            LOG.error("[TC] Error handling webview message: ${e.message}", e)
        }
    }

    private fun handleSyncMessage(msg: JsonObject, type: String) {
        LOG.info("[TC] handleSyncMessage: $type")
        when (type) {
            "sync:requestTerminal" -> {
                val id = sharedState.nextTerminalId()
                val x = msg.get("x")?.asDouble ?: 50.0
                val y = msg.get("y")?.asDouble ?: 50.0
                val w = msg.get("w")?.asDouble ?: 600.0
                val h = msg.get("h")?.asDouble ?: 380.0
                val cols = msg.get("cols")?.asInt ?: 80
                val rows = msg.get("rows")?.asInt ?: 24
                val zIndex = sharedState.nextZIndex()

                LOG.info("[TC] Creating terminal: id=$id at ($x, $y) ${cols}x${rows}")

                sharedState.addTerminalWindow(id, x, y, w, h, zIndex, cols, rows, ownerPid = myPid)

                // Notify webview to create the terminal window UI
                val createMsg = buildJsonObject(
                    "type" to "sync:terminalCreated",
                    "id" to id,
                    "x" to x, "y" to y, "w" to w, "h" to h,
                    "zIndex" to zIndex,
                    "ownerPid" to myPid,
                    "isLocal" to true
                )
                postMessageToWebview(createMsg)

                // Broadcast to other instances (they create UI + subscribe for I/O)
                syncBridge.broadcastChange(buildJsonObject(
                    "type" to "sync:terminalCreated",
                    "id" to id,
                    "x" to x, "y" to y, "w" to w, "h" to h,
                    "zIndex" to zIndex,
                    "ownerPid" to myPid
                ))

                // Create actual pty (small delay so webview sets up xterm first)
                ApplicationManager.getApplication().executeOnPooledThread {
                    Thread.sleep(150)
                    LOG.info("[TC] Creating pty for terminal $id")
                    terminalManager.createTerminal(id, cols, rows)
                }
            }
            "sync:windowMoved" -> {
                val id = msg.get("id")?.asString ?: msg.get("id")?.asInt?.toString() ?: return
                val x = msg.get("x")?.asDouble ?: return
                val y = msg.get("y")?.asDouble ?: return
                sharedState.updateWindowPosition(id, x, y)
                syncBridge.broadcastChange(msg)
            }
            "sync:windowResized" -> {
                val id = msg.get("id")?.asString ?: msg.get("id")?.asInt?.toString() ?: return
                val x = msg.get("x")?.asDouble ?: return
                val y = msg.get("y")?.asDouble ?: return
                val w = msg.get("w")?.asDouble ?: return
                val h = msg.get("h")?.asDouble ?: return
                sharedState.updateWindowRect(id, x, y, w, h)
                syncBridge.broadcastChange(msg)
            }
            "sync:windowFocused" -> {
                syncBridge.broadcastChange(msg)
            }
            "sync:toggleChanged" -> {
                val key = msg.get("key")?.asString ?: return
                val value = msg.get("value")?.asBoolean ?: return
                if (key == "gridSnap") sharedState.state.gridSnap = value
                if (key == "noOverlap") sharedState.state.noOverlap = value
                syncBridge.broadcastChange(msg)
            }
            "sync:imageWindowCreated" -> {
                val id = msg.get("id")?.asString ?: return
                sharedState.addImageWindow(id, msg)
                syncBridge.broadcastChange(msg)
            }
            "sync:browserWindowCreated" -> {
                val id = msg.get("id")?.asString ?: return
                sharedState.addBrowserWindow(id, msg)
                syncBridge.broadcastChange(msg)
            }
            "sync:windowClosed" -> {
                val id = msg.get("id")?.asString ?: return
                sharedState.removeWindow(id)
                syncBridge.broadcastChange(msg)
            }
            "sync:terminalClosed" -> {
                val id = msg.get("id")?.asInt ?: return
                LOG.info("[TC] sync:terminalClosed id=$id")
                terminalManager.close(id)
                sharedState.removeTerminal(id)
                syncBridge.broadcastChange(msg)
            }
            "sync:allWindowsMoved" -> {
                val updates = msg.getAsJsonArray("updates") ?: return
                for (element in updates) {
                    val u = element.asJsonObject
                    val id = u.get("id")?.asString ?: u.get("id")?.asInt?.toString() ?: continue
                    val x = u.get("x")?.asDouble ?: continue
                    val y = u.get("y")?.asDouble ?: continue
                    sharedState.updateWindowPosition(id, x, y)
                }
                syncBridge.broadcastChange(msg)
            }
        }
    }

    private fun handlePaste() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val pasteData = ClipboardHelper.readClipboard()
            val msg = buildJsonObject(
                "type" to "pasteData",
                "image" to pasteData.image,
                "imageWidth" to pasteData.imageWidth,
                "imageHeight" to pasteData.imageHeight,
                "text" to pasteData.text
            )
            postMessageToWebview(msg)
        }
    }

    private fun sendFullSnapshot() {
        val snapshot = sharedState.getFullSnapshot()
        val msg = JsonObject().apply {
            addProperty("type", "sync:fullSnapshot")
            add("payload", gson.toJsonTree(snapshot))
        }
        LOG.info("[TC] Sending fullSnapshot")
        postMessageToWebview(msg)
    }

    private fun postMessageToWebview(msg: JsonObject) {
        if (disposed) return
        if (!pageLoaded) {
            // Page not loaded yet — queue the message for later delivery
            synchronized(pendingMessages) {
                pendingMessages.add(msg)
            }
            LOG.info("[TC] Page not loaded, queuing message: ${msg.get("type")?.asString} (queue size: ${pendingMessages.size})")
            return
        }
        doPostMessageToWebview(msg)
    }

    private fun doPostMessageToWebview(msg: JsonObject) {
        if (disposed) return
        val jsonStr = gson.toJson(msg)
        // Use base64 encoding to safely pass arbitrary JSON through executeJavaScript.
        // atob() returns Latin-1, so we need a JS-side UTF-8 decoder for correct multibyte chars.
        val base64 = java.util.Base64.getEncoder().encodeToString(jsonStr.toByteArray(Charsets.UTF_8))
        val js = """
            (function(){
                if(!window._onHostMessage) { console.error('[TC-JS] _onHostMessage not defined!'); return; }
                var b = atob('$base64');
                var bytes = new Uint8Array(b.length);
                for(var i=0;i<b.length;i++) bytes[i]=b.charCodeAt(i);
                var str = new TextDecoder().decode(bytes);
                window._onHostMessage(JSON.parse(str));
            })();
        """.trimIndent()
        ApplicationManager.getApplication().invokeLater {
            if (disposed) return@invokeLater
            try {
                browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
            } catch (e: Exception) {
                LOG.warn("[TC] executeJavaScript failed: ${e.message}")
            }
        }
    }

    private fun sendCtrlCharToFocusedTerminal(cefBrowser: CefBrowser?, ctrlCode: Int) {
        val jsEscaped = "\\x${ctrlCode.toString(16).padStart(2, '0')}"
        val js = """
            (function(){
                var node = document.activeElement;
                while(node && node !== document.body){
                    if(node.classList && node.classList.contains('terminal-window')){
                        var id = parseInt(node.dataset.id);
                        if(id && window._jbBridgeReady && window._jbBridge){
                            window._jbBridge(JSON.stringify({type:'input',id:id,data:'$jsEscaped'}));
                        }
                        return;
                    }
                    node = node.parentElement;
                }
            })();
        """.trimIndent()
        cefBrowser?.executeJavaScript(js, cefBrowser.url, 0)
    }

    private fun buildJsonObject(vararg pairs: Pair<String, Any?>): JsonObject {
        val obj = JsonObject()
        for ((key, value) in pairs) {
            when (value) {
                null -> obj.add(key, com.google.gson.JsonNull.INSTANCE)
                is String -> obj.addProperty(key, value)
                is Number -> obj.addProperty(key, value)
                is Boolean -> obj.addProperty(key, value)
                else -> obj.add(key, gson.toJsonTree(value))
            }
        }
        return obj
    }

    override fun dispose() {
        LOG.info("[TC] CanvasPanel disposing")
        disposed = true
        keyDispatcher?.let {
            KeyboardFocusManager.getCurrentKeyboardFocusManager().removeKeyEventDispatcher(it)
        }
        keyDispatcher = null
        syncBridge.dispose()
        terminalIOBridge.dispose()
        terminalManager.dispose()
    }
}
