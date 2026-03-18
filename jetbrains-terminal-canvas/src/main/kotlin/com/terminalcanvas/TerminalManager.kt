package com.terminalcanvas

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.pty4j.PtyProcessBuilder
import com.pty4j.PtyProcess
import com.pty4j.WinSize
import java.io.InputStreamReader
import java.io.BufferedReader

class TerminalManager(private val project: Project) {

    companion object {
        private val LOG = Logger.getInstance(TerminalManager::class.java)
    }

    data class TerminalEntry(
        val ptyProcess: PtyProcess,
        val readerThread: Thread,
        var cwd: String?
    )

    private val terminals = mutableMapOf<Int, TerminalEntry>()

    // Callbacks — set by CanvasPanel
    var onOutput: ((id: Int, data: String) -> Unit)? = null
    var onTerminated: ((id: Int, exitCode: Int) -> Unit)? = null
    var onTerminalInfo: ((id: Int, cwd: String) -> Unit)? = null
    var onError: ((id: Int, message: String) -> Unit)? = null

    fun createTerminal(id: Int, cols: Int, rows: Int) {
        val shell = when {
            SystemInfo.isWindows -> "powershell.exe"
            else -> System.getenv("SHELL") ?: "/bin/bash"
        }
        val cmd = arrayOf(shell)

        val workDir = project.basePath ?: System.getProperty("user.home")

        val env = System.getenv().toMutableMap()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"

        LOG.info("[TC] createTerminal: id=$id shell=$shell workDir=$workDir cols=$cols rows=$rows")

        try {
            val ptyProcess = PtyProcessBuilder()
                .setCommand(cmd)
                .setEnvironment(env)
                .setDirectory(workDir)
                .setInitialColumns(cols)
                .setInitialRows(rows)
                .setConsole(false)
                .start()

            LOG.info("[TC] PtyProcess started: id=$id pid=${try { ptyProcess.pid() } catch(_: Exception) { -1 }}")

            // Reader thread for pty output
            val inputStream = ptyProcess.inputStream
            val readerThread = Thread({
                try {
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = inputStream.read(buf)
                        if (n == -1) {
                            LOG.info("[TC] pty reader EOF: id=$id")
                            break
                        }
                        val data = String(buf, 0, n, Charsets.UTF_8)
                        onOutput?.invoke(id, data)
                    }
                } catch (e: Exception) {
                    LOG.info("[TC] pty reader exception: id=$id ${e.javaClass.simpleName}: ${e.message}")
                }

                // Process exited
                val exitCode = try { ptyProcess.waitFor() } catch (_: Exception) { -1 }
                LOG.info("[TC] pty process exited: id=$id exitCode=$exitCode")
                terminals.remove(id)
                onTerminated?.invoke(id, exitCode)
            }, "pty-reader-$id")
            readerThread.isDaemon = true
            readerThread.start()

            val cwd = workDir ?: ""
            terminals[id] = TerminalEntry(ptyProcess, readerThread, cwd)

            // Notify about initial cwd
            onTerminalInfo?.invoke(id, cwd)

        } catch (e: Exception) {
            LOG.error("[TC] FAILED to create pty: id=$id", e)
            onError?.invoke(id, "Failed to start terminal: ${e.message}")
            onTerminated?.invoke(id, -1)
        }
    }

    fun sendInput(id: Int, data: String) {
        val entry = terminals[id]
        if (entry == null) {
            LOG.warn("[TC] sendInput: terminal $id not found (active terminals: ${terminals.keys})")
            return
        }
        try {
            entry.ptyProcess.outputStream.write(data.toByteArray(Charsets.UTF_8))
            entry.ptyProcess.outputStream.flush()
        } catch (e: Exception) {
            LOG.warn("[TC] sendInput failed: id=$id ${e.message}")
        }
    }

    fun resize(id: Int, cols: Int, rows: Int) {
        val entry = terminals[id] ?: return
        try {
            entry.ptyProcess.winSize = WinSize(cols, rows)
        } catch (_: Exception) {
            // Ignore resize errors
        }
    }

    fun close(id: Int) {
        LOG.info("[TC] close terminal: id=$id")
        val entry = terminals.remove(id) ?: return
        try {
            entry.ptyProcess.destroy()
        } catch (_: Exception) {}
    }

    fun dispose() {
        LOG.info("[TC] TerminalManager disposing, ${terminals.size} terminals")
        for ((id, entry) in terminals) {
            try { entry.ptyProcess.destroy() } catch (_: Exception) {}
        }
        terminals.clear()
    }
}
