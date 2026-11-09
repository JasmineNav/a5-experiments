#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
if [ -x ".a5-local/android/platform-tools/adb" ]; then
  export A5_ADB_PATH="$PWD/.a5-local/android/platform-tools/adb"
  export PATH="$PWD/.a5-local/android/platform-tools:$PATH"
fi
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 24 或更高版本，再重新打开启动器。"
  read -r -p "按回车关闭……"
  exit 1
fi
node scripts/experiment-launcher.mjs
result=$?
if [ "$result" -ne 0 ]; then
  read -r -p "启动器已退出，按回车关闭……"
fi
exit "$result"
