package com.terminalcanvas

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class TerminalCanvasToolWindow : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val canvasPanel = CanvasPanel(project)
        val content = ContentFactory.getInstance().createContent(canvasPanel.component, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
