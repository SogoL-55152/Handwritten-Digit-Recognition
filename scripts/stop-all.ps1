#Requires -Version 5.1
<#
.SYNOPSIS
    按与 start-all.ps1 相反的顺序停止全部本地服务。

.DESCRIPTION
    停止顺序：前端 → 训练 worker → 后端 → 模型服务 → Redis → MySQL。
    优先使用 start-all.ps1 写入的 PID 文件；PID 文件缺失（例如手工启动过）时，
    按命令行特征匹配本项目的进程再停止，不会误杀其它 MySQL/Redis/Java 进程。

.PARAMETER Runtime
    运行时目录，默认取环境变量 HDR_RUNTIME，否则 D:\HDR-runtime。

.PARAMETER EnvFile
    环境变量文件，默认 scripts/.env；用于取得进程特征里的端口与路径。

.PARAMETER Force
    等待 5 秒后仍在运行则强制结束（默认就是强制，保留该开关以便语义清晰）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/stop-all.ps1
#>
[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$Runtime,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
    param([string]$Text)
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "    [OK] $Text" -ForegroundColor Green
}

function Write-Skip {
    param([string]$Text)
    Write-Host "    [--] $Text" -ForegroundColor DarkGray
}

function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $count = 0
    foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key, 'Process'))) { continue }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        $count++
    }
    return $count
}

function Get-EnvValue {
    param([string]$Name, [string]$Fallback = '')
    $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrEmpty($v)) { return $Fallback }
    return $v
}

function Get-ListeningPid {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { return [int]($conn | Select-Object -First 1 -ExpandProperty OwningProcess) }
    return 0
}

function Get-SelfProcessChain {
    # 自身及所有祖先进程，避免脚本把自己的父进程（例如终端、IDE、Agent）当成服务杀掉
    $chain = New-Object System.Collections.ArrayList
    $cursor = $PID
    while ($cursor -and $cursor -gt 0) {
        if ($chain -contains $cursor) { break }
        [void]$chain.Add([int]$cursor)
        $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue
        if (-not $info) { break }
        $cursor = [int]$info.ParentProcessId
    }
    return $chain
}

function Stop-ByMarker {
    param([string]$Name, [string[]]$Markers, [string[]]$ProcessNames, [int]$Port = 0)

    $targets = New-Object System.Collections.ArrayList
    $self = Get-SelfProcessChain

    # 1) start-all.ps1 记录的 PID（只作候选，真正动手前还要复核）
    $pidFile = Join-Path $script:RunDir "$Name.pid"
    if (Test-Path -LiteralPath $pidFile) {
        $recorded = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue) -join ''
        $recorded = $recorded.Trim()
        if ($recorded -match '^\d+$') { [void]$targets.Add([int]$recorded) }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }

    # 2) 端口占用者
    if ($Port -gt 0) {
        $portPid = Get-ListeningPid -Port $Port
        if ($portPid) { [void]$targets.Add($portPid) }
    }

    # 3) 命令行扫描（应对手工启动、PID 文件丢失）
    foreach ($proc in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($null -eq $proc.CommandLine) { continue }
        foreach ($m in $Markers) {
            if ($proc.CommandLine.Contains($m)) { [void]$targets.Add([int]$proc.ProcessId); break }
        }
    }

    $stopped = 0
    foreach ($procId in ($targets | Sort-Object -Unique)) {
        if ($self -contains $procId) { continue }
        # 复核：PID 可能已被系统回收给别的进程，必须重新读命令行与映像名
        $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
        if (-not $fresh) { continue }
        if ($ProcessNames -and ($ProcessNames -notcontains $fresh.Name)) {
            Write-Host "    [!!] 跳过 PID $procId（$($fresh.Name)）：映像名不在预期列表 $($ProcessNames -join '/')" -ForegroundColor Yellow
            continue
        }
        $matched = $false
        if ($fresh.CommandLine) {
            foreach ($m in $Markers) { if ($fresh.CommandLine.Contains($m)) { $matched = $true; break } }
        }
        if (-not $matched) {
            Write-Host "    [!!] 跳过 PID $procId（$($fresh.Name)）：命令行不含本项目特征" -ForegroundColor Yellow
            continue
        }
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Ok "$Name 已停止（PID $procId，$($fresh.Name)）"
            $stopped++
        } catch {
            Write-Host "    [!!] $Name（PID $procId）停止失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    if ($stopped -eq 0) { Write-Skip "$Name 未在运行" }
}

# ---------------------------------------------------------------- 环境

if ([string]::IsNullOrEmpty($EnvFile)) { $EnvFile = Join-Path $PSScriptRoot '.env' }
[void](Import-DotEnv -Path $EnvFile)

if ([string]::IsNullOrEmpty($Runtime)) { $Runtime = Get-EnvValue 'HDR_RUNTIME' 'D:\HDR-runtime' }
$script:RunDir = Join-Path $Runtime 'run'

$mysqlPort = [int](Get-EnvValue 'MYSQL_PORT' '13316')
$redisPort = [int](Get-EnvValue 'REDIS_PORT' '16379')
$serverPort = [int](Get-EnvValue 'SERVER_PORT' '8080')
$modelPort = [int](Get-EnvValue 'MODEL_PORT' '5001')
$webPort = [int](Get-EnvValue 'WEB_PORT' '5173')
$mysqlData = Get-EnvValue 'MYSQL_DATADIR' (Join-Path $Runtime 'mysql\data')

# ---------------------------------------------------------------- 反向停止

Write-Step "前端"
Stop-ByMarker -Name 'frontend' -Markers @('vite.js', "--port $webPort") -ProcessNames @('node.exe') -Port $webPort

Write-Step "训练 worker"
Stop-ByMarker -Name 'worker' -Markers @('celery_app:celery_app', '-Q training') -ProcessNames @('python.exe', 'py.exe')

Write-Step "后端"
Stop-ByMarker -Name 'backend' -Markers @('hdr-backend-0.1.0-SNAPSHOT.jar') -ProcessNames @('java.exe', 'javaw.exe') -Port $serverPort

Write-Step "模型服务"
Stop-ByMarker -Name 'model-service' -Markers @('model-service\serve.py', 'model-service/serve.py') -ProcessNames @('python.exe', 'py.exe') -Port $modelPort

Write-Step "Redis"
Stop-ByMarker -Name 'redis' -Markers @('redis-server.exe') -ProcessNames @('redis-server.exe') -Port $redisPort

Write-Step "MySQL"
Stop-ByMarker -Name 'mysql' -Markers @($mysqlData) -ProcessNames @('mysqld.exe') -Port $mysqlPort

# ---------------------------------------------------------------- 校验

Write-Step "端口校验"
$still = New-Object System.Collections.ArrayList
foreach ($p in @($webPort, $serverPort, $modelPort, $redisPort, $mysqlPort)) {
    $owner = Get-ListeningPid -Port $p
    if ($owner) { [void]$still.Add("$p (PID $owner)") }
}
if ($still.Count -eq 0) {
    Write-Ok "全部端口已释放：$webPort / $serverPort / $modelPort / $redisPort / $mysqlPort"
    exit 0
}
Write-Host "    仍在监听：$($still -join ', ')" -ForegroundColor Yellow
Write-Host "    若非本项目的进程占用，请自行确认后再处理。" -ForegroundColor Yellow
exit 1
