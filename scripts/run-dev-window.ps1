[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("server", "dev", "dev:lan", "dev:https")]
  [string]$NpmScript
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7+ is required."
}

& npm run $NpmScript
if ($LASTEXITCODE -ne 0) {
  throw "npm run $NpmScript failed with exit code $LASTEXITCODE."
}
