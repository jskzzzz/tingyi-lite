[CmdletBinding()]
param(
  [switch]$Overlay,
  [switch]$NoBrowser,
  [string]$DataRoot = "",
  [switch]$PassThru
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "听译 Lite 需要 PowerShell 7 或更高版本。"
}
$root = $PSScriptRoot
$nodePath = Join-Path $root "runtime/node/node.exe"
if (-not (Test-Path -LiteralPath $nodePath)) {
  throw "听译 Lite 便携包缺少内置 Node.js runtime。"
}
$nodeVersionText = (& $nodePath --version).Trim().TrimStart([char]"v")
$nodeVersion = $null
if ($LASTEXITCODE -ne 0 -or -not [version]::TryParse($nodeVersionText, [ref]$nodeVersion) -or $nodeVersion.Major -lt 22) {
  throw "听译 Lite 便携包需要 Node.js 22 或更高版本；当前版本：$nodeVersionText"
}

$serverEntry = Join-Path $root "server/index.mjs"
$webRoot = Join-Path $root "web"
$runtimeContainer = Join-Path $root "runtime"
$systemCaptionsHelper = Join-Path $root "native/system-captions/TingyiLite.SystemCaptionsHelper.exe"
$wasapiLoopbackHelper = Join-Path $root "native/wasapi-loopback/TingyiLite.WasapiLoopbackHelper.exe"
$overlayPath = Join-Path $root "native/overlay/TingyiLite.Overlay.exe"
$deviceResolver = Join-Path $root "resolve-device-id.ps1"
# Engines are discovered from the package itself: any runtime/* directory carrying a
# manifest is an engine, so shipping a new model only means adding its directory.
$localAsrRuntimeRoots = @(
  Get-ChildItem -LiteralPath $runtimeContainer -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "runtime-manifest.json") -PathType Leaf } |
    ForEach-Object { $_.FullName }
)
if ($localAsrRuntimeRoots.Count -eq 0) {
  throw "便携包缺少本地识别 runtime：$runtimeContainer"
}
foreach ($requiredPath in @(
  $serverEntry,
  (Join-Path $webRoot "index.html"),
  $systemCaptionsHelper,
  $wasapiLoopbackHelper,
  $deviceResolver
)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "便携包缺少必要文件：$requiredPath"
  }
}

function Get-NormalizedPath([string]$PathValue) {
  return [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($PathValue))
}

$env:TINGYI_DATA_ROOT = if ($DataRoot) {
  if ([System.IO.Path]::IsPathRooted($DataRoot)) {
    Get-NormalizedPath $DataRoot
  } else {
    Get-NormalizedPath (Join-Path $root $DataRoot)
  }
} else {
  Get-NormalizedPath (Join-Path $root "data")
}
New-Item -ItemType Directory -Force -Path $env:TINGYI_DATA_ROOT | Out-Null
. $deviceResolver
$env:TINGYI_DEVICE_ID = Resolve-TingyiDeviceId $env:TINGYI_DATA_ROOT $env:TINGYI_DEVICE_ID
$env:TINGYI_WEB_ROOT = $webRoot
$env:TINGYI_LOCAL_ASR_RUNTIME_DIRS = ConvertTo-Json -InputObject @($localAsrRuntimeRoots) -Compress
$env:TINGYI_SYSTEM_CAPTIONS_HELPER = $systemCaptionsHelper
$env:TINGYI_WASAPI_LOOPBACK_HELPER = $wasapiLoopbackHelper
$port = if ($env:TINGYI_LITE_PORT) { [int]$env:TINGYI_LITE_PORT } else { 8787 }
$hostName = if ($env:TINGYI_LITE_HOST) { $env:TINGYI_LITE_HOST } else { "127.0.0.1" }
$probeHost = if ($hostName -eq "0.0.0.0" -or $hostName -eq "::") { "127.0.0.1" } else { $hostName }
$portProbe = [System.Net.Sockets.TcpClient]::new()
try {
  $portProbe.Connect($probeHost, $port)
  throw "端口 ${probeHost}:$port 已被占用；听译 Lite 未启动。"
} catch [System.Net.Sockets.SocketException] {
  # Connection refused means the requested port is available for this launch.
} finally {
  $portProbe.Dispose()
}

function Stop-LaunchedProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-LaunchedProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$serverProcess = $null
$launchSucceeded = $false
try {
  $serverProcess = Start-Process -FilePath $nodePath -WorkingDirectory $root -ArgumentList @($serverEntry) -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $health = $null
  $healthHeaders = @{}
  if ($env:TINGYI_LOCAL_TOKEN) {
    $healthHeaders.authorization = "Bearer $($env:TINGYI_LOCAL_TOKEN)"
  }
  while ([DateTime]::UtcNow -lt $deadline) {
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
      throw "听译 Lite 服务在就绪前退出，code=$($serverProcess.ExitCode)。"
    }
    try {
      $health = Invoke-RestMethod -Uri "http://${probeHost}:$port/api/health" -Headers $healthHeaders -NoProxy -TimeoutSec 1
      $healthDataRoot = if ($health.dataRoot) { Get-NormalizedPath ([string]$health.dataRoot) } else { "" }
      if ($health.ok -eq $true -and
          $health.product -eq "tingyi-lite" -and
          $health.serverInstanceId -and
          $health.deviceId -ceq $env:TINGYI_DEVICE_ID -and
          $healthDataRoot -ieq (Get-NormalizedPath $env:TINGYI_DATA_ROOT)) {
        break
      }
      $health = $null
    } catch {
      $health = $null
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $health) {
    throw "听译 Lite 服务未在 20 秒内通过健康检查 ${probeHost}:$port；请查看可见的服务窗口。"
  }
  Start-Sleep -Milliseconds 100
  $serverProcess.Refresh()
  if ($serverProcess.HasExited) {
    throw "听译 Lite 服务在就绪交接前退出，code=$($serverProcess.ExitCode)。"
  }

  $baseUrl = "http://${probeHost}:$port"
  $url = "$baseUrl/"
  if ($env:TINGYI_LOCAL_TOKEN) {
    $url = "$url`?token=$([Uri]::EscapeDataString($env:TINGYI_LOCAL_TOKEN))"
  }
  if (-not $NoBrowser) {
    Start-Process $url
  }
  if ($Overlay) {
    if (-not (Test-Path -LiteralPath $overlayPath)) {
      throw "便携包缺少 native overlay：$overlayPath"
    }
    Start-Process -FilePath $overlayPath -WorkingDirectory (Split-Path -Parent $overlayPath) -ArgumentList @(
      "--server",
      $baseUrl,
      "--lines",
      "3"
    )
  }
  $launchSucceeded = $true
  Write-Host "听译 Lite 已启动：$url"
  Write-Host "设备 ID：$env:TINGYI_DEVICE_ID"
  if ($PassThru) {
    [pscustomobject][ordered]@{
      ProcessId = $serverProcess.Id
      Url = $url
      DataRoot = $env:TINGYI_DATA_ROOT
      DeviceId = $env:TINGYI_DEVICE_ID
    }
  }
} finally {
  if (-not $launchSucceeded -and $serverProcess) {
    Stop-LaunchedProcessTree $serverProcess.Id
  }
}
