#requires -Version 5.1
<#
.SYNOPSIS
    安装一键部署缺少的运行时依赖（Windows，winget）。

.DESCRIPTION
    检测 JDK 17 / Node 20+ / Python 3.11 / Maven / Redis 是否可用，缺什么装什么。
    MySQL 需要单独安装并配置数据目录与端口，脚本只给出步骤，不自动装。

    参数：
      -DryRun          只显示将要执行的命令，不实际安装
      -Yes             不询问，直接安装
      -Only <names>    只处理指定项（jdk,node,python,maven,redis）
      -IncludeMysql    额外给出 MySQL 的 winget 安装命令（仍需手动配置）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install-deps.ps1 -DryRun

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install-deps.ps1 -Yes
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [string[]]$Only,
    [switch]$IncludeMysql
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Runtime = 'D:\HDR-runtime'
New-Item -ItemType Directory -Force -Path $script:Runtime | Out-Null
$script:EnvPath = Join-Path $PSScriptRoot '.env'
$script:EnvMap = @{}
if (Test-Path -LiteralPath $script:EnvPath) {
    foreach ($line in Get-Content -LiteralPath $script:EnvPath) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
        $index = $trimmed.IndexOf('=')
        if ($index -le 0) { continue }
        $script:EnvMap[$trimmed.Substring(0, $index).Trim()] = $trimmed.Substring($index + 1).Trim()
    }
}

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
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Find-Tool {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Test-PythonReady {
    param([string]$PythonPath)
    if (-not $PythonPath) { return $false }
    try {
        & $PythonPath -c 'import sys' 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Get-JavaHome {
    foreach ($candidate in @($script:EnvMap['JAVA_HOME'], $env:JAVA_HOME)) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'bin\java.exe'))) { return $candidate }
    }
    $java = Find-Tool 'java.exe'
    if ($java) { return (Split-Path -Parent (Split-Path -Parent $java)) }
    return $null
}

function Invoke-Winget {
    param([string]$Id, [string]$Label)
    if ($DryRun) {
        Write-Host "    [DryRun] winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements"
        return $true
    }
    Write-Host "    安装 $Label（winget $Id）..."
    & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "$Label 安装失败（winget 退出码 $LASTEXITCODE）"
        return $false
    }
    Write-Ok "$Label 安装完成"
    Update-PathFromRegistry
    return $true
}

function Test-Selected {
    param([string]$Name)
    if (-not $Only -or $Only.Count -eq 0) { return $true }
    return ($Only -contains $Name)
}

Write-Step '检查可用性'

$winget = Find-Tool 'winget.exe'
if (-not $winget) {
    Write-Fail '没有 winget（App Installer）：请先在 Microsoft Store 安装「应用安装程序」，或手动安装依赖'
    exit 2
}
Write-Ok "winget 可用：$winget"

$isAdmin = Test-Admin
if ($isAdmin) { Write-Ok '当前是管理员权限' } else { Write-Warn2 '非管理员权限：winget 安装到“用户范围”，部分依赖可能仍需管理员；建议以管理员身份运行' }

$javaHome = Get-JavaHome
$node = Find-Tool 'node.exe'
if (-not $node -and $script:EnvMap['NODE'] -and (Test-Path $script:EnvMap['NODE'])) { $node = $script:EnvMap['NODE'] }
$python = Find-Tool 'python.exe'
if (-not $python -and $script:EnvMap['PYTHON'] -and (Test-Path $script:EnvMap['PYTHON'])) { $python = $script:EnvMap['PYTHON'] }
$mvn = Find-Tool 'mvn.cmd'
if (-not $mvn -and $script:EnvMap['MAVEN_BIN'] -and (Test-Path $script:EnvMap['MAVEN_BIN'])) { $mvn = $script:EnvMap['MAVEN_BIN'] }
$redis = Find-Tool 'redis-server.exe'
if (-not $redis -and $script:EnvMap['REDIS_SERVER_EXE'] -and (Test-Path $script:EnvMap['REDIS_SERVER_EXE'])) { $redis = $script:EnvMap['REDIS_SERVER_EXE'] }

$todo = @()
if (-not $javaHome -and (Test-Selected 'jdk')) { $todo += 'jdk' }
if (-not $node -and (Test-Selected 'node')) { $todo += 'node' }
if (-not $python -and (Test-Selected 'python')) { $todo += 'python' }
if (-not $mvn -and (Test-Selected 'maven')) { $todo += 'maven' }
if (-not $redis -and (Test-Selected 'redis')) { $todo += 'redis' }

$report = @(
    @{ Name = 'JDK 17'; Ok = [bool]$javaHome; Value = $javaHome; Id = 'Microsoft.OpenJDK.17' },
    @{ Name = 'Node 20+'; Ok = [bool]$node; Value = $node; Id = 'OpenJS.NodeJS.LTS' },
    @{ Name = 'Python 3.11'; Ok = [bool]$python; Value = $python; Id = 'Python.Python.3.11' },
    @{ Name = 'Maven'; Ok = [bool]$mvn; Value = $mvn; Id = '（Apache 官方 zip）' },
    @{ Name = 'Redis 7+'; Ok = [bool]$redis; Value = $redis; Id = 'taizod1024.redis-windows-fork' }
)
foreach ($row in $report) {
    if ($row.Ok) { Write-Ok "$($row.Name)：$($row.Value)" }
    else { Write-Warn2 "$($row.Name)：缺失" }
}

if ($IncludeMysql) {
    Write-Warn2 'MySQL 不在自动安装范围：建议 winget install --id Oracle.MySQL --exact，安装后把端口/数据目录写进 scripts/.env'
}

if ($todo.Count -eq 0) {
    Write-Host ''
    Write-Ok '没有需要安装的依赖'
    exit 0
}

if (-not $DryRun -and -not $Yes) {
    $answer = Read-Host "将安装：$($todo -join '、')。继续？(y/N)"
    if ($answer -notmatch '^[Yy]') { Write-Warn2 '已取消'; exit 0 }
}

Write-Step '开始安装'
$failed = @()

if ($todo -contains 'jdk') {
    if (-not (Invoke-Winget -Id 'Microsoft.OpenJDK.17' -Label 'JDK 17')) { $failed += 'jdk' }
}
if ($todo -contains 'node') {
    if (-not (Invoke-Winget -Id 'OpenJS.NodeJS.LTS' -Label 'Node LTS')) { $failed += 'node' }
}
if ($todo -contains 'python') {
    if (-not (Invoke-Winget -Id 'Python.Python.3.11' -Label 'Python 3.11')) { $failed += 'python' }
}
if ($todo -contains 'redis') {
    if (-not (Invoke-Winget -Id 'taizod1024.redis-windows-fork' -Label 'Redis')) { $failed += 'redis' }
}

if ($todo -contains 'maven') {
    $mavenDir = Join-Path $script:Runtime 'maven'
    $mavenZip = Join-Path $script:Runtime 'maven.zip'
    $mavenUrl = 'https://dlcdn.apache.org/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip'
    if ($DryRun) {
        Write-Host "    [DryRun] 下载 $mavenUrl 到 $mavenDir"
    } else {
        try {
            Write-Host '    下载 Maven 3.9.9 ...'
            New-Item -ItemType Directory -Force -Path $mavenDir | Out-Null
            Invoke-WebRequest -Uri $mavenUrl -OutFile $mavenZip -UseBasicParsing
            Expand-Archive -LiteralPath $mavenZip -DestinationPath $mavenDir -Force
            Remove-Item -LiteralPath $mavenZip -Force
            $mvnHome = Get-ChildItem -Path $mavenDir -Directory -Filter 'apache-maven-*' | Select-Object -First 1
            if (-not $mvnHome) { throw '解压后找不到 apache-maven 目录' }
            Write-Ok "Maven 已解压：$($mvnHome.FullName)"
            $env:Path = "$($mvnHome.FullName)\bin;$env:Path"
            $env:MAVEN_HOME_LOCAL = $mvnHome.FullName
            Write-Host "    把 MAVEN_BIN=$($mvnHome.FullName)\bin\mvn.cmd 写进 scripts/.env 后可被部署脚本复用" -ForegroundColor Yellow
        } catch {
            Write-Fail "Maven 下载失败：$($_.Exception.Message)"
            Write-Host '    可手动下载后解压，把 MAVEN_BIN 写进 scripts/.env：https://maven.apache.org/download.cgi'
            $failed += 'maven'
        }
    }
}

Write-Step '结果'
Update-PathFromRegistry
foreach ($row in $report) {
    $now = $null
    switch ($row.Name) {
        'JDK 17' { $now = Get-JavaHome }
        'Node 20+' { $now = Find-Tool 'node.exe'; if (-not $now -and $script:EnvMap['NODE'] -and (Test-Path $script:EnvMap['NODE'])) { $now = $script:EnvMap['NODE'] } }
        'Python 3.11' { $now = Find-Tool 'python.exe'; if (-not $now -and $script:EnvMap['PYTHON'] -and (Test-Path $script:EnvMap['PYTHON'])) { $now = $script:EnvMap['PYTHON'] } }
        'Maven' { $now = Find-Tool 'mvn.cmd'; if (-not $now -and $script:EnvMap['MAVEN_BIN'] -and (Test-Path $script:EnvMap['MAVEN_BIN'])) { $now = $script:EnvMap['MAVEN_BIN'] } }
        'Redis 7+' { $now = Find-Tool 'redis-server.exe'; if (-not $now -and $script:EnvMap['REDIS_SERVER_EXE'] -and (Test-Path $script:EnvMap['REDIS_SERVER_EXE'])) { $now = $script:EnvMap['REDIS_SERVER_EXE'] } }
    }
    if ($now) { Write-Ok "$($row.Name)：$now" } else { Write-Warn2 "$($row.Name)：仍不可用（可能需重开终端让 PATH 生效）" }
}

if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Fail "以下依赖安装失败：$($failed -join '、')"
    exit 1
}

Write-Host ''
Write-Ok '依赖安装完成。请重新打开终端后执行 deploy.bat（或 scripts\start-all.ps1）'
