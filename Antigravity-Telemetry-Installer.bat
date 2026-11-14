@echo off
chcp 65001 >nul
set "SELF_BAT=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lines=[System.IO.File]::ReadAllLines($env:SELF_BAT,[System.Text.Encoding]::UTF8); $idx=[Array]::IndexOf($lines,'# === PS_SCRIPT_START ==='); Invoke-Expression ($lines[($idx+1)..($lines.Length-1)] -join [char]10)"
set "PS_EXIT=%ERRORLEVEL%"
if not "%PS_EXIT%"=="0" (
  echo.
  echo [ERROR] Script exited with code %PS_EXIT%.
)
if not "%ANTIGRAVITY_SKIP_PAUSE%"=="1" pause
exit /b %PS_EXIT%
# === PS_SCRIPT_START ===
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "  Antigravity 2.0 & CLI 遥测栏 + Token 活动热力图 安装器" -ForegroundColor Cyan
Write-Host "  - 实时遥测条: 速率(t/s) | 上下文环形图 | 缓存命中率 | 累计消耗" -ForegroundColor DarkCyan
Write-Host "  - 交互热力图: 点击遥测条展开 Daily / Weekly / Monthly 面板" -ForegroundColor DarkCyan
Write-Host "  - CLI 同步  : 自动配置 agy statusLine 并共享 Token 账本缓存" -ForegroundColor DarkCyan
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host ""

function Read-AsarInfo([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 16) {
        throw "ASAR 文件损坏或长度不足: $path"
    }
    $u0 = [BitConverter]::ToUInt32($bytes, 0)
    $u1 = [BitConverter]::ToUInt32($bytes, 4)
    $u3 = [BitConverter]::ToUInt32($bytes, 12)
    $dataOffset = 8 + [int]$u1
    if ($dataOffset -gt $bytes.Length -or (16 + [int]$u3) -gt $bytes.Length) {
        throw "ASAR Pickle 头异常: u0=$u0, u1=$u1, u3=$u3"
    }
    $jsonStr = [System.Text.Encoding]::UTF8.GetString($bytes, 16, [int]$u3)
    [void][System.Reflection.Assembly]::LoadWithPartialName("System.Web.Extensions")
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $hdr = $ser.DeserializeObject($jsonStr)
    return @{
        Bytes      = $bytes
        DataOffset = $dataOffset
        JsonStr    = $jsonStr
        Hdr        = $hdr
    }
}

function Get-Sha256Hex([byte[]]$buf) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash($buf)
        return ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-DirWritable([string]$dirPath) {
    try {
        $probe = Join-Path $dirPath (".write_probe_" + [Guid]::NewGuid().ToString("N"))
        [System.IO.File]::WriteAllText($probe, "ok")
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Write-Utf8NoBom([string]$targetPath, [string]$text) {
    $parent = Split-Path -Parent $targetPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tmp = $targetPath + ".tmp"
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $text, $enc)
    Move-Item -LiteralPath $tmp -Destination $targetPath -Force
}

function Resolve-SpaceFreeCliScriptPath([string]$cliHome) {
    $direct = Join-Path $cliHome "agy-statusline.js"
    if ($direct -notmatch '\s') {
        return $direct
    }
    try {
        $fso = New-Object -ComObject Scripting.FileSystemObject
        $shortDir = $fso.GetFolder($cliHome).ShortPath
        if ($shortDir -and ($shortDir -notmatch '\s')) {
            return (Join-Path $shortDir "agy-statusline.js")
        }
    } catch {}
    if ($env:PUBLIC -and ($env:PUBLIC -notmatch '\s')) {
        return (Join-Path $env:PUBLIC "agy-statusline.js")
    }
    return (Join-Path ($env:SystemDrive + "\antigravity-telemetry") "agy-statusline.js")
}

function Resolve-CommandTargetPath([string]$cmdStr) {
    if (-not $cmdStr) { return "" }
    $trimmed = $cmdStr.Trim()
    if ($trimmed -match '^(?:node(?:\.exe)?\s+)"?([^"]+?\.js)"?(?:\s|$)') {
        return ($matches[1] -replace '/', '\')
    }
    return ""
}

function Get-ModResource([string]$fileName) {
    $batDir = if ($env:SELF_BAT) { Split-Path -Parent $env:SELF_BAT } else { (Get-Location).Path }
    $localSrc = Join-Path (Join-Path $batDir "src") $fileName
    if (Test-Path -LiteralPath $localSrc) {
        return ([System.IO.File]::ReadAllText($localSrc, [System.Text.Encoding]::UTF8) -replace "\r\n", "`n").TrimEnd()
    }

    $cacheDir = Join-Path (Join-Path $env:USERPROFILE ".gemini\telemetry-mod-cache") "src"
    $cachePath = Join-Path $cacheDir $fileName
    $urls = @(
        "https://fastly.jsdelivr.net/gh/Hsanli060/antigravity-token-pulse@main/src/$fileName",
        "https://cdn.jsdelivr.net/gh/Hsanli060/antigravity-token-pulse@main/src/$fileName",
        "https://raw.githubusercontent.com/Hsanli060/antigravity-token-pulse/main/src/$fileName"
    )

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}

    foreach ($url in $urls) {
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15
            $text = $resp.Content
            if ($text -is [byte[]]) {
                $text = [System.Text.Encoding]::UTF8.GetString($text)
            }
            if ($text -and $text.Trim().Length -gt 20) {
                $normalized = ($text -replace "\r\n", "`n").TrimEnd()
                if (-not (Test-Path -LiteralPath $cacheDir)) {
                    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
                }
                Write-Utf8NoBom $cachePath ($normalized + "`n")
                return $normalized
            }
        } catch {}
    }

    if (Test-Path -LiteralPath $cachePath) {
        Write-Host "[缓存] 网络不可用，已使用本地缓存模块: $fileName" -ForegroundColor Yellow
        return ([System.IO.File]::ReadAllText($cachePath, [System.Text.Encoding]::UTF8) -replace "\r\n", "`n").TrimEnd()
    }

    throw "无法加载模块 $fileName ：未找到本地 src/$fileName 且在线镜像下载失败。建议直接下载仓库 ZIP 压缩包后离线运行。"
}

$IPC_BLOCK = (Get-ModResource "ipc-block.js") + "`n"
$PRELOAD_BLOCK = (@(
    (Get-ModResource "preload-part1.js"),
    (Get-ModResource "preload-part2.js"),
    (Get-ModResource "preload-part3.js")
) -join "`n") + "`n"
$AGY_STATUS_CODE = (Get-ModResource "agy-statusline.js") + "`n"

# 1. 自动查找 Antigravity 2.0 桌面端 app.asar
$asarPath = $null
if ($env:ANTIGRAVITY_ASAR_PATH -and (Test-Path -LiteralPath $env:ANTIGRAVITY_ASAR_PATH)) {
    $asarPath = (Resolve-Path -LiteralPath $env:ANTIGRAVITY_ASAR_PATH).Path
} else {
    $candidates = New-Object System.Collections.ArrayList
    $running = Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($running -and $running.Path) {
        [void]$candidates.Add((Join-Path (Split-Path -Parent $running.Path) "resources\app.asar"))
    }
    if ($env:LOCALAPPDATA) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Antigravity\resources\app.asar"))
    }
    if ($env:ProgramFiles) {
        [void]$candidates.Add((Join-Path $env:ProgramFiles "Antigravity\resources\app.asar"))
    }
    if (${env:ProgramFiles(x86)}) {
        [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} "Antigravity\resources\app.asar"))
    }

    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path -LiteralPath $cand)) {
            $asarPath = (Resolve-Path -LiteralPath $cand).Path
            break
        }
    }
}

$cliHome = if ($env:ANTIGRAVITY_CLI_HOME) { $env:ANTIGRAVITY_CLI_HOME } else { Join-Path $env:USERPROFILE ".gemini\antigravity-cli" }
$hasCli = (Test-Path -LiteralPath $cliHome) -or [bool](Get-Command agy -ErrorAction SilentlyContinue)

if (-not $asarPath) {
    Write-Host "[提示] 未自动扫描到 Antigravity 2.0 桌面端 app.asar。" -ForegroundColor Yellow
    if ($env:ANTIGRAVITY_INSTALLER_MODE) {
        Write-Host "[跳过] 将仅检查/配置 CLI 状态栏。" -ForegroundColor Yellow
    } else {
        $manual = Read-Host "请输入 Antigravity 安装目录或 app.asar 路径 (直接回车则跳过桌面端，仅配置 CLI)"
        if ($manual) {
            $manual = $manual.Trim().Trim('"')
            if (Test-Path -LiteralPath $manual -PathType Container) {
                $manual = Join-Path $manual "resources\app.asar"
            }
            if (Test-Path -LiteralPath $manual) {
                $asarPath = (Resolve-Path -LiteralPath $manual).Path
            } else {
                throw "未找到指定的 app.asar: $manual"
            }
        }
    }
}

$actionMode = "install"
$wasRunning = $false
$exePath = ""

if ($asarPath) {
    Write-Host "[1/3] 找到桌面端目标文件: $asarPath" -ForegroundColor Gray
    $resourcesDir = Split-Path -Parent $asarPath
    if (-not (Test-DirWritable $resourcesDir)) {
        throw "没有目录写入权限 ($resourcesDir)。请右键本脚本 -> 「以管理员身份运行」后重试。"
    }

    $bakPath = $asarPath + ".bak"
    $exePath = Join-Path (Split-Path -Parent $resourcesDir) "Antigravity.exe"

    $info = Read-AsarInfo $asarPath
    $distFiles = $info.Hdr["files"]["dist"]["files"]
    if (-not $distFiles -or -not $distFiles.ContainsKey("ipcHandlers.js") -or -not $distFiles.ContainsKey("preload.js")) {
        throw "目标 app.asar 结构不匹配 (缺少 dist/ipcHandlers.js 或 dist/preload.js)"
    }

    $ipcNodeCheck = $distFiles["ipcHandlers.js"]
    $ipcSample = [System.Text.Encoding]::UTF8.GetString(
        $info.Bytes,
        $info.DataOffset + [int]$ipcNodeCheck["offset"],
        [int]$ipcNodeCheck["size"]
    )
    $preNodeCheck = $distFiles["preload.js"]
    $preSample = [System.Text.Encoding]::UTF8.GetString(
        $info.Bytes,
        $info.DataOffset + [int]$preNodeCheck["offset"],
        [int]$preNodeCheck["size"]
    )

    $alreadyPatched = $ipcSample.Contains("TELEMETRY_MOD_IPC_START") -or
                      $preSample.Contains("TELEMETRY_MOD_PRELOAD_START") -or
                      $preSample.Contains("function installTelemetryBar()")

    if ($alreadyPatched) {
        Write-Host ""
        Write-Host "[检测] 当前 Antigravity 2.0 已包含遥测补丁。" -ForegroundColor Cyan
        $choice = if ($env:ANTIGRAVITY_INSTALLER_MODE) {
            if ($env:ANTIGRAVITY_INSTALLER_MODE -eq "restore") { "2" } else { "1" }
        } else {
            Write-Host "  [1] 重新安装 / 升级到最新版遥测栏 + 热力图 (默认)" -ForegroundColor White
            if (Test-Path -LiteralPath $bakPath) {
                Write-Host "  [2] 恢复官方原版 app.asar 并移除扩展" -ForegroundColor Yellow
            }
            Read-Host "请选择 [1/2] (直接回车执行 1)"
        }
        if ($choice -eq "2") {
            if (-not (Test-Path -LiteralPath $bakPath)) {
                throw "未找到官方原版备份文件: $bakPath"
            }
            $actionMode = "restore"
        }
    } elseif ($env:ANTIGRAVITY_INSTALLER_MODE -eq "restore") {
        if (-not (Test-Path -LiteralPath $bakPath)) {
            throw "未找到官方原版备份文件: $bakPath"
        }
        $actionMode = "restore"
    }

    if (-not $env:ANTIGRAVITY_ASAR_PATH) {
        $procs = Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue
        if ($procs) {
            $wasRunning = $true
            if ($procs[0].Path) { $exePath = $procs[0].Path }
            Write-Host "[关闭] 正在临时关闭 Antigravity 2.0 进程以解除文件占用..." -ForegroundColor Yellow
            $procs | Stop-Process -Force
            Start-Sleep -Milliseconds 1200
        }
    }

    if ($actionMode -eq "restore") {
        Copy-Item -LiteralPath $bakPath -Destination $asarPath -Force
        Write-Host "[OK] 已从备份恢复官方原版 app.asar！" -ForegroundColor Green
    } else {
        # 当当前 app.asar 为未打补丁的官方原版时，刷新 .bak 确保与当前客户端版本一致
        if (-not $alreadyPatched) {
            Copy-Item -LiteralPath $asarPath -Destination $bakPath -Force
            Write-Host "[OK] 已备份当前版本原版至 app.asar.bak" -ForegroundColor Gray
        }

        Write-Host "[2/3] 正在内存级注入遥测面板 & Token 热力图模块..." -ForegroundColor Yellow
        $asarBytes  = $info.Bytes
        $dataOffset = $info.DataOffset
        $jsonStr    = $info.JsonStr

        $targets = New-Object System.Collections.ArrayList

        # (A) dist/ipcHandlers.js
        $ipcNode    = $distFiles["ipcHandlers.js"]
        $ipcOldOff  = [long]$ipcNode["offset"]
        $ipcOldSize = [int]$ipcNode["size"]
        $ipcOldHash = [string]$ipcNode["integrity"]["hash"]
        $ipcCode    = [System.Text.Encoding]::UTF8.GetString($asarBytes, $dataOffset + [int]$ipcOldOff, $ipcOldSize)
        $ipcCode    = [regex]::Replace($ipcCode, "\s*// === TELEMETRY_MOD_IPC_START ===[\s\S]*?// === TELEMETRY_MOD_IPC_END ===\r?\n?", "`n")
        $wcvAnchor  = "    (0, wcvIpcHandlers_1.registerWcvIpcHandlers)"
        $anchorIdx  = $ipcCode.LastIndexOf($wcvAnchor)
        if ($anchorIdx -ne -1) {
            $ipcCode = $ipcCode.Substring(0, $anchorIdx) + $IPC_BLOCK + "`n" + $ipcCode.Substring($anchorIdx)
        } else {
            $lastBrace = $ipcCode.LastIndexOf("}")
            if ($lastBrace -eq -1) {
                throw "无法定位 dist/ipcHandlers.js 注入锚点"
            }
            $ipcCode = $ipcCode.Substring(0, $lastBrace) + $IPC_BLOCK + "`n}`n"
        }
        $ipcNewBytes = [System.Text.Encoding]::UTF8.GetBytes($ipcCode)
        [void]$targets.Add(@{
            Name     = "dist/ipcHandlers.js"
            OldOff   = $ipcOldOff
            OldSize  = $ipcOldSize
            OldHash  = $ipcOldHash
            NewBytes = $ipcNewBytes
        })

        # (B) dist/preload.js
        $preNode    = $distFiles["preload.js"]
        $preOldOff  = [long]$preNode["offset"]
        $preOldSize = [int]$preNode["size"]
        $preOldHash = [string]$preNode["integrity"]["hash"]
        $preCode    = [System.Text.Encoding]::UTF8.GetString($asarBytes, $dataOffset + [int]$preOldOff, $preOldSize)
        $preCode    = [regex]::Replace($preCode, "\s*// === TELEMETRY_MOD_PRELOAD_START ===[\s\S]*?(?://\s*=== TELEMETRY_MOD_PRELOAD_END ===\s*)+", "`n")
        $oldFnIdx   = $preCode.IndexOf("function installTelemetryBar()")
        if ($oldFnIdx -ne -1) {
            $preCode = $preCode.Substring(0, $oldFnIdx).TrimEnd()
        }
        $preCode     = $preCode.TrimEnd() + "`n" + $PRELOAD_BLOCK
        $preNewBytes = [System.Text.Encoding]::UTF8.GetBytes($preCode)
        [void]$targets.Add(@{
            Name     = "dist/preload.js"
            OldOff   = $preOldOff
            OldSize  = $preOldSize
            OldHash  = $preOldHash
            NewBytes = $preNewBytes
        })

        $sortedTargets = $targets | Sort-Object { $_.OldOff } -Descending
        $dataLen = $asarBytes.Length - $dataOffset
        $dataMem = New-Object System.IO.MemoryStream
        $dataMem.Write($asarBytes, $dataOffset, $dataLen)
        $curData = $dataMem.ToArray()
        $dataMem.Dispose()

        foreach ($t in $sortedTargets) {
            $oldOff   = [long]$t.OldOff
            $oldSize  = [int]$t.OldSize
            $oldHash  = [string]$t.OldHash
            $newBytes = [byte[]]$t.NewBytes
            $newSize  = $newBytes.Length
            $delta    = [long]$newSize - [long]$oldSize
            $newHash  = Get-Sha256Hex $newBytes

            if ($delta -ne 0) {
                $jsonStr = [regex]::Replace($jsonStr, '"offset":"(\d+)"', {
                    param($m)
                    $val = [long]$m.Groups[1].Value
                    if ($val -gt $oldOff) {
                        return '"offset":"' + ($val + $delta) + '"'
                    }
                    return $m.Value
                })
            }

            $oldEntryPattern = '"size":' + $oldSize + ',"offset":"' + $oldOff + '","integrity":\{"algorithm":"SHA256","hash":"' + $oldHash + '","blockSize":4194304,"blocks":\["' + $oldHash + '"\]\}'
            $newEntryReplacement = '"size":' + $newSize + ',"offset":"' + $oldOff + '","integrity":{"algorithm":"SHA256","hash":"' + $newHash + '","blockSize":4194304,"blocks":["' + $newHash + '"]}'
            $updatedJson = [regex]::Replace($jsonStr, $oldEntryPattern, $newEntryReplacement)
            if ($updatedJson -eq $jsonStr -and ($oldSize -ne $newSize -or $oldHash -ne $newHash)) {
                throw "更新 ASAR JSON 完整性头失败: $($t.Name)"
            }
            $jsonStr = $updatedJson

            $ms = New-Object System.IO.MemoryStream
            if ($oldOff -gt 0) {
                $ms.Write($curData, 0, [int]$oldOff)
            }
            $ms.Write($newBytes, 0, $newSize)
            $tailOff = [int]$oldOff + $oldSize
            $tailLen = $curData.Length - $tailOff
            if ($tailLen -gt 0) {
                $ms.Write($curData, $tailOff, $tailLen)
            }
            $curData = $ms.ToArray()
            $ms.Dispose()
            Write-Host "  -> 已注入 $($t.Name) ($oldSize -> $newSize bytes)" -ForegroundColor Green
        }

        Write-Host "[3/3] 正在封装并原子写入 app.asar ..." -ForegroundColor Yellow
        $newJsonBytes   = [System.Text.Encoding]::UTF8.GetBytes($jsonStr)
        $newU3          = [uint32]$newJsonBytes.Length
        $alignedJsonLen = [int]([Math]::Ceiling($newJsonBytes.Length / 4.0) * 4)
        $paddingLen     = $alignedJsonLen - $newJsonBytes.Length
        $newU2          = [uint32](4 + $alignedJsonLen)
        $newU1          = [uint32](4 + $newU2)
        $newU0          = [uint32]4

        $outAsarTmp = $asarPath + ".tmp"
        $fsOut = [System.IO.File]::Open($outAsarTmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
        try {
            $bw = New-Object System.IO.BinaryWriter($fsOut)
            $bw.Write($newU0)
            $bw.Write($newU1)
            $bw.Write($newU2)
            $bw.Write($newU3)
            $bw.Write($newJsonBytes)
            if ($paddingLen -gt 0) {
                $bw.Write((New-Object byte[] $paddingLen))
            }
            $bw.Write($curData)
            $bw.Flush()
        } finally {
            $fsOut.Dispose()
        }
        Move-Item -LiteralPath $outAsarTmp -Destination $asarPath -Force
    }
}

# 2. 自动检测并配置 Antigravity CLI (agy) 状态栏与共享缓存同步
if ($hasCli -or (Test-Path -LiteralPath $cliHome)) {
    Write-Host ""
    Write-Host "[CLI] 检测到 Antigravity CLI 环境: $cliHome" -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $cliHome)) {
        New-Item -ItemType Directory -Path $cliHome -Force | Out-Null
    }
    $settingsPath = Join-Path $cliHome "settings.json"
    $settingsObj = $null
    if (Test-Path -LiteralPath $settingsPath) {
        $rawSettings = [System.IO.File]::ReadAllText($settingsPath, [System.Text.Encoding]::UTF8)
        if ($rawSettings.Trim()) {
            $settingsObj = $rawSettings | ConvertFrom-Json
        }
    }
    if (-not $settingsObj) {
        $settingsObj = New-Object PSObject
    }

    $existingStatusLine = $settingsObj.PSObject.Properties["statusLine"]
    $existingCmd = if ($existingStatusLine -and $existingStatusLine.Value) { [string]$existingStatusLine.Value.command } else { "" }
    $existingTarget = Resolve-CommandTargetPath $existingCmd

    if ($actionMode -eq "restore") {
        if ($existingTarget -and (Test-Path -LiteralPath $existingTarget)) {
            $content = [System.IO.File]::ReadAllText($existingTarget, [System.Text.Encoding]::UTF8)
            if ($content.Contains("TELEMETRY_MOD_CLI_STATUSLINE")) {
                $settingsObj.PSObject.Properties.Remove("statusLine")
                Write-Utf8NoBom $settingsPath ($settingsObj | ConvertTo-Json -Depth 10)
                Write-Host "[CLI] 已从 settings.json 移除托管的 statusLine 配置。" -ForegroundColor Yellow
            }
        }
    } else {
        $preserveCustom = $false
        if ($existingTarget -and (Test-Path -LiteralPath $existingTarget)) {
            $existingText = [System.IO.File]::ReadAllText($existingTarget, [System.Text.Encoding]::UTF8)
            if ($existingText.Contains("TELEMETRY_MOD_CLI_STATUSLINE")) {
                Write-Utf8NoBom $existingTarget $AGY_STATUS_CODE
                Write-Host "[CLI] 已升级现有状态栏脚本: $existingTarget" -ForegroundColor Green
                $preserveCustom = $true
            } elseif ($existingText -match 'require\s*\(' -and -not $existingText.Contains("TELEMETRY_MOD_CLI_STATUSLINE")) {
                Write-Host "[CLI] 检测到自定义 statusLine 包装脚本，已完整保留: $existingTarget" -ForegroundColor Green
                $preserveCustom = $true
            }
        }

        if (-not $preserveCustom) {
            $deployPath = Resolve-SpaceFreeCliScriptPath $cliHome
            Write-Utf8NoBom $deployPath $AGY_STATUS_CODE
            $forwardCmdPath = $deployPath -replace '\\', '/'
            $statusObj = [PSCustomObject]@{
                type    = "command"
                command = ("node " + $forwardCmdPath)
                enabled = $true
            }
            if ($existingStatusLine) {
                $settingsObj.statusLine = $statusObj
            } else {
                $settingsObj | Add-Member -NotePropertyName "statusLine" -NotePropertyValue $statusObj -Force
            }
            Write-Utf8NoBom $settingsPath ($settingsObj | ConvertTo-Json -Depth 10)
            Write-Host "[CLI] 已部署状态栏脚本: $deployPath" -ForegroundColor Green
            Write-Host "[CLI] 已合并写入配置: $settingsPath" -ForegroundColor Green
        }

        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Write-Host "[!] 提示: 系统未检测到 node 命令，CLI 状态栏需要安装 Node.js (>=18)。" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
if ($actionMode -eq "restore") {
    Write-Host " [完成] 已恢复 Antigravity 2.0 官方原版。" -ForegroundColor Green
} else {
    Write-Host " [成功] Antigravity 2.0 遥测栏 + 热力图补丁安装完成！" -ForegroundColor Green
    Write-Host " 提示: 客户端自动升级覆盖后，再次双击本文件即可 1 秒恢复。" -ForegroundColor Green
}
Write-Host "=============================================================" -ForegroundColor Green

if ($asarPath -and $wasRunning -and $exePath -and (Test-Path -LiteralPath $exePath)) {
    Start-Process -FilePath $exePath
    Write-Host "[OK] 已为您自动重新打开 Antigravity 2.0！" -ForegroundColor Cyan
}
