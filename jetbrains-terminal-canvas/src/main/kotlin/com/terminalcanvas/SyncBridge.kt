package com.terminalcanvas

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * SyncBridge — Leader/Follower IPC for syncing SharedState across
 * multiple IDE instances (VSCode + JetBrains).
 *
 * Protocol: newline-delimited JSON over Unix socket (or Windows named pipe).
 * Uses the SAME socket path as the VSCode version so cross-IDE sync works.
 *
 * NOTE: On macOS/Linux we use a Unix domain socket via Java NIO channels.
 * On Windows we use a TCP loopback socket with a port file for discovery,
 * since Java NIO doesn't support Windows named pipes natively.
 */
class SyncBridge(private val sharedState: SharedState) {

    companion object {
        private val LOG = Logger.getInstance(SyncBridge::class.java)

        private val SOCKET_PATH: String = run {
            val tmpDir = System.getProperty("java.io.tmpdir")
            File(tmpDir, "terminal-canvas-sync.sock").absolutePath
        }

        private val IS_WINDOWS = System.getProperty("os.name").lowercase().contains("win")

        // Windows: use TCP loopback with a port file for discovery
        private val PORT_FILE_PATH: String = run {
            val tmpDir = System.getProperty("java.io.tmpdir")
            File(tmpDir, "terminal-canvas-sync.port").absolutePath
        }
    }

    private val gson = Gson()

    var role: String? = null           // "leader" | "follower"
        private set

    private var serverChannel: ServerSocketChannel? = null
    private var followerSockets: MutableList<SocketChannel> = mutableListOf()
    private var connection: SocketChannel? = null  // follower → leader

    @Volatile
    private var disposed = false

    private var serverThread: Thread? = null
    private var readerThread: Thread? = null
    private var reconnectTimer: Thread? = null

    // Callback: invoked when a remote change is received that needs to be
    // forwarded to the local webview
    var onRemoteChange: ((JsonObject) -> Unit)? = null

    // Callback: invoked when we need to subscribe to a remote terminal's I/O
    var onSubscribeRemoteTerminal: ((ownerPid: Long, terminalId: Int) -> Unit)? = null

    // ─── Startup ───────────────────────────────────────

    fun start() {
        if (disposed) return
        try {
            tryBecomeLeader()
        } catch (e: Exception) {
            LOG.info("[SyncBridge] Cannot become leader: ${e.message}, connecting as follower")
            try {
                connectAsFollower()
            } catch (e2: Exception) {
                LOG.warn("[SyncBridge] Cannot connect as follower: ${e2.message}, scheduling reconnect")
                scheduleReconnect()
            }
        }
    }

    // ─── Leader: create IPC server ─────────────────────

    private fun tryBecomeLeader() {
        if (IS_WINDOWS) {
            tryBecomeLeaderTcp()
        } else {
            tryBecomeLeaderUnix()
        }
    }

    private fun tryBecomeLeaderUnix() {
        val socketFile = File(SOCKET_PATH)

        // Test if something is already listening
        if (socketFile.exists()) {
            try {
                val addr = java.net.UnixDomainSocketAddress.of(SOCKET_PATH)
                val testConn = SocketChannel.open(addr)
                // Something is listening → can't be leader
                testConn.close()
                throw Exception("leader exists")
            } catch (e: java.net.ConnectException) {
                // Stale socket, remove it
                socketFile.delete()
            } catch (e: Exception) {
                if (e.message == "leader exists") throw e
                // Other error, try removing stale socket
                socketFile.delete()
            }
        }

        val addr = java.net.UnixDomainSocketAddress.of(SOCKET_PATH)
        serverChannel = ServerSocketChannel.open(java.net.StandardProtocolFamily.UNIX)
        serverChannel!!.bind(addr)
        role = "leader"
        LOG.info("[SyncBridge] Role: Leader (Unix socket: $SOCKET_PATH)")

        startAcceptThread()
    }

    private fun tryBecomeLeaderTcp() {
        // Check if a leader already exists by reading port file
        val portFile = File(PORT_FILE_PATH)
        if (portFile.exists()) {
            try {
                val port = portFile.readText().trim().toInt()
                val testConn = SocketChannel.open(InetSocketAddress("127.0.0.1", port))
                testConn.close()
                throw Exception("leader exists")
            } catch (e: java.net.ConnectException) {
                portFile.delete()
            } catch (e: Exception) {
                if (e.message == "leader exists") throw e
                portFile.delete()
            }
        }

        serverChannel = ServerSocketChannel.open()
        serverChannel!!.bind(InetSocketAddress("127.0.0.1", 0))
        val port = (serverChannel!!.localAddress as InetSocketAddress).port
        portFile.writeText(port.toString())
        role = "leader"
        LOG.info("[SyncBridge] Role: Leader (TCP port: $port)")

        startAcceptThread()
    }

    private fun startAcceptThread() {
        serverThread = Thread({
            while (!disposed && serverChannel != null) {
                try {
                    val client = serverChannel!!.accept()
                    if (client != null) {
                        onFollowerConnected(client)
                    }
                } catch (e: Exception) {
                    if (!disposed) {
                        LOG.warn("[SyncBridge] Accept error: ${e.message}")
                    }
                    break
                }
            }
        }, "SyncBridge-Accept").apply {
            isDaemon = true
            start()
        }
    }

    // ─── Leader: handle new follower ───────────────────

    private fun onFollowerConnected(socket: SocketChannel) {
        synchronized(followerSockets) {
            followerSockets.add(socket)
        }
        LOG.info("[SyncBridge] Follower connected (total: ${followerSockets.size})")

        // Send full snapshot
        val snapshot = sharedState.getFullSnapshot()
        val msg = JsonObject().apply {
            addProperty("type", "ipc:fullSnapshot")
            add("payload", gson.toJsonTree(snapshot))
        }
        socketWrite(socket, msg)

        // Start reader thread for this follower
        Thread({
            val buffer = StringBuilder()
            val readBuf = ByteBuffer.allocate(8192)
            try {
                while (!disposed && socket.isOpen) {
                    readBuf.clear()
                    val bytesRead = socket.read(readBuf)
                    if (bytesRead <= 0) break

                    readBuf.flip()
                    buffer.append(StandardCharsets.UTF_8.decode(readBuf))

                    val lines = buffer.toString().split('\n')
                    buffer.clear()
                    buffer.append(lines.last()) // keep incomplete line

                    for (i in 0 until lines.size - 1) {
                        val line = lines[i].trim()
                        if (line.isEmpty()) continue
                        try {
                            val msgFromFollower = gson.fromJson(line, JsonObject::class.java)
                            onMessageFromFollower(msgFromFollower, socket)
                        } catch (e: Exception) {
                            LOG.warn("[SyncBridge] Bad JSON from follower: ${e.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                if (!disposed) {
                    LOG.info("[SyncBridge] Follower read error: ${e.message}")
                }
            } finally {
                synchronized(followerSockets) {
                    followerSockets.remove(socket)
                }
                try { socket.close() } catch (_: Exception) {}
                LOG.info("[SyncBridge] Follower disconnected (total: ${followerSockets.size})")
            }
        }, "SyncBridge-FollowerReader").apply {
            isDaemon = true
            start()
        }
    }

    // ─── Leader: received mutation from a follower ─────

    private fun onMessageFromFollower(msg: JsonObject, sourceSocket: SocketChannel) {
        // Apply to leader's own state
        applyRemoteChange(msg)

        // Broadcast to all OTHER followers
        synchronized(followerSockets) {
            for (s in followerSockets) {
                if (s !== sourceSocket) {
                    socketWrite(s, msg)
                }
            }
        }
    }

    // ─── Follower: connect to leader ───────────────────

    private fun connectAsFollower() {
        val socket = if (IS_WINDOWS) {
            val portFile = File(PORT_FILE_PATH)
            if (!portFile.exists()) throw Exception("no leader port file")
            val port = portFile.readText().trim().toInt()
            SocketChannel.open(InetSocketAddress("127.0.0.1", port))
        } else {
            val addr = java.net.UnixDomainSocketAddress.of(SOCKET_PATH)
            SocketChannel.open(addr)
        }

        connection = socket
        role = "follower"
        LOG.info("[SyncBridge] Role: Follower")

        // Start reader thread
        readerThread = Thread({
            val buffer = StringBuilder()
            val readBuf = ByteBuffer.allocate(8192)
            try {
                while (!disposed && socket.isOpen) {
                    readBuf.clear()
                    val bytesRead = socket.read(readBuf)
                    if (bytesRead <= 0) break

                    readBuf.flip()
                    buffer.append(StandardCharsets.UTF_8.decode(readBuf))

                    val lines = buffer.toString().split('\n')
                    buffer.clear()
                    buffer.append(lines.last())

                    for (i in 0 until lines.size - 1) {
                        val line = lines[i].trim()
                        if (line.isEmpty()) continue
                        try {
                            val msg = gson.fromJson(line, JsonObject::class.java)
                            onMessageFromLeader(msg)
                        } catch (e: Exception) {
                            LOG.warn("[SyncBridge] Bad JSON from leader: ${e.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                if (!disposed) {
                    LOG.info("[SyncBridge] Leader read error: ${e.message}")
                }
            } finally {
                LOG.info("[SyncBridge] Leader disconnected, attempting promotion...")
                connection = null
                role = null
                scheduleReconnect()
            }
        }, "SyncBridge-LeaderReader").apply {
            isDaemon = true
            start()
        }
    }

    // ─── Follower: received message from leader ────────

    private fun onMessageFromLeader(msg: JsonObject) {
        val type = msg.get("type")?.asString
        if (type == "ipc:fullSnapshot") {
            val payload = msg.getAsJsonObject("payload")
            restoreFromSnapshot(payload)
        } else {
            applyRemoteChange(msg)
        }
    }

    // ─── Apply a remote state change to local state ────

    private fun applyRemoteChange(msg: JsonObject) {
        val type = msg.get("type")?.asString ?: return
        LOG.info("[SyncBridge] applyRemoteChange: $type")

        when (type) {
            "sync:terminalCreated" -> {
                val id = msg.get("id")?.asInt ?: return
                val x = msg.get("x")?.asDouble ?: 50.0
                val y = msg.get("y")?.asDouble ?: 50.0
                val w = msg.get("w")?.asDouble ?: 600.0
                val h = msg.get("h")?.asDouble ?: 380.0
                val zIndex = msg.get("zIndex")?.asInt ?: sharedState.nextZIndex()
                val cols = msg.get("cols")?.asInt ?: 80
                val rows = msg.get("rows")?.asInt ?: 24
                val ownerPid = msg.get("ownerPid")?.asLong
                sharedState.addTerminalWindow(id, x, y, w, h, zIndex, cols, rows, ownerPid = ownerPid)
                // Update counters
                if (id >= sharedState.state.nextId) {
                    sharedState.state.nextId = id + 1
                }
                if (zIndex > sharedState.state.maxZIndex) {
                    sharedState.state.maxZIndex = zIndex
                }
                // Subscribe to I/O from the terminal owner
                if (ownerPid != null) {
                    onSubscribeRemoteTerminal?.invoke(ownerPid, id)
                }
            }
            "sync:terminalInfo" -> {
                val id = msg.get("id")?.asInt ?: return
                val cwd = msg.get("cwd")?.asString ?: return
                sharedState.updateTerminalCwd(id, cwd)
            }
            "sync:terminalResize" -> {
                val id = msg.get("id")?.asInt ?: return
                val cols = msg.get("cols")?.asInt ?: return
                val rows = msg.get("rows")?.asInt ?: return
                sharedState.state.terminalWindows[id]?.let {
                    it.cols = cols
                    it.rows = rows
                }
            }
            "sync:terminalClosed" -> {
                val id = msg.get("id")?.asInt ?: return
                sharedState.removeTerminal(id)
            }
            "sync:windowMoved" -> {
                val id = msg.get("id")?.asString ?: msg.get("id")?.asInt?.toString() ?: return
                val x = msg.get("x")?.asDouble ?: return
                val y = msg.get("y")?.asDouble ?: return
                sharedState.updateWindowPosition(id, x, y)
            }
            "sync:windowResized" -> {
                val id = msg.get("id")?.asString ?: msg.get("id")?.asInt?.toString() ?: return
                val x = msg.get("x")?.asDouble ?: return
                val y = msg.get("y")?.asDouble ?: return
                val w = msg.get("w")?.asDouble ?: return
                val h = msg.get("h")?.asDouble ?: return
                sharedState.updateWindowRect(id, x, y, w, h)
            }
            "sync:windowFocused" -> {
                // Forward to webview
            }
            "sync:toggleChanged" -> {
                val key = msg.get("key")?.asString ?: return
                val value = msg.get("value")?.asBoolean ?: return
                if (key == "gridSnap") sharedState.state.gridSnap = value
                if (key == "noOverlap") sharedState.state.noOverlap = value
            }
            "sync:imageWindowCreated" -> {
                val id = msg.get("id")?.asString ?: return
                sharedState.addImageWindow(id, msg)
            }
            "sync:browserWindowCreated" -> {
                val id = msg.get("id")?.asString ?: return
                sharedState.addBrowserWindow(id, msg)
            }
            "sync:windowClosed" -> {
                val id = msg.get("id")?.asString ?: return
                sharedState.removeWindow(id)
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
            }
        }

        // Forward to local webview
        onRemoteChange?.invoke(msg)
    }

    // ─── Restore full snapshot from leader ──────────────

    private fun restoreFromSnapshot(payload: JsonObject) {
        LOG.info("[SyncBridge] Restoring from snapshot")

        // Update counters (take max)
        payload.get("nextId")?.asInt?.let {
            if (it > sharedState.state.nextId) sharedState.state.nextId = it
        }
        payload.get("nextImageId")?.asInt?.let {
            if (it > sharedState.state.nextImageId) sharedState.state.nextImageId = it
        }
        payload.get("nextBrowserId")?.asInt?.let {
            if (it > sharedState.state.nextBrowserId) sharedState.state.nextBrowserId = it
        }
        payload.get("maxZIndex")?.asInt?.let {
            if (it > sharedState.state.maxZIndex) sharedState.state.maxZIndex = it
        }

        // Merge toggles
        payload.get("gridSnap")?.asBoolean?.let { sharedState.state.gridSnap = it }
        payload.get("noOverlap")?.asBoolean?.let { sharedState.state.noOverlap = it }

        // Merge terminal windows
        payload.getAsJsonArray("terminalWindows")?.forEach { entry ->
            val arr = entry.asJsonArray
            val id = arr[0].asInt
            val tw = arr[1].asJsonObject
            if (!sharedState.state.terminalWindows.containsKey(id)) {
                val ownerPid = tw.get("ownerPid")?.asLong
                sharedState.addTerminalWindow(
                    id,
                    tw.get("x")?.asDouble ?: 0.0,
                    tw.get("y")?.asDouble ?: 0.0,
                    tw.get("w")?.asDouble ?: 600.0,
                    tw.get("h")?.asDouble ?: 380.0,
                    tw.get("zIndex")?.asInt ?: 1,
                    tw.get("cols")?.asInt ?: 80,
                    tw.get("rows")?.asInt ?: 24,
                    ownerPid = ownerPid
                )
                tw.get("cwd")?.asString?.let { sharedState.updateTerminalCwd(id, it) }
            }
        }

        // Merge image windows
        payload.getAsJsonArray("imageWindows")?.forEach { entry ->
            val arr = entry.asJsonArray
            val id = arr[0].asString
            if (!sharedState.state.imageWindows.containsKey(id)) {
                sharedState.addImageWindow(id, arr[1].asJsonObject)
            }
        }

        // Merge browser windows
        payload.getAsJsonArray("browserWindows")?.forEach { entry ->
            val arr = entry.asJsonArray
            val id = arr[0].asString
            if (!sharedState.state.browserWindows.containsKey(id)) {
                sharedState.addBrowserWindow(id, arr[1].asJsonObject)
            }
        }

        // Merge terminal buffers
        payload.getAsJsonArray("terminalBuffers")?.forEach { entry ->
            val arr = entry.asJsonArray
            val id = arr[0].asInt
            val bufStr = arr[1].asString
            sharedState.bufferOutput(id, bufStr)
        }

        // Send full snapshot to local webview
        val fullSnapshot = sharedState.getFullSnapshot()
        val snapshotMsg = JsonObject().apply {
            addProperty("type", "sync:fullSnapshot")
            add("payload", gson.toJsonTree(fullSnapshot))
        }
        onRemoteChange?.invoke(snapshotMsg)

        // Subscribe to I/O for all remote terminals
        val myPid = ProcessHandle.current().pid()
        for ((id, tw) in sharedState.state.terminalWindows) {
            val ownerPid = tw.ownerPid
            if (ownerPid != null && ownerPid != myPid) {
                onSubscribeRemoteTerminal?.invoke(ownerPid, id)
            }
        }
    }

    // ─── Follower: try to become leader after disconnect

    private fun scheduleReconnect() {
        if (disposed) return
        reconnectTimer = Thread({
            try {
                Thread.sleep(200 + (Math.random() * 300).toLong())
                if (!disposed) {
                    start()
                }
            } catch (_: InterruptedException) {}
        }, "SyncBridge-Reconnect").apply {
            isDaemon = true
            start()
        }
    }

    // ─── Public: broadcast a local state change ────────

    fun broadcastChange(msg: JsonObject) {
        if (disposed) return
        when (role) {
            "leader" -> {
                synchronized(followerSockets) {
                    for (s in followerSockets) {
                        socketWrite(s, msg)
                    }
                }
            }
            "follower" -> {
                connection?.let { socketWrite(it, msg) }
            }
        }
    }

    // ─── Utility: write newline-delimited JSON ─────────

    private fun socketWrite(socket: SocketChannel, msg: JsonObject) {
        try {
            val data = (gson.toJson(msg) + "\n").toByteArray(StandardCharsets.UTF_8)
            val buf = ByteBuffer.wrap(data)
            while (buf.hasRemaining()) {
                socket.write(buf)
            }
        } catch (e: Exception) {
            LOG.warn("[SyncBridge] Write error: ${e.message}")
        }
    }

    // ─── Cleanup ───────────────────────────────────────

    fun dispose() {
        disposed = true

        reconnectTimer?.interrupt()
        reconnectTimer = null

        synchronized(followerSockets) {
            for (s in followerSockets) {
                try { s.close() } catch (_: Exception) {}
            }
            followerSockets.clear()
        }

        connection?.let {
            try { it.close() } catch (_: Exception) {}
            connection = null
        }

        serverChannel?.let {
            try { it.close() } catch (_: Exception) {}
            serverChannel = null
            // Clean up socket file (Unix only)
            if (!IS_WINDOWS) {
                try { File(SOCKET_PATH).delete() } catch (_: Exception) {}
            } else {
                try { File(PORT_FILE_PATH).delete() } catch (_: Exception) {}
            }
        }

        serverThread?.interrupt()
        readerThread?.interrupt()
        serverThread = null
        readerThread = null

        LOG.info("[SyncBridge] Disposed")
    }
}
