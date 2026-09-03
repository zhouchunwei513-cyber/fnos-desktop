-- FNOS 内置 MPV · 全中文右键菜单
-- 背景：mpv 官方 Windows（shinchiro）构建不随包提供 gettext 中文翻译，也没有 --lang 选项，
--       默认右键菜单是英文。这里用 Lua 构造菜单数据（menu-data 属性），交给 mpv 内置
--       context_menu 脚本以 OSD 方式渲染中文菜单，任何 0.36+ 版本都可用。
-- 打开方式：给内置脚本发 script-message "context_menu open"（等价于 script-binding context_menu/open）。
-- v1.29 增强：音轨/内置字幕轨按名称选择、在线字幕搜索下载、加载本地字幕、画中画。
-- 安全：全部逻辑包在 pcall 里，任何 API 不兼容/异常都只影响菜单本身，绝不影响播放。

local g_results = nil       -- 最近一次在线字幕搜索结果
local g_searching = nil     -- 正在搜索的语言标记
local g_pip_active = false  -- 是否处于画中画小窗（lua 侧跟踪，用于双击退出/标题切换）
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
            local ok, data = pcall(function() return mp.utils.parse_json(out) end)
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

local function show_playback_stats()
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
        mp.osd_message(table.concat(lines, "\n"), 8000)
    end)
end
mp.register_script_message("fnos-playback-stats", show_playback_stats)

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
        item("画中画（小窗置顶）", "script-message fnos-pip"),
        sep(),

        { ["title"] = "播放控制", ["type"] = "submenu", ["submenu"] = {
            item("上一集 / 上一台", "playlist-prev"),
            item("下一集 / 下一台", "playlist-next"),
            item("恢复正常速度", "set speed 1.0", "Backspace"),
            item("A-B 循环", "ab-loop", "l"),
            item("逐帧前进", "frame-step", "."),
            item("逐帧后退", "frame-back-step", ","),
        }},

        { ["title"] = "字幕", ["type"] = "submenu", ["submenu"] = sub_menu },

        audio_submenu(),

        { ["title"] = "画面", ["type"] = "submenu", ["submenu"] = {
            item("切换全屏", "cycle fullscreen", "f"),
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

        { ["title"] = "弹幕", ["type"] = "submenu", ["submenu"] = {
            item("搜索并加载弹幕…", "script-message fnos-danmaku-search"),
            item("弹幕 开 / 关", "script-message fnos-danmaku-toggle"),
            sep(),
            item("字号 大", "script-message fnos-danmaku-opts size 42"),
            item("字号 中", "script-message fnos-danmaku-opts size 34"),
            item("字号 小", "script-message fnos-danmaku-opts size 26"),
            item("速度 慢", "script-message fnos-danmaku-opts speed 0.7"),
            item("速度 正常", "script-message fnos-danmaku-opts speed 1.0"),
            item("速度 快", "script-message fnos-danmaku-opts speed 1.4"),
            item("关闭弹幕", "script-message fnos-danmaku-off"),
        }},

        { ["title"] = g_pip_active and "画中画（开启中·点此退出）" or "画中画", ["type"] = "submenu", ["submenu"] = g_pip_active and {
            item("▶ 退出画中画（恢复跟随飞牛窗口）", "script-message fnos-pip-exit"),
            item("小提示：小窗中双击画面也可退出", nil),
            sep(),
            item("小窗大小：小（320）", "script-message fnos-pip-size 320"),
            item("小窗大小：中（480）", "script-message fnos-pip-size 480"),
            item("小窗大小：大（720）", "script-message fnos-pip-size 720"),
        } or {
            item("进入画中画（小窗置顶）", "script-message fnos-pip-enter"),
            sep(),
            item("小窗大小：小（320）", "script-message fnos-pip-size 320"),
            item("小窗大小：中（480）", "script-message fnos-pip-size 480"),
            item("小窗大小：大（720）", "script-message fnos-pip-size 720"),
        }},

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
        local body = mp.utils.format_json({ filename = media_keyword(), lang = lang })
        helper_async("/subtitle/search", body, function(data)
            g_searching = nil
            if not data or not data.ok then
                mp.osd_message("在线字幕搜索失败（可能被限流，请稍后再试）", 4000); return
            end
            g_results = data.results or {}
            if #g_results == 0 then mp.osd_message("未找到匹配字幕，可尝试『在线搜索字幕（英文）』或更换片名", 4000); return end
            mp.osd_message("找到 " .. tostring(#g_results) .. " 条字幕，已在字幕菜单中列出，请选择", 3500)
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
        helper_async("/subtitle/download", mp.utils.format_json({ item = target }), function(data)
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

-- 画中画状态同步：进入时强制退出全屏（小窗不应全屏）并把视频区双击改为"退出画中画"；
-- 退出时还原双击为默认行为。解决"小窗双击变成最大化全屏、且没有退出入口"。
local function sync_pip_bindings()
    pcall(function()
        if g_pip_active then
            mp.set_property_bool("fullscreen", false)
            -- 小窗双击 = 退出画中画（PiP 绑定优先级最高，覆盖 standalone 的双击全屏）
            mp.add_forced_key_binding("MBTN_LEFT_DBL", "fnos-pip-dbl", function()
                pcall(function()
                    helper_async("/pip/toggle", '{"mode":"exit"}', function(data)
                        if data and data.ok then
                            g_pip_active = false
                            sync_pip_bindings()
                            mp.osd_message("已退出画中画", 2500)
                        end
                    end)
                end)
            end, { complex = true })
        else
            mp.remove_key_binding("fnos-pip-dbl")
            -- 非画中画：独立播放器窗口（ontop=no，即"用 mpv 打开"的窗口）双击=全屏切换；
            -- 嵌入覆盖窗（ontop=yes，贴合飞牛视频区）不启用双击全屏（mpv 默认全屏会破坏跟随）。
            local is_standalone = (mp.get_property_native("ontop") == false)
            if is_standalone then
                mp.add_forced_key_binding("MBTN_LEFT_DBL", "fnos-dbl-fullscreen", function()
                    pcall(function() mp.commandv("cycle", "fullscreen") end)
                end, { complex = true })
            else
                mp.remove_key_binding("fnos-dbl-fullscreen")
            end
        end
        refresh_menu_data()
    end)
end

mp.register_script_message("fnos-pip", function()
    pcall(function()
        helper_async("/pip/toggle", "{}", function(data)
            if data and data.ok then
                g_pip_active = data.pip and true or false
                sync_pip_bindings()
                mp.osd_message(g_pip_active and "已进入画中画（小窗置顶，可拖动；双击画面退出）" or "已退出画中画，恢复跟随飞牛窗口", 3000)
            else
                mp.osd_message("画中画切换失败", 2500)
            end
        end)
    end)
end)

-- 进入画中画（可选 size 参数：320/480/720）
local function pip_enter(sizePx)
    pcall(function()
        local body = sizePx and ('{"mode":"enter","size":' .. tostring(sizePx) .. '}') or '{"mode":"enter"}'
        helper_async("/pip/toggle", body, function(data)
            if data and data.ok then
                g_pip_active = true
                sync_pip_bindings()
                mp.osd_message("已进入画中画（小窗置顶，可拖动；双击画面退出）", 3500)
            else
                mp.osd_message("切换画中画失败：" .. ((data and data.error) or "未知错误"), 3000)
            end
        end)
    end)
end

mp.register_script_message("fnos-pip-enter", function() pip_enter(nil) end)
mp.register_script_message("fnos-pip-exit", function()
    pcall(function()
        helper_async("/pip/toggle", '{"mode":"exit"}', function(data)
            if data and data.ok then
                g_pip_active = false
                sync_pip_bindings()
                mp.osd_message("已退出画中画，恢复正常画面", 2500)
            else
                mp.osd_message("退出画中画失败：" .. ((data and data.error) or "未知错误"), 3000)
            end
        end)
    end)
end)
mp.register_script_message("fnos-pip-size", function(px)
    local n = tonumber(px)
    if n then pip_enter(n) end
end)

-- ---------------- 安装 ----------------
pcall(function()
    -- 先预置一次中文菜单数据（此刻轨道可能还没加载，打开时 open_context_menu 会再刷新）
    refresh_menu_data()
    -- 右键直接呼出中文菜单（覆盖默认右键行为）；每次打开都重建 menu-data（刷新音轨/字幕轨/搜索结果）
    mp.add_forced_key_binding("MBTN_RIGHT", "fnos-context-menu", open_context_menu)
    -- 启动后绑定双击行为（独立窗口双击全屏 / 嵌入窗双击不动作）。延迟到首帧后，确保 ontop 已按形态生效。
    mp.observe_property("ontop", "bool", function() sync_pip_bindings() end)
    mp.msg.info("FNOS 中文右键菜单已加载（含在线字幕/本地字幕/画中画）")
end)
