<#
.SYNOPSIS
    Conex Cargo 编译缓存精细化深度清理脚本
.DESCRIPTION
    1. 自动清理 Cargo test 产生的大量自动化测试二进制 (*.exe) 与符号表 (*.pdb)；
    2. 自动识别并清理死 Hash 编译文件（即已被新代码/新 Hash 取代的老版本 .rlib, .o, .rmeta, .d）；
    3. 严格保留每个 crate 最后一个最新的有效构建产物，保证不影响正常增量编译与即刻调试。
#>
param(
    [string]$DepsDir = "$PSScriptRoot\..\target\debug\deps",
    [switch]$SkipTestExes = $false,
    [switch]$SkipDeadHashes = $false
)

$ErrorActionPreference = "SilentlyContinue"

if (-not (Test-Path $DepsDir)) {
    Write-Host "[clean-cargo-cache] 目录不存在: $DepsDir" -ForegroundColor Yellow
    exit 0
}

$totalFreedBytes = [int64]0
$totalFreedCount = 0

# -------------------------------------------------------------
# 1. 清理自动化测试二进制与符号表 (*.exe + *.pdb)
# -------------------------------------------------------------
if (-not $SkipTestExes) {
    Write-Host "[clean-cargo-cache] 正在扫描测试二进制程序与符号表..." -ForegroundColor Cyan
    $testExes = Get-ChildItem -Path $DepsDir -Filter "*.exe" -File
    $exeCount = 0
    $exeBytes = [int64]0

    foreach ($exe in $testExes) {
        $baseName = $exe.BaseName
        $exeBytes += $exe.Length
        Remove-Item -Path $exe.FullName -Force -ErrorAction SilentlyContinue
        $exeCount++

        $pdb = Join-Path $exe.DirectoryName "$baseName.pdb"
        if (Test-Path $pdb) {
            $pdbItem = Get-Item $pdb -ErrorAction SilentlyContinue
            if ($pdbItem) {
                $exeBytes += $pdbItem.Length
                Remove-Item -Path $pdb -Force -ErrorAction SilentlyContinue
                $exeCount++
            }
        }
    }
    $totalFreedBytes += $exeBytes
    $totalFreedCount += $exeCount
    Write-Host "[clean-cargo-cache] 测试产物清理完成: 移除 $exeCount 个文件 ($([math]::Round($exeBytes / 1MB, 2)) MB)" -ForegroundColor Green
}

# -------------------------------------------------------------
# 2. 清理已被新版本取代的死 Hash 历史编译产物 (.rlib, .o, .rmeta, .d)
# -------------------------------------------------------------
if (-not $SkipDeadHashes) {
    Write-Host "[clean-cargo-cache] 正在分析 crate 版本，识别被取代的死 Hash 缓存..." -ForegroundColor Cyan
    $allFiles = Get-ChildItem -Path $DepsDir -File
    $deadHashes = [System.Collections.Generic.HashSet[string]]::new()

    # 按 crate 基础名称分组所有的 .rlib
    $rlibs = $allFiles | Where-Object { $_.Extension -eq ".rlib" }
    $groups = $rlibs | Group-Object {
        if ($_.Name -match "^(lib[a-zA-Z0-9_]+)-([0-9a-fA-F]+)\.rlib$") {
            $matches[1]
        } else {
            $_.BaseName
        }
    }

    foreach ($g in $groups) {
        if ($g.Count -gt 1) {
            # 按最后修改时间倒序排列，第 1 个为最新使用的版本（保留），其余为过时死 Hash
            $sorted = $g.Group | Sort-Object LastWriteTime -Descending
            $obsolete = $sorted | Select-Object -Skip 1
            foreach ($item in $obsolete) {
                if ($item.Name -match "^lib[a-zA-Z0-9_]+-([0-9a-fA-F]+)\.rlib$") {
                    [void]$deadHashes.Add($matches[1])
                }
            }
        }
    }

    if ($deadHashes.Count -gt 0) {
        Write-Host "[clean-cargo-cache] 发现 $($deadHashes.Count) 个废弃 Hash，开始精准移除对应关联的 .rlib/.o/.rmeta/.d 文件..." -ForegroundColor Cyan
        $deadFiles = $allFiles | Where-Object {
            foreach ($h in $deadHashes) {
                if ($_.Name -match "-$h\.") { return $true }
            }
            return $false
        }

        $deadBytes = [int64]0
        $deadCount = 0
        foreach ($f in $deadFiles) {
            $deadBytes += $f.Length
            Remove-Item -Path $f.FullName -Force -ErrorAction SilentlyContinue
            $deadCount++
        }

        $totalFreedBytes += $deadBytes
        $totalFreedCount += $deadCount
        Write-Host "[clean-cargo-cache] 死 Hash 产物清理完成: 移除 $deadCount 个过时文件 ($([math]::Round($deadBytes / 1GB, 2)) GB)" -ForegroundColor Green
    } else {
        Write-Host "[clean-cargo-cache] 没有发现多余的死 Hash 产物。" -ForegroundColor Green
    }
}

$freedGB = [math]::Round($totalFreedBytes / 1GB, 2)
Write-Host "[clean-cargo-cache] 总结: 总计释放空间 $freedGB GB ($totalFreedCount 个文件)！保留全部最新构建，不影响调试与增量编译。" -ForegroundColor Magenta
