<#
下载并安装基线模型权重。

权重不进 git（114 MB、且属于产物），通过 GitHub Release 分发。
默认只安装「生效基线」一个模型（1.6 MB），不影响本机已有的其它训练产物。

用法：
  powershell -ExecutionPolicy Bypass -File scripts/fetch-weights.ps1
  powershell -ExecutionPolicy Bypass -File scripts/fetch-weights.ps1 -ZipPath dist/hdr-weights-baseline-v1.zip
  powershell -ExecutionPolicy Bypass -File scripts/fetch-weights.ps1 -ForceRegistry   # 覆盖已有 registry.json
#>
param(
    [string]$Url = $env:HDR_WEIGHTS_URL,
    [string]$ZipPath = '',
    [switch]$ForceRegistry,
    [string]$Target = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path $root 'model-service\weights' }

$defaultUrl = 'https://github.com/SogoL-55152/Handwritten-Digit-Recognition/releases/download/weights-v1/hdr-weights-baseline-v1.zip'
if (-not $ZipPath -and -not $Url) { $Url = $defaultUrl }

$tempZip = $null
if (-not $ZipPath) {
    $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) ("hdr-weights-" + [guid]::NewGuid().ToString('N') + '.zip')
    Write-Host "下载权重：$Url"
    Invoke-WebRequest -Uri $Url -OutFile $tempZip -UseBasicParsing
    $ZipPath = $tempZip
}

if (-not (Test-Path $ZipPath)) { throw "找不到权重包：$ZipPath" }
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $ZipPath))
try {
    $manifestEntry = $archive.Entries | Where-Object { $_.FullName -eq 'MANIFEST.json' }
    if (-not $manifestEntry) { throw '权重包缺少 MANIFEST.json' }
    $reader = New-Object System.IO.StreamReader($manifestEntry.Open())
    $manifest = $reader.ReadToEnd() | ConvertFrom-Json
    $reader.Close()

    foreach ($file in $manifest.files) {
        $entry = $archive.Entries | Where-Object { $_.FullName -eq $file.path }
        if (-not $entry) { throw "权重包缺少文件：$($file.path)" }
        $destination = Join-Path $Target ($file.path -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)

        $hash = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash.ToLower()
        if ($hash -ne $file.sha256) { throw "校验失败：$($file.path)" }
        Write-Host "已安装 $($file.path)（$([math]::Round($file.sizeBytes/1MB,2)) MB，sha256 校验通过）"
    }

    $registryPath = Join-Path $Target 'registry.json'
    $registryEntry = $archive.Entries | Where-Object { $_.FullName -eq 'registry.json' }
    if ($registryEntry) {
        if ((Test-Path $registryPath) -and -not $ForceRegistry) {
            Write-Host "已存在 registry.json，跳过（需要覆盖请加 -ForceRegistry）"
        } else {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($registryEntry, $registryPath, $true)
            Write-Host "已写入 registry.json（只含生效基线 $($manifest.activeModel.version)）"
        }
    }

    Write-Host "完成：生效模型 $($manifest.activeModel.modelId) / $($manifest.activeModel.version)"
}
finally {
    $archive.Dispose()
    if ($tempZip -and (Test-Path $tempZip)) { Remove-Item $tempZip -Force }
}
