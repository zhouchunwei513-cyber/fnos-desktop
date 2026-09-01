-- FNOS 内置 MPV · 中文右键菜单
-- 通过 menu-data 属性设置全中文上下文菜单（右键呼出）。mpv 官方 Windows 版
-- 不随包提供中文翻译文件，这里用 Lua 直接构造原生菜单，保证任何版本都可用。

local function item(title, cmd, shortcut)
    local it = { ["title"] = title }
    if cmd then it["cmd"] = cmd end
    if shortcut then it["shortcut"] = shortcut end
    return it
end

local function sep() return { ["type"] = "separator" } end

local menu = {
    item("播放 / 暂停", "cycle pause", "空格"),
    item("停止并返回网页", "quit 0"),
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

    { ["title"] = "字幕", ["type"] = "submenu", ["submenu"] = {
        item("切换字幕轨", "cycle sub", "j"),
        item("显示 / 隐藏字幕", "cycle sub-visibility", "v"),
        item("字幕提前 0.1s", "add sub-delay -0.1", "z"),
        item("字幕延后 0.1s", "add sub-delay 0.1", "Z"),
        item("字幕上移", "add sub-pos -1", "r"),
        item("字幕下移", "add sub-pos +1", "R"),
    }},

    { ["title"] = "音轨 / 声音", ["type"] = "submenu", ["submenu"] = {
        item("切换音轨", "cycle audio", "#"),
        item("静音 / 取消静音", "cycle mute", "m"),
        item("音量 +5", "add volume 5"),
        item("音量 -5", "add volume -5"),
        item("音频提前 0.1s", "add audio-delay -0.1"),
        item("音频延后 0.1s", "add audio-delay 0.1"),
    }},

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

mp.set_property_native("menu-data", menu)
