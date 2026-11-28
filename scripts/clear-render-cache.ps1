#requires -Version 5.1
<#
.SYNOPSIS
    清空训练渲染缓存（training-data/render-cache）。
.DESCRIPTION
    只删缓存文件，不影响数据集、样本与已训练模型；下次训练会重新渲染。
    参数 -DryRun 只统计大小，不删除。
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/clear-render-cache.ps1 -DryRun
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $root 'training-data\render-cache'

if (-not (Test-Path -LiteralPath $cache)) {
    Write-Host '没有渲染缓存目录，无需清理。' -ForegroundColor Green
    exit 0
}

$files = Get-ChildItem -LiteralPath $cache -Filter '*.npz' -File -ErrorAction SilentlyContinue
$size = if ($files) { ($files | Measure-Object Length -Sum).Sum } else { 0 }
Write-Host ("缓存目录：{0}" -f $cache)
Write-Host ("文件数：{0}，大小：{1} MB" -f $files.Count, [math]::Round($size / 1MB, 2))

if ($DryRun) {
    Write-Host '（-DryRun 未删除任何文件）' -ForegroundColor Yellow
    exit 0
}

if ($files.Count -gt 0) {
    $files | Remove-Item -Force
}
Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("已清理，释放 {0} MB" -f [math]::Round($size / 1MB, 2)) -ForegroundColor Green
