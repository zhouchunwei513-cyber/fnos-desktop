mpv.exe 不随源码仓库分发（约 120MB，超 GitHub 单文件 100MB 限制）。

GitHub Actions 构建时会自动从本仓库的 mpv-runtime Release（资产 mpv-runtime-x86_64.7z，
内含 mpv.exe + d3dcompiler_43.dll，Windows x86_64 / mpv v0.41.0）下载并解压到本目录。

本地手动构建：把 mpv.exe（及 d3dcompiler_43.dll）放到本目录即可，例如从
  https://sourceforge.net/projects/mpv-player-windows/files/64bit/
下载 mpv-x86_64 构建解压取得。
