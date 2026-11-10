#!/usr/bin/env bash
# 打印 mac 直播 MPV 覆盖窗的「期望矩形 vs 实际窗口矩形」与逐像素差值。
# 依赖客户端 /diag mpv（v5.1.23 起返回 geomAtSpawn/spawnGeo/macMode/asOk/actualRect/lastVerify）。
# 用法: tools/mac-mpv-geom.sh [MAC_HOST]
set -uo pipefail
KEY="${SSH_KEY:-/vol3/@apphome/fn-deepseek-harness/secrets/ssh/dsh_ed25519}"
KH="${SSH_KH:-/vol3/@apphome/fn-deepseek-harness/secrets/ssh/known_hosts}"
HOST="${1:-${MAC_HOST:-zhouchunwei@192.168.31.83}}"
TMP="$(mktemp /tmp/mac-mpv-geom.XXXXXX.json)"
trap 'rm -f "$TMP"' EXIT
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile="$KH" \
    -o IdentitiesOnly=yes -o ConnectTimeout=10 "$HOST" "bash -s" >"$TMP" <<'REMOTE'
EP="$HOME/Library/Application Support/fnos-client/fnos-launch-endpoint.txt"
PORT=$(sed -n 1p "$EP" | tr -d '\r'); TOKEN=$(sed -n 2p "$EP" | tr -d '\r')
curl -s -m 30 -X POST "http://127.0.0.1:$PORT/diag" \
  --data-urlencode "token=$TOKEN" --data-urlencode "action=mpv" --data-urlencode "params={}"
REMOTE
python3 - "$TMP" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding='utf-8').read().strip()
try:
    data = json.loads(raw)
except Exception:
    print('无法解析 /diag mpv 回包：'); print(raw[:800]); sys.exit(1)
surfs = (data.get('surfaces') if isinstance(data, dict) else None) or []
if not surfs:
    print('没有 MPV surface（先点「🎬 MPV 打开」）'); print(raw[:600]); sys.exit(0)
def fmt(r):
    return '(x=%d, y=%d, w=%d, h=%d)' % (r['x'], r['y'], r['width'], r['height']) if r else 'None'
for i, s in enumerate(surfs):
    print('surface #%d  key=%s standalone=%s macMode=%s asOk=%s' % (
        i, s.get('key'), s.get('standalone'), s.get('macMode'), s.get('asOk')))
    print('  期望(Electron 顶左) :', fmt(s.get('geomAtSpawn')))
    print('  下发(mpv geometry) :', fmt(s.get('spawnGeo')))
    print('  实际(CGWindowList) :', fmt(s.get('actualRect')))
    w, a = s.get('geomAtSpawn'), s.get('actualRect')
    if w and a:
        d = {k: a[k] - w[k] for k in ('x', 'y', 'width', 'height')}
        ok = all(abs(v) <= 2 for v in d.values())
        print('  差值 dx=%d dy=%d dw=%d dh=%d  -> %s' % (
            d['x'], d['y'], d['width'], d['height'], '✅ ≤2px 贴合' if ok else '❌ 未贴合'))
    if s.get('lastVerify'):
        print('  lastVerify         :', json.dumps(s['lastVerify'].get('delta'), ensure_ascii=False))
PY
