#Requires -Version 5.1
<#
.SYNOPSIS
    数据库备份与恢复演练（交接文档 P0-4）。

.DESCRIPTION
    默认流程（不碰现网库）：
      1) mysqldump 整库导出到 $OutDir\hdr-<schema>-<时间戳>.sql
      2) 建临时库 hdr_w2_restorecheck，把备份导入进去
      3) 逐表比对行数，并对关键表比对 CHECKSUM TABLE
      4) 删除临时库
    加 -Live 再做一次真实回滚：停全部服务 → 删除并重建业务库 → 导入备份 → 重新起服务。

.PARAMETER EnvFile
    环境变量文件，默认 scripts/.env（提供 DB_URL / DB_USERNAME / DB_PASSWORD）。

.PARAMETER OutDir
    备份目录，默认 $HDR_RUNTIME\backup。

.PARAMETER Live
    真实回滚演练（会短暂停止并重启全部服务）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/db-backup-restore.ps1 -Live
#>
[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$OutDir,
    [switch]$Live
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step { param([string]$Text) Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    [OK] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    [!!] $Text" -ForegroundColor Yellow }

function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        [Environment]::SetEnvironmentVariable($line.Substring(0, $idx).Trim(), $line.Substring($idx + 1).Trim(), 'Process')
    }
}

function Get-EnvValue {
    param([string]$Name, [string]$Fallback = '')
    $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrEmpty($v)) { return $Fallback }
    return $v
}

function Invoke-MysqlNative {
    param([string]$Exe, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments; return $LASTEXITCODE }
    finally { $ErrorActionPreference = $previous }
}

function Get-TableCounts {
    param([string]$Schema)
    $sql = "SELECT table_name FROM information_schema.tables WHERE table_schema='$Schema' AND table_type='BASE TABLE' ORDER BY table_name"
    $tables = & $script:MysqlExe @script:ConnArgs -N -B -e $sql
    $result = [ordered]@{}
    foreach ($table in $tables) {
        $table = "$table".Trim()
        if ($table -eq '') { continue }
        $count = & $script:MysqlExe @script:ConnArgs -N -B -e "SELECT COUNT(*) FROM ``$Schema``.``$table``"
        $result[$table] = [int]("$count".Trim())
    }
    return $result
}

# ---------------------------------------------------------------- 环境

if ([string]::IsNullOrEmpty($EnvFile)) { $EnvFile = Join-Path $PSScriptRoot '.env' }
Import-DotEnv -Path $EnvFile

$runtime = Get-EnvValue 'HDR_RUNTIME' 'D:\HDR-runtime'
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $runtime 'backup' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$mysqlBin = Split-Path -Parent (Get-EnvValue 'MYSQLD_EXE' 'mysqld')
$script:MysqlExe = Join-Path $mysqlBin 'mysql.exe'
$dumpExe = Join-Path $mysqlBin 'mysqldump.exe'
foreach ($exe in @($script:MysqlExe, $dumpExe)) {
    if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 $exe（检查 MYSQLD_EXE 所在目录）" }
}

$dbUrl = Get-EnvValue 'DB_URL'
if ($dbUrl -notmatch 'jdbc:mysql://([^:/]+):(\d+)/([^?]+)') { throw "DB_URL 无法解析：$dbUrl" }
$dbHost = $Matches[1]
$dbPort = $Matches[2]
$schema = $Matches[3]
$dbUser = Get-EnvValue 'MYSQL_ADMIN_USER' (Get-EnvValue 'DB_USERNAME' 'hdr')
$dbPassword = Get-EnvValue 'MYSQL_ADMIN_PASSWORD' (Get-EnvValue 'DB_PASSWORD')
$script:ConnArgs = @('--no-defaults', '-h', $dbHost, '-P', $dbPort, '-u', $dbUser, "--password=$dbPassword",
                     '--default-character-set=utf8mb4')

Write-Step "备份 $schema（$($dbHost):$($dbPort)）"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $OutDir "hdr-$schema-$stamp.sql"
$errFile = Join-Path $OutDir "hdr-$schema-$stamp.err.log"
$dumpArgs = @('--no-defaults', '-h', $dbHost, '-P', $dbPort, '-u', $dbUser, "--password=$dbPassword",
              '--default-character-set=utf8mb4', '--single-transaction', '--routines', '--triggers',
              '--no-tablespaces', '--skip-add-drop-table', '--no-create-db', $schema)
# 用 Start-Process 的字节级重定向：PowerShell 管道会截断/改写 dump 里的长行和 UTF-8 内容
$dumpProc = Start-Process -FilePath $dumpExe -ArgumentList $dumpArgs -RedirectStandardOutput $backupFile `
    -RedirectStandardError $errFile -PassThru -NoNewWindow -Wait
if ($dumpProc.ExitCode -ne 0) { throw "mysqldump 失败（退出码 $($dumpProc.ExitCode)），见 $errFile" }
$sizeMb = [math]::Round((Get-Item -LiteralPath $backupFile).Length / 1MB, 2)
Write-Ok "备份文件 $backupFile（$sizeMb MB）"

Write-Step "导入临时库并比对"
$scratch = 'hdr_w2_restorecheck'
[void](Invoke-MysqlNative -Exe $script:MysqlExe -Arguments ($script:ConnArgs + @('-e', "DROP DATABASE IF EXISTS ``$scratch``")))
[void](Invoke-MysqlNative -Exe $script:MysqlExe -Arguments ($script:ConnArgs + @('-e', "CREATE DATABASE ``$scratch`` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci")))

$importErr = Join-Path $OutDir "hdr-import-$stamp.err.log"
$importProc = Start-Process -FilePath $script:MysqlExe -ArgumentList ($script:ConnArgs + @($scratch)) `
    -RedirectStandardInput $backupFile -RedirectStandardError $importErr -PassThru -NoNewWindow -Wait
if ($importProc.ExitCode -ne 0) { throw "导入临时库失败（退出码 $($importProc.ExitCode)），见 $importErr" }

$original = Get-TableCounts -Schema $schema
$restored = Get-TableCounts -Schema $scratch
$diff = 0
foreach ($table in $original.Keys) {
    $a = $original[$table]
    $b = 0
    if ($restored.Contains($table)) { $b = $restored[$table] }
    if ($a -ne $b) { Write-Warn "$table 行数不一致：原库 $a / 还原 $b"; $diff++ }
}
Write-Ok ("比对 $($original.Keys.Count) 张表，行数不一致 $diff 张")

$crcTables = @('t_v2_model', 't_user', 't_v2_dataset', 't_v2_dataset_sample', 't_v2_training_task', 'flyway_schema_history')
$crcDiff = 0
foreach ($table in $crcTables) {
    $a = (& $script:MysqlExe @script:ConnArgs -N -B -e "CHECKSUM TABLE ``$schema``.``$table``") -join ''
    $b = (& $script:MysqlExe @script:ConnArgs -N -B -e "CHECKSUM TABLE ``$scratch``.``$table``") -join ''
    $va = ($a -split "`t")[-1]
    $vb = ($b -split "`t")[-1]
    if ($va -ne $vb) { Write-Warn "$table 校验和不同：$va vs $vb"; $crcDiff++ }
}
Write-Ok ("关键表 CHECKSUM 比对：$($crcTables.Count) 张，不一致 $crcDiff 张")

[void](Invoke-MysqlNative -Exe $script:MysqlExe -Arguments ($script:ConnArgs + @('-e', "DROP DATABASE IF EXISTS ``$scratch``")))
Write-Ok "临时库已清理"

if ($Live) {
    Write-Step "真实回滚演练（停应用 → 删库重建 → 导入 → 起应用）"
    # 只停连数据库的应用进程：MySQL/Redis 必须保持运行，否则无法执行恢复。
    $selfChain = New-Object System.Collections.ArrayList
    $cursor = $PID
    while ($cursor -and $cursor -gt 0) {
        if ($selfChain -contains $cursor) { break }
        [void]$selfChain.Add([int]$cursor)
        $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue
        if (-not $info) { break }
        $cursor = [int]$info.ParentProcessId
    }

    foreach ($name in @('worker', 'backend')) {
        $pidFile = Join-Path $runtime "run\$name.pid"
        if (Test-Path -LiteralPath $pidFile) {
            $recorded = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue)
            if ($recorded -and $recorded.Trim() -match '^\d+$' -and -not ($selfChain -contains [int]$recorded.Trim())) {
                Stop-Process -Id ([int]$recorded.Trim()) -Force -ErrorAction SilentlyContinue
                Write-Ok "已停止 $name（PID $($recorded.Trim())）"
            }
        }
    }
    Start-Sleep -Seconds 2
    # 兜底：按命令行清理（排除自身进程链）
    foreach ($proc in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if (-not $proc.CommandLine) { continue }
        if ($selfChain -contains [int]$proc.ProcessId) { continue }
        if ($proc.CommandLine.Contains('hdr-backend-0.1.0-SNAPSHOT.jar') -or $proc.CommandLine.Contains('celery_app:celery_app')) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Ok "已清理残留进程 PID $($proc.ProcessId)（$($proc.Name)）"
        }
    }
    Start-Sleep -Seconds 2

    $mysqlAlive = Get-NetTCPConnection -LocalPort $dbPort -State Listen -ErrorAction SilentlyContinue
    if (-not $mysqlAlive) { throw "MySQL（端口 $dbPort）没有运行，无法执行恢复；请先启动 MySQL 再重试" }

    [void](Invoke-MysqlNative -Exe $script:MysqlExe -Arguments ($script:ConnArgs + @('-e', "DROP DATABASE IF EXISTS ``$schema``")))
    [void](Invoke-MysqlNative -Exe $script:MysqlExe -Arguments ($script:ConnArgs + @('-e', "CREATE DATABASE ``$schema`` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci")))
    $liveErr = Join-Path $OutDir "hdr-live-restore-$stamp.err.log"
    $liveProc = Start-Process -FilePath $script:MysqlExe -ArgumentList ($script:ConnArgs + @($schema)) `
        -RedirectStandardInput $backupFile -RedirectStandardError $liveErr -PassThru -NoNewWindow -Wait
    if ($liveProc.ExitCode -ne 0) { throw "真实恢复失败（退出码 $($liveProc.ExitCode)），见 $liveErr" }
    Write-Ok "业务库已从备份重建"

    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-all.ps1') *> (Join-Path $runtime 'logs\drill-start.log')
    $health = $null
    try { $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$(Get-EnvValue 'SERVER_PORT' '8080')/api/health" -UseBasicParsing -TimeoutSec 30).Content } catch { $health = $null }
    if ($health -and $health.Contains('UP')) { Write-Ok "后端已重启并通过健康检查" }
    else { Write-Warn "后端健康检查未通过，见 $runtime\logs\drill-start.log" }
}

Write-Host ""
if ($diff -eq 0 -and $crcDiff -eq 0) {
    Write-Host "备份/恢复演练通过：$($original.Keys.Count) 张表行数一致，关键表校验和一致。" -ForegroundColor Green
    exit 0
}
Write-Host "备份/恢复演练发现差异，见上面的 [!!] 行。" -ForegroundColor Red
exit 1
