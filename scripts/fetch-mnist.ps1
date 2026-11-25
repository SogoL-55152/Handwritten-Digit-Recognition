# 下载官方 MNIST IDX 文件到 model-service/data/MNIST/raw（一次性准备，不入库）。
# 用法：powershell -File scripts/fetch-mnist.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "model-service\data\MNIST\raw"
$base = if ($env:HDR_MNIST_BASE) { $env:HDR_MNIST_BASE } else { "https://ossci-datasets.s3.amazonaws.com/mnist" }
New-Item -ItemType Directory -Force -Path $target | Out-Null

function Expand-GzipFile([string]$gzPath) {
  $dest = $gzPath.Substring(0, $gzPath.Length - 3)
  $input = New-Object System.IO.FileStream($gzPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
  $output = New-Object System.IO.FileStream($dest, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $gzip = New-Object System.IO.Compression.GZipStream($input, [System.IO.Compression.CompressionMode]::Decompress)
  try { $gzip.CopyTo($output) } finally { $gzip.Dispose(); $output.Dispose(); $input.Dispose(); Remove-Item $gzPath }
}

foreach ($name in @("train-images-idx3-ubyte", "train-labels-idx1-ubyte", "t10k-images-idx3-ubyte", "t10k-labels-idx1-ubyte")) {
  $dest = Join-Path $target $name
  if (Test-Path $dest) { Write-Output "已存在：$name"; continue }
  Write-Output "下载 $name ..."
  Invoke-WebRequest -Uri "$base/$name.gz" -OutFile "$dest.gz"
  Expand-GzipFile "$dest.gz"
}

Write-Output "完成：$target"
