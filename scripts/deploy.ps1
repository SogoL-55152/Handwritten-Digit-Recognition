#requires -Version 5.1
<#
.SYNOPSIS
    一键部署（本机模式，不依赖 Docker）。

.DESCRIPTION
    给没有安装 Docker 的 Windows 机器使用：检测运行时 → 生成 scripts/.env →
    准备 MySQL/Redis → 建库与账号 → 准备 Python 环境 → 构建 → 启动全部服务。

    参数：
      -Force            重新生成 scripts/.env、重建 .venv
      -SkipDeps         跳过 Python 环境与权重准备
      -SkipBuild        跳过后端打包与前端依赖安装
      -SkipFrontend     不启动前端（只跑 API）
      -CheckOnly        只做环境检测，不写文件、不启动
      -NoOpen           启动成功后不自动打开浏览器
      -EnvFile <path>   指定环境文件（默认 scripts/.env）
      -Database <name>  数据库名（默认 hdr_w2_it_live）
      -MysqlRootPassword <pwd>  MySQL root 密码（新建库/账号时需要）
      -Port <n>         前端端口（默认 5173）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipDeps,
    [switch]$SkipBuild,
    [switch]$SkipFrontend,
    [switch]$CheckOnly,
    [switch]$NoOpen,
    [switch]$InstallMissing,
    [string]$EnvFile,
    [string]$Database = 'hdr_w2_it_live',
    [string]$MysqlRootPassword,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:EnvPath = if ([string]::IsNullOrWhiteSpace($EnvFile)) { Join-Path $PSScriptRoot '.env' } else { $EnvFile }
$script:Runtime = 'D:\HDR-runtime'
$script:Problems = New-Object System.Collections.ArrayList
New-Item -ItemType Directory -Force -Path (Join-Path $script:Runtime 'logs') | Out-Null

# ---------------------------------------------------------------- 输出

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "    [OK] $Text" -ForegroundColor Green
}

function Write-Warn2 {
    param([string]$Text)
    Write-Host "    [!]  $Text" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host "    [X]  $Text" -ForegroundColor Red
    [void]$script:Problems.Add($Text)
}

# ---------------------------------------------------------------- 工具函数

function Read-EnvFile {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed.StartsWith('#')) { continue }
        $index = $trimmed.IndexOf('=')
        if ($index -le 0) { continue }
        $key = $trimmed.Substring(0, $index).Trim()
        $value = $trimmed.Substring($index + 1).Trim()
        $map[$key] = $value
    }
    return $map
}

function New-Secret {
    param([int]$Length = 32)
    $bytes = [byte[]]::new($Length)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $text = [Convert]::ToBase64String($bytes)
    $text = $text -replace '[+/=]', ''
    while ($text.Length -lt $Length) { $text += ((New-Guid).ToString('N') -replace '-', '') }
    return $text.Substring(0, $Length)
}

function Find-Tool {
    param([string]$Name, [string[]]$Candidates)
    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Test-PythonDeps {
    param([string]$PythonPath)
    if (-not $PythonPath) { return $false }
    if (-not (Test-Path -LiteralPath $PythonPath)) { return $false }
    # 只用退出码判断：PowerShell 5.1 传参给原生程序会吃掉引号，带引号的表达式不可靠
    $probe = 'import torch, flask, celery, waitress, numpy, PIL, redis, requests'
    try {
        & $PythonPath -I -c $probe 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-Port {
    param([int]$PortNumber)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $PortNumber)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Wait-Port {
    param([int]$PortNumber, [int]$Seconds = 45)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port -PortNumber $PortNumber) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Invoke-Mysql {
    param([string[]]$Arguments)
    # mysql 会把 “密码在命令行不安全” 写到 stderr；在本脚本的 Stop 模式下会变成终止错误
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $script:MysqlClient @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return @{ Code = $code; Output = ($output -join "`n") }
}

function Save-EnvMap {
    $lines = @('# 由 scripts/deploy.ps1 生成；请勿提交到 git')
    foreach ($key in ($script:Map.Keys | Sort-Object)) { $lines += "$key=$($script:Map[$key])" }
    Set-Content -LiteralPath $script:EnvPath -Value $lines -Encoding UTF8
}

# ---------------------------------------------------------------- ① 环境检测

Write-Step '① 检测环境'
Write-Host "    仓库：$script:RepoRoot"
Write-Host "    环境文件：$script:EnvPath"

$envMap = Read-EnvFile -Path $script:EnvPath
$script:Map = $envMap
$forceAll = $Force.IsPresent

$javaHome = $envMap['JAVA_HOME']
if ($env:JAVA_HOME -and -not $javaHome) { $javaHome = $env:JAVA_HOME }
$javaExe = $null
if ($javaHome -and (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    $javaExe = Join-Path $javaHome 'bin\java.exe'
} else {
    $javaExe = Find-Tool -Name 'java.exe' -Candidates @()
    if ($javaExe) { $javaHome = Split-Path -Parent (Split-Path -Parent $javaExe) }
}

$nodeExe = Find-Tool -Name 'node.exe' -Candidates @($envMap['NODE'])
$nodeDir = if ($nodeExe) { Split-Path -Parent $nodeExe } else { $null }

$pythonExe = Find-Tool -Name 'python.exe' -Candidates @($envMap['PYTHON'])
$pythonHealthy = Test-PythonDeps -PythonPath $pythonExe

$mvnExe = Find-Tool -Name 'mvn.cmd' -Candidates @($envMap['MAVEN_BIN'])
$mvnSettings = $envMap['MAVEN_SETTINGS']

$mysqlCandidate = Find-Tool -Name 'mysqld.exe' -Candidates @($envMap['MYSQLD_EXE'], $envMap['MYSQL_BASEDIR'], ($envMap['MYSQL_BASEDIR'] + '\bin\mysqld.exe'))
$mysqlBase = $null
if ($mysqlCandidate) {
    if ($mysqlCandidate -like '*\bin\mysqld.exe') { $mysqlBase = Split-Path -Parent (Split-Path -Parent $mysqlCandidate) }
    elseif (Test-Path (Join-Path $mysqlCandidate 'bin\mysqld.exe')) { $mysqlBase = $mysqlCandidate }
}
$mysqlClient = $null
if ($mysqlBase) { $mysqlClient = Join-Path $mysqlBase 'bin\mysql.exe' }
$script:MysqlClient = $mysqlClient

$redisExe = Find-Tool -Name 'redis-server.exe' -Candidates @($envMap['REDIS_SERVER_EXE'])
$redisCli = Find-Tool -Name 'redis-cli.exe' -Candidates @($envMap['REDIS_CLI_EXE'])

$checks = @(
    @{ Name = 'JDK 17'; Ok = ($javaExe -and (Test-Path $javaExe)); Hint = '安装 JDK 17：winget install --id Microsoft.OpenJDK.17，并设置 JAVA_HOME' },
    @{ Name = 'Node 20+'; Ok = ($nodeExe -and (Test-Path $nodeExe)); Hint = '安装 Node 20 LTS：winget install --id OpenJS.NodeJS.LTS' },
    @{ Name = 'Python 3.11'; Ok = ($pythonExe -and (Test-Path $pythonExe)); Hint = '安装 Python 3.11：winget install --id Python.Python.3.11' },
    @{ Name = 'Maven'; Ok = ($mvnExe -or (Test-Path (Join-Path $script:RepoRoot 'backend\target'))); Hint = '安装 Maven 3.9，或先准备好 backend\target 下的 jar' },
    @{ Name = 'MySQL 8'; Ok = ($mysqlBase -and (Test-Path $mysqlBase) -and (Test-Path $mysqlClient)); Hint = '安装 MySQL 8.0，或在 scripts/.env 指定 MYSQL_BASEDIR' },
    @{ Name = 'Redis 7'; Ok = ($redisExe -and (Test-Path $redisExe)); Hint = '安装 Redis 7，或在 scripts/.env 指定 REDIS_SERVER_EXE' }
)
foreach ($check in $checks) {
    if ($check.Ok) { Write-Ok $check.Name } else { Write-Fail "$($check.Name) —— $($check.Hint)" }
}

$pythonNote = if ($pythonHealthy) { '（torch/flask/celery 已就绪）' } else { '（缺少 torch 等依赖，部署时会安装）' }
if ($pythonExe) { Write-Ok "Python $pythonExe $pythonNote" } else { Write-Fail '找不到 Python：请安装 Python 3.11 并加入 PATH' }

$serverPort = if ($envMap['SERVER_PORT']) { [int]$envMap['SERVER_PORT'] } else { 8080 }
$modelPort = if ($envMap['MODEL_PORT']) { [int]$envMap['MODEL_PORT'] } else { 5001 }
$webPort = if ($Port -gt 0) { $Port } elseif ($envMap['WEB_PORT']) { [int]$envMap['WEB_PORT'] } else { 5173 }
$mysqlPort = if ($envMap['MYSQL_PORT']) { [int]$envMap['MYSQL_PORT'] } else { 13316 }
$redisPort = if ($envMap['REDIS_PORT']) { [int]$envMap['REDIS_PORT'] } else { 16379 }

$busy = @()
foreach ($pair in @(@{ Port = $serverPort; Name = '后端' }, @{ Port = $modelPort; Name = '模型服务' }, @{ Port = $webPort; Name = '前端' }, @{ Port = $mysqlPort; Name = 'MySQL' }, @{ Port = $redisPort; Name = 'Redis' })) {
    if (Test-Port -PortNumber $pair.Port) { $busy += "$($pair.Name) $($pair.Port)" }
}
if ($busy.Count -eq 0) { Write-Ok "端口空闲：$serverPort / $modelPort / $webPort / $mysqlPort / $redisPort" }
else { Write-Warn2 "端口已被占用（服务可能已在运行）：$($busy -join '，')" }

$registry = Join-Path $script:RepoRoot 'model-service\weights\registry.json'
$jar = Get-ChildItem -Path (Join-Path $script:RepoRoot 'backend\target') -Filter '*.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeModules = Test-Path (Join-Path $script:RepoRoot 'frontend\node_modules')
if (Test-Path $registry) { Write-Ok '权重已就绪' } else { Write-Warn2 '缺权重：部署时会执行 scripts/fetch-weights.ps1' }
if ($jar) { Write-Ok "后端 jar 已存在：$($jar.Name)" } else { Write-Warn2 '缺后端 jar：部署时会执行 mvn package' }
if ($nodeModules) { Write-Ok '前端依赖已存在' } else { Write-Warn2 '缺前端依赖：部署时会执行 npm ci' }

if ($script:Problems.Count -gt 0) {
    Write-Host ''
    if ($InstallMissing) {
        Write-Host '尝试安装缺失依赖（scripts/install-deps.ps1）...' -ForegroundColor Yellow
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-deps.ps1') -Yes
        Write-Host ''
        Write-Host '安装完成后请重新运行 deploy.bat（新装的 PATH 需要新终端生效）。' -ForegroundColor Yellow
        exit 0
    }
    Write-Host '环境不满足，已停止。' -ForegroundColor Red
    Write-Host '可以运行 scripts\install-deps.ps1 自动安装，或加 -InstallMissing 参数重跑本脚本。' -ForegroundColor Yellow
    exit 2
}

if ($CheckOnly) {
    Write-Host ''
    Write-Host '检查通过（-CheckOnly 不写文件、不启动服务）。' -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- ② 生成 scripts/.env

Write-Step '② 生成配置'
if (-not (Test-Path $script:EnvPath) -or $forceAll) { $script:Generated = $true } else { $script:Generated = $false }

function Set-IfMissing {
    param([string]$Key, [string]$Value)
    if ($forceAll -or -not $script:Map.ContainsKey($Key) -or [string]::IsNullOrWhiteSpace($script:Map[$Key])) {
        $script:Map[$Key] = $Value
        $script:Generated = $true
    }
}

Set-IfMissing 'DB_PASSWORD' (New-Secret 24)
Set-IfMissing 'V2_JWT_SECRET' (New-Secret 40)
Set-IfMissing 'JWT_SECRET' (New-Secret 40)
Set-IfMissing 'MODEL_INTERNAL_TOKEN' (New-Secret 32)
Set-IfMissing 'MYSQL_ADMIN_PASSWORD' (New-Secret 24)
Set-IfMissing 'HDR_BOOTSTRAP_ADMIN_USERNAME' 'admin'
Set-IfMissing 'HDR_BOOTSTRAP_ADMIN_PASSWORD' (New-Secret 16)
$script:Map['DB_URL'] = "jdbc:mysql://127.0.0.1:$mysqlPort/$Database`?useUnicode=true&characterEncoding=utf8&serverTimezone=UTC&allowPublicKeyRetrieval=true&useSSL=false"
$script:Map['DB_USERNAME'] = 'hdr'
if ($javaHome) { $script:Map['JAVA_HOME'] = $javaHome }
if ($nodeExe) { $script:Map['NODE'] = $nodeExe }
if ($pythonExe) { $script:Map['PYTHON'] = $pythonExe }
if ($mysqlBase) {
    $script:Map['MYSQL_BASEDIR'] = $mysqlBase
    $script:Map['MYSQLD_EXE'] = Join-Path $mysqlBase 'bin\mysqld.exe'
    $script:Map['MYSQLADMIN_EXE'] = Join-Path $mysqlBase 'bin\mysqladmin.exe'
}
if ($envMap['MYSQL_DATADIR']) { $script:Map['MYSQL_DATADIR'] = $envMap['MYSQL_DATADIR'] }
if ($redisExe) { $script:Map['REDIS_SERVER_EXE'] = $redisExe }
if ($redisCli) { $script:Map['REDIS_CLI_EXE'] = $redisCli }
$script:Map['MYSQL_PORT'] = "$mysqlPort"
$script:Map['REDIS_PORT'] = "$redisPort"
$script:Map['SERVER_PORT'] = "$serverPort"
$script:Map['MODEL_PORT'] = "$modelPort"
$script:Map['WEB_PORT'] = "$webPort"
$script:Map['SPRING_PROFILES_ACTIVE'] = 'default'
$script:Map['HDR_PILOT_ENABLED'] = 'false'
$script:Map['HDR_LEGACY_AUTH_ENABLED'] = 'false'
$script:Map['HDR_LEGACY_BOOTSTRAP_ENABLED'] = 'false'
$script:Map['MODEL_SERVICE_URL'] = "http://127.0.0.1:$modelPort"
$script:Map['REDIS_URL'] = "redis://127.0.0.1:$redisPort/0"
$script:Map['REDIS_HOST'] = '127.0.0.1'
$script:Map['WEIGHTS_DIR'] = Join-Path $script:RepoRoot 'model-service\weights'
$script:Map['MODEL_REGISTRY_PATH'] = Join-Path $script:RepoRoot 'model-service\weights\registry.json'
$script:Map['HDR_COLLECTED_DIR'] = Join-Path $script:RepoRoot 'collected-samples'
$script:Map['HDR_RECOGNITION_DIR'] = Join-Path $script:RepoRoot 'recognition-images'
$script:Map['HDR_TRAINING_DATA_DIR'] = Join-Path $script:RepoRoot 'training-data'
$script:Map['TRAINING_DATA_DIR'] = Join-Path $script:RepoRoot 'model-service\data\MNIST\raw'
$script:Map['TRAINING_CALLBACK_URL'] = "http://127.0.0.1:$serverPort"
$script:Map['HDR_IMPORT_ROOT'] = 'D:\;C:\'
$script:Map['HDR_IMPORT_PYTHON'] = $script:Map['PYTHON']
$script:Map['HDR_IMPORT_SCRIPT'] = 'model-service/tools/svhn_import.py'
$script:Map['MYSQL_ADMIN_USER'] = 'root'

if ($script:Generated) {
    Save-EnvMap
    Write-Ok "已写入 $script:EnvPath"
} else {
    Write-Ok "复用现有 $script:EnvPath"
}

# ---------------------------------------------------------------- ③ 启动 MySQL / Redis 并建库

Write-Step '③ 准备数据库'
$datadir = if ($script:Map['MYSQL_DATADIR']) { $script:Map['MYSQL_DATADIR'] } else { Join-Path $script:Runtime 'mysql\data' }

if (-not (Test-Port -PortNumber $mysqlPort)) {
    if (-not (Test-Path (Join-Path $datadir 'mysql'))) {
        Write-Host "    初始化 MySQL 数据目录：$datadir"
        New-Item -ItemType Directory -Force -Path $datadir | Out-Null
        & $script:Map['MYSQLD_EXE'] '--no-defaults' "--basedir=$($script:Map['MYSQL_BASEDIR'])" "--datadir=$datadir" '--initialize-insecure' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "MySQL 初始化失败（$datadir）" }
    }
    Write-Host "    启动 MySQL（端口 $mysqlPort）"
    Start-Process -FilePath $script:Map['MYSQLD_EXE'] -ArgumentList @('--no-defaults', "--basedir=$($script:Map['MYSQL_BASEDIR'])", "--datadir=$datadir", '--bind-address=127.0.0.1', "--port=$mysqlPort", '--mysqlx=OFF', '--default-time-zone=+00:00', '--console') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:Runtime 'logs\mysql.out.log') -RedirectStandardError (Join-Path $script:Runtime 'logs\mysql.err.log')
    if (-not (Wait-Port -PortNumber $mysqlPort -Seconds 60)) { throw "MySQL 未在 60 秒内就绪（$datadir）" }
}
Write-Ok "MySQL 已就绪（$mysqlPort）"

if (-not (Test-Port -PortNumber $redisPort)) {
    Start-Process -FilePath $script:Map['REDIS_SERVER_EXE'] -ArgumentList @('--port', "$redisPort", '--bind', '127.0.0.1') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:Runtime 'logs\redis.out.log') -RedirectStandardError (Join-Path $script:Runtime 'logs\redis.err.log')
    if (-not (Wait-Port -PortNumber $redisPort -Seconds 30)) { throw 'Redis 未在 30 秒内就绪' }
}
Write-Ok "Redis 已就绪（$redisPort）"

$dbPassword = $script:Map['DB_PASSWORD']
$hdrProbe = Invoke-Mysql @('-h', '127.0.0.1', "-P$mysqlPort", '-uhdr', "--password=$dbPassword", '-D', $Database, '-e', 'SELECT 1')
if ($hdrProbe.Code -eq 0) {
    Write-Ok "数据库 $Database 可访问（用户 hdr）"
} else {
    $rootPassword = if ($MysqlRootPassword) { $MysqlRootPassword } else { $script:Map['MYSQL_ADMIN_PASSWORD'] }
    $rootProbe = Invoke-Mysql @('-h', '127.0.0.1', "-P$mysqlPort", '-uroot', "--password=$rootPassword", '-e', 'SELECT 1')
    if ($rootProbe.Code -ne 0) {
        $rootProbe = Invoke-Mysql @('-h', '127.0.0.1', "-P$mysqlPort", '-uroot', '-e', 'SELECT 1')
        if ($rootProbe.Code -eq 0) {
            $newRoot = New-Secret 40
            Invoke-Mysql @('-h', '127.0.0.1', "-P$mysqlPort", '-uroot', '-e', "ALTER USER 'root'@'localhost' IDENTIFIED BY '$newRoot'") | Out-Null
            $script:Map['MYSQL_ADMIN_PASSWORD'] = $newRoot
            $rootPassword = $newRoot
            Write-Warn2 '检测到空密码 root，已设置随机密码并写入 scripts/.env'
        } else {
            throw '无法连接 MySQL（hdr / root 都失败）：请检查 scripts/.env 的 MYSQL_ADMIN_PASSWORD，或用 -MysqlRootPassword 传入 root 密码'
        }
    }
    $sql = @(
        "CREATE DATABASE IF NOT EXISTS $Database CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
        "CREATE USER IF NOT EXISTS 'hdr'@'%' IDENTIFIED BY '$dbPassword'",
        "ALTER USER 'hdr'@'%' IDENTIFIED BY '$dbPassword'",
        "GRANT ALL PRIVILEGES ON $Database.* TO 'hdr'@'%'",
        'FLUSH PRIVILEGES'
    ) -join ';'
    $created = Invoke-Mysql @('-h', '127.0.0.1', "-P$mysqlPort", '-uroot', "--password=$rootPassword", '-e', $sql)
    if ($created.Code -ne 0) { throw "创建数据库/账号失败：$($created.Output)" }
    Write-Ok "已创建数据库 $Database 与用户 hdr"
    Save-EnvMap
}

# ---------------------------------------------------------------- ④ Python 环境

Write-Step '④ 准备 Python 环境'
$venvPython = Join-Path $script:RepoRoot '.venv\Scripts\python.exe'
if ($SkipDeps) {
    Write-Warn2 '已跳过（-SkipDeps）'
} elseif ($pythonHealthy) {
    Write-Ok "复用已就绪的 Python：$($script:Map['PYTHON'])"
} elseif (-not (Test-Path $venvPython) -or $forceAll) {
    Write-Host "    创建 .venv：$venvPython"
    & $script:Map['PYTHON'] -m venv (Join-Path $script:RepoRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw '创建 .venv 失败' }
    & $venvPython -I -m pip install --upgrade pip 2>&1 | Out-Null
    $requirements = @(
        (Join-Path $script:RepoRoot 'model-service\requirements.txt'),
        (Join-Path $script:RepoRoot 'model-service\requirements-worker.txt')
    ) | Where-Object { Test-Path $_ }
    Write-Host '    安装依赖（首次会下载 torch，约 200 MB，请耐心等待）'
    foreach ($reqFile in $requirements) { & $venvPython -I -m pip install -r $reqFile }
    & $venvPython -I -m pip install waitress 'torch==2.6.0'
    if ($LASTEXITCODE -ne 0) { throw 'Python 依赖安装失败' }
    $script:Map['PYTHON'] = $venvPython
    $script:Map['HDR_IMPORT_PYTHON'] = $venvPython
    Write-Ok "Python 环境就绪：$venvPython"
    Save-EnvMap
} else {
    Write-Ok "复用 .venv：$venvPython"
    $script:Map['PYTHON'] = $venvPython
    $script:Map['HDR_IMPORT_PYTHON'] = $venvPython
}

# ---------------------------------------------------------------- ⑤ 权重与构建

Write-Step '⑤ 准备权重与构建'
if (-not $SkipDeps) {
    if (-not (Test-Path (Join-Path $script:RepoRoot 'model-service\weights\registry.json'))) {
        Write-Host '    下载基线权重'
        & (Join-Path $PSScriptRoot 'fetch-weights.ps1')
        if ($LASTEXITCODE -ne 0) { throw '权重下载失败：请检查网络/代理，或手动放到 model-service\weights' }
    }
    Write-Ok '权重已就绪'
} else {
    Write-Warn2 '跳过权重检查（-SkipDeps）'
}

$jar = Get-ChildItem -Path (Join-Path $script:RepoRoot 'backend\target') -Filter '*.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $SkipBuild -and -not $jar) {
    Write-Host '    构建后端（mvn package）'
    Push-Location (Join-Path $script:RepoRoot 'backend')
    try {
        $mvnArgs = @('package', '-DskipTests', '-B')
        if ($mvnSettings) { $mvnArgs += @('-s', $mvnSettings) }
        & $mvnExe @mvnArgs
        if ($LASTEXITCODE -ne 0) { throw '后端构建失败（mvn package）' }
    } finally {
        Pop-Location
    }
    Write-Ok '后端 jar 构建完成'
}

if (-not $SkipBuild -and -not (Test-Path (Join-Path $script:RepoRoot 'frontend\node_modules'))) {
    Write-Host '    安装前端依赖（npm ci）'
    Push-Location (Join-Path $script:RepoRoot 'frontend')
    try {
        & (Join-Path $nodeDir 'npm.cmd') 'ci'
        if ($LASTEXITCODE -ne 0) { Write-Warn2 'npm ci 返回非 0（若 vite 可用可忽略）' }
    } finally {
        Pop-Location
    }
    Write-Ok '前端依赖安装完成'
}

# ---------------------------------------------------------------- ⑥ 启动

Write-Step '⑥ 启动服务'
$startArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-all.ps1'), '-EnvFile', $script:EnvPath)
if ($SkipFrontend) { $startArgs += '-SkipFrontend' }
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & powershell @startArgs
    $startCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previous
}
if ($startCode -ne 0) {
    Write-Fail '服务启动失败：请查看 D:\HDR-runtime\logs 下的日志'
    exit 1
}

# ---------------------------------------------------------------- ⑦ 结果

Write-Step '⑦ 完成'
$url = "http://127.0.0.1:$webPort/login"
Write-Host "    访问：$url" -ForegroundColor Green
Write-Host "    账号：$($script:Map['HDR_BOOTSTRAP_ADMIN_USERNAME'])" -ForegroundColor Green
Write-Host "    密码：$($script:Map['HDR_BOOTSTRAP_ADMIN_PASSWORD'])（也写入 scripts/.env）" -ForegroundColor Green
Write-Host "    数据库：$Database（$mysqlPort）"
Write-Host '    停止：powershell -ExecutionPolicy Bypass -File scripts/stop-all.ps1'
if (-not $NoOpen -and -not $SkipFrontend) { Start-Process $url }
