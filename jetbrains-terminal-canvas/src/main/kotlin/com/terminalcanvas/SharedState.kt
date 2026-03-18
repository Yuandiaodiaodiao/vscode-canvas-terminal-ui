package com.terminalcanvas

import com.google.gson.JsonObject

class SharedState {

    data class TerminalWindowData(
        var x: Double, var y: Double, var w: Double, var h: Double,
        var zIndex: Int, var cols: Int, var rows: Int,
        var cwd: String? = null,
        var ownerPid: Long? = null
    )

    data class ImageWindowData(
        var x: Double, var y: Double, var w: Double, var h: Double,
        var zIndex: Int,
        var imgSrc: String? = null,
        var naturalW: Int = 0, var naturalH: Int = 0,
        var aspectRatio: Double = 1.0
    )

    data class BrowserWindowData(
        var x: Double, var y: Double, var w: Double, var h: Double,
        var zIndex: Int,
        var url: String = ""
    )

    data class CanvasState(
        var nextId: Int = 1,
        var nextImageId: Int = 1,
        var nextBrowserId: Int = 1,
        var maxZIndex: Int = 1,
        var gridSnap: Boolean = false,
        var noOverlap: Boolean = false,
        val terminalWindows: MutableMap<Int, TerminalWindowData> = mutableMapOf(),
        val imageWindows: MutableMap<String, ImageWindowData> = mutableMapOf(),
        val browserWindows: MutableMap<String, BrowserWindowData> = mutableMapOf()
    )

    val state = CanvasState()
    private val terminalBuffers = mutableMapOf<Int, StringBuilder>()
    private val BUFFER_MAX = 512 * 1024

    fun nextTerminalId(): Int = state.nextId++

    fun nextZIndex(): Int = ++state.maxZIndex

    fun addTerminalWindow(id: Int, x: Double, y: Double, w: Double, h: Double, zIndex: Int, cols: Int, rows: Int, ownerPid: Long? = null) {
        state.terminalWindows[id] = TerminalWindowData(x, y, w, h, zIndex, cols, rows, ownerPid = ownerPid)
    }

    fun removeTerminal(id: Int) {
        state.terminalWindows.remove(id)
        terminalBuffers.remove(id)
    }

    fun updateTerminalCwd(id: Int, cwd: String) {
        state.terminalWindows[id]?.cwd = cwd
    }

    fun bufferOutput(id: Int, data: String) {
        val buf = terminalBuffers.getOrPut(id) { StringBuilder() }
        buf.append(data)
        if (buf.length > BUFFER_MAX) {
            val trimmed = buf.substring(buf.length - BUFFER_MAX)
            buf.clear()
            buf.append(trimmed)
        }
    }

    fun addImageWindow(id: String, msg: JsonObject) {
        val zIndex = nextZIndex()
        state.imageWindows[id] = ImageWindowData(
            x = msg.get("x")?.asDouble ?: 0.0,
            y = msg.get("y")?.asDouble ?: 0.0,
            w = msg.get("w")?.asDouble ?: 400.0,
            h = msg.get("h")?.asDouble ?: 300.0,
            zIndex = zIndex,
            imgSrc = msg.get("imgSrc")?.asString,
            naturalW = msg.get("naturalW")?.asInt ?: 400,
            naturalH = msg.get("naturalH")?.asInt ?: 300,
            aspectRatio = msg.get("aspectRatio")?.asDouble ?: 1.0
        )
    }

    fun addBrowserWindow(id: String, msg: JsonObject) {
        val zIndex = nextZIndex()
        state.browserWindows[id] = BrowserWindowData(
            x = msg.get("x")?.asDouble ?: 0.0,
            y = msg.get("y")?.asDouble ?: 0.0,
            w = msg.get("w")?.asDouble ?: 800.0,
            h = msg.get("h")?.asDouble ?: 600.0,
            zIndex = zIndex,
            url = msg.get("url")?.asString ?: ""
        )
    }

    fun removeWindow(id: String) {
        state.imageWindows.remove(id)
        state.browserWindows.remove(id)
    }

    fun updateWindowPosition(id: String, x: Double, y: Double) {
        // Try terminal windows (numeric id)
        val intId = id.toIntOrNull()
        if (intId != null) {
            state.terminalWindows[intId]?.let { it.x = x; it.y = y; return }
        }
        state.imageWindows[id]?.let { it.x = x; it.y = y; return }
        state.browserWindows[id]?.let { it.x = x; it.y = y }
    }

    fun updateWindowRect(id: String, x: Double, y: Double, w: Double, h: Double) {
        val intId = id.toIntOrNull()
        if (intId != null) {
            state.terminalWindows[intId]?.let { it.x = x; it.y = y; it.w = w; it.h = h; return }
        }
        state.imageWindows[id]?.let { it.x = x; it.y = y; it.w = w; it.h = h; return }
        state.browserWindows[id]?.let { it.x = x; it.y = y; it.w = w; it.h = h }
    }

    fun getTerminalBuffer(id: Int): String? {
        return terminalBuffers[id]?.toString()
    }

    fun getFullSnapshot(): Map<String, Any?> {
        return mapOf(
            "nextId" to state.nextId,
            "nextImageId" to state.nextImageId,
            "nextBrowserId" to state.nextBrowserId,
            "maxZIndex" to state.maxZIndex,
            "gridSnap" to state.gridSnap,
            "noOverlap" to state.noOverlap,
            "terminalWindows" to state.terminalWindows.map { (id, tw) ->
                listOf(id, mapOf(
                    "x" to tw.x, "y" to tw.y, "w" to tw.w, "h" to tw.h,
                    "zIndex" to tw.zIndex, "cols" to tw.cols, "rows" to tw.rows,
                    "cwd" to tw.cwd, "ownerPid" to tw.ownerPid, "isLocal" to true
                ))
            },
            "imageWindows" to state.imageWindows.map { (id, iw) ->
                listOf(id, mapOf(
                    "x" to iw.x, "y" to iw.y, "w" to iw.w, "h" to iw.h,
                    "zIndex" to iw.zIndex,
                    "imgSrc" to iw.imgSrc, "naturalW" to iw.naturalW,
                    "naturalH" to iw.naturalH, "aspectRatio" to iw.aspectRatio
                ))
            },
            "browserWindows" to state.browserWindows.map { (id, bw) ->
                listOf(id, mapOf(
                    "x" to bw.x, "y" to bw.y, "w" to bw.w, "h" to bw.h,
                    "zIndex" to bw.zIndex, "url" to bw.url
                ))
            },
            "terminalBuffers" to terminalBuffers.map { (id, buf) ->
                listOf(id, buf.toString())
            }
        )
    }
}
