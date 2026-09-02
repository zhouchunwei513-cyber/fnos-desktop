-- FNOS 内置 MPV · 全中文右键菜单
-- 背景：mpv 官方 Windows（shinchiro）构建不随包提供 gettext 中文翻译，也没有 --lang 选项，
--       默认右键菜单是英文。这里用 Lua 直接构造原生菜单（menu-data 属性），任何版本都可用。
-- v1.29 新增：
--   1) 音轨 / 内置字幕轨 按"名称 + 语言"动态列出（不再只能循环切换）；
--   2) 在线字幕搜索（OpenSubtitles，主进程经本地助手完成搜索·下载·解压·sub-add）；
--   3) 加载本地字幕文件（主进程弹文件对话框，回传绝对路径 sub-add）；
--   4) 画中画（小窗置顶）。
-- 安全：全部逻辑包在 pcall 里，任何 API 不兼容/异常都只影响菜单本身，绝不影响播放。
-- 通信：网络/文件对话框/解压全部在 Electron 主进程的本地助手(127.0.0.1)完成，
--       lua 只通过 Windows 自带 curl.exe 发请求，端口/令牌来自环境变量（spawn 时注入）。

local g_results = nil       -- 最近一次在线字幕搜索结果
local g_searching = nil     -- 正在搜索的语言标记，避免重复点击

-- 前向声明（build_menu 会被 refresh_menu 与右键打开时引用）
local build_menu, refresh_menu, do_search, helper_async, media_keyword

local function item(title, cmd, shortcut)
    local it = { ["title"] = title }
    if cmd then it["cmd"] = cmd end
    if shortcut then it["shortcut"] = shortcut end
    return it
end
local function sep() return { ["type"] = "separator" } end

-- 调主进程本地助手（异步，不阻塞播放）。route 形如 /subtitle/search。
function helper_async(route, bodyJson, onDone)
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
        }, function(success, res, _err)
            local out = (res and res.stdout) or ""
            local ok, data = pcall(function() return mp.utils.parse_json(out) end)
            if ok and type(data) == "table" then onDone(data) else onDone(nil) end
        end)
    end)
end

function media_keyword()
    local f = mp.get_property("filename/no-ext") or "video"
    f = tostring(f):gsub("^.*[\\/]", ""):gsub("%?.*$", "")
    return f
end

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

local function online_results_submenu()
    if not g_results or #g_results == 0 then return nil end
    local t = {}
    for i, r in ipairs(g_results) do
        if i <= 25 then
            local label = string.format("%s  [%s] 下载%s", r.name or ("字幕 " .. i), r.lang or "", tostring(r.downloads or 0))
            table.insert(t, item(label, "script-message fnos-sub-dl " .. tostring(r.id)))
        end
    end
    return { ["title"] = "▶ 在线搜索结果（点击下载）", ["type"] = "submenu", ["submenu"] = t }
end

function refresh_menu()
    pcall(function() mp.set_property_native("menu-data", build_menu()) end)
end

function do_search(lang, lang_label)
    if g_searching then return end
    g_searching = lang
    mp.osd_message("正在搜索在线字幕（" .. lang_label .. "）…", 4000)
    local body = mp.utils.format_json({ filename = media_keyword(), lang = lang })
    helper_async("/subtitle/search", body, function(data)
        g_searching = nil
        if not data or not data.ok then
            mp.osd_message("在线字幕搜索失败（可能被限流，请稍后再试）", 4000); return
        end
        g_results = data.results or {}
        if #g_results == 0 then mp.osd_message("未找到匹配字幕，可换关键词重试", 4000); return end
        refresh_menu()
        mp.osd_message("找到 " .. tostring(#g_results) .. " 条字幕，请在『字幕→在线搜索结果』选择", 4000)
        pcall(function() mp.command("menu") end)
    end)
end

mp.register_script_message("fnos-sub-search", function(lang)
    pcall(function() do_search(lang, lang == "en" and "英文" or "中文") end)
end)

mp.register_script_message("fnos-sub-dl", function(id)
    local target = nil
    if g_results then
        for _, r in ipairs(g_results) do if tostring(r.id) == tostring(id) then target = r.item or r end end
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

mp.register_script_message("fnos-sub-local", function()
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

mp.register_script_message("fnos-pip", function()
    helper_async("/pip/toggle", "{}", function(data)
        if data and data.ok then
            mp.osd_message(data.pip and "已进入画中画（小窗置顶，可拖动）" or "已退出画中画", 3000)
        else
            mp.osd_message("画中画切换失败", 2500)
        end
    end)
end)

function build_menu()
    local sub_menu = {
        item("显示 / 隐藏字幕", "cycle sub-visibility", "v"),
        item("加载本地字幕文件…", "script-message fnos-sub-local"),
        sep(),
        item("在线搜索字幕（中文）", "script-message fnos-sub-search zh"),
        item("在线搜索字幕（英文）", "script-message fnos-sub-search en"),
    }
    local res = online_results_submenu()
    if res then table.insert(sub_menu, sep()); table.insert(sub_menu, res) end
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
        item("停止并返回网页", "quit 0"),
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

        item("播放信息 / 统计", "script-binding stats/display-stats", "i"),
        item("播放列表", "show-text ${playlist} 4000", "F8"),
        item("循环播放", "cycle loop-file", "L"),
        sep(),
        item("FNOS 内置 MPV 硬解内核", "show-text 'FNOS 桌面客户端 · 内置 MPV 显卡硬解内核' 3000"),
    }
end

pcall(function()
    mp.set_property_native("menu-data", build_menu())
    -- 右键直接呼出上面的中文菜单（覆盖默认英文 context menu）；每次打开刷新轨道/搜索结果
    mp.add_forced_key_binding("MBTN_RIGHT", "fnos-context-menu", function()
        pcall(function()
            mp.set_property_native("menu-data", build_menu())
            mp.command("menu")
        end)
    end)
    mp.msg.info("FNOS 中文右键菜单已加载（含在线字幕/本地字幕/画中画）")
end)
