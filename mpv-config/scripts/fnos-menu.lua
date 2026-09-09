-- FNOS 内置 MPV · 全中文右键菜单
-- 背景：mpv 官方 Windows（shinchiro）构建不随包提供 gettext 中文翻译，也没有 --lang 选项，
--       默认右键菜单是英文。这里用 Lua 构造菜单数据（menu-data 属性），交给 mpv 内置
--       context_menu 脚本以 OSD 方式渲染中文菜单，任何 0.36+ 版本都可用。
-- 打开方式：给内置脚本发 script-message "context_menu open"（等价于 script-binding context_menu/open）。
-- v1.33 增强：音轨/内置字幕轨、播放信息、倍速、画面调整等。
-- v1.47.0：弹幕、在线字幕搜索下载、画质切换、跳过片头片尾（ZDY 增强）已全部下线，
--          仅保留本地字幕（内置轨 + 本地字幕文件加载）、音轨、倍速、画面、播放信息等本地能力。
-- 安全：全部逻辑包在 pcall 里，任何 API 不兼容/异常都只影响菜单本身，绝不影响播放。
-- 注意：必须显式 require mp / mp.utils / mp.msg。shinchiro 构建下全局 mp 表不保证带 .utils，
--       直接写 utils.format_json 会在运行时 "attempt to index field 'utils' (a nil value)"，
--       一旦在 build_menu/菜单回调里触发，整个菜单脚本崩溃，画质/播放信息/字幕全部失效。

local mp = require 'mp'
local utils = require 'mp.utils'
local msg = require 'mp.msg'

local build_menu            -- 前向声明（open_context_menu 会先用到，真正赋值在后面）

-- ---------------- 基础工具 ----------------
local function item(title, cmd, shortcut)
    local it = { ["title"] = title }
    if cmd then it["cmd"] = cmd end
    if shortcut then it["shortcut"] = shortcut end
    return it
end
local function sep() return { ["type"] = "separator" } end

-- 子菜单（画质/倍速）打开期间为 true：此时 refresh_menu_data 不得覆盖 menu-data，
-- 否则 context_menu 弹出后点选的菜单项已变回主菜单数据，导致命令不执行（点击失效）。
local g_submenu_open = false

-- 刷新菜单数据：把中文菜单写入 mpv 的 menu-data 属性（内置 context_menu / 原生右键菜单都会读它）
local function refresh_menu_data()
    if g_submenu_open then return end
    pcall(function() mp.set_property_native("menu-data", build_menu()) end)
end

-- 子菜单函数前置声明：它们在文件后部用 local function 定义，但前面的画质/倍速消息处理器
-- 就会引用 close_submenu。Lua 的 local function 只在定义点之后可见，若不前置声明，
-- 前面的闭包会绑定到全局 nil，运行到即报 "attempt to call global 'close_submenu' (a nil value)"，
-- 导致整个 fnos_menu 脚本崩溃、所有控制栏菜单失效。这里先声明 local，后部再赋值。
local open_submenu, close_submenu

-- 安全注册脚本消息：任一菜单处理器内部报错时只记录日志，绝不让异常冒泡
-- （mpv 对未捕获 Lua 错误会直接销毁整个脚本 client，导致所有控制栏/右键菜单失效、回退英文）。
local function safe_msg(name, fn)
    mp.register_script_message(name, function(...)
        local args = {...}
        local ok, err = pcall(function() return fn(unpack(args)) end)
        if not ok then mp.msg.error("[fnos-menu] 处理器 " .. name .. " 出错: " .. tostring(err)) end
    end)
end

-- 打开右键菜单。Windows 无原生右键菜单，mpv 走内置 @context_menu.lua（OSD 渲染）：
--   该脚本只暴露 script-message "context_menu open"，读取 menu-data 属性后绘制中文菜单。
-- 注意：内置命令 "context-menu" 在 Windows 上是 VOCTRL_SHOW_MENU，无原生菜单后端=空操作，
--       因此这里直接发 script-message 打开。每次打开前刷新 menu-data（音轨/字幕轨/搜索结果均为动态）。
local function open_context_menu()
    pcall(function()
        g_submenu_open = false  -- 打开主菜单即退出子菜单态，确保刷新的是完整主菜单
        refresh_menu_data()
        -- 内置 context_menu.lua 注册的脚本名是 "context_menu"、消息名是 "open"，
        -- 必须用 script-message-to 指定目标脚本；写成全局 broadcast 不会被它接收（菜单打不开）。
        mp.commandv("script-message-to", "context_menu", "open")
    end)
end

-- 供 OSC 左下角「≡」按钮调用（script-message-to fnos_menu fnos-context-open），
-- 让左下角≡、右键、控制栏子菜单三者共用同一套中文菜单数据。
safe_msg("fnos-context-open", function() open_context_menu() end)

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
        mp.msg.info("zdy helper req route=" .. route .. " body=" .. tostring(bodyJson):sub(1, 300))
        mp.command_native_async({
            ["name"] = "subprocess", ["args"] = args,
            ["capture_stdout"] = true, ["capture_stderr"] = true, ["playback_only"] = false
        }, function(_success, res, _err)
            local out = (res and res.stdout) or ""
            local st = (res and res.status) or -1
            local ok, data = pcall(function() return utils.parse_json(out) end)
            if ok and type(data) == "table" then
                local n = 0
                if type(data.results) == "table" then n = #data.results
                elseif type(data.comments) == "table" then n = #data.comments
                elseif data.count then n = data.count end
                mp.msg.info("zdy helper ok route=" .. route .. " status=" .. tostring(st)
                    .. " ok=" .. tostring(data.ok) .. " count=" .. tostring(n)
                    .. " channel=" .. tostring(data.channel or data.source or "")
                    .. " err=" .. tostring(data.error or ""))
                onDone(data)
            else
                mp.msg.warn("zdy helper FAIL route=" .. route .. " status=" .. tostring(st)
                    .. " stderr=" .. tostring((res and res.stderr) or ""):sub(1, 200)
                    .. " out=" .. tostring(out):sub(1, 200))
                onDone(nil)
            end
        end)
    end)
end

-- 字节安全工具：Lua 的 pattern 字符类 [..] 按【单字节】匹配，而中文标点/汉字是 UTF-8 多字节，
-- 直接把中文标点写进字符类会把其首字节当成类成员，进而误伤所有含该字节的中文片名
-- （此前"孤注一掷/泰坦尼克号/落凡尘"等几乎全部中文片名都被误判为"含标点"而拒绝，
--  导致弹幕/字幕只能拿 "video" 去搜索）。因此所有多字节中文标点/语气词都用 plain 子串匹配。
local function _contains_any(s, subs)
    for _, sub in ipairs(subs) do
        if s:find(sub, 1, true) then return true end  -- plain=true，按字节精确匹配整个多字节串
    end
    return false
end
local function _ends_with_any(s, subs)
    for _, sub in ipairs(subs) do
        local ls, lb = #s, #sub
        if ls >= lb and s:sub(ls - lb + 1) == sub then return true end
    end
    return false
end

-- 判断是否为“可作为片名搜索”的合法文本。媒体详情接口里嵌套的剧集/相关推荐/片段数组，
-- 其 title 可能是一句对白（如“你希望那样吗”）或纯媒体哈希，必须识别并丢弃，否则字幕/弹幕
-- 会拿一句对白或哈希去搜索，必然 0 结果。
local function valid_movie_name(n)
    if not n then return false end
    n = tostring(n):gsub("^%s+", ""):gsub("%s+$", "")
    if n == "" then return false end
    local low = n:lower()
    for _, b in ipairs({ "飞牛影视", "飞牛", "fnos", "loading", "加载中", "未命名", "video", "-" }) do
        if low == b then return false end
    end
    -- 句读/疑问/感叹标点 → 多半是对白字幕而非片名（plain 子串匹配，多字节安全）。
    -- 不拒绝冒号（: ：）：英文片名常见 "The Chronicles of Narnia: The Lion..."，中文也常见"阿凡达：水之道"。
    if _contains_any(n, { "?", "!", "？", "！", "。", "，", "、", "；", "“", "”", "\"", "'", "‘", "’", "…", "—" }) then
        return false
    end
    -- 句末语气词（整字结尾匹配，多字节安全）→ 多为对白。
    if _ends_with_any(n, { "吗", "呢", "吧", "啊", "呀", "嘛", "哦", "哩", "么" }) then return false end
    -- 纯十六进制/数字 GUID（媒体 range id 形如 e66071fadcf2435abe3852f4c3671e1b）。这里只含 ASCII，字符类安全。
    if n:match("^[0-9a-fA-F%-]+$") and #n >= 8 then return false end
    if n:match("^%d+$") then return false end
    -- URL/路径片段（media-title 未就绪时会回退成播放地址，如 "media/range/.../video"）
    if n:find("[/\\]") then return false end
    if _contains_any(low, { "http", "range", ".com", ".m3u8", "index" })
        or _ends_with_any(low, { ".ts" }) then return false end
    -- 过短（单字节噪声）或过长（整句）都不像片名
    if #n < 2 or #n > 80 then return false end
    return true
end

-- 识别"压制/抓轨文件名"（如 No More Bets.2023.2160p.60fps.HQ.WEB-DL.H265...-BestWEB）。
-- 这类是种子/抓轨文件名，不是展示片名；流媒体场景 force-media-title 稍后会覆盖成正式中文片名，
-- 自动增强应等待，避免拿整串英文压制名去搜弹幕/字幕（命中错误二创/0 结果）。
local function is_release_filename(n)
    n = tostring(n or "")
    local low = n:lower()
    local has_year = n:find("19%d%d") or n:find("20[0-3]%d")
    local has_tag = low:find("web%-dl") or low:find("webrip") or low:find("bluray")
        or low:find("bdrip") or low:find("hdrip") or low:find("x264") or low:find("x265")
        or low:find("h264") or low:find("h265") or low:find("hevc") or low:find("ddp")
        or low:find("aac") or low:find("remux") or n:find("2160p") or n:find("1080p")
        or n:find("720p") or n:find("480p") or low:find("bestweb")
    return has_year and has_tag and #n > 24
end

local function media_keyword()
    -- 优先用真实片名（force-media-title / media-title，由客户端按网页接口片名设置）；
    -- 若片名是对白碎片/哈希等垃圾值，则退到文件名。去掉站点后缀与噪音，提升字幕/弹幕命中率。
    local name = mp.get_property("media-title") or ""
    if not valid_movie_name(name) then
        name = mp.get_property("filename/no-ext") or "video"
    end
    name = tostring(name):gsub("^.*[\\/]", ""):gsub("%?.*$", "")
    name = name:gsub("%s*[-_|–—]%s*飞牛.*$", ""):gsub("%s*[-_|–—]%s*fnos.*$", "")
    if not valid_movie_name(name) then name = "video" end
    return name
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

-- 实时播放信息覆盖层：每 0.5s 重绘，进度/码率/缓存/倍速实时变化；再次点击菜单或按 x 关闭。
local _stats_visible = false
local _stats_timer = nil

local function fmt_time(sec)
    sec = math.max(0, math.floor(tonumber(sec) or 0))
    local h = math.floor(sec / 3600)
    local m = math.floor((sec % 3600) / 60)
    local s = sec % 60
    if h > 0 then return string.format("%d:%02d:%02d", h, m, s) end
    return string.format("%02d:%02d", m, s)
end

local function hide_playback_stats()
    _stats_visible = false
    if _stats_timer then _stats_timer:kill(); _stats_timer = nil end
    mp.osd_message("", 0.01)
end

local function render_playback_stats()
    if not _stats_visible then return end
    pcall(function()
        local g = function(p, d) local v = mp.get_property(p); if v == nil or v == "" then return d end; return v end
        local gn = function(p, d) local v = mp.get_property_number(p); if v == nil then return d end; return v end
        local lines = {}
        local title = g("media-title", "")
        table.insert(lines, "『" .. tostring(title) .. "』")
        local pos = gn("time-pos", 0)
        local dur = gn("duration", 0)
        local pct = (dur > 0) and (pos / dur * 100) or 0
        table.insert(lines, "进度: " .. fmt_time(pos) .. " / " .. (dur > 0 and fmt_time(dur) or "直播/未知")
            .. string.format("  (%.1f%%)", pct))
        table.insert(lines, "分辨率: " .. tostring(gn("width", 0)) .. "×" .. tostring(gn("height", 0))
            .. "   帧率: " .. string.format("%.1f", gn("estimated-vf-fps", gn("container-fps", 0))) .. " fps"
            .. "   倍速: " .. string.format("%.2f", gn("speed", 1)) .. "x")
        table.insert(lines, "视频: " .. tostring(g("video-codec", "—")) .. "   音频: " .. tostring(g("audio-codec", "—")))
        table.insert(lines, "总码率: " .. fmt_kbps(gn("packet-bitrate", gn("video-bitrate", 0)))
            .. "   视频码率: " .. fmt_kbps(gn("video-bitrate", 0)))
        table.insert(lines, "音频码率: " .. fmt_kbps(gn("audio-bitrate", 0))
            .. "   音量: " .. string.format("%d", gn("volume", 100)) .. "%")
        local hw = g("hwdec-current", "")
        table.insert(lines, "硬解: " .. tostring(hw ~= "" and hw or g("hwdec", "—"))
            .. "   丢帧: " .. tostring(gn("frame-drop-count", 0)))
        table.insert(lines, "缓存: " .. string.format("%.1f", gn("demuxer-cache-duration", 0)) .. " 秒   缓冲: "
            .. string.format("%d", gn("cache-buffering-state", 100)) .. "%"
            .. "   A/V: " .. string.format("%.3f", gn("avsync", 0)) .. "s")
        table.insert(lines, "—— 实时刷新 · 再点菜单「播放信息」或按 x 关闭 ——")
        -- duration 设长于刷新间隔（0.8s > 0.5s），由下一次重绘覆盖，实现持续实时更新
        mp.osd_message(table.concat(lines, "\n"), 0.8)
    end)
end

local function show_playback_stats()
    -- 再点一次"播放信息"即关闭
    if _stats_visible then hide_playback_stats(); return end
    _stats_visible = true
    render_playback_stats()
    _stats_timer = mp.add_periodic_timer(0.5, render_playback_stats)
end

-- 按 x 快速关闭播放信息
mp.add_key_binding("x", "fnos-stats-close", function()
    if _stats_visible then hide_playback_stats() end
end)
safe_msg("fnos-playback-stats", show_playback_stats)
-- 切文件 / 退出时自动关闭覆盖层，避免残留
mp.register_event("end-file", function() if _stats_visible then pcall(hide_playback_stats) end end)

-- v1.47.0：画质/清晰度切换已移除（在线流媒体清晰度由片源决定，mpv 无法切换源分辨率，
-- 旧本地 vf scale 只会让画面更糊）。右键菜单与 OSC 均不再提供该项。

-- 打开一个"子菜单"并保持其 menu-data 不被主菜单覆盖。
-- 关键修复：旧实现打开子菜单后立即 refresh_menu_data()，把 menu-data 还原成主菜单，
-- 导致 context_menu 弹出后用户点击的是被覆盖的主菜单数据，画质/倍速命令不执行（点击失效）。
-- 现用 g_submenu_open 标记：子菜单打开期间 refresh_menu_data 不再覆盖，关闭时才还原。
open_submenu = function(data)
    g_submenu_open = true
    mp.set_property_native("menu-data", data)
    mp.commandv("script-message-to", "context_menu", "open")
end
close_submenu = function()
    g_submenu_open = false
    refresh_menu_data()
end

-- v1.47.0：底部控制栏「清晰度/画质」按钮已随画质功能一并移除。

-- 倍速：设置播放速度（mpv 自动用 scaletempo2 保持音调不变）并给出明确 OSD 反馈。
-- 注意：speed 是真实生效的（音频变速不变调、视频同步），此前用户以为"没用"是因为旧菜单
-- 用裸 `set speed` 无任何提示、也不刷新选中态。现统一走本处理器。
local function set_speed(s)
    pcall(function()
        local v = tonumber(s) or 1.0
        mp.set_property_number("speed", v)
        local back = mp.get_property_number("speed", v)
        local tag = (math.abs(back - 1.0) < 0.001) and "（正常速度）" or "（音频变速不变调）"
        mp.osd_message("▶ 播放倍速：" .. string.format("%.2f", back) .. "x  " .. tag, 2200)
        pcall(refresh_menu_data)
    end)
end
safe_msg("fnos-speed", function(s) set_speed(s); close_submenu() end)

-- 底部控制栏「倍速」按钮：弹出倍速子菜单
safe_msg("fnos-speed-menu", function()
    pcall(function()
        local cur = mp.get_property_number("speed", 1) or 1
        local data = {
            { title = "播放倍速（当前 " .. string.format("%.2f", cur) .. "x）", state = { "disabled" },
              cmd = "osd-msg show-text 倍速" },
            { type = "separator" },
        }
        for _, sp in ipairs({ 0.5, 0.75, 1.0, 1.25, 1.5, 2.0 }) do
            local label = (math.abs(sp - 1.0) < 0.001) and "1.0x（正常）" or string.format("%.2gx", sp)
            if math.abs(cur - sp) < 0.001 then label = "✓ " .. label end
            data[#data + 1] = { title = label, cmd = "script-message fnos-speed " .. tostring(sp) }
        end
        open_submenu(data)
    end)
end)

-- 音轨切换子菜单（自包含，避免跨脚本写 menu-data 竞态）
safe_msg("fnos-audio-menu", function()
    pcall(function()
        local tracks = mp.get_property_native("track-list") or {}
        local cur = mp.get_property_number("aid", -1)
        local data = {
            { title = "音轨选择", state = { "disabled" }, cmd = "osd-msg show-text 音轨" },
            { type = "separator" },
            { title = (cur == -1 or cur == nil) and "✓ 静音轨" or "静音轨",
              cmd = "set aid no; osd-msg show-text 已关闭音轨" },
        }
        for _, t in ipairs(tracks) do
            if t.type == "audio" then
                local lang = t.lang and (t.lang:sub(1, 12)) or "音轨"
                local title = t.title and (t.title:sub(1, 30)) or ""
                local label = "音轨 " .. t.id .. " · " .. lang .. (title ~= "" and (" " .. title) or "")
                if t.id == cur then label = "✓ " .. label end
                data[#data + 1] = { title = label, cmd = "set aid " .. t.id .. "; osd-msg show-text 音轨 " .. t.id }
            end
        end
        open_submenu(data)
    end)
end)

-- 字幕设置子菜单（自包含）
safe_msg("fnos-sub-menu", function()
    pcall(function()
        local tracks = mp.get_property_native("track-list") or {}
        local cur = mp.get_property_number("sid", -1)
        local vis = mp.get_property_bool("sub-visibility", true)
        local data = {
            { title = "字幕设置", state = { "disabled" }, cmd = "osd-msg show-text 字幕设置" },
            { type = "separator" },
            { title = vis and "✓ 字幕显示开" or "字幕显示开", cmd = "cycle sub-visibility" },
            { title = (cur == -1 or cur == nil or not vis) and "✓ 关闭字幕" or "关闭字幕", cmd = "set sid no; osd-msg show-text 关闭字幕" },
        }
        for _, t in ipairs(tracks) do
            if t.type == "sub" then
                local lang = t.lang and (t.lang:sub(1, 12)) or "字幕"
                local title = t.title and (t.title:sub(1, 30)) or ""
                local label = "字幕轨 " .. t.id .. " · " .. lang .. (title ~= "" and (" " .. title) or "")
                if t.id == cur and vis then label = "✓ " .. label end
                data[#data + 1] = { title = label, cmd = "set sid " .. t.id .. "; set sub-visibility yes; osd-msg show-text 字幕轨 " .. t.id }
            end
        end
        data[#data + 1] = { type = "separator" }
        data[#data + 1] = { title = "字幕上移", cmd = "add sub-margin-y 30; osd-msg show-text 字幕上移" }
        data[#data + 1] = { title = "字幕下移", cmd = "add sub-margin-y -30; osd-msg show-text 字幕下移" }
        data[#data + 1] = { title = "字幕放大", cmd = "add sub-scale 0.1" }
        data[#data + 1] = { title = "字幕缩小", cmd = "add sub-scale -0.1" }
        open_submenu(data)
    end)
end)

-- 画质子菜单里的"返回"：刷新为完整主菜单并重新打开
safe_msg("fnos-menu-main", function()
    pcall(function()
        g_submenu_open = false
        refresh_menu_data()
        mp.commandv("script-message-to", "context_menu", "open")
    end)
end)

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

-- v1.47.0：在线字幕搜索结果 / 弹幕搜索结果构建函数已随功能下线移除。

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
    -- v1.47.0：移除弹幕、在线字幕搜索、跳过片头片尾（ZDY 增强）相关项。
    -- 字幕菜单仅保留：显示/隐藏、加载本地字幕文件、内置字幕轨切换、字幕时序/位置/字号调整。
    local sub_menu = {
        item("显示 / 隐藏字幕", "cycle sub-visibility", "v"),
        item("加载本地字幕文件…", "script-message fnos-sub-local"),
    }
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
            item("恢复正常速度", "script-message fnos-speed 1.0", "Backspace"),
            item("A-B 循环", "ab-loop", "l"),
            item("逐帧前进", "frame-step", "."),
            item("逐帧后退", "frame-back-step", ","),
        }},

        { ["title"] = "字幕", ["type"] = "submenu", ["submenu"] = sub_menu },

        audio_submenu(),

        { ["title"] = "画面", ["type"] = "submenu", ["submenu"] = {
            item("切换全屏", "cycle fullscreen", "f"),
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

        { ["title"] = "播放速度", ["type"] = "submenu", ["submenu"] = (function()
            local cur = mp.get_property_number("speed", 1) or 1
            local t = {
                { ["title"] = "当前倍速 " .. string.format("%.2f", cur) .. "x（音频自动变速不变调）", ["selectable"] = false },
                sep(),
            }
            for _, sp in ipairs({ 0.5, 0.75, 1.0, 1.25, 1.5, 2.0 }) do
                local label = (math.abs(sp - 1.0) < 0.001) and "1.00x（正常）" or string.format("%.2gx", sp)
                if math.abs(cur - sp) < 0.001 then label = "✓ " .. label end
                t[#t + 1] = item(label, "script-message fnos-speed " .. tostring(sp))
            end
            return t
        end)()},

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

-- ---------------- 脚本消息：本地字幕加载（v1.47.0 起移除在线字幕搜索/下载） ----------------
safe_msg("fnos-sub-local", function()
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

-- v1.47.0：弹幕搜索/选择/下载处理器已移除（弹幕功能整体下线）。

-- v1.47.0：跳过片头/片尾（ZDY 增强）功能已移除。


-- v1.47.0：起播自动增强（自动弹幕/在线字幕/片头片尾）已整体移除。

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
    mp.add_forced_key_binding("MBTN_RIGHT", "fnos-context-menu", function()
        local ok, err = pcall(open_context_menu)
        if not ok then mp.msg.error("[fnos-menu] 打开菜单出错: " .. tostring(err)) end
    end)
    -- 独立窗口双击全屏；延迟到首帧后确保 ontop 已按形态生效。
    mp.observe_property("ontop", "bool", function() sync_dbl_binding() end)
    mp.msg.info("FNOS 中文右键菜单已加载（本地字幕/音轨/倍速/画面/播放信息；v1.47.0 已移除弹幕/在线字幕/画质/片头片尾）")
end)
