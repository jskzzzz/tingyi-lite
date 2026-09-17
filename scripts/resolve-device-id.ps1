[CmdletBinding()]
param(
  [string]$ResolverDataRoot,
  [string]$ResolverConfiguredDeviceId
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "resolve-device-id.ps1 requires PowerShell 7 or newer."
}
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Test-TingyiDeviceId([string]$DeviceId) {
  return $DeviceId -cne "local-device" -and $DeviceId -cmatch "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
}

function Read-TingyiDeviceId([string]$IdentityPath, [string]$ConfiguredDeviceId, [int]$WaitMilliseconds = 0) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
  while ($true) {
    try {
      $identityInfo = Get-Item -LiteralPath $IdentityPath -Force
      if ($identityInfo.PSIsContainer -or ($identityInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Device identity must be a real file: $IdentityPath"
      }
      $persisted = [System.IO.File]::ReadAllText(
        $IdentityPath,
        [System.Text.UTF8Encoding]::new($false)
      ).Trim()
      if (-not (Test-TingyiDeviceId $persisted)) {
        throw "Invalid device identity file: $IdentityPath"
      }
      if ($ConfiguredDeviceId -and $ConfiguredDeviceId -cne $persisted) {
        throw "TINGYI_DEVICE_ID does not match the persisted device identity in $IdentityPath"
      }
      return $persisted
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw
      }
      Start-Sleep -Milliseconds 10
    }
  }
}

function Invoke-WithTingyiDeviceIdentityLock([string]$IdentityPath, [scriptblock]$Operation) {
  $lockPath = "$IdentityPath.lock"
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  $lockStream = $null
  while (-not $lockStream) {
    try {
      $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for the device identity lock: $lockPath"
      }
      Start-Sleep -Milliseconds 10
    }
  }
  try {
    return & $Operation
  } finally {
    $lockStream.Dispose()
  }
}

function Write-TingyiDeviceIdFileAtomic([string]$IdentityPath, [string]$DeviceId) {
  $temporaryPath = Join-Path (Split-Path -Parent $IdentityPath) ".device-id-$([Guid]::NewGuid().ToString('N')).tmp"
  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $temporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    $payload = [System.Text.UTF8Encoding]::new($false).GetBytes("$DeviceId`n")
    $stream.Write($payload, 0, $payload.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    [System.IO.File]::Move($temporaryPath, $IdentityPath, $false)
  } finally {
    if ($stream) {
      $stream.Dispose()
    }
    if (Test-Path -LiteralPath $temporaryPath) {
      [System.IO.File]::Delete($temporaryPath)
    }
  }
}

function Write-TingyiDeviceId([string]$IdentityPath, [string]$DeviceId) {
  [void](Invoke-WithTingyiDeviceIdentityLock $IdentityPath {
    if (Test-Path -LiteralPath $IdentityPath) {
      [void](Read-TingyiDeviceId $IdentityPath $DeviceId)
      return
    }
    Write-TingyiDeviceIdFileAtomic $IdentityPath $DeviceId
  })
}

function Test-TingyiExistingTimeline([string]$DataRoot) {
  foreach ($name in @("events.jsonl", "outbox.jsonl")) {
    $path = Join-Path $DataRoot $name
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 0) {
      return $true
    }
  }
  return $false
}

function Resolve-TingyiDeviceId([string]$DataRoot, [string]$ConfiguredDeviceId) {
  $identityPath = Join-Path $DataRoot "device-id.txt"
  $configured = $ConfiguredDeviceId.Trim()
  if ($configured -and -not (Test-TingyiDeviceId $configured)) {
    throw "TINGYI_DEVICE_ID must be unique, must not be the reserved legacy value local-device, and may contain only 1-128 ASCII letters, digits, underscores, or hyphens."
  }
  if (-not (Test-Path -LiteralPath $identityPath) -and (Test-TingyiExistingTimeline $DataRoot)) {
    throw "Existing Lite data has no device-id.txt. Run the explicit data:migrate:device-id dry-run and apply workflow before starting."
  }
  return Invoke-WithTingyiDeviceIdentityLock $identityPath {
    if (Test-Path -LiteralPath $identityPath) {
      return Read-TingyiDeviceId $identityPath $configured
    }
    if (Test-TingyiExistingTimeline $DataRoot) {
      throw "Existing Lite data has no device-id.txt. Run the explicit data:migrate:device-id dry-run and apply workflow before starting."
    }
    $candidate = if ($configured) { $configured } else { "device_$([Guid]::NewGuid().ToString('N'))" }
    Write-TingyiDeviceIdFileAtomic $identityPath $candidate
    return $candidate
  }
}

if ($MyInvocation.InvocationName -ne ".") {
  if (-not $ResolverDataRoot) {
    throw "-ResolverDataRoot is required."
  }
  $resolvedRoot = [System.IO.Path]::GetFullPath($ResolverDataRoot)
  New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
  Resolve-TingyiDeviceId $resolvedRoot $ResolverConfiguredDeviceId
}
