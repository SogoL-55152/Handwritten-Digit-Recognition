#Requires -Version 5.1
<#
.SYNOPSIS
    按依赖顺序启动手写数字识别系统的全部本地服务。

.DESCRIPTION
    启动顺序（不能乱）：MySQL → Redis → 模型服务 → 后端 → 训练 worker → 前端。
    每启动一步都做健康探测，任一步失败立即停止后续步骤并打印该服务的日志尾部。
    已在监听的端口会被跳过（脚本可重复执行）。PID 与日志写在 -Runtime 目录，供 stop-all.ps1 使用。

.PARAMETER EnvFile
    环境变量文件，默认 scripts/.env（不存在则使用脚本内置默认值）。
    模板见 scripts/.env.example。

.PARAMETER Runtime
    运行时目录（日志、PID、MySQL 数据目录），默认 D:\HDR-runtime。

.PARAMETER Build
    启动前先构建：npm ci（node_modules 缺失时）+ mvn package -DskipTests。

.PARAMETER SkipWorker
    不启动 Celery 训练 worker（只做识别、不做训练时可用）。

.PARAMETER SkipFrontend
    不启动 Vite 开发服务器。

.PARAMETER TimeoutSeconds
    单个服务等待就绪的秒数，默认 120。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/start-all.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/start-all.ps1 -Build
#>
[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$Runtime,
    [switch]$Build,
    [switch]$SkipWorker,
    [switch]$SkipFrontend,
    [switch]$KeepProcessEnv,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Failures = New-Object System.Collections.ArrayList
$script:Started = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- 基础工具

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

function Write-Warn {
    param([string]$Text)
    Write-Host "    [!!] $Text" -ForegroundColor Yellow
}

function Import-DotEnv {
    param([string]$Path, [switch]$KeepProcessEnv)
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Warn "未找到环境文件 $Path，使用脚本内置默认值（建议先 Copy-Item scripts/.env.example scripts/.env）"
        return 0
    }
    $count = 0
    foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        # 默认由文件说了算：机器上残留的 JAVA_HOME / PYTHON 等旧值不应该覆盖部署配置。
        # 除非：
        #   -KeepProcessEnv  → 当前进程里已有的变量一律保留；
        #   文件里的值为空   → 视为"未配置"，不去清掉调用方已经设好的值
        #                      （否则给一次命令临时传 HDR_BOOTSTRAP_ADMIN_* 之类的变量会被空值抹掉）。
        if ($KeepProcessEnv -and -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key, 'Process'))) { continue }
        if ($value -eq '' -and -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key, 'Process'))) { continue }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        $count++
    }
    return $count
}

function Set-Default {
    param([string]$Name, [string]$Value)
    if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($Name, 'Process'))) {
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }
}

function Get-EnvValue {
    param([string]$Name, [string]$Fallback = '')
    $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrEmpty($v)) { return $Fallback }
    return $v
}

function New-Directory {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return }
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}

function Get-ListeningPid {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { return [int]($conn | Select-Object -First 1 -ExpandProperty OwningProcess) }
    return 0
}

function Wait-TcpPort {
    param([int]$Port, [int]$Seconds, [string]$Name)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Get-ListeningPid -Port $Port) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Wait-HttpOk {
    param([string]$Url, [int]$Seconds, [string]$Name, [string]$Contains = '')
    $deadline = (Get-Date).AddSeconds($Seconds)
    $lastError = ''
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) {
                if ($Contains -eq '' -or $response.Content.Contains($Contains)) { return $true }
                $lastError = "响应未包含 '$Contains'"
            }
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 800
    }
    if ($lastError -ne '') { Write-Warn "$Name 探测最后一次错误：$lastError" }
    return $false
}

function Show-LogTail {
    param([string]$Path, [int]$Lines = 15)
    if (Test-Path -LiteralPath $Path) {
        Write-Host "    --- $Path (最后 $Lines 行) ---" -ForegroundColor DarkYellow
        Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    }
}

function Start-Managed {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [hashtable]$ExtraEnv = @{}
    )
    $outLog = Join-Path $script:LogDir "$Name.out.log"
    $errLog = Join-Path $script:LogDir "$Name.err.log"
    foreach ($f in @($outLog, $errLog)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
    # Start-Process 不接受空参数项，先过滤掉
    $Arguments = @($Arguments | Where-Object { -not [string]::IsNullOrEmpty($_) })

    $saved = @{}
    foreach ($key in $ExtraEnv.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $ExtraEnv[$key], 'Process')
    }
    try {
        $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    } finally {
        foreach ($key in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
        }
    }

    $pidFile = Join-Path $script:RunDir "$Name.pid"
    Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ASCII
    [void]$script:Started.Add([pscustomobject]@{ Name = $Name; Pid = $proc.Id; OutLog = $outLog; ErrLog = $errLog })
    return $proc.Id
}

function Fail-Step {
    param([string]$Name, [string]$Reason, [string]$Log)
    Write-Host "    [FAIL] $Name：$Reason" -ForegroundColor Red
    Show-LogTail -Path $Log
    [void]$script:Failures.Add("$Name：$Reason")
}

# PowerShell 5.1 在 ErrorActionPreference=Stop 下会把原生命令写往 stderr 的输出
# 当成终止错误（例如 npm / mvn 的正常告警），所以统一走这两个包装函数。
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory = '', [string]$LogPath = '')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory }
        try {
            if ($LogPath) { & $FilePath @Arguments *> $LogPath } else { & $FilePath @Arguments *> $null }
            return $LASTEXITCODE
        } finally {
            if ($WorkingDirectory) { Pop-Location }
        }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Invoke-NativeOutput {
    param([string]$FilePath, [string[]]$Arguments = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text = (& $FilePath @Arguments 2>&1 | Out-String)
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $text.Trim() }
    } finally {
        $ErrorActionPreference = $previous
    }
}

# ---------------------------------------------------------------- 0. 环境

Write-Step "读取环境变量"
if ([string]::IsNullOrEmpty($EnvFile)) { $EnvFile = Join-Path $PSScriptRoot '.env' }
$loaded = Import-DotEnv -Path $EnvFile -KeepProcessEnv:$KeepProcessEnv
Write-Ok "环境文件：$EnvFile（载入 $loaded 项；文件里的值优先，要保留当前变量请加 -KeepProcessEnv）"

if ([string]::IsNullOrEmpty($Runtime)) { $Runtime = Get-EnvValue 'HDR_RUNTIME' 'D:\HDR-runtime' }
$env:HDR_RUNTIME = $Runtime
$script:LogDir = Join-Path $Runtime 'logs'
$script:RunDir = Join-Path $Runtime 'run'
New-Directory $Runtime
New-Directory $script:LogDir
New-Directory $script:RunDir

Set-Default 'SPRING_PROFILES_ACTIVE' 'default'
Set-Default 'HDR_PILOT_ENABLED' 'false'
Set-Default 'HDR_LEGACY_AUTH_ENABLED' 'false'
Set-Default 'HDR_LEGACY_BOOTSTRAP_ENABLED' 'false'
Set-Default 'SERVER_PORT' '8080'
Set-Default 'MODEL_PORT' '5001'
Set-Default 'WEB_PORT' '5173'
Set-Default 'MYSQL_PORT' '13316'
Set-Default 'REDIS_PORT' '16379'
Set-Default 'REDIS_HOST' '127.0.0.1'
Set-Default 'MODEL_SERVICE_URL' ("http://127.0.0.1:" + (Get-EnvValue 'MODEL_PORT' '5001'))
Set-Default 'TRAINING_CALLBACK_URL' ("http://127.0.0.1:" + (Get-EnvValue 'SERVER_PORT' '8080'))
Set-Default 'WEIGHTS_DIR' (Join-Path $script:RepoRoot 'model-service\weights')
Set-Default 'MODEL_REGISTRY_PATH' (Join-Path $script:RepoRoot 'model-service\weights\registry.json')
Set-Default 'HDR_COLLECTED_DIR' (Join-Path $script:RepoRoot 'collected-samples')
Set-Default 'HDR_RECOGNITION_DIR' (Join-Path $script:RepoRoot 'recognition-images')
Set-Default 'HDR_TRAINING_DATA_DIR' (Join-Path $script:RepoRoot 'training-data')
Set-Default 'TRAINING_DATA_DIR' (Join-Path $script:RepoRoot 'model-service\data\MNIST\raw')
Set-Default 'HDR_IMPORT_ROOT' ($env:SystemDrive + '\;C:\')
Set-Default 'HDR_IMPORT_PYTHON' (Get-EnvValue 'PYTHON' 'python')
Set-Default 'PYTHONIOENCODING' 'utf-8'

$python = Get-EnvValue 'PYTHON' 'python'
$node = Get-EnvValue 'NODE' 'node'
$javaHome = Get-EnvValue 'JAVA_HOME'
$mysqlPort = [int](Get-EnvValue 'MYSQL_PORT' '13316')
$redisPort = [int](Get-EnvValue 'REDIS_PORT' '16379')
$serverPort = [int](Get-EnvValue 'SERVER_PORT' '8080')
$modelPort = [int](Get-EnvValue 'MODEL_PORT' '5001')
$webPort = [int](Get-EnvValue 'WEB_PORT' '5173')

$mvn = Get-EnvValue 'MAVEN_BIN' 'mvn'
$mvnSettings = Get-EnvValue 'MAVEN_SETTINGS'
$mysqld = Get-EnvValue 'MYSQLD_EXE' 'mysqld'
$mysqladmin = Get-EnvValue 'MYSQLADMIN_EXE' 'mysqladmin'
$mysqlBase = Get-EnvValue 'MYSQL_BASEDIR'
$mysqlData = Get-EnvValue 'MYSQL_DATADIR' (Join-Path $Runtime 'mysql\data')
$redisServer = Get-EnvValue 'REDIS_SERVER_EXE' 'redis-server'
$redisCli = Get-EnvValue 'REDIS_CLI_EXE' 'redis-cli'

Write-Step "检查依赖与目录"
$missing = New-Object System.Collections.ArrayList
foreach ($c in @($python, $node, $mysqld, $redisServer)) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $c)) { [void]$missing.Add($c) }
}
if ($missing.Count -gt 0) {
    Write-Host "缺少可执行文件：$($missing -join ', ')" -ForegroundColor Red
    Write-Host "请在 scripts/.env 里指定正确路径（模板见 scripts/.env.example）" -ForegroundColor Red
    exit 1
}
foreach ($d in @((Get-EnvValue 'HDR_COLLECTED_DIR'), (Get-EnvValue 'HDR_RECOGNITION_DIR'), (Get-EnvValue 'HDR_TRAINING_DATA_DIR'), (Get-EnvValue 'WEIGHTS_DIR'), $mysqlData)) {
    New-Directory $d
}
Write-Ok "python : $python"
Write-Ok "node   : $node"
Write-Ok "mysqld : $mysqld"
Write-Ok "redis  : $redisServer"

$jar = Join-Path $script:RepoRoot 'backend\target\hdr-backend-0.1.0-SNAPSHOT.jar'
$frontendDir = Join-Path $script:RepoRoot 'frontend'
$viteEntry = Join-Path $frontendDir 'node_modules\vite\bin\vite.js'

if ($Build -or -not (Test-Path -LiteralPath $jar)) {
    Write-Step "构建后端 jar（mvn package -DskipTests）"
    if (-not $javaHome) {
        Write-Host "需要 JAVA_HOME 才能构建，请在 scripts/.env 里设置" -ForegroundColor Red
        exit 1
    }
    $env:JAVA_HOME = $javaHome
    $mvnArgs = @('-B', '-ntp')
    if ($mvnSettings -and (Test-Path -LiteralPath $mvnSettings)) { $mvnArgs += @('-s', $mvnSettings) }
    $mvnArgs += @('-DskipTests', 'package')
    Push-Location (Join-Path $script:RepoRoot 'backend')
    try {
        $mvnExit = Invoke-Native -FilePath $mvn -Arguments $mvnArgs -LogPath (Join-Path $script:LogDir 'mvn-package.log')
    } finally { Pop-Location }
    if ($mvnExit -ne 0 -or -not (Test-Path -LiteralPath $jar)) {
        Fail-Step '后端构建' "mvn package 失败（退出码 $mvnExit）" (Join-Path $script:LogDir 'mvn-package.log')
        exit 1
    }
    Write-Ok "已生成 $jar"
}

if (($Build -or -not (Test-Path -LiteralPath $viteEntry)) -and -not $SkipFrontend) {
    Write-Step "安装前端依赖（npm ci）"
    $npmExit = Invoke-Native -FilePath (Get-EnvValue 'NPM_BIN' 'npm') -Arguments @('ci', '--no-audit', '--no-fund') `
        -WorkingDirectory $frontendDir -LogPath (Join-Path $script:LogDir 'npm-ci.log')
    if ($npmExit -ne 0) {
        Write-Warn "npm ci 退出码 $npmExit（部分 npm 版本因安装脚本策略返回非 0，若 vite 可用可忽略）"
    } else { Write-Ok "前端依赖就绪" }
}

# ---------------------------------------------------------------- 1. MySQL

Write-Step "MySQL（端口 $mysqlPort）"
$existing = Get-ListeningPid -Port $mysqlPort
if ($existing) {
    Write-Skip "端口已在监听（PID $existing），跳过启动"
} else {
    if (-not (Test-Path -LiteralPath $mysqlData)) {
        Write-Warn "数据目录不存在，执行初始化：$mysqlData"
        New-Directory $mysqlData
        $initArgs = @('--no-defaults', '--initialize-insecure', "--basedir=$mysqlBase", "--datadir=$mysqlData")
        $initExit = Invoke-Native -FilePath $mysqld -Arguments $initArgs -LogPath (Join-Path $script:LogDir 'mysql-init.log')
        if ($initExit -ne 0) { Fail-Step 'MySQL' '初始化失败' (Join-Path $script:LogDir 'mysql-init.log'); }
        else { Write-Ok '数据目录已初始化（root 空密码，稍后由部署步骤设置）' }
    }
    $args = @('--no-defaults', "--basedir=$mysqlBase", "--datadir=$mysqlData",
              "--port=$mysqlPort", '--bind-address=127.0.0.1', '--mysqlx=OFF', '--default-time-zone=+00:00', '--console')
    [void](Start-Managed -Name 'mysql' -FilePath $mysqld -Arguments $args -WorkingDirectory $mysqlBase)
    if (-not (Wait-TcpPort -Port $mysqlPort -Seconds $TimeoutSeconds -Name 'MySQL')) {
        Fail-Step 'MySQL' '端口未就绪' (Join-Path $script:LogDir 'mysql.err.log')
    } else { Write-Ok "已启动（PID $(Get-ListeningPid -Port $mysqlPort)）" }
}

# ---------------------------------------------------------------- 2. Redis

Write-Step "Redis（端口 $redisPort）"
$existing = Get-ListeningPid -Port $redisPort
if ($existing) {
    Write-Skip "端口已在监听（PID $existing），跳过启动"
} else {
    $args = @('--port', "$redisPort", '--bind', '127.0.0.1', '--appendonly', 'no')
    [void](Start-Managed -Name 'redis' -FilePath $redisServer -Arguments $args -WorkingDirectory (Split-Path -Parent $redisServer))
    if (-not (Wait-TcpPort -Port $redisPort -Seconds $TimeoutSeconds -Name 'Redis')) {
        Fail-Step 'Redis' '端口未就绪' (Join-Path $script:LogDir 'redis.err.log')
    } else {
        $pong = ''
        if (Get-Command $redisCli -ErrorAction SilentlyContinue) { $pong = (Invoke-NativeOutput -FilePath $redisCli -Arguments @('-h', '127.0.0.1', '-p', "$redisPort", 'ping')).Output }
        Write-Ok "已启动（PID $(Get-ListeningPid -Port $redisPort)，PING=$pong）"
    }
}

# ---------------------------------------------------------------- 3. 模型服务

Write-Step "模型服务（端口 $modelPort）"
$existing = Get-ListeningPid -Port $modelPort
if ($existing) {
    Write-Skip "端口已在监听（PID $existing），跳过启动"
} else {
    $token = Get-EnvValue 'MODEL_INTERNAL_TOKEN'
    if ([string]::IsNullOrEmpty($token)) { Write-Warn 'MODEL_INTERNAL_TOKEN 为空：内部识别接口会被拒绝，请在 scripts/.env 里设置' }
    if (-not (Test-Path -LiteralPath (Get-EnvValue 'MODEL_REGISTRY_PATH'))) {
        Write-Warn "注册表不存在：$(Get-EnvValue 'MODEL_REGISTRY_PATH')（先跑 scripts/fetch-weights.ps1）"
    }
    $args = @('-I', (Join-Path $script:RepoRoot 'model-service\serve.py'))
    [void](Start-Managed -Name 'model-service' -FilePath $python -Arguments $args -WorkingDirectory $script:RepoRoot)
    $url = "http://127.0.0.1:$modelPort/api/v1/health"
    if (-not (Wait-HttpOk -Url $url -Seconds $TimeoutSeconds -Name '模型服务' -Contains 'UP')) {
        Fail-Step '模型服务' "健康检查失败 $url" (Join-Path $script:LogDir 'model-service.err.log')
    } else { Write-Ok "健康 $url" }
}

# ---------------------------------------------------------------- 4. 后端

Write-Step "后端（端口 $serverPort）"
$existing = Get-ListeningPid -Port $serverPort
if ($existing) {
    Write-Skip "端口已在监听（PID $existing），跳过启动"
} else {
    if ($javaHome) { $javaExe = Join-Path $javaHome 'bin\java.exe' } else { $javaExe = 'java' }
    $args = @('-Dfile.encoding=UTF-8', '-jar', $jar)
    [void](Start-Managed -Name 'backend' -FilePath $javaExe -Arguments $args -WorkingDirectory $script:RepoRoot)
    $url = "http://127.0.0.1:$serverPort/api/health"
    if (-not (Wait-HttpOk -Url $url -Seconds $TimeoutSeconds -Name '后端' -Contains 'UP')) {
        Fail-Step '后端' "健康检查失败 $url" (Join-Path $script:LogDir 'backend.out.log')
    } else { Write-Ok "健康 $url" }
}

# ---------------------------------------------------------------- 5. 训练 worker

if ($SkipWorker) {
    Write-Step "训练 worker"
    Write-Skip "按参数跳过（-SkipWorker）"
} else {
    Write-Step "训练 worker（Celery 队列 training）"
    $hb = ''
    if (Get-Command $redisCli -ErrorAction SilentlyContinue) {
        $hb = (Invoke-NativeOutput -FilePath $redisCli -Arguments @('-h', '127.0.0.1', '-p', "$redisPort", 'exists', 'training:worker:heartbeat')).Output
    }
    if ($hb -eq '1') {
        Write-Skip "heartbeat 已存在，worker 看来已在运行"
    } else {
        # 注意：这里不能用 python -I（隔离模式会把 cwd 从 sys.path 移除），
        # 训练代码里有 from models.cnn import ... 依赖工作目录 model-service。
        $args = @('-m', 'celery', '-A', 'celery_app:celery_app', 'worker',
                  '--pool=solo', '-Q', 'training', '--loglevel=INFO', '--hostname', 'hdr-worker-1@%h')
        [void](Start-Managed -Name 'worker' -FilePath $python -Arguments $args -WorkingDirectory (Join-Path $script:RepoRoot 'model-service'))
        $deadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 60))
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 1000
            if (Get-Command $redisCli -ErrorAction SilentlyContinue) {
                $alive = (Invoke-NativeOutput -FilePath $redisCli -Arguments @('-h', '127.0.0.1', '-p', "$redisPort", 'exists', 'training:worker:heartbeat')).Output
                if ($alive -eq '1') { $ready = $true; break }
            }
        }
        if ($ready) { Write-Ok 'worker 已上报 heartbeat' }
        else { Fail-Step '训练 worker' '未在预期时间内上报 training:worker:heartbeat' (Join-Path $script:LogDir 'worker.err.log') }
    }
}

# ---------------------------------------------------------------- 6. 前端

if ($SkipFrontend) {
    Write-Step "前端"
    Write-Skip "按参数跳过（-SkipFrontend）"
} else {
    Write-Step "前端（Vite 开发服务器，端口 $webPort）"
    $existing = Get-ListeningPid -Port $webPort
    if ($existing) {
        Write-Skip "端口已在监听（PID $existing），跳过启动"
    } else {
        $args = @($viteEntry, '--host', '127.0.0.1', '--port', "$webPort", '--strictPort')
        [void](Start-Managed -Name 'frontend' -FilePath $node -Arguments $args -WorkingDirectory $frontendDir)
        $url = "http://127.0.0.1:$webPort/"
        if (-not (Wait-HttpOk -Url $url -Seconds $TimeoutSeconds -Name '前端')) {
            Fail-Step '前端' "页面不可访问 $url" (Join-Path $script:LogDir 'frontend.out.log')
        } else { Write-Ok "可访问 $url" }
    }
}

# ---------------------------------------------------------------- 汇总

Write-Step "汇总"
$rows = @(
    [pscustomobject]@{ 服务 = 'MySQL';      地址 = "127.0.0.1:$mysqlPort";     端口 = $mysqlPort }
    [pscustomobject]@{ 服务 = 'Redis';      地址 = "127.0.0.1:$redisPort";     端口 = $redisPort }
    [pscustomobject]@{ 服务 = '模型服务';    地址 = "http://127.0.0.1:$modelPort/api/v1/health"; 端口 = $modelPort }
    [pscustomobject]@{ 服务 = '后端';       地址 = "http://127.0.0.1:$serverPort/api/health";    端口 = $serverPort }
    [pscustomobject]@{ 服务 = '前端';       地址 = "http://127.0.0.1:$webPort";                  端口 = $webPort }
)
foreach ($row in $rows) {
    $up = Get-ListeningPid -Port $row.端口
    $state = 'DOWN'
    if ($up) { $state = "UP (PID $up)" }
    Write-Host ("    {0,-8} {1,-52} {2}" -f $row.服务, $row.地址, $state)
}
Write-Host ""
Write-Host "    日志目录：$script:LogDir"
Write-Host "    PID 目录：$script:RunDir"
Write-Host "    停止全部：powershell -ExecutionPolicy Bypass -File scripts/stop-all.ps1"

if ($script:Failures.Count -gt 0) {
    Write-Host ""
    Write-Host "启动未全部成功：" -ForegroundColor Red
    foreach ($f in $script:Failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}

Write-Host ""
Write-Host "全部服务已就绪。登录地址 http://127.0.0.1:$webPort/login" -ForegroundColor Green
exit 0
