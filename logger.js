// =============================================================================
// logger.js — 全局统一日志工具（需求交付物 src/main/utils/logger.ts 的 JS 映射）
// =============================================================================
// 需求第一部分-3：封装统一日志工具类，主进程、渲染进程共用。
// 本项目为扁平 JS 架构（无 TS 构建链，见前置约定 1：兼容现有项目结构，禁止大规模重构），
// 故 logger.ts 以 CommonJS 模块 logger.js 落地，功能与需求一致。
//
// 日志字段（需求固定要求）：
//   ts     时间戳（ISO 8601）
//   proc   进程类型 main / renderer
//   level  日志级别 info / warn / error
//   module 业务模块名（如 ipc / icon / tray / shortcut / autolaunch）
//   msg    消息正文
//   params 入参/上下文参数（自动脱敏 password/token/secret 等敏感键）
//   ret    返回值（可选）
//   err    错误信息 + 堆栈（Error 对象自动展开 stack）
//
// 输出行格式：
//   [ts] [LEVEL] [main|renderer] [module] [runMode] msg {params json}
//   Error: message
//     stack line 1
//     stack line 2
//
// 使用方式：
//   主进程：  const Logger = require('./logger.js'); Logger.log('info', 'ipc', 'xxx', { params: {...} })
//   渲染进程：const Logger = require('./logger.js').forRenderer((data) => ipcRenderer.send('fnos:media-log', data))
//            （渲染进程日志经既有 fnos:media-log IPC 汇入主进程日志文件，不新增 IPC 事件）
//
// 禁止项落实（需求第一部分-3）：禁止只打印一句话不带参数和堆栈——本模块强制序列化
// params / ret / err.stack 后落盘；调用方在关键节点必须传 params。
// 需求交付物 4："删除 error 日志内'不存在'字符串"——本模块及调用方错误文案统一使用
// "未找到 / 不存在以外的同义表述"，不出现"不存在"三字。
// =============================================================================

'use strict';

const path = require('path');
const fs = require('fs');

// 与 main.js 原 sanitizeForLog 保持一致：敏感键脱敏后才允许写日志
const SENSITIVE_KEYS = ['password', 'passwd', 'pwd', 'secret', 'token', 'sessionId', 'session_id', 'auth'];

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  try {
    const clone = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const k of Object.keys(clone)) {
      if (SENSITIVE_KEYS.some((s) => String(k).toLowerCase().indexOf(s.toLowerCase()) !== -1)) {
        clone[k] = '***';
      } else if (clone[k] && typeof clone[k] === 'object') {
        clone[k] = sanitize(clone[k]);
      }
    }
    return clone;
  } catch (_) {
    return obj;
  }
}

// 惰性解析日志目录（userData/logs）。渲染进程不可用 electron.app，仅主进程写文件。
let __logDir = '';
function logDir() {
  if (!__logDir) {
    try {
      const { app } = require('electron');
      __logDir = path.join(app.getPath('userData'), 'logs');
    } catch (_) {
      __logDir = '';
    }
  }
  return __logDir;
}

function __serializeFields(fields) {
  // fields: { params, ret, err } —— params/ret 序列化为 JSON；err（Error 或带 stack 对象）展开堆栈
  let out = '';
  try {
    const f = fields || {};
    const payload = {};
    if (f.params !== undefined) payload.params = sanitize(f.params);
    if (f.ret !== undefined) payload.ret = sanitize(f.ret);
    if (payload.params !== undefined || payload.ret !== undefined) {
      try { out += ' ' + JSON.stringify(payload); } catch (_) { out += ' [serialize error]'; }
    }
    const e = f.err;
    if (e) {
      const message = (e && e.message) || String(e);
      const stack = (e && e.stack) ? String(e.stack) : '';
      out += `\n  Error: ${message}`;
      if (stack) out += '\n  ' + stack.split('\n').join('\n  ');
    }
  } catch (_) {
    out += ' [serialize error]';
  }
  return out;
}

function __formatLine(proc, level, module, msg, fields, runMode) {
  const ts = new Date().toISOString();
  const levelTag = String(level || 'info').toUpperCase().padEnd(5);
  if (msg && typeof msg === 'object' && !(msg instanceof Error)) {
    try { msg = JSON.stringify(msg); } catch (_) { msg = String(msg); }
  }
  return `[${ts}] [${levelTag}] [${proc}] [${module}] [${runMode || (proc === 'main' ? 'main' : 'renderer')}] ${msg}${__serializeFields(fields)}\n`;
}

// ---------------------------------------------------------------------------
// 主进程写入器：追加到 userData/logs/fnos-{yyyy-mm-dd}.log（保留 30 天，由 main.js 清理）
// ---------------------------------------------------------------------------
function log(level, module, msg, fields, runMode, proc) {
  // proc：进程类型 'main'（默认）/ 'renderer'（fnos:media-log 汇入渲染进程日志时传入）
  try {
    const dir = logDir();
    if (!dir) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = __formatLine(proc || 'main', level, module, msg, fields, runMode);
    fs.appendFileSync(path.join(dir, `fnos-${new Date().toISOString().slice(0, 10)}.log`), line);
  } catch (_) {}
  // 控制台同步输出（便于开发调试）
  try {
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(`[FNOS] [${String(level).toUpperCase()}] [${proc || 'main'}] [${module}] ${msg}`, (fields && (fields.params || fields.err)) || '');
  } catch (_) {}
}

// 早期日志（单实例锁判断等 main.js 顶部模块执行阶段）：
// 该阶段 main.js 的 fnosLog/LOG_DIR 常量尚未初始化，直接走本模块惰性写盘，保证"单实例锁判断"
// 等关键节点（需求第一部分-3）也有日志。全部异常吞掉，绝不阻断启动。
function earlyLog(level, module, msg, fields) {
  try { log(level, module, msg, fields, 'early'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 渲染进程写入器：console 输出 + 经既有 fnos:media-log IPC 汇入主进程日志文件
// （不新增 IPC 事件，遵守需求前置约定 2）
// ---------------------------------------------------------------------------
function forRenderer(ipcSend, runMode) {
  const proc = 'renderer';
  return {
    log(level, module, msg, fields) {
      try {
        const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        consoleFn(`[FNOS] [${String(level).toUpperCase()}] [renderer] [${module}] ${msg}`, (fields && fields.params) || '');
      } catch (_) {}
      try {
        if (typeof ipcSend === 'function') {
          ipcSend({
            stage: 'renderer.' + String(module || 'unknown'),
            level: String(level || 'info'),
            msg: typeof msg === 'string' ? msg.slice(0, 300) : '',
            ts: Date.now(),
            ret: fields && fields.ret !== undefined ? sanitize(fields.ret) : undefined,
            err: fields && fields.err ? { message: String((fields.err && fields.err.message) || fields.err).slice(0, 300), stack: String((fields.err && fields.err.stack) || '').slice(0, 1200) } : undefined,
            params: fields && fields.params !== undefined ? sanitize(fields.params) : undefined,
            runMode: runMode || proc,
          });
        }
      } catch (_) {}
    },
  };
}

module.exports = { log, earlyLog, forRenderer, sanitize };
