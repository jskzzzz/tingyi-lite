[CmdletBinding()]
param(
  [int]$ApiPort = 8787,
  [int]$WebPort = 5177,
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7+ is required. Run this script with pwsh, not Windows PowerShell."
}

$normalizedRepoRoot = [System.IO.Path]::TrimEndingDirectorySeparator(
  [System.IO.Path]::GetFullPath($RepoRoot)
).Replace('/', '\')

function Get-ListenerSnapshot {
  return @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in @($ApiPort, $WebPort) }
  )
}

function Test-IsProjectDevListener([int]$ProcessId, [ValidateSet("API", "Web")] [string]$Kind) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $process -or $process.Name -notin @("node", "node.exe") -or -not $process.CommandLine) {
    return $false
  }

  $commandLine = ([string]$process.CommandLine).Replace('/', '\')
  if ($commandLine.IndexOf($normalizedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $false
  }

  $marker = if ($Kind -eq "API") { "src\server\index.ts" } else { "\vite\bin\vite.js" }
  return $commandLine.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-ProcessTree([int]$ProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-ProjectListenerProcessIds(
  [object[]]$Listeners,
  [int]$Port,
  [ValidateSet("API", "Web")] [string]$Kind
) {
  $processIds = @(
    $Listeners |
      Where-Object { $_.LocalPort -eq $Port } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  if ($processIds.Count -eq 0) {
    return @()
  }

  $projectProcessIds = @($processIds | Where-Object { Test-IsProjectDevListener ([int]$_) $Kind })
  if ($projectProcessIds.Count -ne $processIds.Count) {
    return @()
  }

  return $projectProcessIds
}

$listeners = @(Get-ListenerSnapshot)
$listenersToStop = @(
  @(Get-ProjectListenerProcessIds $listeners $ApiPort "API") | ForEach-Object {
    [pscustomobject]@{ ProcessId = [int]$_; Port = $ApiPort; Kind = "API" }
  }
  @(Get-ProjectListenerProcessIds $listeners $WebPort "Web") | ForEach-Object {
    [pscustomobject]@{ ProcessId = [int]$_; Port = $WebPort; Kind = "Web" }
  }
)

foreach ($listener in $listenersToStop) {
  Write-Host "Stopping previous Tingyi Lite $($listener.Kind) listener on port $($listener.Port) (PID $($listener.ProcessId))..."
  Stop-ProcessTree $listener.ProcessId
}

if ($listenersToStop.Count -gt 0) {
  $stoppedPorts = @($listenersToStop | Select-Object -ExpandProperty Port -Unique)
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    $remaining = @(Get-ListenerSnapshot | Where-Object { $_.LocalPort -in $stoppedPorts })
    if ($remaining.Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 100
  }

  $remaining = @(Get-ListenerSnapshot | Where-Object { $_.LocalPort -in $stoppedPorts })
  if ($remaining.Count -gt 0) {
    throw "Previous Tingyi Lite listener did not release port(s): $($stoppedPorts -join ', ')."
  }
}
