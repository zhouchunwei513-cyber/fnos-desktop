#!/usr/bin/env bash
# 编译自定义 NSIS 安装包（Linux 原生 makensis，无需 wine）
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAKENSIS="$HOME/.cache/electron-builder/nsis/nsis-3.0.4.1/linux/makensis"
NSIS_DIR="$HOME/.cache/electron-builder/nsis/nsis-3.0.4.1"
VERSION=$(node -p "require('$ROOT/package.json').version")
OUT_NAME="FNOS-Setup-${VERSION}.exe"
OUT="$ROOT/dist/$OUT_NAME"

if [ ! -x "$MAKENSIS" ]; then
  echo "❌ 未找到 makensis: $MAKENSIS，请先运行 electron-builder 触发 NSIS 下载"
  exit 1
fi

if [ ! -d "$ROOT/dist/win-unpacked" ]; then
  echo "❌ 未找到 $ROOT/dist/win-unpacked，请先执行 electron-builder --dir"
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 复制一份 nsi 并替换路径
sed \
  -e "s|INSTALLER_OUT.exe|$OUT|g" \
  -e "s|ICON_PATH|$ROOT/icon.ico|g" \
  -e "s|LICENSE_FILE|$ROOT/build/LICENSE.txt|g" \
  -e "s|APP_DIR|$ROOT/dist/win-unpacked|g" \
  "$ROOT/build/installer.nsi" > "$WORK/installer.nsi"

echo "==> 使用 makensis 编译: $($MAKENSIS -VERSION | head -1)"
echo "==> 输出: $OUT"

NSISDIR="$NSIS_DIR" "$MAKENSIS" -V2 -NOCD "$WORK/installer.nsi"

echo ""
echo "==> 编译完成"
ls -lh "$OUT"
