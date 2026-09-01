mpv.exe 不随源码仓库分发（约 120MB，超过 GitHub 100MB 单文件限制）。

GitHub Actions 构建时会自动从 mpv 官方 Windows 构建（SourceForge）下载并放到本目录。
本地手动构建时，请下载 mpv-x86_64 构建，解压出 mpv.exe
（如有 d3dcompiler_43.dll 一并放入）放到本目录：
  - https://sourceforge.net/projects/mpv-player-windows/files/64bit/
  - 或 https://github.com/mpv-player/mpv 的 Actions x86_64 构建
