#!/usr/bin/env bash
# 在 macOS CI runner 上把 Homebrew 的 mpv 打成一个最小 .app 包，
# 供 electron-builder 以 extraResources 形式随 app 分发（路径与 main/mpv-player 的探测逻辑一致）：
#   <Resources>/mpv/<arch>/mpv.app/Contents/MacOS/mpv        ← 启动脚本
#   <Resources>/mpv/<arch>/mpv.app/Contents/MacOS/mpv.real   ← 真实二进制
#   <Resources>/mpv/<arch>/mpv.app/Contents/Frameworks/*.dylib
# 用法: build/mac-bundle-mpv.sh <arm64|x64>
set -euo pipefail
ARCH="${1:-arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/mac-mpv/$ARCH"
APP="$OUT/mpv.app"
MACOS="$APP/Contents/MacOS"
FW="$APP/Contents/Frameworks"

HOST_ARCH="$(uname -m)"
WANT_ARCH="$([ "$ARCH" = "x64" ] && echo x86_64 || echo arm64)"
if [ "$HOST_ARCH" != "$WANT_ARCH" ]; then
  echo "host=$HOST_ARCH want=$WANT_ARCH → 跳过（跨架构不打包 mpv，运行时回退系统 mpv）"
  exit 0
fi
if ! command -v brew >/dev/null 2>&1; then echo "no brew, skip mpv bundling"; exit 0; fi
if ! brew install mpv >/dev/null 2>&1; then echo "brew install mpv failed, skip"; exit 0; fi

MPV_BIN="$(brew --prefix mpv)/bin/mpv"
[ -x "$MPV_BIN" ] || { echo "mpv binary not found, skip"; exit 0; }

rm -rf "$OUT"; mkdir -p "$MACOS" "$FW"
cp "$MPV_BIN" "$MACOS/mpv.real"
chmod +x "$MACOS/mpv.real"

# 收集直接依赖里的 Homebrew dylib（递归一层即可覆盖 celler 依赖链）
collect() {
  otool -L "$1" 2>/dev/null | tail -n +2 | awk '{print $1}' | while read -r lib; do
    case "$lib" in
      /opt/homebrew/*|/usr/local/*)
        base="$(basename "$lib")"
        if [ ! -f "$FW/$base" ] && [ -f "$lib" ]; then
          cp "$lib" "$FW/$base" && collect "$lib"
        fi ;;
    esac
  done
}
collect "$MACOS/mpv.real" || true

cat > "$MACOS/mpv" <<'WRAP'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export DYLD_FALLBACK_LIBRARY_PATH="$DIR/../Frameworks:${DYLD_FALLBACK_LIBRARY_PATH:-}"
exec "$DIR/mpv.real" "$@"
WRAP
chmod +x "$MACOS/mpv"

echo "mpv bundled: $(du -sh "$OUT" | cut -f1) | dylibs: $(ls -1 "$FW" | wc -l | tr -d ' ')"
