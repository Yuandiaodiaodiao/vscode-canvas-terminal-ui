# Terminal Canvas - VSCode Extension

## 项目概述
一个 VSCode 插件，提供无限画布工作区，用户可以在画布上自由创建、拖拽、缩放、排布多个终端窗口，适用于同时监控多个终端的场景。

## 架构

```
[VSCode Extension Host]          [Webview (Canvas UI)]
        |                                |
   node-pty 进程管理  <── 消息桥 ──>  xterm.js 渲染
        |                                |
   真实 shell 进程              拖拽/缩放/平移/布局
```

### 数据流
1. Webview 发送 `createTerminal` → Extension Host 通过 node-pty 启动 shell 进程
2. node-pty `onData` → `postMessage` → Webview xterm.js `write()`
3. xterm.js `onData` → `postMessage` → node-pty `write()`
4. 窗口 resize → xterm fit-addon 计算 cols/rows → node-pty `resize()`

## 文件结构

```
src/
  extension.js    — 入口，注册命令 + 侧边栏 WebviewViewProvider
  panel.js        — Webview 面板管理，node-pty 进程生命周期
  sidebar.js      — 侧边栏面板，提供 "Open Terminal Canvas" 按钮
  webview.js      — 画布 UI（HTML/CSS/JS），包含 xterm.js 终端渲染
media/
  icon.svg        — Activity Bar 图标
.vscode/
  launch.json     — F5 调试配置
```

## 关键设计

### node-pty 加载策略
VSCode 自带 node-pty，按以下顺序尝试加载：
1. `require('node-pty')` — 直接加载
2. `${appRoot}/node_modules.asar.unpacked/node-pty` — VSCode 内置
3. `${appRoot}/node_modules/node-pty` — 备选路径

### 画布坐标系
- 画布使用 CSS `transform: translate(x,y) scale(zoom)` 实现平移和缩放
- 终端窗口使用 `position: absolute` 定位在画布内
- 拖拽/缩放计算时需除以 `zoom` 将屏幕坐标转换为画布坐标
- 滚轮缩放以鼠标位置为中心点

### 终端窗口交互
- 标题栏拖拽移动
- 8 方向 resize handle（上下左右 + 四角）
- 点击自动置顶（z-index 递增）
- 聚焦窗口高亮边框

### 布局预设
- Grid: 2×2 / 3×2 / 4×3
- Stack: 垂直 / 水平排列
- Fit All: 自动缩放视口以显示所有窗口

## 入口
- Activity Bar 图标 → 侧边栏 → "Open Terminal Canvas" 按钮
- 命令面板: `Open Canvas`
- 快捷键: `Cmd+Shift+T`
