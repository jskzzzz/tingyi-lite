[CmdletBinding()]
param(
  [string]$PackageRoot = "artifacts/portable/tingyi-lite",
  [ValidateRange(0, 65535)]
  [int]$Port = 0
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "smoke-lite-package.ps1 requires PowerShell 7 or newer."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$rootPath = if ([System.IO.Path]::IsPathRooted($PackageRoot)) {
  [System.IO.Path]::GetFullPath($PackageRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $PackageRoot))
}
$verifier = Join-Path $rootPath "verify.ps1"
$starter = Join-Path $rootPath "start.ps1"
$webRoot = Join-Path $rootPath "web"
$runtimeContainer = Join-Path $rootPath "runtime"
$systemCaptionsHelper = Join-Path $rootPath "native/system-captions/TingyiLite.SystemCaptionsHelper.exe"
$localAsrRuntimeRoots = @(
  Get-ChildItem -LiteralPath $runtimeContainer -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "runtime-manifest.json") -PathType Leaf } |
    ForEach-Object { $_.FullName }
)
if ($localAsrRuntimeRoots.Count -eq 0) {
  throw "便携包缺少本地识别 runtime：$runtimeContainer"
}

$sourceVerifier = Join-Path $PSScriptRoot "verify-lite-package.ps1"
if (Test-Path -LiteralPath $sourceVerifier) {
  & $sourceVerifier -PackageRoot $rootPath
}
& $verifier -PackageRoot $rootPath

if ($Port -eq 0) {
  $portLease = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $portLease.Start()
    $Port = ([System.Net.IPEndPoint]$portLease.LocalEndpoint).Port
  } finally {
    $portLease.Stop()
  }
}

$portProbe = [System.Net.Sockets.TcpClient]::new()
try {
  $portProbe.Connect("127.0.0.1", $Port)
  throw "Portable smoke port 127.0.0.1:$Port is already in use."
} catch [System.Net.Sockets.SocketException] {
  # Connection refused means the selected port is available.
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

$smokeDataRoot = Join-Path ([System.IO.Path]::GetTempPath()) "tingyi-lite-package-smoke-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $smokeDataRoot | Out-Null
$environmentNames = @(
  "TINGYI_DATA_ROOT",
  "TINGYI_WEB_ROOT",
  "TINGYI_LOCAL_ASR_RUNTIME_DIRS",
  "TINGYI_SYSTEM_CAPTIONS_HELPER",
  "TINGYI_DEVICE_ID",
  "TINGYI_LITE_PORT",
  "TINGYI_LITE_HOST",
  "TINGYI_LOCAL_TOKEN",
  "TINGYI_ALLOW_INSECURE_LAN",
  "TINGYI_SYNC_ENDPOINT",
  "TINGYI_SYNC_TOKEN",
  "TINGYI_SYNC_TENANT_ID",
  "TINGYI_SYNC_AUTO_INTERVAL_MS",
  "TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
}

$serverProcess = $null
try {
  $env:TINGYI_DATA_ROOT = $smokeDataRoot
  $env:TINGYI_WEB_ROOT = $webRoot
  $env:TINGYI_LOCAL_ASR_RUNTIME_DIRS = ConvertTo-Json -InputObject @($localAsrRuntimeRoots) -Compress
  $env:TINGYI_SYSTEM_CAPTIONS_HELPER = $systemCaptionsHelper
  $env:TINGYI_DEVICE_ID = "device_smoke_$([Guid]::NewGuid().ToString('N'))"
  $env:TINGYI_LITE_PORT = [string]$Port
  $env:TINGYI_LITE_HOST = "127.0.0.1"
  foreach ($name in @(
    "TINGYI_LOCAL_TOKEN",
    "TINGYI_ALLOW_INSECURE_LAN",
    "TINGYI_SYNC_ENDPOINT",
    "TINGYI_SYNC_TOKEN",
    "TINGYI_SYNC_TENANT_ID",
    "TINGYI_SYNC_AUTO_INTERVAL_MS",
    "TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS"
  )) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }

  $launch = & $starter -NoBrowser -DataRoot $smokeDataRoot -PassThru
  if (-not $launch -or -not $launch.ProcessId) {
    throw "Portable start.ps1 did not return its launched server process."
  }
  $serverProcess = Get-Process -Id ([int]$launch.ProcessId) -ErrorAction Stop

  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $health = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
      throw "Portable smoke server exited before readiness with code $($serverProcess.ExitCode)."
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:${Port}/api/health" -NoProxy -TimeoutSec 1
      if ($health.ok -eq $true -and $health.product -eq "tingyi-lite" -and $health.serverInstanceId) {
        break
      }
      $health = $null
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $health) {
    throw "Portable smoke server did not become healthy within 20 seconds."
  }

  $baseUrl = "http://127.0.0.1:$Port"
  $index = Invoke-WebRequest -Uri "$baseUrl/" -NoProxy -UseBasicParsing -TimeoutSec 5
  $assetMatch = [regex]::Match($index.Content, 'src="(?<path>/assets/[^" ]+\.js)"')
  if (-not $assetMatch.Success) {
    throw "Portable entry HTML does not reference a JavaScript asset."
  }
  $assetPath = $assetMatch.Groups["path"].Value
  $asset = Invoke-WebRequest -Uri "$baseUrl$assetPath" -NoProxy -UseBasicParsing -TimeoutSec 5
  if ([int]$index.StatusCode -ne 200 -or [int]$asset.StatusCode -ne 200) {
    throw "Portable static Web smoke failed."
  }

  [pscustomobject][ordered]@{
    ok = $true
    product = $health.product
    packageRoot = $rootPath
    port = $Port
    indexStatus = [int]$index.StatusCode
    assetPath = $assetPath
    assetStatus = [int]$asset.StatusCode
  } | ConvertTo-Json -Compress
} finally {
  if ($serverProcess) {
    Stop-LaunchedProcessTree $serverProcess.Id
  }
  foreach ($name in $environmentNames) {
    $previous = $previousEnvironment[$name]
    if ($null -eq $previous) {
      [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
    } else {
      [System.Environment]::SetEnvironmentVariable($name, [string]$previous, "Process")
    }
  }
  Remove-Item -LiteralPath $smokeDataRoot -Recurse -Force -ErrorAction SilentlyContinue
}
