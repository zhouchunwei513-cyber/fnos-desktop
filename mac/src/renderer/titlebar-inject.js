'use strict';
/**
 * macOS 版 titlebar-inject —— 有意实现的空实现（no-op）。
 *
 * Windows 版的 titlebar-inject 会把自绘标题栏注入到 webview 承载的 NAS 页面内部，
 * 再用 body transform 下移页面；macOS 上标题栏由外壳窗口（BrowserWindow hiddenInset
 * + shell.html 自绘工具栏）承担，绝不能注入远端页面，否则会出现双标题栏、
 * webview 高度被扣两次、fnOS 首页底部被裁切。
 *
 * 保留同名模块是为了让与 Windows 共用的 preload.js / settings-preload.js
 * 里的 `require('./titlebar-inject')` 不抛错（它们都包在 try/catch 中，
 * 这里显式提供函数，语义上就是"macOS 无需注入"）。
 */
module.exports = function titlebarInject(/* { ipcRenderer } */) {
  return null;
};
