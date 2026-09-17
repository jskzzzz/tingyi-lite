[CmdletBinding()]
param(
  [string]$Root = "data",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "migrate-device-id.ps1 requires PowerShell 7 or newer."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$rootPath = if ([System.IO.Path]::IsPathRooted($Root)) {
  [System.IO.Path]::GetFullPath($Root)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Root))
}
if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
  throw "Lite data root does not exist: $rootPath"
}

$deviceIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
function Add-DeviceId([object]$Value, [string]$Source) {
  if ($Value -ceq "local-device") {
    throw "Legacy local-device data cannot be re-keyed safely in place. Back it up and reset the pre-release data root."
  }
  if ($Value -isnot [string] -or $Value -cnotmatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$") {
    throw "Invalid deviceId in ${Source}: $Value"
  }
  [void]$deviceIds.Add($Value)
}

$eventsPath = Join-Path $rootPath "events.jsonl"
if (Test-Path -LiteralPath $eventsPath) {
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $eventsPath -Encoding UTF8) {
    $lineNumber += 1
    if (-not $line.Trim()) { continue }
    try {
      $event = $line | ConvertFrom-Json
    } catch {
      throw "${eventsPath}:${lineNumber}: invalid JSON"
    }
    if ($event.eventType -eq "session.started") {
      Add-DeviceId $event.session.deviceId "${eventsPath}:${lineNumber}"
    }
  }
}

$outboxPath = Join-Path $rootPath "outbox.jsonl"
if (Test-Path -LiteralPath $outboxPath) {
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $outboxPath -Encoding UTF8) {
    $lineNumber += 1
    if (-not $line.Trim()) { continue }
    try {
      $item = $line | ConvertFrom-Json
    } catch {
      throw "${outboxPath}:${lineNumber}: invalid JSON"
    }
    Add-DeviceId $item.deviceId "${outboxPath}:${lineNumber}"
    $cursor = 0L
    if (-not [long]::TryParse([string]$item.localCursor, [ref]$cursor) -or $cursor -lt 1) {
      throw "${outboxPath}:${lineNumber}: invalid localCursor"
    }
    $expectedOutboxId = "outbox_$($item.deviceId)_$($cursor.ToString().PadLeft(8, '0'))"
    if ($item.outboxId -cne $expectedOutboxId) {
      throw "${outboxPath}:${lineNumber}: legacy or mismatched outboxId requires a pre-release data reset"
    }
  }
}

if ($deviceIds.Count -eq 0) {
  throw "Existing Lite timeline does not contain a deviceId to migrate."
}
if ($deviceIds.Count -ne 1) {
  throw "Lite timeline contains multiple deviceId values; resolve it with a manual external migration."
}

$deviceId = @($deviceIds)[0]
$identityPath = Join-Path $rootPath "device-id.txt"
$status = if (Test-Path -LiteralPath $identityPath) { "existing" } elseif ($Apply) { "created" } else { "planned" }
. (Join-Path $PSScriptRoot "resolve-device-id.ps1")
if (Test-Path -LiteralPath $identityPath) {
  $resolved = Resolve-TingyiDeviceId $rootPath $deviceId
  if ($resolved -cne $deviceId) {
    throw "Persisted device identity does not match the timeline."
  }
} elseif ($Apply) {
  Write-TingyiDeviceId $identityPath $deviceId
}

[pscustomobject][ordered]@{
  ok = $true
  apply = [bool]$Apply
  status = $status
  dataRoot = $rootPath
  deviceId = $deviceId
  identityPath = $identityPath
} | ConvertTo-Json -Compress
