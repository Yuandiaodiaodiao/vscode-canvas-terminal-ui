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

/**
 * TerminalIOBridge — Per-instance IPC server for terminal I/O forwarding.
 *
 * Each IDE instance runs ONE IO server socket. Remote instances connect
 * to the owner's socket to subscribe to terminal output.
 *
 * Protocol: newline-delimited JSON.
 *   Remote → Owner:  io:input, io:resize, io:subscribe
 *   Owner → Remote:  io:output, io:terminated
 *
 * Socket path: $TMPDIR/terminal-canvas-io-{pid}.sock (same as VSCode version)
 */
class TerminalIOBridge(private val sharedState: SharedState) {

    companion object {
        private val LOG = Logger.getInstance(TerminalIOBridge::class.java)
        private val IS_WINDOWS = System.getProperty("os.name").lowercase().contains("win")

        fun socketPathFor(pid: Long): String {
            return if (IS_WINDOWS) {
                // Windows: use TCP with port file
                val tmpDir = System.getProperty("java.io.tmpdir")
                File(tmpDir, "terminal-canvas-io-$pid.port").absolutePath
            } else {
                val tmpDir = System.getProperty("java.io.tmpdir")
                File(tmpDir, "terminal-canvas-io-$pid.sock").absolutePath
            }
        }
    }

    private val gson = Gson()
    val myPid: Long = ProcessHandle.current().pid()

    @Volatile
    private var disposed = false

    // ─── Server side (we are the pty owner) ──────────
    private var serverChannel: ServerSocketChannel? = null
    private var serverThread: Thread? = null

    // terminalId → Set<SocketChannel>: who wants output for each terminal
    private val subscribers = mutableMapOf<Int, MutableSet<SocketChannel>>()

    // ─── Client side (connect to remote owners) ──────
    // ownerPid → ClientEntry
    private val clients = mutableMapOf<Long, ClientEntry>()

    // Callback: when remote terminal produces output
    var onRemoteOutput: ((terminalId: Int, data: String) -> Unit)? = null
    // Callback: when remote terminal terminates
    var onRemoteTerminated: ((terminalId: Int, exitCode: Int) -> Unit)? = null
    // Callback: when remote sends input to our terminal
    var onRemoteInput: ((terminalId: Int, data: String) -> Unit)? = null
    // Callback: when remote sends resize to our terminal
    var onRemoteResize: ((terminalId: Int, cols: Int, rows: Int) -> Unit)? = null

    data class ClientEntry(
        var socket: SocketChannel? = null,
        var ready: Boolean = false,
        val queue: MutableList<JsonObject> = mutableListOf()
    )

    // ═══════════════════════════════════════════════════
    //  Server side — accept connections from remote instances
    // ═══════════════════════════════════════════════════

    fun startServer() {
        if (disposed) return

        if (IS_WINDOWS) {
            startServerTcp()
        } else {
            startServerUnix()
        }
    }

    private fun startServerUnix() {
        val sockPath = socketPathFor(myPid)
        val socketFile = File(sockPath)

        // Clean stale socket
        if (socketFile.exists()) socketFile.delete()

        val addr = java.net.UnixDomainSocketAddress.of(sockPath)
        serverChannel = ServerSocketChannel.open(java.net.StandardProtocolFamily.UNIX)
        serverChannel!!.bind(addr)
        LOG.info("[TerminalIOBridge] IO server listening: $sockPath (pid=$myPid)")

        startAcceptThread()
    }

    private fun startServerTcp() {
        serverChannel = ServerSocketChannel.open()
        serverChannel!!.bind(InetSocketAddress("127.0.0.1", 0))
        val port = (serverChannel!!.localAddress as InetSocketAddress).port

        // Write port file so remote instances can discover us
        val portFile = File(socketPathFor(myPid))
        portFile.writeText(port.toString())
        LOG.info("[TerminalIOBridge] IO server listening: TCP port $port (pid=$myPid)")

        startAcceptThread()
    }

    private fun startAcceptThread() {
        serverThread = Thread({
            while (!disposed && serverChannel != null) {
                try {
                    val client = serverChannel!!.accept() ?: continue
                    onRemoteConnected(client)
                } catch (e: Exception) {
                    if (!disposed) LOG.warn("[TerminalIOBridge] Accept error: ${e.message}")
                    break
                }
            }
        }, "TerminalIOBridge-Accept").apply {
            isDaemon = true
            start()
        }
    }

    private fun onRemoteConnected(socket: SocketChannel) {
        LOG.info("[TerminalIOBridge] Remote connected")

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
                    buffer.append(lines.last())

                    for (i in 0 until lines.size - 1) {
                        val line = lines[i].trim()
                        if (line.isEmpty()) continue
                        try {
                            handleRemoteMessage(gson.fromJson(line, JsonObject::class.java), socket)
                        } catch (e: Exception) {
                            LOG.warn("[TerminalIOBridge] Bad JSON from remote: ${e.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                if (!disposed) LOG.info("[TerminalIOBridge] Remote read error: ${e.message}")
            } finally {
                removeSubscriber(socket)
                try { socket.close() } catch (_: Exception) {}
            }
        }, "TerminalIOBridge-RemoteReader").apply {
            isDaemon = true
            start()
        }
    }

    private fun handleRemoteMessage(msg: JsonObject, socket: SocketChannel) {
        val type = msg.get("type")?.asString ?: return
        when (type) {
            "io:input" -> {
                val terminalId = msg.get("terminalId")?.asInt ?: return
                val data = msg.get("data")?.asString ?: return
                onRemoteInput?.invoke(terminalId, data)
            }
            "io:resize" -> {
                val terminalId = msg.get("terminalId")?.asInt ?: return
                val cols = msg.get("cols")?.asInt ?: return
                val rows = msg.get("rows")?.asInt ?: return
                onRemoteResize?.invoke(terminalId, cols, rows)
            }
            "io:subscribe" -> {
                val ids = msg.getAsJsonArray("terminalIds") ?: return
                for (element in ids) {
                    val tid = element.asInt
                    synchronized(subscribers) {
                        val subs = subscribers.getOrPut(tid) { mutableSetOf() }
                        subs.add(socket)
                    }

                    // Replay buffered output so remote doesn't see blank screen
                    val buf = sharedState.getTerminalBuffer(tid)
                    if (buf != null && buf.isNotEmpty()) {
                        socketWrite(socket, buildMsg("io:output", "terminalId" to tid, "data" to buf))
                    }
                }
                LOG.info("[TerminalIOBridge] Remote subscribed to terminals: ${ids}")
            }
        }
    }

    private fun removeSubscriber(socket: SocketChannel) {
        synchronized(subscribers) {
            val emptyKeys = mutableListOf<Int>()
            for ((tid, sockets) in subscribers) {
                sockets.remove(socket)
                if (sockets.isEmpty()) emptyKeys.add(tid)
            }
            for (k in emptyKeys) subscribers.remove(k)
        }
    }

    // ═══════════════════════════════════════════════════
    //  Owner push — send pty output to subscribed remotes
    // ═══════════════════════════════════════════════════

    /** Called when local pty produces output */
    fun pushOutput(terminalId: Int, data: String) {
        val sockets: List<SocketChannel>
        synchronized(subscribers) {
            sockets = subscribers[terminalId]?.toList() ?: return
        }
        if (sockets.isEmpty()) return
        val msg = buildMsg("io:output", "terminalId" to terminalId, "data" to data)
        for (s in sockets) {
            socketWrite(s, msg)
        }
    }

    /** Called when local pty exits */
    fun pushTerminated(terminalId: Int, exitCode: Int) {
        val sockets: List<SocketChannel>
        synchronized(subscribers) {
            sockets = subscribers[terminalId]?.toList() ?: emptyList()
            subscribers.remove(terminalId)
        }
        val msg = buildMsg("io:terminated", "terminalId" to terminalId, "exitCode" to exitCode)
        for (s in sockets) {
            socketWrite(s, msg)
        }
    }

    // ═══════════════════════════════════════════════════
    //  Client side — connect to remote owner for I/O
    // ═══════════════════════════════════════════════════

    /** Subscribe to output from terminals owned by a remote instance */
    fun subscribe(ownerPid: Long, terminalIds: List<Int>) {
        if (terminalIds.isEmpty() || ownerPid == myPid) return
        LOG.info("[TerminalIOBridge] Subscribing to owner pid=$ownerPid for terminals=$terminalIds")

        val msg = JsonObject().apply {
            addProperty("type", "io:subscribe")
            add("terminalIds", gson.toJsonTree(terminalIds))
        }

        synchronized(clients) {
            val entry = clients.getOrPut(ownerPid) { ClientEntry() }
            if (entry.ready && entry.socket != null) {
                socketWrite(entry.socket!!, msg)
            } else if (entry.socket != null) {
                // Still connecting, queue it
                entry.queue.add(msg)
            } else {
                // Need to create connection
                entry.queue.add(msg)
                connectToOwner(ownerPid, entry)
            }
        }
    }

    /** Forward input to a remote terminal owner */
    fun forwardInput(ownerPid: Long, terminalId: Int, data: String) {
        sendToOwner(ownerPid, buildMsg("io:input", "terminalId" to terminalId, "data" to data))
    }

    /** Forward resize to a remote terminal owner */
    fun forwardResize(ownerPid: Long, terminalId: Int, cols: Int, rows: Int) {
        sendToOwner(ownerPid, buildMsg("io:resize", "terminalId" to terminalId, "cols" to cols, "rows" to rows))
    }

    private fun sendToOwner(ownerPid: Long, msg: JsonObject) {
        synchronized(clients) {
            val entry = clients.getOrPut(ownerPid) { ClientEntry() }
            if (entry.ready && entry.socket != null) {
                socketWrite(entry.socket!!, msg)
            } else if (entry.socket != null) {
                entry.queue.add(msg)
            } else {
                entry.queue.add(msg)
                connectToOwner(ownerPid, entry)
            }
        }
    }

    private fun connectToOwner(ownerPid: Long, entry: ClientEntry) {
        Thread({
            try {
                val socket = if (IS_WINDOWS) {
                    val portFile = File(socketPathFor(ownerPid))
                    if (!portFile.exists()) throw Exception("No port file for pid=$ownerPid")
                    val port = portFile.readText().trim().toInt()
                    SocketChannel.open(InetSocketAddress("127.0.0.1", port))
                } else {
                    val sockPath = socketPathFor(ownerPid)
                    val addr = java.net.UnixDomainSocketAddress.of(sockPath)
                    SocketChannel.open(addr)
                }

                synchronized(clients) {
                    entry.socket = socket
                    entry.ready = true
                    // Flush queued messages
                    for (queued in entry.queue) {
                        socketWrite(socket, queued)
                    }
                    entry.queue.clear()
                }
                LOG.info("[TerminalIOBridge] Connected to owner pid=$ownerPid")

                // Read output from owner
                val buffer = StringBuilder()
                val readBuf = ByteBuffer.allocate(8192)
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
                            handleOwnerMessage(gson.fromJson(line, JsonObject::class.java))
                        } catch (e: Exception) {
                            LOG.warn("[TerminalIOBridge] Bad JSON from owner: ${e.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                LOG.warn("[TerminalIOBridge] Cannot connect to owner pid=$ownerPid: ${e.message}")
            } finally {
                synchronized(clients) {
                    clients.remove(ownerPid)
                }
            }
        }, "TerminalIOBridge-Client-$ownerPid").apply {
            isDaemon = true
            start()
        }
    }

    private fun handleOwnerMessage(msg: JsonObject) {
        val type = msg.get("type")?.asString ?: return
        when (type) {
            "io:output" -> {
                val terminalId = msg.get("terminalId")?.asInt ?: return
                val data = msg.get("data")?.asString ?: return
                onRemoteOutput?.invoke(terminalId, data)
            }
            "io:terminated" -> {
                val terminalId = msg.get("terminalId")?.asInt ?: return
                val exitCode = msg.get("exitCode")?.asInt ?: 0
                onRemoteTerminated?.invoke(terminalId, exitCode)
            }
        }
    }

    // ═══════════════════════════════════════════════════
    //  Utilities
    // ═══════════════════════════════════════════════════

    private fun buildMsg(type: String, vararg pairs: Pair<String, Any?>): JsonObject {
        return JsonObject().apply {
            addProperty("type", type)
            for ((key, value) in pairs) {
                when (value) {
                    null -> {}
                    is String -> addProperty(key, value)
                    is Number -> addProperty(key, value)
                    is Boolean -> addProperty(key, value)
                    else -> add(key, gson.toJsonTree(value))
                }
            }
        }
    }

    private fun socketWrite(socket: SocketChannel, msg: JsonObject) {
        try {
            val data = (gson.toJson(msg) + "\n").toByteArray(StandardCharsets.UTF_8)
            val buf = ByteBuffer.wrap(data)
            while (buf.hasRemaining()) {
                socket.write(buf)
            }
        } catch (e: Exception) {
            LOG.warn("[TerminalIOBridge] Write error: ${e.message}")
        }
    }

    // ═══════════════════════════════════════════════════
    //  Cleanup
    // ═══════════════════════════════════════════════════

    fun dispose() {
        disposed = true

        // Close client connections
        synchronized(clients) {
            for ((_, entry) in clients) {
                try { entry.socket?.close() } catch (_: Exception) {}
            }
            clients.clear()
        }

        // Close server
        serverChannel?.let {
            try { it.close() } catch (_: Exception) {}
            serverChannel = null
            if (!IS_WINDOWS) {
                try { File(socketPathFor(myPid)).delete() } catch (_: Exception) {}
            } else {
                try { File(socketPathFor(myPid)).delete() } catch (_: Exception) {}
            }
        }

        synchronized(subscribers) { subscribers.clear() }

        serverThread?.interrupt()
        serverThread = null

        LOG.info("[TerminalIOBridge] Disposed")
    }
}
