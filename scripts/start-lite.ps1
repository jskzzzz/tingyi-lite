[CmdletBinding()]
param(
  [switch]$Lan,
  [switch]$Https,
  [switch]$DemoCaptions,
  [switch]$SkipHelperBuild,
  [switch]$NoBrowser,
  [int]$ApiPort = 8787,
  [string]$DataRoot = "data",
  [string]$LocalToken = $env:TINGYI_LOCAL_TOKEN,
  [ValidateRange(1, 300)]
  [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7+ is required. Run this script with pwsh, not Windows PowerShell."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
  throw "node_modules is missing. Run npm install in $repoRoot first."
}

function Assert-TcpPortAvailable([string]$HostName, [int]$Port, [string]$Label) {
  $probe = [System.Net.Sockets.TcpClient]::new()
  try {
    $probe.Connect($HostName, $Port)
    throw "$Label port ${HostName}:$Port is already in use."
  } catch [System.Net.Sockets.SocketException] {
    # Connection refused means the requested port is available.
  } finally {
    $probe.Dispose()
  }
}

function Get-NormalizedDataRoot([string]$PathValue) {
  return [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($PathValue))
}

function Test-NormalizedPathEquals([string]$Left, [string]$Right) {
  $comparison = if ($IsWindows) {
    [System.StringComparison]::OrdinalIgnoreCase
  } else {
    [System.StringComparison]::Ordinal
  }
  return [string]::Equals((Get-NormalizedDataRoot $Left), (Get-NormalizedDataRoot $Right), $comparison)
}

function Get-UsableLanIpv4Addresses {
  $addresses = foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($networkInterface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up -or
        $networkInterface.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) {
      continue
    }
    foreach ($unicast in $networkInterface.GetIPProperties().UnicastAddresses) {
      if ($unicast.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        continue
      }
      $address = $unicast.Address.ToString()
      if ($address -ne "0.0.0.0" -and -not $address.StartsWith("169.254.")) {
        $address
      }
    }
  }
  return @($addresses | Sort-Object -Unique)
}

function Stop-LaunchedProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-LaunchedProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

if ($ApiPort -eq 5177) {
  throw "API and Web cannot both use port 5177."
}
& (Join-Path $PSScriptRoot "stop-lite-dev-ports.ps1") -ApiPort $ApiPort -WebPort 5177 -RepoRoot $repoRoot
Assert-TcpPortAvailable "127.0.0.1" $ApiPort "API"
Assert-TcpPortAvailable "127.0.0.1" 5177 "Web"
$webHosts = if ($Lan -or $Https) { @(Get-UsableLanIpv4Addresses) } else { @("127.0.0.1") }
if ($webHosts.Count -eq 0) {
  throw "No active non-loopback IPv4 address is available for LAN/HTTPS startup."
}

& npm run build
if ($LASTEXITCODE -ne 0) {
  throw "Web build failed with exit code $LASTEXITCODE."
}

if (-not $SkipHelperBuild) {
  & npm run build:system-captions-helper
  if ($LASTEXITCODE -ne 0) {
    throw "System captions helper build failed with exit code $LASTEXITCODE."
  }
  & npm run build:wasapi-loopback-helper
  if ($LASTEXITCODE -ne 0) {
    throw "WASAPI loopback helper build failed with exit code $LASTEXITCODE."
  }
}

$dataRootPath = Get-NormalizedDataRoot $(if ([System.IO.Path]::IsPathRooted($DataRoot)) { $DataRoot } else { Join-Path $repoRoot $DataRoot })
New-Item -ItemType Directory -Force -Path $dataRootPath | Out-Null
. (Join-Path $repoRoot "scripts\resolve-device-id.ps1")
$deviceId = Resolve-TingyiDeviceId $dataRootPath $env:TINGYI_DEVICE_ID
$env:TINGYI_DEVICE_ID = $deviceId

$apiHost = if ($Lan -or $Https) { "0.0.0.0" } else { "127.0.0.1" }
if (($Lan -or $Https) -and -not $LocalToken) {
  $LocalToken = [Guid]::NewGuid().ToString("N")
}

$env:TINGYI_DATA_ROOT = $dataRootPath
$env:TINGYI_LITE_PORT = [string]$ApiPort
$env:TINGYI_LITE_HOST = $apiHost
if ($LocalToken) {
  $env:TINGYI_LOCAL_TOKEN = $LocalToken
}
if ($DemoCaptions) {
  $nodeCommand = (Get-Command node -ErrorAction Stop).Source
  $demoHelper = Join-Path $repoRoot "scripts\dev-caption-helper.mjs"
  $helperArgs = @($demoHelper) | ConvertTo-Json -Compress -AsArray
  $env:TINGYI_SYSTEM_CAPTIONS_HELPER = $nodeCommand
  $env:TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS = $helperArgs
}

$webScript = if ($Https) { "dev:https" } elseif ($Lan) { "dev:lan" } else { "dev" }
$windowRunner = Join-Path $repoRoot "scripts\run-dev-window.ps1"
$quotedRunner = '"' + $windowRunner + '"'
$apiProcess = $null
$webProcess = $null
try {
  $apiProcess = Start-Process -FilePath "pwsh.exe" -WorkingDirectory $repoRoot -ArgumentList @(
    "-NoLogo", "-NoProfile", "-File", $quotedRunner, "-NpmScript", "server"
  ) -PassThru
  $webProcess = Start-Process -FilePath "pwsh.exe" -WorkingDirectory $repoRoot -ArgumentList @(
    "-NoLogo", "-NoProfile", "-File", $quotedRunner, "-NpmScript", $webScript
  ) -PassThru

  $healthHeaders = @{}
  if ($LocalToken) {
    $healthHeaders.authorization = "Bearer $LocalToken"
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  $apiReady = $false
  $webReady = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $apiProcess.Refresh()
    $webProcess.Refresh()
    if ($apiProcess.HasExited) {
      throw "API process exited before readiness with code $($apiProcess.ExitCode)."
    }
    if ($webProcess.HasExited) {
      throw "Web process exited before readiness with code $($webProcess.ExitCode)."
    }
    if (-not $apiReady) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:${ApiPort}/api/health" -Headers $healthHeaders -NoProxy -TimeoutSec 1
        $apiReady = $health.ok -eq $true -and
          $health.product -eq "tingyi-lite" -and
          [bool]$health.serverInstanceId -and
          $health.deviceId -ceq $deviceId -and
          [bool]$health.dataRoot -and
          (Test-NormalizedPathEquals ([string]$health.dataRoot) $dataRootPath)
      } catch {
        $apiReady = $false
      }
    }
    if (-not $webReady) {
      try {
        $probeParameters = @{
          Uri = "$(if ($Https) { 'https' } else { 'http' })://127.0.0.1:5177/"
          NoProxy = $true
          TimeoutSec = 1
          UseBasicParsing = $true
        }
        if ($Https) {
          $probeParameters.SkipCertificateCheck = $true
        }
        $webResponse = Invoke-WebRequest @probeParameters
        $indexReady = [int]$webResponse.StatusCode -eq 200 -and
          $webResponse.Content.Contains("<title>听译 Lite</title>") -and
          $webResponse.Content.Contains('/src/web/main.tsx')
        if ($indexReady) {
          $moduleProbeParameters = @{
            Uri = "$(if ($Https) { 'https' } else { 'http' })://127.0.0.1:5177/src/web/main.tsx"
            NoProxy = $true
            TimeoutSec = 3
            UseBasicParsing = $true
          }
          if ($Https) {
            $moduleProbeParameters.SkipCertificateCheck = $true
          }
          $moduleResponse = Invoke-WebRequest @moduleProbeParameters
          $webReady = [int]$moduleResponse.StatusCode -eq 200 -and $moduleResponse.Content.Length -gt 0
        }
      } catch {
        $webReady = $false
      }
    }
    if ($apiReady -and $webReady) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $apiReady -or -not $webReady) {
    throw "Tingyi Lite did not become ready within $StartupTimeoutSeconds seconds (API=$apiReady, Web=$webReady)."
  }
  Start-Sleep -Milliseconds 100
  $apiProcess.Refresh()
  $webProcess.Refresh()
  if ($apiProcess.HasExited -or $webProcess.HasExited) {
    throw "Tingyi Lite process exited during readiness handoff (API=$($apiProcess.HasExited), Web=$($webProcess.HasExited))."
  }
} catch {
  if ($webProcess) {
    Stop-LaunchedProcessTree $webProcess.Id
  }
  if ($apiProcess) {
    Stop-LaunchedProcessTree $apiProcess.Id
  }
  throw
}

$scheme = if ($Https) { "https" } else { "http" }
$webUrls = @($webHosts | ForEach-Object { "${scheme}://${_}:5177/" })
$overlayUrls = @($webHosts | ForEach-Object { "${scheme}://${_}:5177/overlay" })
if ($LocalToken) {
  $encodedToken = [Uri]::EscapeDataString($LocalToken)
  $webUrls = @($webUrls | ForEach-Object { "$_`?token=$encodedToken" })
  $overlayUrls = @($overlayUrls | ForEach-Object { "$_`?token=$encodedToken" })
}

Write-Host "Tingyi Lite API (local): http://127.0.0.1:${ApiPort}"
foreach ($webUrl in $webUrls) {
  Write-Host "Tingyi Lite Web: $webUrl"
}
foreach ($overlayUrl in $overlayUrls) {
  Write-Host "Overlay: $overlayUrl"
}
Write-Host "Device ID: $deviceId"
if ($DemoCaptions) {
  Write-Host "Demo captions: enabled for UI/event-pipeline testing."
}
Write-Host "Two visible pwsh windows are ready: one for API, one for Web."
if (-not $NoBrowser) {
  Start-Process $webUrls[0]
}
