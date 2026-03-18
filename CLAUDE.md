# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 代码协作指南

- 任务执行完成后不需要总结太多,只需要列出修改过的文件即可

## 项目概述

Terminal Canvas — 一个 VSCode 插件,提供无限画布工作区,可在画布上自由创建、拖拽、缩放、排布多个终端窗口 + 图片窗口 + 浏览器窗口(iframe)。

## 开发命令

```bash
# 调试: 在 VSCode 中按 F5,使用 .vscode/launch.json 的 extensionHost 配置
# 等同于: --extensionDevelopmentPath=${workspaceFolder}

# Lint
npm run lint
```

无构建步骤,纯 JS 项目,VSCode 直接加载 `src/extension.js` 作为入口。

## 架构

```
Extension Host (Node.js)              Webview (浏览器沙箱)
┌──────────────────────┐              ┌─────────────────────────────┐
│ extension.js         │              │ media/canvas/*.js           │
│  ├─ panel.js         │   postMsg    │  ├─ canvas-core.js (状态/变换)│
│  ├─ sidebar.js       │◄───────────►│  ├─ window-base.js (公共)    │
│  └─ terminal-manager │              │  ├─ terminal-window.js      │
│      .js (node-pty)  │              │  ├─ image-window.js         │
└──────────────────────┘              │  ├─ browser-window.js       │
                                      │  └─ init.js (启动+事件绑定)  │
                                      └─────────────────────────────┘
```

### 消息桥协议 (postMessage)

Extension → Webview: `output`, `terminated`, `error`, `pasteData`
Webview → Extension: `createTerminal`, `input`, `resize`, `closeTerminal`, `openInPanel`

### Extension Host 层 (`src/`)

- **extension.js** — 入口,注册 `terminalCanvas.open` 和 `terminalCanvas.pasteImage` 命令,注册侧边栏 WebviewViewProvider
- **panel.js** — `TerminalCanvasPanel` 单例,管理 Webview 面板生命周期,桥接消息到 TerminalManager
- **sidebar.js** — `SidebarProvider`,Activity Bar 侧边栏入口,内嵌完整画布 UI,支持 `openInPanel` 弹出到独立面板
- **terminal-manager.js** — 核心进程管理:
  - node-pty 加载策略:直接 require → VSCode asar.unpacked → VSCode node_modules
  - 每个终端一个 pty 进程,Map<id, {ptyProcess}> 管理
  - 剪贴板图片读取:electron clipboard → macOS osascript → Linux xclip → Windows PowerShell

### Webview 层 (`media/canvas/`)

脚本通过 `<script>` 标签按顺序加载,共享全局作用域(非模块化):

1. **canvas-core.js** — 全局状态(`windows` Map, `imageWindows` Map, zoom/pan)、画布变换、SVG 网格背景、缩放、平移、minimap
2. **window-base.js** — `bringToFront()`, `closeWindow()`, `resolveOverlaps()` 等共享窗口操作
3. **terminal-window.js** — `createTerminalWindow()`,创建 xterm.js 实例 + 8 方向 resize + 标题栏拖拽 + quick command 按钮
4. **image-window.js** — `createImageWindow()`,剪贴板粘贴图片,aspect-ratio 锁定 resize
5. **browser-window.js** — `createBrowserWindow()`,URL 粘贴创建 iframe 窗口,拖拽时显示 overlay 防止 iframe 吞事件
6. **init.js** — 工具栏绑定、layout 预设(Grid/Stack)、消息监听、xterm 加载(本地优先,CDN 兜底)

### 三种窗口类型

| 类型 | 存储 Map | 创建触发 | 特殊行为 |
|------|----------|----------|----------|
| Terminal | `windows` | "+Terminal" 按钮 / Layout | xterm.js 渲染,pty 进程 |
| Image | `imageWindows` | Ctrl+V 粘贴图片 | aspect-ratio 锁定 resize |
| Browser | `imageWindows` | Ctrl+V 粘贴 URL | iframe sandbox,拖拽 overlay |

注意: Browser 窗口也存储在 `imageWindows` Map 中。

### 粘贴行为 (Ctrl+V)

由 `terminalCanvas.pasteImage` 命令触发,Extension Host 读取剪贴板后发送 `pasteData` 消息,Webview 根据鼠标位置决定行为:
- 鼠标在终端上 → 粘贴文本到该终端
- 鼠标在空白区 + 剪贴板有图片 → 创建图片窗口
- 鼠标在空白区 + 剪贴板有 URL → 创建浏览器窗口

### 画布坐标系

- CSS `transform: translate(x,y) scale(zoom)` 实现平移缩放
- 拖拽/resize 计算时 `dx / zoom` 将屏幕像素转为画布像素
- Grid snap 以 20px 为单位对齐
- No-overlap 模式: 拖拽/resize 结束后自动推开重叠窗口

### xterm.js 加载

本地打包在 `media/xterm/`(xterm 5.3.0 + fit-addon 0.8.0),加载失败则 fallback 到 jsDelivr CDN。

---

## JetBrains 插件 (`jetbrains-terminal-canvas/`)

VSCode 版的 JetBrains 平台移植，核心思路：**Webview 层 (JS/CSS) 100% 复用，Extension Host 层用 Kotlin 重写**。

### 开发命令

```bash
cd jetbrains-terminal-canvas

# 构建插件 zip（产物在 build/distributions/）
JAVA_HOME=$(/usr/libexec/java_home -v 22) ./gradlew buildPlugin

# 启动沙箱 IDE 调试
JAVA_HOME=$(/usr/libexec/java_home -v 22) ./gradlew runIde
```

需要 JDK 22（本机已安装），Gradle Wrapper 自动下载 Gradle 8.10。

### 架构映射

| VSCode | JetBrains |
|--------|-----------|
| Extension Host (Node.js) | Plugin (Kotlin, JVM) |
| Webview (iframe sandbox) | JCEF (JBCefBrowser) |
| node-pty | pty4j (IntelliJ 内置) |
| `acquireVsCodeApi().postMessage()` | `JBCefJSQuery` + bridge shim |
| `webview.postMessage()` | `cefBrowser.executeJavaScript()` + base64 编码 |
| WebviewPanel | Tool Window + JBCefBrowser |
| vscode.commands | AnAction |
| 剪贴板 (electron/osascript/xclip) | `java.awt.Toolkit` 统一 API |

### 项目结构

```
jetbrains-terminal-canvas/
├── build.gradle.kts                  # IntelliJ Platform Gradle Plugin 2.2.1
├── settings.gradle.kts
├── gradle.properties
├── gradlew                           # Gradle Wrapper
├── src/main/
│   ├── kotlin/com/terminalcanvas/
│   │   ├── TerminalCanvasAction.kt       # 打开画布的 Action (Ctrl+Shift+T)
│   │   ├── TerminalCanvasToolWindow.kt   # Tool Window 工厂
│   │   ├── CanvasPanel.kt               # JCEF 浏览器面板 + 消息桥 + HTML 生成
│   │   ├── TerminalManager.kt           # pty4j 终端进程管理
│   │   ├── SharedState.kt               # 画布状态管理
│   │   └── ClipboardHelper.kt           # Java AWT 剪贴板读取
│   └── resources/
│       ├── META-INF/plugin.xml           # 插件描述
│       ├── icons/terminal-canvas.svg     # Tool Window 图标
│       └── webview/                      # ← 从 media/ 复制，JS 零修改
│           ├── canvas/*.js, styles.css   # 7 个 JS + 1 个 CSS（仅 init.js 有微小适配）
│           └── xterm/*.js, xterm.css     # xterm 5.3.0 + fit-addon
```

### 消息桥实现

通过在 HTML 中注入 bridge shim 实现 **canvas JS 文件零修改**：

1. `window.acquireVsCodeApi()` 被 polyfill，`postMessage()` 转发到 `JBCefJSQuery`
2. Kotlin→JS 消息通过 `cefBrowser.executeJavaScript()` 调用 `window._onHostMessage()`，JSON 用 base64 编码避免转义问题
3. xterm.js/CSS 作为 inline `<script>`/`<style>` 预加载，`init.js` 检测 `_xtermPreloaded` 跳过动态加载
4. `--vscode-*` CSS 变量在 HTML `<style>` 中映射为 JetBrains 主题色值

### 与 VSCode 版的差异

- **无 multi-instance IPC**：JetBrains 版为单实例，不需要 SyncBridge / TerminalIOBridge
- **无 pop-out 按钮**：已在 Tool Window 中，`btn-pop-out` 隐藏
- **剪贴板**：Java AWT 统一处理，无需平台分支脚本
- `init.js` 唯一改动：添加 `_xtermPreloaded` 检测（3 行）

