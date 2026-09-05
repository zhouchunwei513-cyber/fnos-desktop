/**
 * fnos_auth.js — 飞牛 fnOS 系统级 WebSocket 认证客户端
 *
 * 逆向自飞牛官方 Web API 文档（https://fnosp.github.io/fnnas-api/）实测验证：
 *   1. WS 连接  ws(s)://<host>/websocket?type=main
 *   2. 发送 util.crypto.getRSAPub 获取服务器 RSA 公钥 + si
 *   3. 随机生成 32B AES key / 16B iv：
 *        - RSA(PKCS1) 公钥加密 AES key -> base64 (rsa 字段)
 *        - AES-256-CBC 加密登录体 JSON -> base64 (aes 字段)
 *      发送 {req:"encrypted", iv, rsa, aes}
 *   4. 登录返回 token + secret(用会话 AES key 加密的 16B HMAC 密钥)
 *   5. 后续签名命令：HMAC-SHA256(secretRaw, compactJSON) -> base64，
 *      拼在 JSON 前发送：<sign><json>
 *
 * 说明：
 *   - 本模块仅实现【系统级】WS 认证（user.info 等系统命令实测通过）。
 *   - 飞牛影视字幕接口 /v/api/v1/subtitle/* 属于 trimemedia 媒体服务，
 *     使用独立的 OAuth token（新版 fnOS 已强制浏览器 SSO），系统 WS token 不被其接受，
 *     因此字幕检索仍走 assrt 等公开源；本模块供后续飞牛系统能力扩展使用。
 *
 * 纯 Node 内置模块实现，Node 18+ 有全局 WebSocket，可直接运行。
 */

'use strict';

const crypto = require('crypto');

function genReqId() {
  return Date.now().toString(16) + crypto.randomBytes(8).toString('hex');
}

/**
 * 登录飞牛 fnOS，返回 { token, secretRaw, close }。
 * @param {Object} opts
 * @param {string} opts.host  NAS 主机（IP 或域名）
 * @param {number} [opts.port] 端口
 * @param {boolean} [opts.tls] 是否 wss/https
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {number} [opts.timeoutMs]
 */
function login(opts) {
  const {
    host,
    port = 0,
    tls = false,
    username,
    password,
    timeoutMs = 15000,
  } = opts || {};

  if (!host || !username || !password) {
    return Promise.reject(new Error('fnos_auth: host/username/password 必填'));
  }
  if (typeof WebSocket === 'undefined') {
    return Promise.reject(new Error('fnos_auth: 当前 Node 无全局 WebSocket（需 Node 18+）'));
  }

  const scheme = tls ? 'wss' : 'ws';
  const portPart = port ? `:${port}` : '';
  const wsUrl = `${scheme}://${host}${portPart}/websocket?type=main`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      reject(new Error('fnos_auth: 登录超时'));
    }, timeoutMs);

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { ws.close(); } catch (e) { /* ignore */ } reject(err); }
      else resolve(val);
    };

    ws.addEventListener('open', () => {
      // step 1: get RSA pub
      const pubId = genReqId();
      const onPub = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.reqid !== pubId) return;
        ws.removeEventListener('message', onPub);

        if (!msg.pub || msg.result !== 'succ') {
          done(new Error('fnos_auth: 获取 RSA 公钥失败 ' + JSON.stringify(msg).slice(0, 160)));
          return;
        }

        const aesKey = crypto.randomBytes(32);
        const aesIv = crypto.randomBytes(16);
        let rsaB64;
        try {
          rsaB64 = crypto.publicEncrypt(
            { key: msg.pub, padding: crypto.constants.RSA_PKCS1_PADDING },
            aesKey
          ).toString('base64');
        } catch (e) {
          done(new Error('fnos_auth: RSA 加密失败 ' + e.message));
          return;
        }

        const innerId = genReqId();
        const loginBody = {
          req: 'user.login',
          reqid: innerId,
          user: username,
          password,
          deviceType: 'Browser',
          deviceName: 'Windows-Google Chrome',
          stay: false,
          si: msg.si,
        };

        let aesB64;
        try {
          const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesIv);
          aesB64 = Buffer.concat([
            cipher.update(JSON.stringify(loginBody), 'utf8'),
            cipher.final(),
          ]).toString('base64');
        } catch (e) {
          done(new Error('fnos_auth: AES 加密失败 ' + e.message));
          return;
        }

        const onLogin = (ev2) => {
          let m2;
          try { m2 = JSON.parse(ev2.data); } catch (e) { return; }
          if (m2.reqid !== innerId) return;
          ws.removeEventListener('message', onLogin);

          if (!m2.token) {
            done(new Error('fnos_auth: 登录失败 ' + JSON.stringify(m2).slice(0, 160)));
            return;
          }

          let secretRaw;
          try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesIv);
            secretRaw = Buffer.concat([
              decipher.update(Buffer.from(m2.secret, 'base64')),
              decipher.final(),
            ]);
          } catch (e) {
            done(new Error('fnos_auth: secret 解密失败 ' + e.message));
            return;
          }

          const session = {
            token: m2.token,
            uid: m2.uid,
            secretRaw,
            ws,
            close() { try { ws.close(); } catch (e) { /* ignore */ } },
            call(cmdObj) {
              return sendSigned(ws, secretRaw, cmdObj, timeoutMs);
            },
          };
          done(null, session);
        };

        ws.addEventListener('message', onLogin);
        ws.send(JSON.stringify({
          req: 'encrypted',
          iv: aesIv.toString('base64'),
          rsa: rsaB64,
          aes: aesB64,
          reqid: genReqId(),
        }));
      };

      ws.addEventListener('message', onPub);
      ws.send(JSON.stringify({ req: 'util.crypto.getRSAPub', reqid: pubId }));
    });

    ws.addEventListener('error', (e) => {
      done(new Error('fnos_auth: WebSocket 错误 ' + (e && e.message ? e.message : '连接失败')));
    });
  });
}

function sendSigned(ws, secretRaw, cmdObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = genReqId();
    const payload = Object.assign({ reqid: id }, cmdObj);
    const data = JSON.stringify(payload);
    const sign = crypto.createHmac('sha256', secretRaw).update(data).digest('base64');

    const handler = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.reqid !== id) return;
      ws.removeEventListener('message', handler);
      clearTimeout(timer);
      resolve(m);
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('fnos_auth: 命令超时 ' + (cmdObj && cmdObj.req)));
    }, timeoutMs || 10000);

    ws.addEventListener('message', handler);
    ws.send(sign + data);
  });
}

module.exports = { login, genReqId };
