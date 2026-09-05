#!/bin/bash
# 构建 ZDY FPK 包（gzip USTAR tar）
# 用法: bash build.sh [x86|arm]
set -e
cd "$(dirname "$0")"
ARCH="${1:-x86}"
PLATFORM="x86"
SUFFIX="x86_64"
if [ "$ARCH" = "arm" ] || [ "$ARCH" = "aarch64" ]; then PLATFORM="arm"; SUFFIX="aarch64"; fi

WORK="$(pwd)/dist/build"
rm -rf "$WORK"
mkdir -p "$WORK"

# 1) 顶层文件
cp manifest "$WORK/manifest"
# 按架构替换 platform
sed -i "s/^platform .*/platform              = ${PLATFORM}/" "$WORK/manifest"
cp ICON.PNG "$WORK/ICON.PNG"
cp ICON_256.PNG "$WORK/ICON_256.PNG"

# 2) 生命周期脚本
mkdir -p "$WORK/cmd" "$WORK/config"
cp cmd/* "$WORK/cmd/"
chmod +x "$WORK/cmd/"*
cp config/privilege "$WORK/config/privilege"
cp config/resource "$WORK/config/resource"

# 3) app.tgz（server + www + ui；纯 JS 两架构相同）
mkdir -p "$WORK/apppkg"
cp -r app/server "$WORK/apppkg/server"
[ -d app/www ] && cp -r app/www "$WORK/apppkg/www"
cp -r app/ui "$WORK/apppkg/ui"
tar --format=ustar -czf "$WORK/app.tgz" -C "$WORK/apppkg" .
rm -rf "$WORK/apppkg"

# 4) 打包 fpk
mkdir -p dist
VER="$(grep -E '^version' "$WORK/manifest" | awk -F'=' '{gsub(/ /,"",$2);print $2}')"
OUT="dist/zdy-${VER}-${SUFFIX}.fpk"
tar --format=ustar -czf "$OUT" -C "$WORK" manifest ICON.PNG ICON_256.PNG cmd config app.tgz
rm -rf "$WORK"
echo "built: $OUT"
ls -la "$OUT"
