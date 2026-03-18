#!/bin/bash
# 启动 JetBrains 沙箱 IDE 调试 Terminal Canvas 插件
# 用法:
#   ./debug.sh          — 启动沙箱 IDE
#   ./debug.sh log      — 实时查看 idea.log
#   ./debug.sh devtools — 启动 IDE 并开启 JCEF DevTools (F12 可打开)

cd "$(dirname "$0")"

export JAVA_HOME=$(/usr/libexec/java_home -v 22)

# 沙箱 IDE 的日志目录
LOG_DIR="build/idea-sandbox/system/log"
LOG_FILE="$LOG_DIR/idea.log"

case "${1:-run}" in
  log)
    if [ ! -f "$LOG_FILE" ]; then
      echo "日志文件不存在: $LOG_FILE"
      echo "请先运行 ./debug.sh 启动沙箱 IDE"
      exit 1
    fi
    echo "=== 实时查看 $LOG_FILE ==="
    echo "Ctrl+C 退出"
    echo ""
    tail -f "$LOG_FILE" | grep --line-buffered -i -E "terminal.?canvas|terminalcanvas|JCEF|pty"
    ;;

  devtools)
    echo "JAVA_HOME=$JAVA_HOME"
    echo "启动沙箱 IDE (JCEF DevTools 已启用, 在 JCEF 面板右键 → Open DevTools)..."
    ./gradlew runIde --jvm-args="-Dintellij.internal.jcef.debug=true"
    ;;

  run|"")
    echo "JAVA_HOME=$JAVA_HOME"
    echo "启动沙箱 IDE..."
    echo ""
    echo "提示:"
    echo "  查看日志:    ./debug.sh log       (另开终端)"
    echo "  JCEF调试:    ./debug.sh devtools"
    echo "  日志文件:    $LOG_FILE"
    echo "  IDE内查看:   Help → Show Log in Finder"
    echo ""
    ./gradlew runIde
    ;;

  *)
    echo "用法: ./debug.sh [run|log|devtools]"
    echo "  run       启动沙箱 IDE (默认)"
    echo "  log       实时查看 idea.log 中插件相关日志"
    echo "  devtools  启动 IDE 并开启 JCEF DevTools"
    ;;
esac
