[CmdletBinding()]
param(
  [string]$Tag = "latest",
  [string]$Repository = "jskzzzz/tingyi-lite",
  [string]$RuntimeRoot = "runtime",
  [switch]$Force
)

# 源码仓库不含 ASR runtime 载荷（两个模型的 ONNX 与原生库合计约 850 MB），
# 它们作为 release 资产分发。本脚本负责下载、按 SHA-256 校验并解压到 runtime/ 下，
# 解压结果就是服务期望的布局（runtime/moonshine-cpp、runtime/funasr-paraformer-zh-2pass）。
#
# 校验值是 runtime 内容本身的指纹，只要模型没换就一直有效；不匹配时明确失败，
# 不做“继续使用可疑文件”的降级。

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "fetch-local-asr-runtimes.ps1 requires PowerShell 7 or newer."
}

$runtimes = @(
  [pscustomobject]@{
    Name = "moonshine-cpp"
    DisplayName = "Moonshine 英文（24 kHz 流式）"
    Bytes = 83501251
    Sha256 = "5f33344f30521e8bfd051031feb3667c0a2fa4040e63019e046ec8fb21dc48bd"
  },
  [pscustomobject]@{
    Name = "funasr-paraformer-zh-2pass"
    DisplayName = "FunASR Paraformer 2-pass 中文（含 VAD/标点/ITN）"
    Bytes = 707786689
    Sha256 = "64452f0712b7ad2de18452f234693254998909c569a0bf7eb0213e80c2e8a21d"
  }
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedRuntimeRoot = if ([System.IO.Path]::IsPathRooted($RuntimeRoot)) {
  [System.IO.Path]::GetFullPath($RuntimeRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RuntimeRoot))
}
$downloadRoot = Join-Path $resolvedRuntimeRoot ".downloads"

if ($Tag -eq "latest") {
  Write-Host "解析最新 release ..."
  try {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" `
      -Headers @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "tingyi-lite-fetch" }
  } catch {
    throw "无法查询 $Repository 的最新 release（$($_.Exception.Message)）。请显式指定版本，例如：-Tag v0.1.1"
  }
  $Tag = $latest.tag_name
  if (-not $Tag) {
    throw "release 响应里没有 tag_name；请显式指定 -Tag"
  }
}
Write-Host "使用 release：$Tag （$Repository）"
Write-Host "目标目录：$resolvedRuntimeRoot"
Write-Host ""

$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)?.Source
if (-not $curl) {
  throw "需要 curl.exe（Windows 10 1803+ 自带）。若缺失，请手动从 https://github.com/$Repository/releases 下载两个 zip 并解压到 $resolvedRuntimeRoot"
}

New-Item -ItemType Directory -Path $resolvedRuntimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

foreach ($runtime in $runtimes) {
  $targetDir = Join-Path $resolvedRuntimeRoot $runtime.Name
  $manifestPath = Join-Path $targetDir "runtime-manifest.json"
  if ((Test-Path -LiteralPath $manifestPath) -and -not $Force) {
    Write-Host "已存在，跳过：$($runtime.Name)（需要重装请加 -Force）"
    continue
  }

  $archiveName = "$($runtime.Name).zip"
  $archivePath = Join-Path $downloadRoot $archiveName
  $url = "https://github.com/$Repository/releases/download/$Tag/$archiveName"

  Write-Host "下载 $($runtime.DisplayName) ..."
  & $curl -fL --retry 3 --retry-delay 5 --connect-timeout 30 -o $archivePath $url
  if ($LASTEXITCODE -ne 0) {
    throw "下载失败（curl 退出码 $LASTEXITCODE）：$url"
  }

  $info = Get-Item -LiteralPath $archivePath
  if ($info.Length -ne $runtime.Bytes) {
    throw "大小校验失败：$archiveName 期望 $($runtime.Bytes) 字节，实际 $($info.Length) 字节"
  }
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $runtime.Sha256) {
    throw "SHA-256 校验失败：$archiveName 期望 $($runtime.Sha256)，实际 $hash"
  }
  Write-Host "  校验通过：$($info.Length) 字节 / sha256 $hash"

  Write-Host "  解压到 $targetDir ..."
  Expand-Archive -LiteralPath $archivePath -DestinationPath $resolvedRuntimeRoot -Force
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "解压后未找到 $manifestPath，归档结构与预期不符"
  }
  Write-Host "  完成：$($runtime.Name)"
  Write-Host ""
}

Write-Host "两个离线 runtime 已就位。下一步：npm run server（或 npm run dev 打开开发态页面）"
