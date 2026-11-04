# FNOS 客户端强力卸载器 —— 构建脚本
# 用 Windows 自带的 .NET Framework 4.x 编译器生成单文件便携 exe（无外部依赖）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build-uninstaller.ps1
#   powershell -ExecutionPolicy Bypass -File build-uninstaller.ps1 -OutDir "D:\dist"
param(
    [string]$OutDir = ""
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $here 'dist' }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) { throw '找不到 csc.exe：需要 .NET Framework 4.x' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$srcs = Get-ChildItem (Join-Path $here 'src') -Filter '*.cs' | ForEach-Object { $_.FullName }
$icon = Join-Path $repo 'icon.ico'
$manifest = Join-Path $here 'uninstaller.manifest'
$out = Join-Path $OutDir 'FNOS-Uninstaller.exe'

$cscArgs = @(
    '/nologo'
    '/target:winexe'
    '/platform:anycpu'
    '/optimize+'
    '/codepage:65001'
    '/win32manifest:' + $manifest
    '/out:' + $out
)
if (Test-Path $icon) { $cscArgs += ('/win32icon:' + $icon) }
$cscArgs += '/reference:System.dll'
$cscArgs += '/reference:System.Core.dll'
$cscArgs += '/reference:System.Drawing.dll'
$cscArgs += '/reference:System.Windows.Forms.dll'
$cscArgs += $srcs

& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "compile failed, exit=$LASTEXITCODE" }

$f = Get-Item $out
"OK  ->  $($f.FullName)  $([math]::Round($f.Length/1KB,1)) KB"
