# Terminal Canvas

<img width="1088" height="1034" alt="Clipboard_Screenshot_1773673099" src="https://github.com/user-attachments/assets/f0d1b37e-df0b-441d-b943-141eb73b13f0" />

> 🖥️ VSCode 无限画布终端工作区 | An infinite canvas workspace for terminals in VSCode

## 简介

Terminal Canvas 是一个 VSCode 扩展，提供无限画布工作区，可在画布上自由创建、拖拽、缩放、排布多个终端窗口、图片窗口和浏览器窗口。

Terminal Canvas is a VSCode extension that provides an infinite canvas workspace where you can freely create, drag, resize, and arrange multiple terminal windows, image windows, and browser windows (iframe).

## ✨ 功能特性 / Features

- **🖥️ 多终端窗口 / Multiple Terminals** — 在画布上同时打开多个终端，使用 xterm.js 渲染，支持真实 pty 进程
  Open multiple terminals on the canvas simultaneously, rendered with xterm.js and backed by real pty processes

- **🖼️ 图片窗口 / Image Windows** — 通过 Ctrl+V 粘贴剪贴板图片到画布，支持等比缩放
  Paste clipboard images onto the canvas with Ctrl+V, with aspect-ratio locked resizing

- **🌐 浏览器窗口 / Browser Windows** — 粘贴 URL 创建 iframe 浏览器窗口
  Paste URLs to create iframe browser windows

- **🔍 无限画布 / Infinite Canvas** — 自由平移缩放，SVG 网格背景，小地图导航
  Free pan & zoom, SVG grid background, minimap navigation

- **📐 智能布局 / Smart Layout** — Grid / Stack 预设布局，20px 网格对齐，自动防重叠
  Grid / Stack layout presets, 20px grid snapping, automatic overlap prevention

- **↔️ 8 方向调整大小 / 8-Direction Resize** — 所有窗口支持 8 个方向自由调整尺寸
  All windows support resizing from 8 directions

- **📋 智能粘贴 / Smart Paste** — 根据鼠标位置和剪贴板内容自动选择行为：粘贴文本到终端 / 创建图片窗口 / 创建浏览器窗口
  Automatically chooses behavior based on cursor position and clipboard content: paste text to terminal / create image window / create browser window

## 🚀 快速开始 / Quick Start

### 安装 / Installation

1. 克隆仓库 / Clone the repo:
   ```bash
   git clone https://github.com/Yuandiaodiaodiao/vscode-canvas-terminal-ui.git
   ```
2. 在 VSCode 中打开项目 / Open in VSCode
3. 按 **F5** 启动调试 / Press **F5** to launch Extension Development Host

### 使用 / Usage

- **快捷键 / Shortcut**: `Ctrl+Shift+T` (Mac: `Cmd+Shift+T`) 打开画布面板 / Open canvas panel
- **侧边栏 / Sidebar**: 点击 Activity Bar 中的 Terminal Canvas 图标 / Click the Terminal Canvas icon in Activity Bar
- 点击 **+Terminal** 按钮创建新终端 / Click **+Terminal** to create a new terminal
- 在空白区域 **Ctrl+V** 粘贴图片或 URL / **Ctrl+V** on blank area to paste images or URLs

## 🏗️ 架构 / Architecture

```
Extension Host (Node.js)              Webview (Browser Sandbox)
┌──────────────────────┐              ┌─────────────────────────────┐
│ extension.js         │              │ media/canvas/*.js           │
│  ├─ panel.js         │   postMsg    │  ├─ canvas-core.js          │
│  ├─ sidebar.js       │◄───────────►│  ├─ window-base.js          │
│  └─ terminal-manager │              │  ├─ terminal-window.js      │
│      .js (node-pty)  │              │  ├─ image-window.js         │
└──────────────────────┘              │  ├─ browser-window.js       │
                                      │  └─ init.js                 │
                                      └─────────────────────────────┘
```

### Extension Host 层 / Extension Host Layer (`src/`)

| 文件 / File | 职责 / Role |
|---|---|
| `extension.js` | 入口，注册命令和侧边栏 / Entry point, registers commands & sidebar |
| `panel.js` | Webview 面板生命周期管理 / Webview panel lifecycle management |
| `sidebar.js` | Activity Bar 侧边栏 Provider / Activity Bar sidebar provider |
| `terminal-manager.js` | node-pty 进程管理，剪贴板读取 / node-pty process management, clipboard reading |

### Webview 层 / Webview Layer (`media/canvas/`)

| 文件 / File | 职责 / Role |
|---|---|
| `canvas-core.js` | 全局状态、画布变换、缩放、平移、minimap / Global state, canvas transform, zoom, pan, minimap |
| `window-base.js` | 窗口公共操作（置顶、关闭、防重叠）/ Shared window ops (bring to front, close, overlap prevention) |
| `terminal-window.js` | 终端窗口创建与交互 / Terminal window creation & interaction |
| `image-window.js` | 图片窗口（等比缩放）/ Image window (aspect-ratio resize) |
| `browser-window.js` | 浏览器 iframe 窗口 / Browser iframe window |
| `init.js` | 工具栏、布局预设、事件绑定、xterm 加载 / Toolbar, layout presets, event bindingsss, xterm loading |

### 消息协议 / Message Protocol

| 方向 / Direction | 消息类型 / Message Types |
|---|---|
| Extension → Webview | `output`, `terminated`, `error`, `pasteData` |
| Webview → Extension | `createTerminal`, `input`, `resize`, `closeTerminal`, `openInPanel` |

## 📄 License

MIT
