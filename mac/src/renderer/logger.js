'use strict';
// 与 Windows 版 preload 共用的 logger 落点（preload 里 require('./logger.js')）。
// 实际实现放在 src/logger.js，主进程与渲染进程共用同一份。
module.exports = require('../logger.js');
