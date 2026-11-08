#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 生成 macOS 应用图标 build/icons/icon.icns
#
# 为什么需要这个脚本：
#   仓库里只有 build/icons/*.png（最大 256x256）和根目录 icon.png（1024x1024），
#   没有 .icns。electron-builder 的 mac 目标要求 .icns（或用 512x512+ 的 png）。
#   macOS 自带 sips / iconutil 可以把 1024 的 png 拆成标准 iconset 再打回 icns，
#   这两条命令在 macOS 上零依赖；本脚本只在 macOS（或装了 iconutil 的环境）运行。
#
# 用法：
#   bash build/make-icns.sh        # 生成 build/icons/icon.icns
#   npm run icons:mac              # 同上（package.json 里的 predist:mac / prebuild:mac 会自动调用）
#
# 说明：
#   - 源图优先用根目录 icon.png（1024x1024，build-icon.cjs 生成），缺失时回退
#     build/icons/256x256.png（会被放大，仅作兜底）。
#   - 已有 icns 且比源图新则直接跳过，避免每次构建重复生成。
#   - Linux/Windows 上没有 iconutil，脚本会明确报错退出（提示在 macOS 上执行），
#     不会静默产出一个不可用的图标。
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONSET="${ROOT}/build/icons/icon.iconset"
OUT="${ROOT}/build/icons/icon.icns"

SRC="${ROOT}/icon.png"
if [ ! -f "$SRC" ]; then
  SRC="${ROOT}/build/icons/256x256.png"
fi
if [ ! -f "$SRC" ]; then
  echo "[make-icns] 找不到源图：icon.png 或 build/icons/256x256.png" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
  echo "[make-icns] 需要 macOS 的 sips + iconutil（当前环境不可用）。" >&2
  echo "[make-icns] 请在 macOS 上执行，或在 CI 的 macos-* runner 上运行该步骤。" >&2
  exit 1
fi

if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  echo "[make-icns] 已是最新：$OUT"
  exit 0
fi

echo "[make-icns] 源图：$SRC"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Apple 标准 iconset 尺寸（文件名必须严格匹配，iconutil 才认）
emit() { # <像素> <文件名>
  sips -z "$1" "$1" "$SRC" --out "${ICONSET}/$2" >/dev/null
}
emit 16   icon_16x16.png
emit 32   icon_16x16@2x.png
emit 32   icon_32x32.png
emit 64   icon_32x32@2x.png
emit 128  icon_128x128.png
emit 256  icon_128x128@2x.png
emit 256  icon_256x256.png
emit 512  icon_256x256@2x.png
emit 512  icon_512x512.png
emit 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$ICONSET"

if [ ! -s "$OUT" ]; then
  echo "[make-icns] 生成失败：$OUT 为空" >&2
  exit 1
fi
echo "[make-icns] 完成：$OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
