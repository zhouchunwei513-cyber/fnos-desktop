## v5.0.4

### 应用内点链接：改为客户端新窗口打开

- 用户要求：应用里点链接/点功能，一律在客户端以新窗口打开，不再跳系统浏览器；
- 修法：`setWindowOpenHandler` 里非 NAS 主机的 http(s) 地址由 `shell.openExternal` 改为
  `createAppWindow(url, { source: 'external' })`（失败才回退浏览器）；
- 日志 `nav.external.window`。

