@echo off & setlocal EnableExtensions & chcp 65001 >nul 2>nul & set "SELF_BAT=%~f0" & powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $lines=[System.IO.File]::ReadAllLines($env:SELF_BAT,[System.Text.Encoding]::UTF8); $idx=[Array]::IndexOf($lines,'# === PS_SCRIPT_START ==='); if($idx -lt 0){throw 'Invalid installer script'}; Invoke-Expression ($lines[($idx+1)..($lines.Length-1)] -join [char]10)" & call exit /b %%ERRORLEVEL%%
# === PS_SCRIPT_START ===
$ErrorActionPreference = "Stop"
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Read-Utf8NoBom([string]$targetPath) {
    $raw = [System.IO.File]::ReadAllText($targetPath, [System.Text.Encoding]::UTF8)
    if ($null -eq $raw) { return "" }
    return $raw.TrimStart([char]0xFEFF)
}

function Move-FileWithRetry([string]$sourcePath, [string]$destPath, [int]$maxRetries = 15, [int]$delayMs = 500) {
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            Move-Item -LiteralPath $sourcePath -Destination $destPath -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $maxRetries) {
                throw "写入目标文件失败 ($destPath): $($_.Exception.Message)。请确认 Antigravity 2.0 已从系统托盘完全退出且无杀毒软件锁定文件后重试。"
            }
            if ($attempt -eq 2) {
                Write-Host "[等待] 文件正被其他进程占用，正在自动重试 ($destPath)..." -ForegroundColor Yellow
            }
            Start-Sleep -Milliseconds $delayMs
        }
    }
}

function Copy-FileWithRetry([string]$sourcePath, [string]$destPath, [int]$maxRetries = 15, [int]$delayMs = 500) {
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            Copy-Item -LiteralPath $sourcePath -Destination $destPath -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $maxRetries) {
                throw "复制文件失败 ($sourcePath -> $destPath): $($_.Exception.Message)"
            }
            Start-Sleep -Milliseconds $delayMs
        }
    }
}

function Read-BytesWithRetry([string]$sourcePath, [int]$maxRetries = 15, [int]$delayMs = 500) {
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            [byte[]]$buf = [System.IO.File]::ReadAllBytes($sourcePath)
            return ,$buf
        } catch {
            if ($attempt -eq $maxRetries) {
                throw "读取文件失败 ($sourcePath): $($_.Exception.Message)。请确认 Antigravity 2.0 已从系统托盘完全退出且无杀毒软件锁定文件后重试。"
            }
            if ($attempt -eq 2) {
                Write-Host "[等待] 文件正被其他进程占用，正在自动重试 ($sourcePath)..." -ForegroundColor Yellow
            }
            Start-Sleep -Milliseconds $delayMs
        }
    }
}

function Write-Utf8NoBom([string]$targetPath, [string]$text) {
    $parent = Split-Path -Parent $targetPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tmp = $targetPath + ".tmp." + [Guid]::NewGuid().ToString("N")
    $enc = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($tmp, $text, $enc)
        Move-FileWithRetry $tmp $targetPath
    } finally {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-BytesAtomic([string]$targetPath, [byte[]]$data) {
    $parent = Split-Path -Parent $targetPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tmp = $targetPath + ".tmp." + [Guid]::NewGuid().ToString("N")
    try {
        [System.IO.File]::WriteAllBytes($tmp, $data)
        Move-FileWithRetry $tmp $targetPath
    } finally {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Copy-FileAtomic([string]$sourcePath, [string]$destPath) {
    $parent = Split-Path -Parent $destPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tmp = $destPath + ".tmp." + [Guid]::NewGuid().ToString("N")
    try {
        Copy-FileWithRetry $sourcePath $tmp
        Move-FileWithRetry $tmp $destPath
    } finally {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-DirWritable([string]$dirPath, [switch]$CreateIfMissing) {
    if (-not $dirPath) { return $false }
    $createdDir = $false
    try {
        if (-not (Test-Path -LiteralPath $dirPath)) {
            if (-not $CreateIfMissing) { return $false }
            New-Item -ItemType Directory -Path $dirPath -Force -ErrorAction Stop | Out-Null
            $createdDir = $true
        }
        $probe = Join-Path $dirPath (".write_probe_" + [Guid]::NewGuid().ToString("N"))
        [System.IO.File]::WriteAllText($probe, "ok")
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        if ($createdDir) {
            try { Remove-Item -LiteralPath $dirPath -Force -ErrorAction SilentlyContinue } catch {}
        }
        return $false
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

function New-AsarFileIntegrity([byte[]]$buf, [long]$blockSize = 4194304) {
    if ($blockSize -le 0) { $blockSize = 4194304 }
    $fullHash = Get-Sha256Hex $buf
    $blocksList = New-Object 'System.Collections.Generic.List[string]'
    if ($buf.Length -eq 0) {
        $blocksList.Add($fullHash)
    } else {
        for ($pos = 0L; $pos -lt $buf.Length; $pos += $blockSize) {
            $len = [int][Math]::Min($blockSize, [long]$buf.Length - $pos)
            $chunk = New-Object byte[] $len
            [Array]::Copy($buf, [int]$pos, $chunk, 0, $len)
            $blocksList.Add((Get-Sha256Hex $chunk))
        }
    }
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    $dict["algorithm"] = "SHA256"
    $dict["hash"] = $fullHash
    $dict["blockSize"] = [int]$blockSize
    $dict["blocks"] = $blocksList.ToArray()
    return ,$dict
}

function Set-AsarEntryIntegrity([System.Collections.IDictionary]$entry, [byte[]]$buf) {
    if (-not ($entry.ContainsKey("integrity") -and ($entry["integrity"] -is [System.Collections.IDictionary]))) {
        return
    }
    $oldInteg = $entry["integrity"]
    $bs = if ($oldInteg.ContainsKey("blockSize") -and [long]$oldInteg["blockSize"] -gt 0) { [long]$oldInteg["blockSize"] } else { 4194304L }
    $integObj = New-AsarFileIntegrity $buf $bs
    if ($integObj -is [PSObject]) { $integObj = $integObj.psobject.BaseObject }
    $entry["integrity"] = $integObj
}

function New-AsarJsonSerializer {
    [void][System.Reflection.Assembly]::LoadWithPartialName("System.Web.Extensions")
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $ser.RecursionLimit = 1024
    return $ser
}

function Read-AsarInfo([string]$path) {
    [byte[]]$bytes = Read-BytesWithRetry $path
    if ($bytes.Length -lt 16) {
        throw "ASAR 文件损坏或长度不足: $path"
    }
    $u0 = [BitConverter]::ToUInt32($bytes, 0)
    $u1 = [BitConverter]::ToUInt32($bytes, 4)
    $u2 = [BitConverter]::ToUInt32($bytes, 8)
    $u3 = [BitConverter]::ToUInt32($bytes, 12)
    $dataOffset = 8L + [long]$u1
    if ($u0 -ne 4 -or $dataOffset -gt $bytes.Length -or (16L + [long]$u3) -gt $dataOffset) {
        throw "ASAR Pickle 头异常: u0=$u0, u1=$u1, u2=$u2, u3=$u3"
    }
    $jsonStr = [System.Text.Encoding]::UTF8.GetString($bytes, 16, [int]$u3).TrimStart([char]0xFEFF)
    $ser = New-AsarJsonSerializer
    $hdr = $ser.DeserializeObject($jsonStr)
    if (-not ($hdr -is [System.Collections.IDictionary]) -or -not $hdr.ContainsKey("files")) {
        throw "ASAR 头 JSON 结构无效: $path"
    }
    return @{
        Bytes      = $bytes
        DataOffset = [int]$dataOffset
        JsonStr    = $jsonStr
        Hdr        = $hdr
    }
}

function Get-AsarEntry([System.Collections.IDictionary]$hdr, [string]$relPath) {
    $parts = $relPath -split '/' | Where-Object { $_ }
    $cur = $hdr
    foreach ($part in $parts) {
        if (-not ($cur -is [System.Collections.IDictionary]) -or -not $cur.ContainsKey("files")) {
            return $null
        }
        $files = $cur["files"]
        if (-not ($files -is [System.Collections.IDictionary]) -or -not $files.ContainsKey($part)) {
            return $null
        }
        $cur = $files[$part]
    }
    return $cur
}

function Update-AsarOffsets([System.Collections.IDictionary]$dirNode, [long]$afterOffset, [long]$delta) {
    if (-not $dirNode -or -not $dirNode.ContainsKey("files")) { return }
    $files = $dirNode["files"]
    if (-not ($files -is [System.Collections.IDictionary])) { return }
    foreach ($key in @($files.Keys)) {
        $item = $files[$key]
        if (-not ($item -is [System.Collections.IDictionary])) { continue }
        if ($item.ContainsKey("files") -and ($item["files"] -is [System.Collections.IDictionary])) {
            Update-AsarOffsets $item $afterOffset $delta
        } elseif ((-not $item.ContainsKey("unpacked") -or -not [bool]$item["unpacked"]) -and $item.ContainsKey("offset") -and $null -ne $item["offset"]) {
            $off = [long]$item["offset"]
            if ($off -gt $afterOffset) {
                $item["offset"] = [string]($off + $delta)
            }
        }
    }
}

function Verify-AsarHeaderAndData([string]$jsonText, [byte[]]$dataBuf, [object[]]$targets) {
    $ser = New-AsarJsonSerializer
    $parsed = $ser.DeserializeObject($jsonText)
    if (-not ($parsed -is [System.Collections.IDictionary]) -or -not $parsed.ContainsKey("files")) {
        throw "ASAR 校验失败: 新生成的头 JSON 无法解析为有效根对象"
    }

    function Check-AsarTree([System.Collections.IDictionary]$node, [string]$prefix) {
        $files = $node["files"]
        foreach ($key in @($files.Keys)) {
            $full = if ($prefix) { "$prefix/$key" } else { "$key" }
            $item = $files[$key]
            if (-not ($item -is [System.Collections.IDictionary])) {
                throw "ASAR 校验失败: 条目结构异常 ($full)"
            }
            if ($item.ContainsKey("files") -and ($item["files"] -is [System.Collections.IDictionary])) {
                Check-AsarTree $item $full
                continue
            }
            if (($item.ContainsKey("unpacked") -and [bool]$item["unpacked"]) -or $item.ContainsKey("link")) {
                continue
            }
            if (-not $item.ContainsKey("offset") -or $null -eq $item["offset"] -or -not $item.ContainsKey("size") -or $null -eq $item["size"]) {
                throw "ASAR 校验失败: 缺少 offset 或 size ($full)"
            }
            $off = [long]$item["offset"]
            $sz  = [long]$item["size"]
            if ($off -lt 0 -or $sz -lt 0 -or ($off + $sz) -gt [long]$dataBuf.Length) {
                throw "ASAR 校验失败: 条目偏移越界 ($full : offset=$off, size=$sz, dataLen=$($dataBuf.Length))"
            }
        }
    }

    Check-AsarTree $parsed ""

    foreach ($t in $targets) {
        $entry = Get-AsarEntry $parsed $t.RelPath
        if (-not $entry) {
            throw "ASAR 校验失败: 找不到目标条目 $($t.RelPath)"
        }
        $off = [long]$entry["offset"]
        $sz  = [long]$entry["size"]
        if ($sz -ne [long]$t.NewBytes.Length) {
            throw "ASAR 校验失败: $($t.RelPath) size 不匹配 ($sz != $($t.NewBytes.Length))"
        }
        $slice = New-Object byte[] ([int]$sz)
        [Array]::Copy($dataBuf, [int]$off, $slice, 0, [int]$sz)
        $actualHash = Get-Sha256Hex $slice
        $expectedHash = Get-Sha256Hex $t.NewBytes
        if ($actualHash -ne $expectedHash) {
            throw "ASAR 校验失败: $($t.RelPath) 数据载荷 SHA-256 不匹配"
        }
        if ($entry.ContainsKey("integrity") -and ($entry["integrity"] -is [System.Collections.IDictionary])) {
            $integ = $entry["integrity"]
            $bs = if ($integ.ContainsKey("blockSize") -and [long]$integ["blockSize"] -gt 0) { [long]$integ["blockSize"] } else { 4194304L }
            $expectedInteg = New-AsarFileIntegrity $slice $bs
            if ($expectedInteg -is [PSObject]) { $expectedInteg = $expectedInteg.psobject.BaseObject }
            if ([string]$integ["hash"] -ne [string]$expectedInteg["hash"]) {
                throw "ASAR 校验失败: $($t.RelPath) integrity.hash 不匹配"
            }
            $actualBlocks = @($integ["blocks"])
            $expBlocks = @($expectedInteg["blocks"])
            if ($actualBlocks.Count -ne $expBlocks.Count) {
                throw "ASAR 校验失败: $($t.RelPath) integrity.blocks 块数不匹配"
            }
            for ($bi = 0; $bi -lt $expBlocks.Count; $bi++) {
                if ([string]$actualBlocks[$bi] -ne [string]$expBlocks[$bi]) {
                    throw "ASAR 校验失败: $($t.RelPath) integrity.blocks[$bi] 哈希不匹配"
                }
            }
        }
    }
}

function Get-ElectronAsarFuseState([string]$exePath) {
    if (-not $exePath -or -not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
        return @{ Found = $false; AsarIntegrityEnabled = $false }
    }
    $sentinel = [System.Text.Encoding]::ASCII.GetBytes("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX")
    $chunkSize = 4 * 1024 * 1024
    $overlap = 128
    $fs = [System.IO.File]::Open($exePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $buf = New-Object byte[] ($chunkSize + $overlap)
        $carry = 0
        while ($true) {
            $read = $fs.Read($buf, $carry, $chunkSize)
            if ($read -le 0) { break }
            $total = $carry + $read
            $limit = $total - $sentinel.Length - 6
            for ($i = 0; $i -le $limit; $i++) {
                if ($buf[$i] -ne $sentinel[0]) { continue }
                $matched = $true
                for ($j = 1; $j -lt $sentinel.Length; $j++) {
                    if ($buf[$i + $j] -ne $sentinel[$j]) { $matched = $false; break }
                }
                if (-not $matched) { continue }
                $verPos = $i + $sentinel.Length
                $ver = [int]$buf[$verPos]
                $cnt = [int]$buf[$verPos + 1]
                if ($ver -ge 1 -and $ver -le 5 -and $cnt -ge 5 -and $cnt -le 32 -and ($verPos + 2 + $cnt) -le $total) {
                    $validChars = $true
                    $sb = New-Object System.Text.StringBuilder
                    for ($k = 0; $k -lt $cnt; $k++) {
                        $b = $buf[$verPos + 2 + $k]
                        if ($b -ne 0x30 -and $b -ne 0x31) { $validChars = $false; break }
                        [void]$sb.Append([char]$b)
                    }
                    if ($validChars) {
                        $flagsStr = $sb.ToString()
                        return @{
                            Found                = $true
                            Version              = $ver
                            Count                = $cnt
                            Flags                = $flagsStr
                            AsarIntegrityEnabled = ($flagsStr[4] -eq '1')
                        }
                    }
                }
            }
            if ($total -gt $overlap) {
                [Array]::Copy($buf, $total - $overlap, $buf, 0, $overlap)
                $carry = $overlap
            } else {
                $carry = $total
            }
        }
    } finally {
        $fs.Dispose()
    }
    return @{ Found = $false; AsarIntegrityEnabled = $false }
}

function Test-NodeJsSyntax([string]$ipcCode, [string]$preCode) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { return }
    $tmpDir = [System.IO.Path]::GetTempPath()
    $uid = [Guid]::NewGuid().ToString("N")
    $chkTmp = Join-Path $tmpDir ("agy_chk_" + $uid + ".js")
    $ipcTmp = Join-Path $tmpDir ("agy_chk_ipc_" + $uid + ".js")
    $preTmp = Join-Path $tmpDir ("agy_chk_pre_" + $uid + ".js")
    try {
        $enc = New-Object System.Text.UTF8Encoding($false)
        $chkJs = "const fs = require('fs'), vm = require('vm');`nfor (const [p, n] of [[process.argv[2], 'dist/ipcHandlers.js'], [process.argv[3], 'dist/preload.js']]) {`n  new vm.Script(fs.readFileSync(p, 'utf8'), { filename: n });`n}`n"
        [System.IO.File]::WriteAllText($chkTmp, $chkJs, $enc)
        [System.IO.File]::WriteAllText($ipcTmp, $ipcCode, $enc)
        [System.IO.File]::WriteAllText($preTmp, $preCode, $enc)
        $errOut = & $nodeCmd.Source $chkTmp $ipcTmp $preTmp 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Node vm.Script 语法预校验失败，已中止写入 app.asar: $($errOut -join ' ')"
        }
    } finally {
        foreach ($f in @($chkTmp, $ipcTmp, $preTmp)) {
            if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Test-NodeVersionReady {
    try {
        $out = & cmd.exe /d /c "node -v 2>nul"
        if ($LASTEXITCODE -ne 0 -or -not $out) {
            return @{ Ready = $false; Version = ""; Major = 0; Reason = "未检测到 node 命令 (cmd.exe /c node -v 失败)" }
        }
        $verStr = (($out | Select-Object -First 1) + "").Trim()
        if ($verStr -match '^v?(\d+)\.') {
            $major = [int]$matches[1]
            if ($major -ge 18) {
                return @{ Ready = $true; Version = $verStr; Major = $major; Reason = "" }
            }
            return @{ Ready = $false; Version = $verStr; Major = $major; Reason = "Node.js 版本过低 ($verStr < v18)" }
        }
        return @{ Ready = $false; Version = $verStr; Major = 0; Reason = "无法识别 Node.js 版本输出: $verStr" }
    } catch {
        return @{ Ready = $false; Version = ""; Major = 0; Reason = $_.Exception.Message }
    }
}

function Resolve-SpaceFreeCliScriptPath([string]$cliHome) {
    $direct = Join-Path $cliHome "agy-statusline.js"
    if (($direct -notmatch '\s') -and (Test-DirWritable $cliHome -CreateIfMissing)) {
        return $direct
    }
    try {
        if (-not (Test-Path -LiteralPath $cliHome)) {
            New-Item -ItemType Directory -Path $cliHome -Force -ErrorAction SilentlyContinue | Out-Null
        }
        if (Test-Path -LiteralPath $cliHome) {
            $fso = New-Object -ComObject Scripting.FileSystemObject
            $shortDir = $fso.GetFolder($cliHome).ShortPath
            if ($shortDir -and ($shortDir -notmatch '\s') -and (Test-DirWritable $shortDir)) {
                return (Join-Path $shortDir "agy-statusline.js")
            }
        }
    } catch {}

    $fallbacks = New-Object System.Collections.ArrayList
    if ($env:ProgramData) {
        [void]$fallbacks.Add((Join-Path $env:ProgramData "antigravity-telemetry"))
    }
    if ($env:PUBLIC) {
        [void]$fallbacks.Add((Join-Path $env:PUBLIC "antigravity-telemetry"))
    }
    if ($env:SystemDrive) {
        [void]$fallbacks.Add((Join-Path ($env:SystemDrive + "\") "antigravity-telemetry"))
    }
    foreach ($dir in $fallbacks) {
        if ($dir -and ($dir -notmatch '\s') -and (Test-DirWritable $dir -CreateIfMissing)) {
            return (Join-Path $dir "agy-statusline.js")
        }
    }
    throw "无法找到不含空格的可写目录以部署 CLI 状态栏脚本 (请检查 %ProgramData% 或 %PUBLIC% 写入权限)。"
}

function Resolve-CommandTargetPath([string]$cmdStr) {
    if (-not $cmdStr) { return "" }
    $trimmed = $cmdStr.Trim()
    if ($trimmed -match '^"?(?:[^"\s]*[/\\])?node(?:\.exe)?"?\s+"([^"]+\.js)"(?:\s|$)') {
        return ($matches[1] -replace '/', '\')
    }
    if ($trimmed -match '^"?(?:[^"\s]*[/\\])?node(?:\.exe)?"?\s+([^\s"]+\.js)(?:\s|$)') {
        return ($matches[1] -replace '/', '\')
    }
    return ""
}

function Read-HttpResponseUtf8Text($resp) {
    if (-not $resp) { return $null }
    if ($resp.RawContentStream) {
        $ms = New-Object System.IO.MemoryStream
        try {
            if ($resp.RawContentStream.CanSeek) {
                $resp.RawContentStream.Position = 0
            }
            $resp.RawContentStream.CopyTo($ms)
            $rawBytes = $ms.ToArray()
            if ($rawBytes -and $rawBytes.Length -gt 0) {
                return [System.Text.Encoding]::UTF8.GetString($rawBytes).TrimStart([char]0xFEFF)
            }
        } finally {
            $ms.Dispose()
        }
    }
    $content = $resp.Content
    if ($content -is [byte[]]) {
        return [System.Text.Encoding]::UTF8.GetString($content).TrimStart([char]0xFEFF)
    } elseif ($content) {
        return ([string]$content).TrimStart([char]0xFEFF)
    }
    return $null
}

function Test-ModResourceContent([string]$fileName, [string]$text) {
    if (-not $text) { return $false }
    $trimmed = $text.Trim()
    if ($trimmed.Length -lt 500) { return $false }
    if ($trimmed -match "(?is)^(?:<!doctype|<html|<head|<\?xml)") { return $false }
    switch ($fileName) {
        "ipc-block.js" {
            return ($text.Contains("TELEMETRY_MOD_IPC_START") -and $text.Contains("TELEMETRY_MOD_IPC_END"))
        }
        "preload-part1.js" {
            return ($text.Contains("TELEMETRY_MOD_PRELOAD_START") -and $text.Contains("installTelemetryBar"))
        }
        "preload-part2.js" {
            return $text.Contains("refreshActivityModal")
        }
        "preload-part3.js" {
            return $text.Contains("TELEMETRY_MOD_PRELOAD_END")
        }
        "agy-statusline.js" {
            return ($trimmed.StartsWith("#!/usr/bin/env node") -and $text.Contains("TELEMETRY_MOD_CLI_STATUSLINE"))
        }
        default {
            return $true
        }
    }
}

function Resolve-ModRemoteRef {
    if ($script:ModRefInitialized) {
        return @{ Ref = $script:ResolvedModRef; IsImmutable = $script:ResolvedModIsImmutable }
    }
    $script:ModRefInitialized = $true
    $script:ResolvedModRef = "main"
    $script:ResolvedModIsImmutable = $false

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}

    if ($env:ANTIGRAVITY_MOD_REF -and $env:ANTIGRAVITY_MOD_REF.Trim()) {
        $overrideRef = $env:ANTIGRAVITY_MOD_REF.Trim()
        if ($overrideRef -notmatch "^[A-Za-z0-9._/-]+$" -or $overrideRef.Contains("..")) {
            throw "无效的 ANTIGRAVITY_MOD_REF 值: '$overrideRef'"
        }
        $script:ResolvedModRef = $overrideRef
        $script:ResolvedModIsImmutable = ($overrideRef -match "^[0-9a-fA-F]{40}$")
        Write-Host "[在线] 使用指定模块引用: $($script:ResolvedModRef)" -ForegroundColor DarkCyan
        return @{ Ref = $script:ResolvedModRef; IsImmutable = $script:ResolvedModIsImmutable }
    }

    $apiUrl = "https://api.github.com/repos/Hsanli060/antigravity-token-pulse/commits/main"
    try {
        $resp = Invoke-WebRequest -Uri $apiUrl -UseBasicParsing -TimeoutSec 5 -UserAgent "Antigravity-Telemetry-Installer" -Headers @{
            "Accept"        = "application/vnd.github.sha"
            "Cache-Control" = "no-cache"
            "Pragma"        = "no-cache"
        }
        $shaText = Read-HttpResponseUtf8Text $resp
        if ($shaText) { $shaText = $shaText.Trim() }
        if ($shaText -and $shaText -match "^[0-9a-fA-F]{40}$") {
            $script:ResolvedModRef = $shaText.ToLowerInvariant()
            $script:ResolvedModIsImmutable = $true
            Write-Host "[在线] 已解析最新 main 提交 SHA: $($script:ResolvedModRef.Substring(0, 8))" -ForegroundColor DarkCyan
            return @{ Ref = $script:ResolvedModRef; IsImmutable = $script:ResolvedModIsImmutable }
        }
    } catch {}

    Write-Host "[在线] GitHub API SHA 解析未命中，回退使用 main（优先直连 raw.githubusercontent.com）" -ForegroundColor DarkYellow
    return @{ Ref = $script:ResolvedModRef; IsImmutable = $script:ResolvedModIsImmutable }
}

function Get-ModResource([string]$fileName) {
    $batDir = if ($env:SELF_BAT) { Split-Path -Parent $env:SELF_BAT } else { (Get-Location).Path }
    $localSrc = Join-Path (Join-Path $batDir "src") $fileName
    if (Test-Path -LiteralPath $localSrc) {
        return ((Read-Utf8NoBom $localSrc) -replace "\r\n", "`n").TrimEnd()
    }

    $geminiRoot = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".gemini" } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA ".gemini" } else { [System.IO.Path]::GetTempPath() }
    $cacheDir = Join-Path (Join-Path $geminiRoot "telemetry-mod-cache") "src"
    $cachePath = Join-Path $cacheDir $fileName

    $refInfo = Resolve-ModRemoteRef
    $ref = $refInfo.Ref
    if ($refInfo.IsImmutable) {
        $shortRef = $ref.Substring(0, 8)
        $sources = @(
            @{ Url = "https://raw.githubusercontent.com/Hsanli060/antigravity-token-pulse/$ref/src/$fileName"; Label = "raw.githubusercontent.com@$shortRef" },
            @{ Url = "https://cdn.jsdelivr.net/gh/Hsanli060/antigravity-token-pulse@$ref/src/$fileName"; Label = "cdn.jsdelivr.net@$shortRef" },
            @{ Url = "https://fastly.jsdelivr.net/gh/Hsanli060/antigravity-token-pulse@$ref/src/$fileName"; Label = "fastly.jsdelivr.net@$shortRef" }
        )
    } else {
        $sources = @(
            @{ Url = "https://raw.githubusercontent.com/Hsanli060/antigravity-token-pulse/$ref/src/$fileName"; Label = "raw.githubusercontent.com/$ref" },
            @{ Url = "https://fastly.jsdelivr.net/gh/Hsanli060/antigravity-token-pulse@$ref/src/$fileName"; Label = "fastly.jsdelivr.net@$ref" },
            @{ Url = "https://cdn.jsdelivr.net/gh/Hsanli060/antigravity-token-pulse@$ref/src/$fileName"; Label = "cdn.jsdelivr.net@$ref" }
        )
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}

    foreach ($srcItem in $sources) {
        try {
            $resp = Invoke-WebRequest -Uri $srcItem.Url -UseBasicParsing -TimeoutSec 15 -UserAgent "Antigravity-Telemetry-Installer" -Headers @{
                "Cache-Control" = "no-cache"
                "Pragma"        = "no-cache"
            }
            $text = Read-HttpResponseUtf8Text $resp
            if (-not (Test-ModResourceContent $fileName $text)) {
                Write-Host "[重试] $($srcItem.Label) 返回的 $fileName 内容校验未通过，切换下一个源..." -ForegroundColor Yellow
                continue
            }
            $normalized = ($text -replace "\r\n", "`n").TrimEnd()
            if (-not (Test-Path -LiteralPath $cacheDir)) {
                New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
            }
            Write-Utf8NoBom $cachePath ($normalized + "`n")
            Write-Host "[在线] 已加载 $fileName <- $($srcItem.Label)" -ForegroundColor DarkGray
            return $normalized
        } catch {}
    }

    if (Test-Path -LiteralPath $cachePath) {
        $cached = ((Read-Utf8NoBom $cachePath) -replace "\r\n", "`n").TrimEnd()
        if (Test-ModResourceContent $fileName $cached) {
            Write-Host "[缓存] 网络不可用或校验未通过，已使用本地缓存模块: $fileName" -ForegroundColor Yellow
            return $cached
        }
    }

    throw "无法加载模块 $fileName ：未找到本地 src/$fileName 且在线镜像下载/校验均失败。建议直接下载仓库 ZIP 压缩包后离线运行。"
}

function Split-TrailingSourceMap([string]$code) {
    $m = [regex]::Match($code, "(?:^|\r?\n)([ \t]*//[#@]\s*sourceMappingURL=[^\r\n]*\s*)$")
    if (-not $m.Success) {
        return @{ Prefix = $code.TrimEnd(); SourceMapTail = "" }
    }
    return @{
        Prefix        = $code.Substring(0, $m.Index).TrimEnd()
        SourceMapTail = $m.Groups[1].Value.Trim()
    }
}

function Strip-TelemetryIpcBlock([string]$code) {
    $out = $code.TrimStart([char]0xFEFF)
    $out = [regex]::Replace(
        $out,
        "[ \t]*//\s*===\s*TELEMETRY_MOD_IPC_START\s*===[\s\S]*?(?://\s*===\s*TELEMETRY_MOD_IPC_END\s*===[ \t]*(?:\r?\n)?)+",
        ""
    )
    $out = [regex]::Replace($out, "(?m)^[ \t]*//\s*===\s*TELEMETRY_MOD_IPC_(?:START|END)\s*===[ \t]*\r?\n?", "")
    return $out
}

function Strip-TelemetryPreloadBlock([string]$code) {
    $out = $code.TrimStart([char]0xFEFF)
    $out = [regex]::Replace(
        $out,
        "[ \t]*//\s*===\s*TELEMETRY_MOD_PRELOAD_START\s*===[\s\S]*?(?://\s*===\s*TELEMETRY_MOD_PRELOAD_END\s*===[ \t]*(?:\r?\n)?)+",
        ""
    )
    $out = [regex]::Replace($out, "(?m)^[ \t]*//\s*===\s*TELEMETRY_MOD_PRELOAD_(?:START|END)\s*===[ \t]*\r?\n?", "")
    $legacyMatch = [regex]::Match($out, "(?m)^[ \t]*function installTelemetryBar\s*\(\)")
    if ($legacyMatch.Success) {
        $tail = $out.Substring($legacyMatch.Index)
        $sm = [regex]::Match($tail, "(\r?\n[ \t]*//[#@]\s*sourceMappingURL=[^\r\n]*\s*)$")
        $before = $out.Substring(0, $legacyMatch.Index).TrimEnd()
        if ($sm.Success) {
            $prefixPart = if ($before) { $before + "`n" } else { "" }
            $out = $prefixPart + $sm.Groups[1].Value.Trim() + "`n"
        } else {
            $out = if ($before) { $before + "`n" } else { "" }
        }
    }
    return $out
}

function Apply-TelemetryIpcBlock([string]$rawCode, [string]$ipcBlock) {
    $code = Strip-TelemetryIpcBlock $rawCode
    $trimmedBlock = ($ipcBlock -replace "\r\n", "`n").Trim()
    if (-not ($trimmedBlock.Contains("TELEMETRY_MOD_IPC_START") -and $trimmedBlock.Contains("TELEMETRY_MOD_IPC_END"))) {
        $trimmedBlock = "// === TELEMETRY_MOD_IPC_START ===`n{`n" + $trimmedBlock + "`n}`n// === TELEMETRY_MOD_IPC_END ==="
    }

    $wcvMatches = [regex]::Matches($code, "(?m)^[ \t]*(?:\(0,\s*[\w$]+\.registerWcvIpcHandlers\)|[\w$.]*registerWcvIpcHandlers)\s*\(")
    if ($wcvMatches.Count -gt 0) {
        $last = $wcvMatches[$wcvMatches.Count - 1]
        return $code.Substring(0, $last.Index) + $trimmedBlock + "`n" + $code.Substring($last.Index)
    }

    $parts = Split-TrailingSourceMap $code
    $head = if ($parts.Prefix) { $parts.Prefix + "`n" } else { "" }
    $tail = if ($parts.SourceMapTail) { $parts.SourceMapTail + "`n" } else { "" }
    return $head + $trimmedBlock + "`n" + $tail
}

function Apply-TelemetryPreloadBlock([string]$rawCode, [string]$preloadBlock) {
    $code = Strip-TelemetryPreloadBlock $rawCode
    $trimmedBlock = ($preloadBlock -replace "\r\n", "`n").Trim()
    $parts = Split-TrailingSourceMap $code
    $head = if ($parts.Prefix) { $parts.Prefix + "`n" } else { "" }
    $tail = if ($parts.SourceMapTail) { $parts.SourceMapTail + "`n" } else { "" }
    return $head + $trimmedBlock + "`n" + $tail
}

function Extract-ExeDirFromRegistryString([string]$rawVal) {
    if (-not $rawVal) { return "" }
    $s = $rawVal.Trim()
    if ($s -match '^"([^"]+?\.exe)"') {
        return (Split-Path -Parent $matches[1])
    }
    $sNoIcon = ($s -replace ',\s*-?\d+$', '').Trim().Trim('"')
    if ($sNoIcon -match '^(.+?\.exe)(?:\s|$)') {
        return (Split-Path -Parent $matches[1])
    }
    return ""
}

function Show-IdeDistinctionNotice([string[]]$ideDirs) {
    Write-Host ""
    Write-Host "[说明] 检测到本机安装的是 Antigravity IDE (VS Code 内核，目录为 resources\app\)，" -ForegroundColor Yellow
    Write-Host "       而非 Antigravity 2.0 桌面端 (独立 Electron 客户端，包含 resources\app.asar)。" -ForegroundColor Yellow
    if ($ideDirs -and $ideDirs.Count -gt 0) {
        Write-Host "       已发现的 Antigravity IDE 目录: $($ideDirs -join '; ')" -ForegroundColor DarkYellow
    }
    Write-Host "       本桌面端 ASAR 注入仅适用于 Antigravity 2.0；若你同时使用 agy CLI，脚本将继续检查 CLI 状态栏配置。" -ForegroundColor Yellow
}

function Invoke-InstallerMain {
    Write-Host "=============================================================" -ForegroundColor Cyan
    Write-Host "  Antigravity 2.0 & CLI 遥测栏 + Token 活动热力图 安装器" -ForegroundColor Cyan
    Write-Host "  - 实时遥测条: 速率(t/s) | 上下文环形图(/ 1M) | 缓存命中率 | 累计消耗" -ForegroundColor DarkCyan
    Write-Host "  - 交互热力图: 点击遥测条展开 Daily / Weekly / Monthly 面板" -ForegroundColor DarkCyan
    Write-Host "  - CLI 同步  : 自动配置 agy statusLine 并共享 Token 账本缓存" -ForegroundColor DarkCyan
    Write-Host "=============================================================" -ForegroundColor Cyan
    Write-Host ""

    $modeEnv = ""
    if ($env:ANTIGRAVITY_INSTALLER_MODE) {
        $modeEnv = $env:ANTIGRAVITY_INSTALLER_MODE.Trim().ToLowerInvariant()
        if ($modeEnv -ne "install" -and $modeEnv -ne "restore") {
            throw "无效的 ANTIGRAVITY_INSTALLER_MODE: '$modeEnv' (仅支持 install 或 restore)"
        }
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
$detectedIdeDirs = New-Object System.Collections.Generic.List[string]
$seenInstallDirs = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

if ($env:ANTIGRAVITY_ASAR_PATH -and $env:ANTIGRAVITY_ASAR_PATH.Trim()) {
    $envTarget = $env:ANTIGRAVITY_ASAR_PATH.Trim().Trim('"')
    if (Test-Path -LiteralPath $envTarget -PathType Container) {
        $asarFromRes = Join-Path $envTarget "resources\app.asar"
        $asarDirect = Join-Path $envTarget "app.asar"
        $ideAppDir = Join-Path $envTarget "resources\app"
        if (Test-Path -LiteralPath $asarFromRes -PathType Leaf) {
            $asarPath = (Resolve-Path -LiteralPath $asarFromRes).Path
        } elseif (Test-Path -LiteralPath $asarDirect -PathType Leaf) {
            $asarPath = (Resolve-Path -LiteralPath $asarDirect).Path
        } elseif (Test-Path -LiteralPath $ideAppDir -PathType Container) {
            Show-IdeDistinctionNotice @($envTarget)
            throw "ANTIGRAVITY_ASAR_PATH 指向的是 Antigravity IDE 目录（无 app.asar）: $envTarget"
        } else {
            throw "指定的 ANTIGRAVITY_ASAR_PATH 目录中未找到 app.asar: $envTarget"
        }
    } elseif (Test-Path -LiteralPath $envTarget -PathType Leaf) {
        $asarPath = (Resolve-Path -LiteralPath $envTarget).Path
    } else {
        throw "指定的 ANTIGRAVITY_ASAR_PATH 不存在: $envTarget"
    }
} else {
    $orderedDirs = New-Object System.Collections.Generic.List[string]
    $addOrdered = {
        param([string]$d)
        if (-not $d) { return }
        $clean = $d.Trim().Trim('"').TrimEnd('\')
        if (-not $clean) { return }
        try { $clean = [System.IO.Path]::GetFullPath($clean) } catch {}
        if ($seenInstallDirs.Add($clean)) {
            [void]$orderedDirs.Add($clean)
        }
    }

    # (a) 运行中进程路径
    $runningProcs = @(Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue)
    foreach ($rp in $runningProcs) {
        try {
            if ($rp.Path) { & $addOrdered (Split-Path -Parent $rp.Path) }
        } catch {}
    }

    # (b) Registry Uninstall (HKCU / HKLM / WOW6432Node)
    $regRoots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($regPath in $regRoots) {
        $items = @(Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue)
        foreach ($item in $items) {
            $dn = [string]$item.DisplayName
            $il = [string]$item.InstallLocation
            $di = [string]$item.DisplayIcon
            $us = [string]$item.UninstallString
            if ($dn -match 'Antigravity' -or $il -match 'Antigravity' -or $di -match 'Antigravity' -or $us -match 'Antigravity') {
                if ($il) { & $addOrdered $il }
                if ($di) { & $addOrdered (Extract-ExeDirFromRegistryString $di) }
                if ($us) { & $addOrdered (Extract-ExeDirFromRegistryString $us) }
            }
        }
    }

    # (c) 常见默认安装目录
    if ($env:LOCALAPPDATA) {
        & $addOrdered (Join-Path $env:LOCALAPPDATA "Programs\Antigravity")
        & $addOrdered (Join-Path $env:LOCALAPPDATA "Antigravity")
        & $addOrdered (Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE")
    }
    if ($env:ProgramFiles) {
        & $addOrdered (Join-Path $env:ProgramFiles "Antigravity")
        & $addOrdered (Join-Path $env:ProgramFiles "Antigravity IDE")
    }
    if (${env:ProgramFiles(x86)}) {
        & $addOrdered (Join-Path ${env:ProgramFiles(x86)} "Antigravity")
        & $addOrdered (Join-Path ${env:ProgramFiles(x86)} "Antigravity IDE")
    }

    foreach ($dir in $orderedDirs) {
        $candAsar = Join-Path $dir "resources\app.asar"
        $candIdeApp = Join-Path $dir "resources\app"
        if (Test-Path -LiteralPath $candAsar -PathType Leaf) {
            if (-not $asarPath) {
                $asarPath = (Resolve-Path -LiteralPath $candAsar).Path
            }
        } elseif (Test-Path -LiteralPath $candIdeApp -PathType Container) {
            [void]$detectedIdeDirs.Add($dir)
        }
    }
}

$cliHome = if ($env:ANTIGRAVITY_CLI_HOME -and $env:ANTIGRAVITY_CLI_HOME.Trim()) {
    $env:ANTIGRAVITY_CLI_HOME.Trim().Trim('"')
} else {
    Join-Path $env:USERPROFILE ".gemini\antigravity-cli"
}
$hasCli = [bool]($env:ANTIGRAVITY_CLI_HOME -and $env:ANTIGRAVITY_CLI_HOME.Trim()) -or (Test-Path -LiteralPath $cliHome) -or [bool](Get-Command agy -ErrorAction SilentlyContinue)

if (-not $asarPath) {
    Write-Host "[提示] 未自动扫描到 Antigravity 2.0 桌面端 app.asar。" -ForegroundColor Yellow
    if ($detectedIdeDirs.Count -gt 0) {
        Show-IdeDistinctionNotice $detectedIdeDirs.ToArray()
    }
    if ($modeEnv) {
        Write-Host "[跳过] 无交互模式跳过桌面端，继续检查/配置 CLI 状态栏。" -ForegroundColor Yellow
    } else {
        $manual = Read-Host "请输入 Antigravity 2.0 安装目录或 app.asar 路径 (直接回车则跳过桌面端，仅配置 CLI)"
        if ($manual) {
            $manualClean = $manual.Trim().Trim('"')
            if (Test-Path -LiteralPath $manualClean -PathType Container) {
                $candRes = Join-Path $manualClean "resources\app.asar"
                $candDirect = Join-Path $manualClean "app.asar"
                $candIde = Join-Path $manualClean "resources\app"
                if (Test-Path -LiteralPath $candRes -PathType Leaf) {
                    $asarPath = (Resolve-Path -LiteralPath $candRes).Path
                } elseif (Test-Path -LiteralPath $candDirect -PathType Leaf) {
                    $asarPath = (Resolve-Path -LiteralPath $candDirect).Path
                } elseif (Test-Path -LiteralPath $candIde -PathType Container) {
                    Show-IdeDistinctionNotice @($manualClean)
                } else {
                    Write-Host "[警告] 指定目录中未找到 resources\app.asar: $manualClean ，已跳过桌面端并继续配置 CLI。" -ForegroundColor Yellow
                }
            } elseif (Test-Path -LiteralPath $manualClean -PathType Leaf) {
                $asarPath = (Resolve-Path -LiteralPath $manualClean).Path
            } else {
                Write-Host "[警告] 未找到指定的 app.asar: $manualClean ，已跳过桌面端并继续配置 CLI。" -ForegroundColor Yellow
            }
        }
    }
}

$actionMode = if ($modeEnv -eq "restore") { "restore" } else { "install" }
$wasRunning = $false
$exePath = ""
$skipAsarDueToFuse = $false

if ($asarPath) {
    Write-Host "[1/3] 找到桌面端目标文件: $asarPath" -ForegroundColor Gray
    $resourcesDir = Split-Path -Parent $asarPath
    if (-not (Test-DirWritable $resourcesDir)) {
        throw "没有目录写入权限 ($resourcesDir)。请右键本脚本 -> 「以管理员身份运行」后重试。"
    }

    $bakPath = $asarPath + ".bak"
    $exePath = Join-Path (Split-Path -Parent $resourcesDir) "Antigravity.exe"

    $info = Read-AsarInfo $asarPath
    $distEntry = Get-AsarEntry $info.Hdr "dist"
    $ipcNodeCheck = Get-AsarEntry $info.Hdr "dist/ipcHandlers.js"
    $preNodeCheck = Get-AsarEntry $info.Hdr "dist/preload.js"
    if (-not $distEntry -or -not $ipcNodeCheck -or -not $preNodeCheck) {
        throw "目标 app.asar 结构不匹配 (缺少 dist/ipcHandlers.js 或 dist/preload.js)"
    }
    if (($ipcNodeCheck.ContainsKey("unpacked") -and [bool]$ipcNodeCheck["unpacked"]) -or
        ($preNodeCheck.ContainsKey("unpacked") -and [bool]$preNodeCheck["unpacked"]) -or
        -not $ipcNodeCheck.ContainsKey("offset") -or -not $preNodeCheck.ContainsKey("offset")) {
        throw "目标 app.asar 中的 dist/ipcHandlers.js 或 dist/preload.js 为 unpacked 或缺少 offset。"
    }

    $ipcOffCheck = [long]$ipcNodeCheck["offset"]
    $ipcSizeCheck = [int]$ipcNodeCheck["size"]
    $preOffCheck = [long]$preNodeCheck["offset"]
    $preSizeCheck = [int]$preNodeCheck["size"]
    if ($info.DataOffset + $ipcOffCheck + $ipcSizeCheck -gt $info.Bytes.Length -or
        $info.DataOffset + $preOffCheck + $preSizeCheck -gt $info.Bytes.Length) {
        throw "目标 app.asar 条目偏移越界，文件可能已损坏。"
    }

    $ipcSample = [System.Text.Encoding]::UTF8.GetString($info.Bytes, $info.DataOffset + [int]$ipcOffCheck, $ipcSizeCheck)
    $preSample = [System.Text.Encoding]::UTF8.GetString($info.Bytes, $info.DataOffset + [int]$preOffCheck, $preSizeCheck)

    $alreadyPatched = $ipcSample.Contains("TELEMETRY_MOD_IPC_START") -or
                      $preSample.Contains("TELEMETRY_MOD_PRELOAD_START") -or
                      $preSample.Contains("function installTelemetryBar()")

    if ($alreadyPatched) {
        Write-Host ""
        Write-Host "[检测] 当前 Antigravity 2.0 已包含遥测补丁。" -ForegroundColor Cyan
        $choice = if ($modeEnv) {
            if ($modeEnv -eq "restore") { "2" } else { "1" }
        } else {
            Write-Host "  [1] 重新安装 / 升级到最新版遥测栏 + 热力图 (默认)" -ForegroundColor White
            Write-Host "  [2] 恢复官方原版 app.asar 并移除扩展" -ForegroundColor Yellow
            Read-Host "请选择 [1/2] (直接回车执行 1)"
        }
        if ($choice -and $choice.Trim() -eq "2") {
            $actionMode = "restore"
        }
    }

    if ($actionMode -eq "install" -and $env:ANTIGRAVITY_IGNORE_FUSE_CHECK -ne "1") {
        $fuseState = Get-ElectronAsarFuseState $exePath
        if ($fuseState.Found -and $fuseState.AsarIntegrityEnabled) {
            Write-Host ""
            Write-Host "[警告] 检测到 Antigravity.exe 已启用 Electron Fuse EnableEmbeddedAsarIntegrityValidation (fuse[4]=1)。" -ForegroundColor Red
            Write-Host "       在此模式下修改 app.asar 将导致桌面端无法通过完整性校验并拒绝启动，已安全阻止桌面端注入。" -ForegroundColor Red
            Write-Host "       (如需强制跳过检查，可设置环境变量 ANTIGRAVITY_IGNORE_FUSE_CHECK=1 后重试)" -ForegroundColor DarkYellow
            $skipAsarDueToFuse = $true
        }
    }

    $needModifyAsar = (-not $skipAsarDueToFuse) -and (
        ($actionMode -eq "install") -or
        ($actionMode -eq "restore" -and ($alreadyPatched -or (Test-Path -LiteralPath $bakPath)))
    )

    if ($needModifyAsar -and (-not $env:ANTIGRAVITY_ASAR_PATH)) {
        $currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        $installRootDir = (Split-Path -Parent $resourcesDir).TrimEnd('\') + '\'
        $findTargetProcs = {
            @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
                if ($_.SessionId -ne $currentSessionId) { return $false }
                if ($_.ProcessName -eq "Antigravity") { return $true }
                try {
                    if ($_.Path -and $_.Path.StartsWith($installRootDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                        return $true
                    }
                } catch {}
                return $false
            })
        }

        $procs = & $findTargetProcs
        if ($procs.Count -gt 0) {
            $wasRunning = $true
            foreach ($p in $procs) {
                try {
                    if ($p.ProcessName -eq "Antigravity" -and $p.Path) { $exePath = $p.Path; break }
                } catch {}
            }
            Write-Host "[关闭] 正在临时关闭当前会话中的 Antigravity 2.0 及其子进程以解除文件占用..." -ForegroundColor Yellow
            for ($attempt = 1; $attempt -le 5; $attempt++) {
                $procs = & $findTargetProcs
                if ($procs.Count -eq 0) { break }
                try {
                    $procs | Stop-Process -Force -ErrorAction Stop
                } catch {
                    $msg = $_.Exception.Message
                    if ($_.Exception -is [System.UnauthorizedAccessException] -or $msg -match 'Access is denied|拒绝访问') {
                        throw "无法关闭正在运行的 Antigravity 2.0 进程（拒绝访问 / 权限不足）。请先手动完全退出 Antigravity 2.0，或右键本脚本「以管理员身份运行」后重试。"
                    }
                    if ($attempt -eq 5) {
                        throw "关闭 Antigravity 2.0 进程失败: $msg 。请先手动退出客户端后重试。"
                    }
                }
                $pids = @($procs | ForEach-Object { $_.Id })
                if ($pids.Count -gt 0) {
                    Wait-Process -Id $pids -Timeout 10 -ErrorAction SilentlyContinue
                }
                Start-Sleep -Milliseconds 500
            }
            $leftover = & $findTargetProcs
            if ($leftover.Count -gt 0) {
                throw "Antigravity 2.0 进程未能在预期时间内退出，请手动从系统托盘完全退出后重试。"
            }
        }
    }

    if ($needModifyAsar) {
        # 等待子进程/杀软释放文件写入锁（最多 15 次 × 500ms）
        for ($w = 0; $w -lt 15; $w++) {
            try {
                $testFs = [System.IO.File]::Open($asarPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
                $testFs.Dispose()
                break
            } catch {
                if ($w -eq 14) {
                    throw "目标文件被占用且无法获得写入锁: $asarPath 。请先关闭 Antigravity 2.0 后重试。"
                }
                Start-Sleep -Milliseconds 500
            }
        }
    }

    if ($skipAsarDueToFuse) {
        Write-Host "[跳过] 因 Electron ASAR 完整性校验熔断位已启用，跳过修改桌面端 app.asar。" -ForegroundColor Yellow
    } elseif ($actionMode -eq "restore") {
        if (Test-Path -LiteralPath $bakPath -PathType Leaf) {
            [void](Read-AsarInfo $bakPath)
            Copy-FileAtomic $bakPath $asarPath
            Write-Host "[OK] 已从备份恢复官方原版 app.asar！" -ForegroundColor Green
        } elseif ($alreadyPatched) {
            Write-Host "[恢复] 未找到 app.asar.bak，正在内存中安全剥离遥测注入块..." -ForegroundColor Yellow
            $asarBytes = $info.Bytes
            $dataOffset = $info.DataOffset
            $hdrObj = $info.Hdr

            $cleanIpc = Strip-TelemetryIpcBlock $ipcSample
            $cleanPre = Strip-TelemetryPreloadBlock $preSample
            Test-NodeJsSyntax $cleanIpc $cleanPre

            $targets = @(
                @{ RelPath = "dist/ipcHandlers.js"; OldOff = $ipcOffCheck; OldSize = $ipcSizeCheck; NewBytes = [System.Text.Encoding]::UTF8.GetBytes($cleanIpc) },
                @{ RelPath = "dist/preload.js";     OldOff = $preOffCheck; OldSize = $preSizeCheck; NewBytes = [System.Text.Encoding]::UTF8.GetBytes($cleanPre) }
            ) | Sort-Object { $_.OldOff } -Descending

            $dataLen = $asarBytes.Length - $dataOffset
            $curData = New-Object byte[] $dataLen
            [Array]::Copy($asarBytes, $dataOffset, $curData, 0, $dataLen)

            foreach ($t in $targets) {
                $entry = Get-AsarEntry $hdrObj $t.RelPath
                $delta = [long]$t.NewBytes.Length - [long]$t.OldSize
                if ($delta -ne 0) { Update-AsarOffsets $hdrObj $t.OldOff $delta }
                $entry["size"] = [int]$t.NewBytes.Length
                Set-AsarEntryIntegrity $entry $t.NewBytes
                $ms = New-Object System.IO.MemoryStream
                try {
                    if ($t.OldOff -gt 0) { $ms.Write($curData, 0, [int]$t.OldOff) }
                    $ms.Write($t.NewBytes, 0, $t.NewBytes.Length)
                    $tailOff = [int]$t.OldOff + $t.OldSize
                    $tailLen = $curData.Length - $tailOff
                    if ($tailLen -gt 0) { $ms.Write($curData, $tailOff, $tailLen) }
                    $curData = $ms.ToArray()
                } finally {
                    $ms.Dispose()
                }
            }

            $ser = New-AsarJsonSerializer
            $newJsonStr = $ser.Serialize($hdrObj)
            Verify-AsarHeaderAndData $newJsonStr $curData $targets

            $newJsonBytes = [System.Text.Encoding]::UTF8.GetBytes($newJsonStr)
            $newU3 = [uint32]$newJsonBytes.Length
            $alignedJsonLen = [int]([Math]::Ceiling($newJsonBytes.Length / 4.0) * 4)
            $paddingLen = $alignedJsonLen - $newJsonBytes.Length
            $newU2 = [uint32](4 + $alignedJsonLen)
            $newU1 = [uint32](4 + $newU2)
            $newU0 = [uint32]4

            $outAsarTmp = $asarPath + ".tmp." + [Guid]::NewGuid().ToString("N")
            $fsOut = [System.IO.File]::Open($outAsarTmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
            try {
                $bw = New-Object System.IO.BinaryWriter($fsOut)
                $bw.Write($newU0)
                $bw.Write($newU1)
                $bw.Write($newU2)
                $bw.Write($newU3)
                $bw.Write($newJsonBytes)
                if ($paddingLen -gt 0) { $bw.Write((New-Object byte[] $paddingLen)) }
                $bw.Write($curData)
                $bw.Flush()
            } finally {
                $fsOut.Dispose()
            }
            try {
                Move-FileWithRetry $outAsarTmp $asarPath
            } finally {
                if (Test-Path -LiteralPath $outAsarTmp) {
                    Remove-Item -LiteralPath $outAsarTmp -Force -ErrorAction SilentlyContinue
                }
            }
            Write-Host "[OK] 已从 app.asar 剥离遥测注入块！" -ForegroundColor Green
        } else {
            Write-Host "[跳过] 当前 app.asar 未检测到遥测补丁，无需恢复。" -ForegroundColor Gray
        }
    } else {
        if (-not $alreadyPatched) {
            Copy-FileAtomic $asarPath $bakPath
            Write-Host "[OK] 已备份当前版本原版至 app.asar.bak" -ForegroundColor Gray
        }

        Write-Host "[2/3] 正在内存级注入遥测面板 & Token 热力图模块..." -ForegroundColor Yellow
        $asarBytes  = $info.Bytes
        $dataOffset = $info.DataOffset
        $hdrObj     = $info.Hdr

        $ipcCode = Apply-TelemetryIpcBlock $ipcSample $IPC_BLOCK
        $preCode = Apply-TelemetryPreloadBlock $preSample $PRELOAD_BLOCK

        Test-NodeJsSyntax $ipcCode $preCode

        $ipcNewBytes = [System.Text.Encoding]::UTF8.GetBytes($ipcCode)
        $preNewBytes = [System.Text.Encoding]::UTF8.GetBytes($preCode)

        $targets = @(
            @{ RelPath = "dist/ipcHandlers.js"; OldOff = $ipcOffCheck; OldSize = $ipcSizeCheck; NewBytes = $ipcNewBytes },
            @{ RelPath = "dist/preload.js";     OldOff = $preOffCheck; OldSize = $preSizeCheck; NewBytes = $preNewBytes }
        ) | Sort-Object { $_.OldOff } -Descending

        $dataLen = $asarBytes.Length - $dataOffset
        $curData = New-Object byte[] $dataLen
        [Array]::Copy($asarBytes, $dataOffset, $curData, 0, $dataLen)

        foreach ($t in $targets) {
            $oldOff   = [long]$t.OldOff
            $oldSize  = [int]$t.OldSize
            $newBytes = [byte[]]$t.NewBytes
            $newSize  = $newBytes.Length
            $delta    = [long]$newSize - [long]$oldSize

            $entry = Get-AsarEntry $hdrObj $t.RelPath
            if ($delta -ne 0) {
                Update-AsarOffsets $hdrObj $oldOff $delta
            }
            $entry["size"] = [int]$newSize
            Set-AsarEntryIntegrity $entry $newBytes

            $ms = New-Object System.IO.MemoryStream
            try {
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
            } finally {
                $ms.Dispose()
            }
            Write-Host "  -> 已注入 $($t.RelPath) ($oldSize -> $newSize bytes)" -ForegroundColor Green
        }

        Write-Host "[3/3] 正在校验并原子写入 app.asar ..." -ForegroundColor Yellow
        $ser = New-AsarJsonSerializer
        $newJsonStr = $ser.Serialize($hdrObj)
        Verify-AsarHeaderAndData $newJsonStr $curData $targets

        $newJsonBytes   = [System.Text.Encoding]::UTF8.GetBytes($newJsonStr)
        $newU3          = [uint32]$newJsonBytes.Length
        $alignedJsonLen = [int]([Math]::Ceiling($newJsonBytes.Length / 4.0) * 4)
        $paddingLen     = $alignedJsonLen - $newJsonBytes.Length
        $newU2          = [uint32](4 + $alignedJsonLen)
        $newU1          = [uint32](4 + $newU2)
        $newU0          = [uint32]4

        $outAsarTmp = $asarPath + ".tmp." + [Guid]::NewGuid().ToString("N")
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
        try {
            Move-FileWithRetry $outAsarTmp $asarPath
        } finally {
            if (Test-Path -LiteralPath $outAsarTmp) {
                Remove-Item -LiteralPath $outAsarTmp -Force -ErrorAction SilentlyContinue
            }
        }
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
        $rawSettings = Read-Utf8NoBom $settingsPath
        if ($rawSettings.Trim()) {
            try {
                $settingsObj = $rawSettings | ConvertFrom-Json
            } catch {
                throw "无法解析 $settingsPath (请检查 JSON 格式是否有效): $($_.Exception.Message)"
            }
        }
    }
    if (-not $settingsObj) {
        $settingsObj = New-Object PSObject
    }

    $existingStatusLine = $settingsObj.PSObject.Properties["statusLine"]
    $existingCmd = if ($existingStatusLine -and $existingStatusLine.Value) { [string]$existingStatusLine.Value.command } else { "" }
    $existingTarget = Resolve-CommandTargetPath $existingCmd

    if ($actionMode -eq "restore") {
        $shouldCleanSettings = $false
        if ($existingTarget -and (Test-Path -LiteralPath $existingTarget)) {
            $content = Read-Utf8NoBom $existingTarget
            if ($content.Contains("TELEMETRY_MOD_CLI_STATUSLINE")) {
                $shouldCleanSettings = $true
                Remove-Item -LiteralPath $existingTarget -Force -ErrorAction SilentlyContinue
            }
        } elseif ($existingTarget -and ($existingTarget -match '(?:^|[\\/])agy-statusline\.js$')) {
            $shouldCleanSettings = $true
        }
        if ($shouldCleanSettings -and $existingStatusLine) {
            $settingsObj.PSObject.Properties.Remove("statusLine")
            Write-Utf8NoBom $settingsPath ($settingsObj | ConvertTo-Json -Depth 10)
            Write-Host "[CLI] 已从 settings.json 移除托管的 statusLine 配置。" -ForegroundColor Yellow
        }
    } else {
        $nodeCheck = Test-NodeVersionReady
        $preserveCustom = $false
        $deployPath = ""
        if ($existingTarget -and (Test-Path -LiteralPath $existingTarget)) {
            $existingText = Read-Utf8NoBom $existingTarget
            if ($existingText.Contains("TELEMETRY_MOD_CLI_STATUSLINE")) {
                if ($existingTarget -notmatch '\s' -and (Test-DirWritable (Split-Path -Parent $existingTarget))) {
                    $deployPath = $existingTarget
                }
            } elseif ($existingText -match 'require\s*\(') {
                Write-Host "[CLI] 检测到自定义 statusLine 包装脚本，已完整保留: $existingTarget" -ForegroundColor Green
                $preserveCustom = $true
            }
        }

        if (-not $preserveCustom) {
            if (-not $deployPath) {
                $deployPath = Resolve-SpaceFreeCliScriptPath $cliHome
            }
            Write-Utf8NoBom $deployPath $AGY_STATUS_CODE
            Write-Host "[CLI] 已部署/更新状态栏脚本: $deployPath" -ForegroundColor Green

            if ($nodeCheck.Ready) {
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
                Write-Host "[CLI] 已通过 Node ($($nodeCheck.Version)) 校验并写入配置: $settingsPath" -ForegroundColor Green
            } else {
                Write-Host "[!] 警告: $($nodeCheck.Reason)。" -ForegroundColor Yellow
                Write-Host "    agy 状态栏需要 Node.js >= 18。为避免 agy 因执行失败而自动禁用状态栏，本次未向 settings.json 写入 `"enabled`": true。" -ForegroundColor Yellow
                Write-Host "    请安装 Node.js (>= 18) 并确保 cmd.exe /c node -v 可用后，重新运行本脚本即可自动启用。" -ForegroundColor Yellow
            }
        } elseif (-not $nodeCheck.Ready) {
            Write-Host "[!] 提示: $($nodeCheck.Reason)，CLI 状态栏需要安装 Node.js (>= 18)。" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
if ($actionMode -eq "restore") {
    Write-Host " [完成] 已恢复 Antigravity 2.0 官方原版。" -ForegroundColor Green
} elseif ($skipAsarDueToFuse) {
    Write-Host " [完成] CLI 检查已完成（桌面端因 Electron 完整性熔断位保护已跳过）。" -ForegroundColor Yellow
} else {
    Write-Host " [成功] Antigravity 2.0 遥测栏 + 热力图补丁安装完成！" -ForegroundColor Green
    Write-Host " 提示: 客户端自动升级覆盖后，再次双击本文件即可 1 秒恢复。" -ForegroundColor Green
}
Write-Host "=============================================================" -ForegroundColor Green

    if ($asarPath -and (-not $skipAsarDueToFuse) -and (-not $env:ANTIGRAVITY_ASAR_PATH) -and $wasRunning -and $exePath -and (Test-Path -LiteralPath $exePath)) {
        Start-Process -FilePath $exePath
        Write-Host "[OK] 已为您自动重新打开 Antigravity 2.0！" -ForegroundColor Cyan
    }
}

$installerExitCode = 0
$installerErrorMsg = ""
try {
    Invoke-InstallerMain
} catch {
    $installerExitCode = 1
    $installerErrorMsg = $_.Exception.Message
} finally {
    if ($installerExitCode -ne 0 -and $installerErrorMsg) {
        Write-Host ""
        Write-Host "[ERROR] $installerErrorMsg" -ForegroundColor Red
    }
    $skipPause = ($env:ANTIGRAVITY_SKIP_PAUSE -eq "1") -or
                 (-not [string]::IsNullOrWhiteSpace($env:ANTIGRAVITY_INSTALLER_MODE)) -or
                 ($env:ANTIGRAVITY_NONINTERACTIVE -eq "1")
    if (-not $skipPause) {
        Write-Host ""
        try {
            if (-not [Console]::IsInputRedirected) {
                Write-Host "按任意键退出..." -ForegroundColor DarkGray
                [void][Console]::ReadKey($true)
            }
        } catch {}
    }
}
exit $installerExitCode
