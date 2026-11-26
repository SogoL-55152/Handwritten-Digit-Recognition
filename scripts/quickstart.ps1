#Requires -Version 5.1
<#
.SYNOPSIS
    一键启动：clone 仓库后运行本脚本即可。
    优先使用 Docker Compose（只需装 Docker）；没有 Docker 时退回本机脚本 scripts/start-all.ps1。

.DESCRIPTION
    1) 生成 .env（随机数据库密码 / JWT 密钥 / 内部 token / 管理员密码），已存在则复用
    2) 确保基线权重存在（没有则调用 scripts/fetch-weights.ps1）
    3) docker compose up -d --build，等待前端可访问
    4) 打印访问地址与管理员账号，并打开浏览器

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/quickstart.ps1
    powershell -ExecutionPolicy Bypass -File scripts/quickstart.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step { param([string]$Text) Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn2 { param([string]$Text) Write-Host "    $Text" -ForegroundColor Yellow }

function New-Secret([int]$Length = 32) {
    $bytes = New-Object byte[] $Length
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').Replace('=', '')
}

function Read-EnvFile([string]$Path) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $index = $trimmed.IndexOf('=')
        if ($index -le 0) { continue }
        $map[$trimmed.Substring(0, $index).Trim()] = $trimmed.Substring($index + 1).Trim()
    }
    return $map
}

# ---------------------------------------------------------------- 1. 生成 .env

Write-Step '准备配置 .env'
$envPath = Join-Path $root '.env'
$envMap = Read-EnvFile $envPath
$created = $false
foreach ($key in 'MYSQL_ROOT_PASSWORD', 'DB_PASSWORD', 'V2_JWT_SECRET', 'MODEL_INTERNAL_TOKEN') {
    if (-not $envMap[$key] -or $envMap[$key] -match '^change-me') {
        $envMap[$key] = New-Secret 32
        $created = $true
    }
}
if (-not $envMap['MYSQL_DATABASE']) { $envMap['MYSQL_DATABASE'] = 'hdr_w2' }
if (-not $envMap['WEB_PORT']) { $envMap['WEB_PORT'] = '8088' }
if (-not $envMap['MODEL_WEIGHTS_DIR']) {
    $envMap['MODEL_WEIGHTS_DIR'] = (Join-Path $root 'model-service\weights')
}
if (-not $envMap['HDR_BOOTSTRAP_ADMIN_USERNAME']) {
    $envMap['HDR_BOOTSTRAP_ADMIN_USERNAME'] = 'admin'
    $envMap['HDR_BOOTSTRAP_ADMIN_PASSWORD'] = New-Secret 16
    $created = $true
}

if ($created -or -not (Test-Path $envPath)) {
    $lines = @(
        '# 由 scripts/quickstart.ps1 自动生成；请勿提交到 git',
        "MYSQL_ROOT_PASSWORD=$($envMap['MYSQL_ROOT_PASSWORD'])",
        "MYSQL_DATABASE=$($envMap['MYSQL_DATABASE'])",
        "DB_PASSWORD=$($envMap['DB_PASSWORD'])",
        "V2_JWT_SECRET=$($envMap['V2_JWT_SECRET'])",
        "MODEL_INTERNAL_TOKEN=$($envMap['MODEL_INTERNAL_TOKEN'])",
        "MODEL_WEIGHTS_DIR=$($envMap['MODEL_WEIGHTS_DIR'])",
        "WEB_PORT=$($envMap['WEB_PORT'])",
        "HDR_BOOTSTRAP_ADMIN_USERNAME=$($envMap['HDR_BOOTSTRAP_ADMIN_USERNAME'])",
        "HDR_BOOTSTRAP_ADMIN_PASSWORD=$($envMap['HDR_BOOTSTRAP_ADMIN_PASSWORD'])",
        'RECOGNITION_MIN_CONFIDENCE=0.90',
        'RECOGNITION_MIN_MARGIN=0.85',
        'W2_MAX_WORKSPACES=3',
        'W2_RECOGNITION_PER_MINUTE=60',
        'W2_GLOBAL_RECOGNITION_PER_MINUTE=240',
        'W2_MAX_MEMBERS=5',
        'W2_DAILY_RECOGNITION_LIMIT=1000',
        'W2_REGISTER_PER_IP=5',
        'W2_REGISTER_WINDOW_SECONDS=900'
    )
    Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
    Write-Ok "已生成 .env（随机密码与密钥）"
} else {
    Write-Ok '已存在 .env，复用现有配置'
}

# ---------------------------------------------------------------- 2. 权重

Write-Step '检查基线权重'
$registry = Join-Path $root 'model-service\weights\registry.json'
if (-not (Test-Path $registry)) {
    Write-Warn2 '未找到权重，开始下载…'
    & (Join-Path $PSScriptRoot 'fetch-weights.ps1')
    if ($LASTEXITCODE -ne 0) { throw '权重下载失败，请检查网络或手动运行 scripts/fetch-weights.ps1' }
} else {
    Write-Ok '权重已就绪'
}

# ---------------------------------------------------------------- 3. 选择启动方式

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Write-Step '未检测到 Docker'
    Write-Warn2 '改用一键部署 scripts/deploy.ps1（需要 JDK/Node/Python/MySQL/Redis）'
    $deploy = Join-Path $PSScriptRoot 'deploy.ps1'
    if (Test-Path $deploy) {
        & powershell -ExecutionPolicy Bypass -File $deploy
    } else {
        $local = Join-Path $PSScriptRoot 'start-all.ps1'
        if (-not (Test-Path $local)) { throw '缺少 scripts/deploy.ps1 与 scripts/start-all.ps1。请安装 Docker Desktop 后重试。' }
        & $local
    }
    if ($LASTEXITCODE -ne 0) { throw '本机启动失败，请查看控制台输出与日志。' }
    Write-Host ''
    Write-Host "启动完成：http://127.0.0.1:5173/login" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/login' }
    return
}

Write-Step '启动 Docker Compose'
try { & docker compose version *> $null } catch { throw 'Docker 已安装但缺少 compose 插件，请升级 Docker Desktop。' }
$composeArgs = @('compose', 'up', '-d')
if (-not $SkipBuild) { $composeArgs += '--build' }
& docker @composeArgs
if ($LASTEXITCODE -ne 0) { throw 'docker compose up 失败，请查看上面的输出。' }

# ---------------------------------------------------------------- 4. 等待就绪

$webPort = $envMap['WEB_PORT']
$url = "http://127.0.0.1:$webPort"
Write-Step "等待服务就绪（$url）"
$deadline = (Get-Date).AddMinutes(6)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; break }
    } catch { Start-Sleep -Seconds 3 }
}
if (-not $ready) {
    Write-Host '服务在 6 分钟内未就绪，最近日志：' -ForegroundColor Yellow
    & docker compose logs --tail=40
    throw '启动超时'
}

Write-Host ''
Write-Host "启动完成：$url" -ForegroundColor Green
Write-Host "管理员账号：$($envMap['HDR_BOOTSTRAP_ADMIN_USERNAME'])" -ForegroundColor Green
Write-Host "管理员密码：$($envMap['HDR_BOOTSTRAP_ADMIN_PASSWORD'])" -ForegroundColor Green
Write-Host '停止：scripts\stop-all.bat 或 docker compose down（数据保留）'
if (-not $NoBrowser) { Start-Process $url }
