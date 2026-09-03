-- ============================================================================
-- fnos-danmaku.lua  —  FNOS 桌面客户端弹幕系统（mpv 脚本层 / 渲染端）
-- 数据源：B站公开弹幕（免 Key）。搜索/下载由内置 mpv-helper(Node) 完成，
--         helper 持有 mpv JSON IPC，通过 script-message 把弹幕 JSON 推进本脚本。
-- 渲染：mpv osd-overlay（ASS），滚动/顶部/底部弹幕，随播放进度推进。
-- 不改动 Electron 播放/解码逻辑。
-- ============================================================================
local mp = require 'mp'
local utils = require 'mp.utils'
local msg = require 'mp.msg'

local CFG = {
    font = 'Microsoft YaHei, SimHei, PingFang SC, Noto Sans CJK SC, sans-serif',
    baseSize = 34,
    opacity = 0.92,
    speed = 1.0,
    lineCount = 8,
    margin = 24,
    maxOnScreen = 120,
    scrollSec = 11,       -- 滚动弹幕横穿屏幕用时（秒），越小越快
    fixedSec = 4.5,       -- 顶/底部固定弹幕停留秒数
}

local state = {
    enabled = false,
    items = {},
    loadedKey = nil,
    overlay = nil,
    timer = nil,
    width = 1280, height = 720,
}

local function log(...) msg.info('danmaku:', ...) end

-- ---- helper 通信（Windows 自带 curl.exe，与右键菜单脚本同一通道） ----
local function helper_async(route, bodyJson, onDone)
    pcall(function()
        local port = os.getenv and os.getenv('FNOS_MPV_HELPER_PORT')
        local token = (os.getenv and os.getenv('FNOS_MPV_HELPER_TOKEN')) or ''
        if not port or port == '' then
            mp.osd_message('弹幕服务未就绪（请更新客户端）', 3000); onDone(nil); return
        end
        local windir = (os.getenv and os.getenv('WINDIR')) or 'C:\\Windows'
        local curl = windir .. '\\System32\\curl.exe'
        local url = 'http://127.0.0.1:' .. port .. route .. '?token=' .. token
        local args = { curl, '-s', '-m', '60', '-X', 'POST',
                       '-H', 'Content-Type: application/json',
                       '--data', bodyJson or '{}', url }
        mp.command_native_async({
            ['name'] = 'subprocess', ['args'] = args,
            ['capture_stdout'] = true, ['capture_stderr'] = true, ['playback_only'] = false
        }, function(_s, res, _e)
            local out = (res and res.stdout) or ''
            local ok, data = pcall(function() return utils.parse_json(out) end)
            if ok and type(data) == 'table' then onDone(data) else onDone(nil) end
        end)
    end)
end

local function media_keyword()
    local name = mp.get_property('media-title') or ''
    if name == '' then name = mp.get_property('filename/no-ext') or 'video' end
    name = tostring(name):gsub('^.*[\\/]', ''):gsub('%?.*$', '')
    name = name:gsub('%s*[-_|–—]%s*飞牛.*$', ''):gsub('%s*[-_|–—]%s*fnos.*$', '')
    return (name ~= '' and name) or 'video'
end

local function ass_color(hex, alpha)
    local r = math.floor(hex / 0x10000) % 256
    local g = math.floor(hex / 0x100) % 256
    local b = hex % 256
    local a = math.floor((1 - (alpha or 1)) * 255)
    return string.format('&H%02X%02X%02X%02X', a, b, g, r)
end

local function esc_ass(s)
    s = tostring(s):gsub('\\', '\\'):gsub('{', '('):gsub('}', ')'):gsub('\r?\n', ' ')
    return s
end

local function measure_video()
    state.width = mp.get_property_number('width', 1280) or 1280
    state.height = mp.get_property_number('height', 720) or 720
end

local function scale_font(itemSize)
    local base = CFG.baseSize * (state.height / 720)
    local factor = (itemSize and itemSize > 0) and (itemSize / 25) or 1
    local px = math.floor(base * (0.75 + factor * 0.45))
    local lo = math.floor(state.height / 30)
    local hi = math.floor(state.height / 12)
    if px < lo then px = lo end
    if px > hi then px = hi end
    return px
end

-- 渲染当前时刻弹幕
local function render()
    if not state.overlay then return end
    if not state.enabled or not next(state.items) then state.overlay.data = ''; state.overlay:update(); return end
    local now = mp.get_property_number('time-pos', -1)
    if now < 0 then return end

    local h = state.height
    local fsz = scale_font(25)
    local lineH = math.floor(fsz * 1.4)
    local topBase = CFG.margin * (h / 720)
    local botBase = h - CFG.margin * (h / 720)
    local scrollSec = CFG.scrollSec / CFG.speed

    local parts = {}
    parts[#parts + 1] = string.format('{\\an7\\fs%d\\fn%s\\bord2\\shad0\\be0}', fsz, CFG.font)

    local laneFreeUntil = {}   -- 滚动轨道释放时间（基于弹幕出现时刻）
    local topLaneBusy = {}
    local botLaneBusy = {}
    local count = 0

    for _, it in ipairs(state.items) do
        if count >= CFG.maxOnScreen then break end
        local dt = now - it.t
        if dt >= 0 and dt <= scrollSec + CFG.fixedSec then
            local isTop = (it.type == 5)
            local isBottom = (it.type == 4)
            local col = ass_color(it.color or 0xffffff, CFG.opacity)
            local text = esc_ass(it.text)
            local itemFs = scale_font(it.size)

            if isTop or isBottom then
                if dt <= CFG.fixedSec then
                    local busy = isTop and topLaneBusy or botLaneBusy
                    local lane = 1
                    while busy[lane] and lane <= CFG.lineCount do lane = lane + 1 end
                    if lane <= CFG.lineCount then
                        busy[lane] = true
                        local y = isTop and (topBase + (lane - 1) * lineH)
                                              or (botBase - lane * lineH)
                        parts[#parts + 1] = string.format(
                            '{\\an8\\pos(%d,%d)\\fs%d\\1c%s\\bord2\\fad(120,200)}%s',
                            math.floor(state.width / 2), math.floor(y), itemFs, col, text)
                        count = count + 1
                    end
                end
            else
                if dt <= scrollSec then
                    -- 选轨道：同一轨道上一条弹幕已完全进入（留出间距）才复用
                    local lane = 1
                    local approxW = #text * itemFs * 0.92
                    local gap = (approxW / state.width) * scrollSec * 0.6
                    while lane <= CFG.lineCount and (laneFreeUntil[lane] or -1) > (it.t + gap) do
                        lane = lane + 1
                    end
                    if lane <= CFG.lineCount then
                        laneFreeUntil[lane] = it.t + gap
                        local y = topBase + (lane - 1) * lineH
                        local startX = state.width + 20
                        local endX = -(approxW + 20)
                        parts[#parts + 1] = string.format(
                            '{\\an7\\move(%.0f,%.0f,%.0f,%.0f,0,%d)\\fs%d\\1c%s\\bord2}%s',
                            startX, y, endX, y,
                            math.floor(scrollSec * 1000), itemFs, col, text)
                        count = count + 1
                    end
                end
            end
        end
    end

    state.overlay.data = table.concat(parts, '')
    state.overlay:update()
end

local function ensure_overlay()
    if not state.overlay then
        state.overlay = mp.create_osd_overlay('ass-events')
        state.overlay.z = 0
    end
end

local function start_timer()
    if state.timer then return end
    state.timer = mp.add_periodic_timer(0.1, function() pcall(render) end)
end

local function stop_timer()
    if state.timer then state.timer:kill(); state.timer = nil end
    if state.overlay then state.overlay.data = ''; pcall(function() state.overlay:update() end) end
end

local function set_enabled(on)
    state.enabled = on and true or false
    if state.enabled then
        measure_video(); ensure_overlay(); start_timer()
        mp.osd_message('弹幕已开启', 1500)
    else
        stop_timer()
        mp.osd_message('弹幕已关闭', 1500)
    end
end

local function load_items(json_str, key)
    local ok, parsed = pcall(function() return utils.parse_json(json_str) end)
    if not ok or type(parsed) ~= 'table' then log('parse json fail'); return 0 end
    local list = parsed.danmaku or parsed.items or parsed
    if type(list) ~= 'table' then return 0 end
    local arr = {}
    for _, d in ipairs(list) do
        local t = tonumber(d.t)
        if t and d.text and t >= 0 then
            arr[#arr + 1] = {
                t = t,
                text = tostring(d.text),
                color = tonumber(d.color) or 0xffffff,
                size = tonumber(d.size) or 25,
                type = tonumber(d.type) or 1,
            }
        end
    end
    table.sort(arr, function(a, b) return a.t < b.t end)
    state.items = arr
    state.loadedKey = key
    measure_video()
    return #arr
end

-- helper（主进程）通过 IPC 下发弹幕 JSON
mp.register_script_message('fnos-danmaku-data', function(json_str, key)
    pcall(function()
        local n = load_items(json_str, key)
        if n > 0 then
            set_enabled(true)
            mp.osd_message('弹幕已加载 ' .. tostring(n) .. ' 条', 2500)
        else
            mp.osd_message('未获取到弹幕', 2500)
        end
    end)
end)

mp.register_script_message('fnos-danmaku-toggle', function() set_enabled(not state.enabled) end)
mp.register_script_message('fnos-danmaku-on', function() set_enabled(true) end)
mp.register_script_message('fnos-danmaku-off', function() set_enabled(false) end)

-- ---- 弹幕搜索/选择（经 helper 拉 B 站弹幕，下载后 helper 经 IPC 回推 fnos-danmaku-data） ----
local g_dmResults = nil
local function dm_open_results_menu()
    pcall(function()
        local items = { { title = '弹幕搜索：' .. media_keyword(), selectable = false } }
        if not g_dmResults or #g_dmResults == 0 then
            items[#items + 1] = { title = '（无结果，可换片名后重新搜索）', selectable = false }
        else
            for _, r in ipairs(g_dmResults) do
                items[#items + 1] = {
                    title = r.name or ('弹幕 ' .. tostring(r.id)),
                    cmd = 'script-message fnos-danmaku-pick ' .. tostring(r.id)
                }
            end
        end
        items[#items + 1] = { type = 'separator' }
        items[#items + 1] = { title = '重新搜索弹幕', cmd = 'script-message fnos-danmaku-search' }
        mp.set_property_native('menu-data', { type = 'menu', title = '弹幕', items = items })
        mp.commandv('script-message-to', 'context_menu', 'open')
    end)
end

local function dm_search()
    pcall(function()
        local kw = media_keyword()
        mp.osd_message('正在搜索弹幕：' .. kw .. ' …', 4000)
        helper_async('/danmaku/search', utils.format_json({ keyword = kw }), function(data)
            if not data or not data.ok then mp.osd_message('弹幕搜索失败（网络错误或被限流）', 3500); return end
            g_dmResults = data.results or {}
            if #g_dmResults == 0 then mp.osd_message('未找到弹幕，可换片名重试', 3500); return end
            dm_open_results_menu()
        end)
    end)
end

local function dm_pick(cid)
    pcall(function()
        mp.osd_message('正在加载弹幕…', 4000)
        helper_async('/danmaku/download', utils.format_json({ cid = tostring(cid) }), function(data)
            if data and data.ok and (data.count or 0) > 0 then
                mp.osd_message('弹幕加载中：' .. tostring(data.count) .. ' 条', 2500)
            else
                mp.osd_message('弹幕加载失败：' .. ((data and data.error) or '网络错误'), 3500)
            end
        end)
    end)
end

mp.register_script_message('fnos-danmaku-search', function() dm_search() end)
mp.register_script_message('fnos-danmaku-pick', function(cid) dm_pick(cid) end)

mp.register_script_message('fnos-danmaku-opts', function(k, v)
    pcall(function()
        local num = tonumber(v)
        if not num then return end
        if k == 'size' then CFG.baseSize = math.max(16, math.min(72, num))
        elseif k == 'opacity' then CFG.opacity = math.max(0.1, math.min(1, num))
        elseif k == 'speed' then CFG.speed = math.max(0.4, math.min(2.5, num))
        elseif k == 'lines' then CFG.lineCount = math.max(3, math.min(20, math.floor(num))) end
        measure_video()
    end)
end)

mp.register_event('file-loaded', function()
    measure_video()
    state.items = {}; state.loadedKey = nil
end)

log('FNOS 弹幕脚本已加载')
