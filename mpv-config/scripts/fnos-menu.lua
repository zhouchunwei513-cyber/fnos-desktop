-- FNOS 内置 MPV · 全中文右键菜单
-- 背景：mpv 官方 Windows（shinchiro）构建不随包提供 gettext 中文翻译，也没有 --lang 选项，
--       默认右键菜单是英文。这里用 Lua 构造菜单数据（menu-data 属性），交给 mpv 内置
--       context_menu 脚本以 OSD 方式渲染中文菜单，任何 0.36+ 版本都可用。
-- 打开方式：给内置脚本发 script-message "context_menu open"（等价于 script-binding context_menu/open）。
-- v1.33 增强：音轨/内置字幕轨、在线字幕搜索下载、画质、播放信息、跳过片头片尾、弹幕。
-- 安全：全部逻辑包在 pcall 里，任何 API 不兼容/异常都只影响菜单本身，绝不影响播放。
-- 注意：必须显式 require mp / mp.utils / mp.msg。shinchiro 构建下全局 mp 表不保证带 .utils，
--       直接写 utils.format_json 会在运行时 "attempt to index field 'utils' (a nil value)"，
--       一旦在 build_menu/菜单回调里触发，整个菜单脚本崩溃，画质/播放信息/字幕全部失效。

local mp = require 'mp'
local utils = require 'mp.utils'
local msg = require 'mp.msg'

local g_results = nil       -- 最近一次在线字幕搜索结果
local g_searching = nil     -- 正在搜索的语言标记
local g_dm_results = nil    -- 最近一次弹幕搜索结果（cid/标题）
local g_dm_searching = false -- 弹幕是否正在搜索
local g_skip_intro_sec = 90   -- 手动跳过片头：前进秒数
local g_skip_credits_sec = 60 -- 手动跳到片尾：回退秒数
local g_skip_auto = false     -- 自动跳过片头（按章节标记）
local g_auto_enhance = true   -- 起播自动经 ZDY 加载弹幕/字幕/片头片尾（再次打开影片秒载缓存）
local g_auto_done = false     -- 当前文件自动增强是否已触发（防重）
-- ZDY 权威片头片尾时间戳（秒）；起播自动获取，优先于章节/默认秒数
local g_zdy_intro_end = nil
local g_zdy_credits_start = nil
local build_menu            -- 前向声明（open_context_menu 会先用到，真正赋值在后面）

-- ---------------- 基础工具 ----------------
local function item(title, cmd, shortcut)
    local it = { ["title"] = title }
    if cmd then it["cmd"] = cmd end
    if shortcut then it["shortcut"] = shortcut end
    return it
end
local function sep() return { ["type"] = "separator" } end

-- 刷新菜单数据：把中文菜单写入 mpv 的 menu-data 属性（内置 context_menu / 原生右键菜单都会读它）
local function refresh_menu_data()
    pcall(function() mp.set_property_native("menu-data", build_menu()) end)
end

-- 打开右键菜单。Windows 无原生右键菜单，mpv 走内置 @context_menu.lua（OSD 渲染）：
--   该脚本只暴露 script-message "context_menu open"，读取 menu-data 属性后绘制中文菜单。
-- 注意：内置命令 "context-menu" 在 Windows 上是 VOCTRL_SHOW_MENU，无原生菜单后端=空操作，
--       因此这里直接发 script-message 打开。每次打开前刷新 menu-data（音轨/字幕轨/搜索结果均为动态）。
local function open_context_menu()
    pcall(function()
        refresh_menu_data()
        -- 内置 context_menu.lua 注册的脚本名是 "context_menu"、消息名是 "open"，
        -- 必须用 script-message-to 指定目标脚本；写成全局 broadcast 不会被它接收（菜单打不开）。
        mp.commandv("script-message-to", "context_menu", "open")
    end)
end

-- 调主进程本地助手（异步 subprocess 调 curl，绝不阻塞播放）。route 形如 /subtitle/search。
local function helper_async(route, bodyJson, onDone)
    pcall(function()
        local port = os.getenv and os.getenv("FNOS_MPV_HELPER_PORT")
        local token = (os.getenv and os.getenv("FNOS_MPV_HELPER_TOKEN")) or ""
        if not port or port == "" then
            mp.osd_message("字幕服务未就绪（请更新客户端）", 3000); onDone(nil); return
        end
        local windir = (os.getenv and os.getenv("WINDIR")) or "C:\\Windows"
        local curl = windir .. "\\System32\\curl.exe"
        local url = "http://127.0.0.1:" .. port .. route .. "?token=" .. token
        local args = { curl, "-s", "-m", "45", "-X", "POST",
                       "-H", "Content-Type: application/json",
                       "--data", bodyJson or "{}", url }
        mp.command_native_async({
            ["name"] = "subprocess", ["args"] = args,
            ["capture_stdout"] = true, ["capture_stderr"] = true, ["playback_only"] = false
        }, function(_success, res, _err)
            local out = (res and res.stdout) or ""
            local ok, data = pcall(function() return utils.parse_json(out) end)
            if ok and type(data) == "table" then onDone(data) else onDone(nil) end
        end)
    end)
end

local function media_keyword()
    -- 优先用真实片名（force-media-title / media-title，由客户端按网页 document.title 设置）；
    -- 否则退到文件名。去掉站点后缀与年份/分辨率等噪音，提升字幕/弹幕命中率。
    local name = mp.get_property("media-title") or ""
    if name == "" then name = mp.get_property("filename/no-ext") or "video" end
    name = tostring(name):gsub("^.*[\\/]", ""):gsub("%?.*$", "")
    name = name:gsub("%s*[-_|–—]%s*飞牛.*$", ""):gsub("%s*[-_|–—]%s*fnos.*$", "")
    return (name ~= "" and name) or "video"
end

-- ---------------- 播放统计信息（码率/分辨率/帧率/硬解/格式/丢帧/缓存）----------------
-- 用属性实时拼出中文统计 OSD，替代旧版英文 stats 页（shinchiro 构建不带中文翻译）。
local function fmt_kbps(v)
    local n = tonumber(v)
    if not n or n <= 0 then return "—" end
    if n >= 1000000 then return string.format("%.2f Mbps", n / 1000000) end
    if n >= 1000 then return string.format("%.1f Mbps", n / 1000) end
    return string.format("%d Kbps", n)
end

local _stats_visible = false
local function show_playback_stats()
    -- 再点一次"播放信息"即关闭（提供明确退出机制）
    if _stats_visible then
        _stats_visible = false
        mp.osd_message("", 0.01)
        return
    end
    _stats_visible = true
    pcall(function()
        local g = function(p, d) local v = mp.get_property(p); if v == nil or v == "" then return d end; return v end
        local gn = function(p, d) local v = mp.get_property_number(p); if v == nil then return d end; return v end
        local lines = {}
        local title = g("media-title", "")
        table.insert(lines, "『" .. tostring(title) .. "』")
        table.insert(lines, "分辨率: " .. tostring(gn("width", 0)) .. "×" .. tostring(gn("height", 0))
            .. "   帧率: " .. string.format("%.2f", gn("estimated-vf-fps", gn("container-fps", 0))) .. " fps")
        table.insert(lines, "视频: " .. tostring(g("video-codec", "—")) .. "   音频: " .. tostring(g("audio-codec", "—")))
        table.insert(lines, "总码率: " .. fmt_kbps(gn("packet-bitrate", gn("video-bitrate", 0)))
            .. "   视频码率: " .. fmt_kbps(gn("video-bitrate", 0)))
        table.insert(lines, "音频码率: " .. fmt_kbps(gn("audio-bitrate", 0)))
        local hw = g("hwdec-current", "")
        table.insert(lines, "硬解: " .. tostring(hw ~= "" and hw or g("hwdec", "—")))
        table.insert(lines, "丢帧: " .. tostring(gn("frame-drop-count", 0)) .. "   误帧: " .. tostring(gn("frame-mistimed-count", 0))
            .. "   显示同步: " .. tostring(g("display-sync-active", "no") == "yes" and "开" or "关"))
        table.insert(lines, "缓存: " .. string.format("%.1f", gn("demuxer-cache-time", 0)) .. " 秒 / "
            .. string.format("%.1f", gn("demuxer-cache-duration", 0)) .. " 秒   缓冲: "
            .. string.format("%d", gn("cache-buffering-state", 100)) .. "%")
        local spd = gn("avsync", 0)
        table.insert(lines, "A/V 同步偏差: " .. string.format("%.3f", spd) .. " 秒   音量: "
            .. string.format("%d", gn("volume", 100)) .. "%")
        table.insert(lines, "————（再次点击菜单「播放信息」或按 x 关闭）")
        mp.osd_message(table.concat(lines, "\n"), 12000)
        mp.add_timeout(12.1, function() _stats_visible = false end)
    end)
end
-- 按 x 快速关闭播放信息
mp.add_key_binding("x", "fnos-stats-close", function()
    if _stats_visible then _stats_visible = false; mp.osd_message("", 0.01) end
end)
mp.register_script_message("fnos-playback-stats", show_playback_stats)

-- 画质（输出缩放）：原画=清除 vf 中的 scale；其余把输出高度限制到目标值（宽度按比例 -2 保持偶数）
local g_quality = "原画"
local function set_quality(q, h)
    pcall(function()
        if not q or q == "original" or q == "原画" then
            mp.commandv("vf", "remove", "@fnos_q")
            g_quality = "原画"
        else
            mp.commandv("vf", "remove", "@fnos_q")
            mp.commandv("vf", "add", "@fnos_q:lavfi=[scale=-2:'min(" .. h .. ",ih)':flags=lanczos]")
            g_quality = tostring(h) .. "p"
        end
        mp.osd_message("画质：" .. g_quality, 2000)
        pcall(refresh_menu_data)
    end)
end
mp.register_script_message("fnos-quality", function(q)
    if not q or q == "original" or q == "原画" then set_quality("original")
    else local h = tonumber(tostring(q):match("%d+")); if h then set_quality(h, h) end end
end)

-- 底部控制栏「画质」按钮：直接弹画质选择菜单（无二级菜单）
mp.register_script_message("fnos-quality-menu", function()
    local data = { type = "menu", title = "画质选择", items = {
        { title = (g_quality == "原画" and "✓ " or "") .. "原画（不缩放）", cmd = "script-message fnos-quality original" },
        { title = (g_quality == "1080p" and "✓ " or "") .. "1080p", cmd = "script-message fnos-quality 1080" },
        { title = (g_quality == "720p" and "✓ " or "") .. "720p", cmd = "script-message fnos-quality 720" },
        { title = (g_quality == "480p" and "✓ " or "") .. "480p", cmd = "script-message fnos-quality 480" },
        { title = (g_quality == "360p" and "✓ " or "") .. "360p", cmd = "script-message fnos-quality 360" },
    } }
    mp.commandv("script-message-to", "context_menu", "update-data", utils.format_json(data))
    mp.commandv("script-message-to", "context_menu", "open")
end)
mp.get_quality_label = function() return g_quality end

-- 动态列出轨道（kind=audio/sub；prop=aid/sid）
local function track_items(kind, prop)
    local list = {}
    pcall(function()
        local n = mp.get_property_number("track-list/count", 0) or 0
        for i = 0, n - 1 do
            local base = "track-list/" .. i .. "/"
            if mp.get_property(base .. "type") == kind then
                local id = mp.get_property_number(base .. "id")
                local title = mp.get_property(base .. "title") or ""
                local lang = mp.get_property(base .. "lang") or ""
                local codec = mp.get_property(base .. "codec") or ""
                local sel = mp.get_property(base .. "selected") == "yes"
                local label = title
                if label == "" and lang ~= "" then label = lang .. "（" .. (codec ~= "" and codec or kind) .. "）" end
                if label == "" then label = (kind == "audio" and "音轨 " or "字幕轨 ") .. tostring(id) end
                if sel then label = "✓ " .. label end
                table.insert(list, item(label, "set " .. prop .. " " .. tostring(id)))
            end
        end
    end)
    return list
end

local function online_result_items()
    -- 搜索结果直接平铺进字幕菜单（不套二级子菜单）；无结果返回空
    if not g_results or #g_results == 0 then return {} end
    local t = { sep(), { ["title"] = "在线搜索结果（点击下载加载）", ["type"] = "separator" } }
    for i, r in ipairs(g_results) do
        if i <= 20 then
            local src = r.source and (r.source .. " · ") or ""
            local label = string.format("%s%s  [%s]  下载%s", src, r.name or ("字幕 " .. i), r.lang or "", tostring(r.downloads or 0))
            if #label > 92 then label = label:sub(1, 92) .. "…" end
            table.insert(t, item(label, "script-message fnos-sub-dl " .. tostring(r.id)))
        end
    end
    return t
end

-- 弹幕搜索结果：平铺进弹幕子菜单（与字幕一致，统一由本脚本持有 menu-data，避免与弹幕脚本竞态写菜单）
local function danmaku_result_items()
    if g_dm_searching then
        return { sep(), { ["title"] = "弹幕搜索中，请稍候再右键打开…", ["selectable"] = false } }
    end
    if not g_dm_results or #g_dm_results == 0 then return {} end
    local t = { sep(), { ["title"] = "弹幕搜索结果（点击加载）", ["type"] = "separator" } }
    for i, r in ipairs(g_dm_results) do
        if i <= 12 then
            local label = r.name or ("弹幕 " .. tostring(r.id))
            if #label > 90 then label = label:sub(1, 90) .. "…" end
            table.insert(t, item(label, "script-message fnos-dm-pick " .. tostring(r.id)))
        end
    end
    return t
end

-- ---------------- 菜单子构建器 ----------------

local function audio_submenu()
    local t = track_items("audio", "aid")
    if #t == 0 then t = { item("（暂无多音轨）") } end
    table.insert(t, 1, item("循环切换音轨", "cycle audio", "#"))
    table.insert(t, sep())
    table.insert(t, item("静音 / 取消静音", "cycle mute", "m"))
    table.insert(t, item("音量 +5", "add volume 5"))
    table.insert(t, item("音量 -5", "add volume -5"))
    table.insert(t, item("音频提前 0.1s", "add audio-delay -0.1"))
    table.insert(t, item("音频延后 0.1s", "add audio-delay 0.1"))
    return { ["title"] = "音轨 / 声音", ["type"] = "submenu", ["submenu"] = t }
end

local function builtin_sub_submenu()
    local t = track_items("sub", "sid")
    table.insert(t, 1, item("不显示内置字幕", "set sid no"))
    return t
end

-- 真正的菜单构建
build_menu = function()
    local sub_menu = {
        item("显示 / 隐藏字幕", "cycle sub-visibility", "v"),
        item("加载本地字幕文件…", "script-message fnos-sub-local"),
        sep(),
        g_searching
            and item("正在搜索在线字幕…")
            or  item("在线搜索字幕（点击直接出结果）", "script-message fnos-sub-search zh"),
    }
    local online = online_result_items()
    for _, it in ipairs(online) do table.insert(sub_menu, it) end
    table.insert(sub_menu, sep())
    local builtin = builtin_sub_submenu()
    if #builtin > 1 then
        table.insert(sub_menu, { ["title"] = "内置字幕轨", ["type"] = "submenu", ["submenu"] = builtin })
    end
    table.insert(sub_menu, sep())
    table.insert(sub_menu, item("字幕提前 0.1s", "add sub-delay -0.1", "z"))
    table.insert(sub_menu, item("字幕延后 0.1s", "add sub-delay 0.1", "Z"))
    table.insert(sub_menu, item("字幕上移", "add sub-pos -1", "r"))
    table.insert(sub_menu, item("字幕下移", "add sub-pos +1", "R"))
    table.insert(sub_menu, item("字幕字号放大", "multiply sub-scale 1.1"))
    table.insert(sub_menu, item("字幕字号缩小", "multiply sub-scale 0.9"))

    return {
        item("播放 / 暂停", "cycle pause", "空格"),
        item("停止播放 / 关闭", "stop"),
        item("全屏", "cycle fullscreen", "f"),
        sep(),

        { ["title"] = "播放控制", ["type"] = "submenu", ["submenu"] = {
            item("上一集 / 上一台", "playlist-prev"),
            item("下一集 / 下一台", "playlist-next"),
            item("恢复正常速度", "set speed 1.0", "Backspace"),
            item("A-B 循环", "ab-loop", "l"),
            item("逐帧前进", "frame-step", "."),
            item("逐帧后退", "frame-back-step", ","),
        }},

        { ["title"] = "跳过片头 / 片尾", ["type"] = "submenu", ["submenu"] = {
            item("跳过片头（默认前进 90 秒）", "script-message fnos-skip intro"),
            item("跳到片尾前（回退 60 秒）", "script-message fnos-skip credits"),
            sep(),
            item("片头跳过长度：60 秒", "script-message fnos-skip-set intro 60"),
            item("片头跳过长度：90 秒（默认）", "script-message fnos-skip-set intro 90"),
            item("片头跳过长度：120 秒", "script-message fnos-skip-set intro 120"),
            sep(),
            item("片尾回退长度：45 秒", "script-message fnos-skip-set credits 45"),
            item("片尾回退长度：60 秒（默认）", "script-message fnos-skip-set credits 60"),
            item("片尾回退长度：90 秒", "script-message fnos-skip-set credits 90"),
            sep(),
            item("自动跳过（按章节标记 片头/片尾）", "script-message fnos-skip-auto"),
            { ["title"] = g_skip_auto and "✓ 自动跳过：已开启" or "自动跳过：未开启", ["selectable"] = false },
        }},

        { ["title"] = "字幕", ["type"] = "submenu", ["submenu"] = sub_menu },

        audio_submenu(),

        { ["title"] = "画面", ["type"] = "submenu", ["submenu"] = {
            item("切换全屏", "cycle fullscreen", "f"),
            sep(),
            -- 画质（输出缩放）：原画=不缩放；其余把输出高度压到目标值，省算力/带宽观感更顺滑
            item("画质：原画（不缩放）", "script-message fnos-quality original"),
            item("画质：1080p", "script-message fnos-quality 1080"),
            item("画质：720p", "script-message fnos-quality 720"),
            item("画质：480p", "script-message fnos-quality 480"),
            item("画质：360p", "script-message fnos-quality 360"),
            sep(),
            item("画面比例 16:9", "set video-aspect-override 16:9"),
            item("画面比例 4:3", "set video-aspect-override 4:3"),
            item("画面比例 自动", "set video-aspect-override -1", "A"),
            item("截图(含字幕)", "screenshot each-frame", "s"),
            item("截图(仅画面)", "no-osd screenshot video", "S"),
            item("亮度 +", "add brightness 10"),
            item("亮度 -", "add brightness -10"),
            item("对比度 +", "add contrast 10"),
            item("对比度 -", "add contrast -10"),
        }},

        { ["title"] = "播放速度", ["type"] = "submenu", ["submenu"] = {
            item("0.25 倍速", "set speed 0.25"),
            item("0.5 倍速", "set speed 0.5"),
            item("0.75 倍速", "set speed 0.75"),
            item("正常 1.0 倍速", "set speed 1.0"),
            item("1.25 倍速", "set speed 1.25"),
            item("1.5 倍速", "set speed 1.5"),
            item("2.0 倍速", "set speed 2.0"),
        }},

        { ["title"] = "弹幕", ["type"] = "submenu", ["submenu"] = (function()
            local dmenu = {
                { ["title"] = g_auto_enhance and "✓ 起播自动加载（弹幕/字幕/片头）" or "起播自动加载（弹幕/字幕/片头）：关",
                  ["cmd"] = "script-message fnos-auto-enhance" },
                item("🔍 搜索并加载弹幕（自动按片名）", "script-message fnos-dm-search"),
                item("弹幕 开 / 关", "script-message fnos-danmaku-toggle"),
            }
            -- 搜索结果直接平铺（点 fnos-dm-search 后 helper 返回，写入菜单，重新右键即见）
            for _, it in ipairs(danmaku_result_items()) do table.insert(dmenu, it) end
            table.insert(dmenu, sep())
            table.insert(dmenu, item("字号 大", "script-message fnos-danmaku-opts size 42"))
            table.insert(dmenu, item("字号 中", "script-message fnos-danmaku-opts size 34"))
            table.insert(dmenu, item("字号 小", "script-message fnos-danmaku-opts size 26"))
            table.insert(dmenu, item("速度 慢", "script-message fnos-danmaku-opts speed 0.7"))
            table.insert(dmenu, item("速度 正常", "script-message fnos-danmaku-opts speed 1.0"))
            table.insert(dmenu, item("速度 快", "script-message fnos-danmaku-opts speed 1.4"))
            table.insert(dmenu, item("关闭弹幕", "script-message fnos-danmaku-off"))
            return dmenu
        end)() },

        { ["title"] = "进度跳转", ["type"] = "submenu", ["submenu"] = {
            item("后退 5 秒", "seek -5", "←"),
            item("前进 5 秒", "seek 5", "→"),
            item("后退 1 分钟", "seek -60", "↓"),
            item("前进 1 分钟", "seek 60", "↑"),
            item("后退 10 分钟", "seek -600", "PgUp"),
            item("前进 10 分钟", "seek 600", "PgDn"),
            item("回到开头", "seek 0 absolute-percent", "Home"),
        }},
        sep(),

        item("播放信息", "script-message fnos-playback-stats", "i"),
        item("循环播放（开 / 关）", "cycle loop-file", "L"),
        sep(),
        item("FNOS 内置 MPV 显卡硬解内核", "show-text 'FNOS 桌面客户端 · 内置 MPV 显卡硬解内核' 3000"),
    }
end

-- ---------------- 脚本消息：字幕搜索/下载/本地/画中画 ----------------
mp.register_script_message("fnos-sub-search", function(lang)
    pcall(function()
        if g_searching then return end
        g_searching = lang
        mp.osd_message("正在搜索在线字幕（" .. (lang == "en" and "英文" or "中文") .. "）…", 4000)
        local body = utils.format_json({ filename = media_keyword(), lang = lang })
        helper_async("/subtitle/search", body, function(data)
            g_searching = nil
            if not data or not data.ok then
                mp.osd_message("在线字幕搜索失败（可能被限流，请稍后再试）", 4000); return
            end
            g_results = data.results or {}
            if #g_results == 0 then mp.osd_message("未找到匹配字幕，可尝试『在线搜索字幕（英文）』或更换片名", 4000); return end
            mp.osd_message("找到 " .. tostring(#g_results) .. " 条字幕，请在字幕菜单选择", 1800)
            open_context_menu()
        end)
    end)
end)

mp.register_script_message("fnos-sub-dl", function(id)
    pcall(function()
        local target = nil
        if g_results then
            for _, r in ipairs(g_results) do if tostring(r.id) == tostring(id) then target = r end end
        end
        if not target then mp.osd_message("字幕条目已过期，请重新搜索", 3000); return end
        mp.osd_message("正在下载并加载字幕…", 4000)
        helper_async("/subtitle/download", utils.format_json({ item = target }), function(data)
            if data and data.ok then
                mp.osd_message("字幕已加载（" .. tostring(data.count or 1) .. " 个）", 3000)
            else
                mp.osd_message("字幕下载失败：" .. ((data and data.error) or "网络错误"), 4000)
            end
        end)
    end)
end)

mp.register_script_message("fnos-sub-local", function()
    pcall(function()
        mp.osd_message("请在弹出的对话框选择字幕文件…", 4000)
        helper_async("/subtitle/open-dialog", "{}", function(data)
            if data and data.ok and not data.cancelled then
                mp.osd_message("本地字幕已加载", 3000)
            elseif data and data.cancelled then
                mp.osd_message("已取消选择字幕", 2000)
            else
                mp.osd_message("加载本地字幕失败：" .. ((data and data.error) or "未知错误"), 4000)
            end
        end)
    end)
end)

-- ---------------- 弹幕：搜索/选择（结果平铺进本脚本菜单，避免与弹幕脚本竞态写 menu-data）----------------
mp.register_script_message("fnos-dm-search", function()
    pcall(function()
        if g_dm_searching then return end
        g_dm_searching = true
        g_dm_results = nil
        local kw = media_keyword()
        local sdur = mp.get_property_number("duration", 0) or 0
        mp.osd_message("正在搜索弹幕：" .. kw .. " …", 4000)
        helper_async("/danmaku/search", utils.format_json({ keyword = kw, duration = sdur }), function(data)
            g_dm_searching = false
            if not data or not data.ok then
                mp.osd_message("弹幕搜索失败（网络错误）", 1800); return
            end
            g_dm_results = data.results or {}
            if #g_dm_results == 0 then
                mp.osd_message("未找到弹幕，可换片名后重试", 1800); return
            end
            mp.osd_message("找到 " .. tostring(#g_dm_results) .. " 组弹幕，请右键『弹幕』菜单选择加载", 1800)
            refresh_menu_data()
        end)
    end)
end)

-- 选择某组弹幕：在菜单脚本里查回完整条目（含 source/bvid/episodeId/cid）后，
-- 直接调 helper 的 /danmaku/download（ZDY 需要完整条目才能下载）。
-- 下载成功后 helper 经 IPC 回推 fnos-danmaku-data，弹幕渲染脚本自动渲染，无需再转发。
mp.register_script_message("fnos-dm-pick", function(cid)
    pcall(function()
        if not cid then return end
        local target = nil
        if g_dm_results then
            for _, r in ipairs(g_dm_results) do
                if tostring(r.id) == tostring(cid)
                    or tostring(r.episodeId) == tostring(cid)
                    or tostring(r.cid) == tostring(cid)
                    or tostring(r.bvid) == tostring(cid) then target = r end
            end
        end
        if not target then
            -- 兜底：只有 cid（如外部脚本触发）
            target = { cid = tostring(cid), id = tostring(cid) }
        end
        mp.osd_message("正在加载弹幕…", 1500)
        helper_async("/danmaku/download", utils.format_json({ item = target }), function(data)
            if not (data and data.ok and (data.count or 0) > 0) then
                mp.osd_message("弹幕加载失败：" .. ((data and data.error) or "网络错误"), 2500)
            end
        end)
    end)
end)

-- ---------------- 跳过片头 / 片尾 ----------------
-- 说明：权威片头片尾时间戳由 NAS 端 FPK（SkipIntro 库）提供；客户端这里先提供
--       立即可用的"手动跳过 + 按章节自动跳过"，无时间戳数据时也能正常工作。
-- 手动：片头默认前进 g_skip_intro_sec(90s)；片尾回退 g_skip_credits_sec(60s)。
-- 自动：扫描章节标题，命中"片头/OP/intro"的章节结束位置，播放进入该区间时自动跳到其结尾；
--       命中"片尾/ED/credits"则跳到该章节开头之后（接近正片结束的片尾可按需求跳到下一集）。
local function find_chapter_range(keywords)
    local n = mp.get_property_number("chapter-list/count", 0) or 0
    for i = 0, n - 1 do
        local base = "chapter-list/" .. i .. "/"
        local title = (mp.get_property(base .. "title") or ""):lower()
        for _, kw in ipairs(keywords) do
            if title:find(kw, 1, true) then
                local start_t = mp.get_property_number(base .. "time", 0) or 0
                -- 章节结束 = 下一章开始；最后一章用文件时长
                local end_t = mp.get_property_number("duration", 0) or 0
                if i + 1 < n then
                    end_t = mp.get_property_number("chapter-list/" .. (i + 1) .. "/time", end_t) or end_t
                end
                return start_t, end_t, title
            end
        end
    end
    return nil
end

local function do_skip_intro()
    pcall(function()
        -- 优先 ZDY 权威时间戳
        if g_zdy_intro_end and g_zdy_intro_end > 0 then
            local pos = mp.get_property_number("time-pos", 0) or 0
            if pos < g_zdy_intro_end - 1 then
                mp.commandv("seek", tostring(g_zdy_intro_end), "absolute+exact")
                mp.osd_message("已跳过片头（ZDY " .. tostring(math.floor(g_zdy_intro_end)) .. "s）", 1800)
                return
            end
        end
        -- 其次用章节标记（精确），否则用默认固定秒数
        local s, e = find_chapter_range({ "片头", "op", "intro", "开场" })
        if s then
            local pos = mp.get_property_number("time-pos", 0) or 0
            if pos >= s - 1 and pos < e then
                mp.commandv("seek", tostring(e), "absolute+exact")
                mp.osd_message("已跳过片头（章节）", 2000); return
            end
        end
        mp.commandv("seek", tostring(g_skip_intro_sec), "relative+exact")
        mp.osd_message("已跳过片头（前进 " .. tostring(g_skip_intro_sec) .. " 秒）", 2000)
    end)
end

local function do_skip_credits()
    pcall(function()
        local dur = mp.get_property_number("duration", 0) or 0
        -- 优先 ZDY 权威片尾时间戳
        if g_zdy_credits_start and g_zdy_credits_start > 0 then
            mp.commandv("seek", tostring(g_zdy_credits_start), "absolute+exact")
            mp.osd_message("已跳到片尾（ZDY " .. tostring(math.floor(g_zdy_credits_start)) .. "s）", 1800)
            return
        end
        local s = find_chapter_range({ "片尾", "ed", "credits", "ending", "彩蛋" })
        if s then
            mp.commandv("seek", tostring(s), "absolute+exact")
            mp.osd_message("已跳到片尾开始处", 2000); return
        end
        -- 无章节：回退 credits_sec（用于回看片尾字幕），直播/无时长流则提示
        if dur > 0 then
            local target = math.max(0, dur - g_skip_credits_sec)
            mp.commandv("seek", tostring(target), "absolute+exact")
            mp.osd_message("已跳到片尾前 " .. tostring(g_skip_credits_sec) .. " 秒", 2000)
        else
            mp.osd_message("当前为直播流，无片尾可跳转", 2000)
        end
    end)
end

mp.register_script_message("fnos-skip", function(which)
    if which == "credits" then do_skip_credits() else do_skip_intro() end
end)
mp.register_script_message("fnos-skip-set", function(kind, sec)
    pcall(function()
        local n = tonumber(sec)
        if not n then return end
        if kind == "credits" then g_skip_credits_sec = n
        else g_skip_intro_sec = n end
        mp.osd_message((kind == "credits" and "片尾回退" or "片头跳过") .. "长度已设为 " .. tostring(n) .. " 秒", 2000)
        refresh_menu_data()
    end)
end)

-- 自动跳过：时间轴观察者。片头用 ZDY 时间戳/章节标记自动跳过；片尾在开启 g_skip_auto 且
-- 到达 ZDY 片尾时间戳时提示（片尾不强制跳走，避免打断观看，用户可用菜单/按钮跳过）。
local g_auto_intro_done = false
local g_auto_credits_done = false
mp.register_script_message("fnos-skip-auto", function()
    pcall(function()
        g_skip_auto = not g_skip_auto
        mp.osd_message(g_skip_auto and "已开启自动跳过片头（按章节标记）" or "已关闭自动跳过", 2500)
        refresh_menu_data()
    end)
end)
mp.observe_property("time-pos", "number", function(pos)
    if not pos then return end
    pcall(function()
        -- 优先：ZDY 权威片头时间戳（起播自动获取）。片头区间一般 0~introEnd，
        -- 只要仍处于片头内（pos < introEnd）就自动跳过一次，不依赖 g_skip_auto 开关。
        if g_zdy_intro_end and g_zdy_intro_end > 0 and g_zdy_intro_end < (mp.get_property_number("duration", 0) or 0) then
            if pos < g_zdy_intro_end - 0.5 and not g_auto_intro_done then
                g_auto_intro_done = true
                mp.commandv("seek", tostring(g_zdy_intro_end), "absolute+exact")
                mp.osd_message("自动跳过片头（ZDY）", 1800)
            end
            return
        end
        -- 回退：章节标记自动跳过（需用户在菜单开启"自动跳过"）
        if not g_skip_auto then return end
        local s, e = find_chapter_range({ "片头", "op", "intro", "开场" })
        if s then
            if pos >= s - 1 and pos < e - 0.5 then
                if not g_auto_intro_done then
                    g_auto_intro_done = true
                    mp.commandv("seek", tostring(e), "absolute+exact")
                    mp.osd_message("自动跳过片头", 2000)
                end
            elseif pos < s - 2 or pos >= e then
                g_auto_intro_done = false
            end
        end
    end)
end)

-- ---------------- 起播自动增强（弹幕 + 字幕 + 片头片尾，仅走 ZDY 服务端）----------------
-- 需求：再次打开影片时自动加载"已搜索到的"弹幕/字幕/片头片尾。ZDY 服务端有磁盘持久缓存
--       （搜索结果 7 天 / 弹幕 30 天），因此即使是首次也会把结果缓存，重复打开秒返回。
-- 行为：file-loaded 后等片名就绪 → 并行向 ZDY 请求：弹幕(自动加载最优)、字幕(自动加载最优)、
--       片头片尾时间戳(自动应用到下面的 time-pos 观察者)。任一失败静默，绝不打扰播放。
-- 直播流（无时长）跳过自动加载。可在『弹幕』菜单用"起播自动加载"开关关闭。
local function is_live()
    -- 直播流为 http(s) 且无确定时长；点播文件（即使是 http）都有 duration
    local dur = mp.get_property_number("duration", 0) or 0
    local path = mp.get_property("path") or ""
    return dur <= 0 and path:find("^http") ~= nil
end

local function auto_fetch_skip(kw)
    local dur = mp.get_property_number("duration", 0) or 0
    helper_async("/skip/timestamps", utils.format_json({ title = kw, filename = kw, duration = dur }), function(data)
        if data and data.ok then
            g_zdy_intro_end = tonumber(data.introEnd) or nil
            g_zdy_credits_start = tonumber(data.creditsStart or data.outroStart) or nil
        end
    end)
end

local function auto_fetch_danmaku(kw)
    local dur = mp.get_property_number("duration", 0) or 0
    helper_async("/danmaku/search", utils.format_json({ keyword = kw, duration = dur }), function(data)
        if not data or not data.ok or not data.results or #data.results == 0 then return end
        g_dm_results = data.results
        -- ZDY 已按片名清洗 + 时长贴合度过滤排序（同名 MV/解说切片已剔除）。
        -- 自动加载第一项；用 fnos-dm-pick（携带完整条目 source/bvid/episodeId）由 helper 转发 ZDY 下载。
        local best = data.results[1]
        if best then
            local key = best.id or best.episodeId or best.cid or best.bvid
            if key then mp.commandv("script-message", "fnos-dm-pick", tostring(key)) end
        end
        refresh_menu_data()
    end)
end

local function auto_fetch_subtitle(kw)
    helper_async("/subtitle/search", utils.format_json({ filename = kw, lang = "zh" }), function(data)
        if not data or not data.ok or not data.results or #data.results == 0 then return end
        g_results = data.results
        -- 自动下载并加载第一条（ZDY 已按相关度评分排序，最匹配的简体/双语正片字幕在最前）。
        -- helper 下载后作为外挂字幕载入但不强制显示，用户可在字幕菜单切换/关闭。
        local best = data.results[1]
        if best then
            helper_async("/subtitle/download", utils.format_json({ item = best }), function(dd)
                if dd and dd.ok and (dd.count or 0) > 0 then
                    mp.osd_message("已自动加载匹配字幕（可在字幕菜单切换）", 2200)
                end
            end)
        end
        refresh_menu_data()
    end)
end

local function run_auto_enhance()
    pcall(function()
        if not g_auto_enhance then return end
        if is_live() then return end
        local kw = media_keyword()
        if not kw or kw == "video" or kw == "" then return end
        auto_fetch_skip(kw)
        auto_fetch_danmaku(kw)
        auto_fetch_subtitle(kw)
    end)
end

-- file-loaded 后片名可能尚未就绪，轮询最多约 6 秒直到拿到片名再触发
local function schedule_auto_enhance()
    g_auto_done = false
    g_auto_intro_done = false
    g_auto_credits_done = false
    g_zdy_intro_end = nil
    g_zdy_credits_start = nil
    local tries = 0
    local function tick()
        pcall(function()
            tries = tries + 1
            if g_auto_done then return end
            local title = mp.get_property("media-title") or ""
            if (title ~= "" and title ~= "video") or tries >= 12 then
                g_auto_done = true
                run_auto_enhance()
                return
            end
            mp.add_timeout(0.5, tick)
        end)
    end
    mp.add_timeout(0.8, tick)
end

mp.register_event("file-loaded", function()
    pcall(function() schedule_auto_enhance() end)
end)

mp.register_script_message("fnos-auto-enhance", function()
    pcall(function()
        g_auto_enhance = not g_auto_enhance
        mp.osd_message(g_auto_enhance and "已开启起播自动加载（弹幕/字幕/片头片尾）" or "已关闭起播自动加载", 2500)
        refresh_menu_data()
    end)
end)

-- 双击：独立播放器窗口（ontop=no，"用 mpv 打开"）双击=全屏切换；嵌入覆盖窗（ontop=yes）不动作。
local function sync_dbl_binding()
    pcall(function()
        local is_standalone = (mp.get_property_native("ontop") == false)
        if is_standalone then
            mp.add_forced_key_binding("MBTN_LEFT_DBL", "fnos-dbl-fullscreen", function()
                pcall(function() mp.commandv("cycle", "fullscreen") end)
            end, { complex = true })
        else
            mp.remove_key_binding("fnos-dbl-fullscreen")
        end
    end)
end

-- ---------------- 安装 ----------------
pcall(function()
    -- 先预置一次中文菜单数据（此刻轨道可能还没加载，打开时 open_context_menu 会再刷新）
    refresh_menu_data()
    -- 右键直接呼出中文菜单（覆盖默认右键行为）；每次打开都重建 menu-data（刷新音轨/字幕轨/搜索结果）
    mp.add_forced_key_binding("MBTN_RIGHT", "fnos-context-menu", open_context_menu)
    -- 独立窗口双击全屏；延迟到首帧后确保 ontop 已按形态生效。
    mp.observe_property("ontop", "bool", function() sync_dbl_binding() end)
    mp.msg.info("FNOS 中文右键菜单已加载（含在线字幕/画质/跳过片头片尾/弹幕）")
end)
