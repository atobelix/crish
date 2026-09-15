<#
.SYNOPSIS
    定期/自动清理 Cargo 测试产生的巨型二进制文件 (*.exe) 及调试符号表 (*.pdb)
.DESCRIPTION
    Cargo 运行测试时会在 target/debug/deps 下生成大量的单测可执行文件与符号表。
    Cargo 不会自动垃圾回收旧测试程序，导致几百个文件消耗几十 GB。
    本脚本安全清理这些测试程序，完全不影响正常业务开发与调试。
#>
param(
    [string]$TargetRoot = "C:\Software\conex\target\debug\deps",
    [int]$KeepLatestHours = 0
)

$ErrorActionPreference = "SilentlyContinue"

if (-not (Test-Path $TargetRoot)) {
    Write-Host "[clean-tests] 目标目录不存在: $TargetRoot" -ForegroundColor Yellow
    exit 0
}

Write-Host "[clean-tests] 正在扫描测试二进制与符号表: $TargetRoot ..." -ForegroundColor Cyan

$testExes = Get-ChildItem -Path $TargetRoot -Filter "*.exe" -File
if (-not $testExes) {
    Write-Host "[clean-tests] 未发现残留的测试二进制文件。" -ForegroundColor Green
    exit 0
}

$now = Get-Date
$deletedCount = 0
$deletedBytes = [int64]0

foreach ($exe in $testExes) {
    if ($KeepLatestHours -gt 0) {
        $ageHours = ($now - $exe.LastWriteTime).TotalHours
        if ($ageHours -lt $KeepLatestHours) {
            continue
        }
    }

    $baseName = $exe.BaseName
    $deletedBytes += $exe.Length
    Remove-Item -Path $exe.FullName -Force -ErrorAction SilentlyContinue
    $deletedCount++

    $pdb = Join-Path $exe.DirectoryName "$baseName.pdb"
    if (Test-Path $pdb) {
        $pdbItem = Get-Item $pdb -ErrorAction SilentlyContinue
        if ($pdbItem) {
            $deletedBytes += $pdbItem.Length
            Remove-Item -Path $pdb -Force -ErrorAction SilentlyContinue
            $deletedCount++
        }
    }
}

$freedGB = [math]::Round($deletedBytes / 1GB, 2)
$freedMB = [math]::Round($deletedBytes / 1MB, 2)

if ($freedGB -ge 1) {
    Write-Host "[clean-tests] 清理完成: 移除了 $deletedCount 个测试文件，释放空间 $freedGB GB！" -ForegroundColor Green
} else {
    Write-Host "[clean-tests] 清理完成: 移除了 $deletedCount 个测试文件，释放空间 $freedMB MB。" -ForegroundColor Green
}
