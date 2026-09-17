[CmdletBinding()]
param(
  [string]$PackageRoot = "",
  [switch]$AllowMutableData
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "verify-lite-package.ps1 requires PowerShell 7 or newer."
}

$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-RealDirectoryChain([string]$Path) {
  $current = $Path
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Portable package path must not traverse a reparse point: $current"
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) {
      break
    }
    $current = $parent
  }
}

function Assert-NoAlternateDataStreams([string]$Path, [string]$Label) {
  foreach ($stream in @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop)) {
    if ($stream.Stream -cne ':$DATA') {
      throw "Portable package must not contain alternate data streams: ${Label}:$($stream.Stream)"
    }
  }
}

function Assert-Utf8Bom([string]$Path, [string]$Label) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    throw "Portable package PowerShell script must use UTF-8 with BOM: $Label"
  }
}

if ($PackageRoot) {
  $rootPath = if ([System.IO.Path]::IsPathRooted($PackageRoot)) {
    [System.IO.Path]::GetFullPath($PackageRoot)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $PackageRoot))
  }
} elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot "package-manifest.json")) {
  $rootPath = [System.IO.Path]::GetFullPath($PSScriptRoot)
} else {
  $rootPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "artifacts/portable/tingyi-lite"))
}

Assert-RealDirectoryChain $rootPath
$rootInfo = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
if (-not $rootInfo.PSIsContainer -or ($rootInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw "Portable package root must be a real directory: $rootPath"
}
Assert-NoAlternateDataStreams $rootPath "."

$manifestPath = Join-Path $rootPath "package-manifest.json"
$manifestInfo = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
if ($manifestInfo.PSIsContainer -or ($manifestInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw "Portable package manifest must be a real file: $manifestPath"
}
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
} catch {
  throw "Invalid portable package manifest JSON: $($_.Exception.Message)"
}

if ($manifest.schemaVersion -ne 2 -or $manifest.product -ne "tingyi-lite-portable") {
  throw "Invalid portable package manifest identity."
}
if ($manifest.version -isnot [string] -or -not $manifest.version.Trim()) {
  throw "Portable package manifest version must be a non-empty string."
}
if ($manifest.sourceRevision -isnot [string] -or $manifest.sourceRevision -cnotmatch "^[a-f0-9]{40,64}$") {
  throw "Portable package manifest sourceRevision must be a Git object ID."
}
$generatedAt = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse([string]$manifest.generatedAt, [ref]$generatedAt)) {
  throw "Portable package manifest generatedAt must be an ISO timestamp."
}

$manifestCount = 0L
$manifestTotal = 0L
if (-not [long]::TryParse([string]$manifest.fileCount, [ref]$manifestCount) -or $manifestCount -lt 0) {
  throw "Portable package manifest fileCount must be a non-negative integer."
}
if (-not [long]::TryParse([string]$manifest.totalBytes, [ref]$manifestTotal) -or $manifestTotal -lt 0) {
  throw "Portable package manifest totalBytes must be a non-negative integer."
}

$runtimeContainer = Join-Path $rootPath "runtime"
$packagedRuntimes = @(
  Get-ChildItem -LiteralPath $runtimeContainer -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "runtime-manifest.json") -PathType Leaf } |
    ForEach-Object { $_.Name }
)
if ($packagedRuntimes.Count -eq 0) {
  throw "Portable package requires at least one local ASR runtime declaring a manifest under runtime/."
}

$entries = @($manifest.files)
$manifestPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$manifestEntries = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
$calculatedTotal = 0L
$rootPrefix = $rootPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

function Assert-AllowedProductPath([string]$RelativePath) {
  $parts = @($RelativePath.Split("/"))
  $forbiddenDirectories = @("data", ".runs", ".codegraph", "node_modules", "cache", ".cache")
  foreach ($part in $parts) {
    if ($forbiddenDirectories -contains $part.ToLowerInvariant()) {
      throw "Portable package must not include development or mutable data: $RelativePath"
    }
  }
  $fileName = [System.IO.Path]::GetFileName($RelativePath)
  $lowerName = $fileName.ToLowerInvariant()
  $extension = [System.IO.Path]::GetExtension($fileName).ToLowerInvariant()
  if ($lowerName.StartsWith(".env", [System.StringComparison]::OrdinalIgnoreCase) -or
      $lowerName.Contains("credential") -or $lowerName.Contains("secret") -or
      $lowerName -eq "private.key" -or
      $extension -in @(".key", ".pem", ".pfx", ".p12", ".mp3", ".mp4", ".wav", ".flac", ".m4a", ".webm", ".ogg", ".aac")) {
    throw "Portable package must not include secrets, credentials, or test media: $RelativePath"
  }

  $exactPaths = @(
    "README.md",
    "resolve-device-id.ps1",
    "start.cmd",
    "start.mjs",
    "start.ps1",
    "verify.ps1",
    "server/index.mjs",
    "web/index.html",
    "web/favicon.svg",
    "native/system-captions/Microsoft.Windows.SDK.NET.dll",
    "native/system-captions/TingyiLite.SystemCaptionsHelper.deps.json",
    "native/system-captions/TingyiLite.SystemCaptionsHelper.dll",
    "native/system-captions/TingyiLite.SystemCaptionsHelper.exe",
    "native/system-captions/TingyiLite.SystemCaptionsHelper.pdb",
    "native/system-captions/TingyiLite.SystemCaptionsHelper.runtimeconfig.json",
    "native/system-captions/WinRT.Runtime.dll",
    "native/overlay/TingyiLite.Overlay.deps.json",
    "native/overlay/TingyiLite.Overlay.dll",
    "native/overlay/TingyiLite.Overlay.exe",
    "native/overlay/TingyiLite.Overlay.pdb",
    "native/overlay/TingyiLite.Overlay.runtimeconfig.json",
    "native/wasapi-loopback/TingyiLite.WasapiLoopbackHelper.exe",
    "runtime/node/node.exe"
  )
  if ($RelativePath -cin $exactPaths) {
    return
  }
  if ($RelativePath.StartsWith("web/assets/", [System.StringComparison]::Ordinal) -and
      $extension -cin @(".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ico")) {
    return
  }
  foreach ($runtimeName in $packagedRuntimes) {
    if ($RelativePath.StartsWith("runtime/$runtimeName/", [System.StringComparison]::Ordinal)) {
      return
    }
  }
  throw "Portable package path is not in the product allowlist: $RelativePath"
}

foreach ($entry in $entries) {
  if ($null -eq $entry -or $entry.path -isnot [string]) {
    throw "Portable package manifest contains an invalid file entry."
  }
  $relativePath = $entry.path
  if ($relativePath.Equals("data", [System.StringComparison]::OrdinalIgnoreCase) -or
      $relativePath.StartsWith("data/", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable package manifest must not include mutable user data: $relativePath"
  }
  $parts = $relativePath.Split("/")
  if (-not $relativePath -or $relativePath.Contains("\") -or [System.IO.Path]::IsPathRooted($relativePath) -or $parts.Where({ -not $_ -or $_ -eq "." -or $_ -eq ".." }).Count -gt 0) {
    throw "Portable package manifest path must be normalized and relative: $relativePath"
  }
  Assert-AllowedProductPath $relativePath
  if (-not $manifestPaths.Add($relativePath)) {
    throw "Portable package manifest contains a duplicate path: $relativePath"
  }

  $byteLength = 0L
  if (-not [long]::TryParse([string]$entry.byteLength, [ref]$byteLength) -or $byteLength -lt 0) {
    throw "Portable package manifest byteLength is invalid: $relativePath"
  }
  if ($entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch "^[a-f0-9]{64}$") {
    throw "Portable package manifest SHA-256 is invalid: $relativePath"
  }

  $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootPath $relativePath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)))
  if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable package manifest path escapes its root: $relativePath"
  }
  $manifestEntries.Add($relativePath, [pscustomobject]@{
    path = $candidate
    byteLength = $byteLength
    sha256 = $entry.sha256
  })
  $calculatedTotal += $byteLength
}

if ($manifestCount -ne $entries.Count) {
  throw "Portable package manifest fileCount does not match files."
}
if ($manifestTotal -ne $calculatedTotal) {
  throw "Portable package manifest totalBytes does not match files."
}

$requiredPaths = @(
  "README.md",
  "resolve-device-id.ps1",
  "start.cmd",
  "start.mjs",
  "start.ps1",
  "verify.ps1",
  "server/index.mjs",
  "web/index.html",
  "native/system-captions/TingyiLite.SystemCaptionsHelper.exe",
  "native/overlay/TingyiLite.Overlay.exe",
  "runtime/node/node.exe"
)
# Runtime payload requirements are derived from each packaged manifest instead of a fixed
# list, so a new engine only has to be added to the package to be fully verified. The
# manifest must ship its command, its provenance license files, and every hashed file.
foreach ($runtimeName in $packagedRuntimes) {
  $runtimeManifestPath = Join-Path $runtimeContainer "$runtimeName/runtime-manifest.json"
  try {
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    throw "Portable package runtime manifest is invalid JSON: runtime/$runtimeName/runtime-manifest.json"
  }
  if ($runtimeManifest.schemaVersion -ne 4 -or $runtimeManifest.runtime -ne "local-asr-engine" -or $runtimeManifest.protocol -ne "local-asr-jsonl-v2") {
    throw "Portable package runtime manifest has an invalid identity: runtime/$runtimeName/runtime-manifest.json"
  }
  $requiredPaths += "runtime/$runtimeName/runtime-manifest.json"
  $requiredPaths += "runtime/$runtimeName/$($runtimeManifest.command)"
  foreach ($licenseProperty in @("runtime", "model")) {
    $licenseFile = [string]$runtimeManifest.provenance.$licenseProperty.licenseFile
    if ($licenseFile) {
      $requiredPaths += "runtime/$runtimeName/$licenseFile"
    }
  }
  $endpointLicenseFile = [string]$runtimeManifest.provenance.endpoint.licenseFile
  if ($endpointLicenseFile) {
    $requiredPaths += "runtime/$runtimeName/$endpointLicenseFile"
  }
  foreach ($fileProperty in $runtimeManifest.files.PSObject.Properties) {
    $requiredPaths += "runtime/$runtimeName/$($fileProperty.Name)"
  }
}
$requiredPaths = @($requiredPaths | Sort-Object -Unique)
foreach ($requiredPath in $requiredPaths) {
  if (-not $manifestPaths.Contains($requiredPath)) {
    throw "Portable package manifest is missing required product file: $requiredPath"
  }
}

$actualPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$pending = [System.Collections.Generic.Stack[string]]::new()
$pending.Push($rootPath)
while ($pending.Count -gt 0) {
  $directory = $pending.Pop()
  foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
    $relativePath = $item.FullName.Substring($rootPath.Length).TrimStart("\", "/").Replace("\", "/")
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Portable package must not contain reparse points: $relativePath"
    }
    Assert-NoAlternateDataStreams $item.FullName $relativePath
    if ($item.PSIsContainer) {
      if ($relativePath -ieq "data") {
        if (-not $AllowMutableData) {
          throw "Portable package strict release verification must not contain data: $relativePath"
        }
      } else {
        $directoryParts = @($relativePath.Split("/"))
        $forbiddenDirectory = $directoryParts | Where-Object { $_.ToLowerInvariant() -in @(".runs", ".codegraph", "node_modules", "cache", ".cache") } | Select-Object -First 1
        if ($forbiddenDirectory) {
          throw "Portable package must not include development or mutable data: $relativePath"
        }
        $directoryPrefix = "$relativePath/"
        $isProductAncestor = $manifestPaths.Where({ $_.StartsWith($directoryPrefix, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        if (-not $isProductAncestor) {
          throw "Portable package directory is not an ancestor of an allowed product file: $relativePath"
        }
        $pending.Push($item.FullName)
      }
    } elseif ($relativePath -cne "package-manifest.json") {
      if (-not $actualPaths.Add($relativePath)) {
        throw "Portable package contains a duplicate file path: $relativePath"
      }
    }
  }
}

foreach ($relativePath in $actualPaths) {
  if (-not $manifestPaths.Contains($relativePath)) {
    throw "Portable package contains an unmanifested file: $relativePath"
  }
}
foreach ($relativePath in $manifestPaths) {
  if (-not $actualPaths.Contains($relativePath)) {
    throw "Portable package manifest file is missing: $relativePath"
  }
  $entry = $manifestEntries[$relativePath]
  $fileInfo = Get-Item -LiteralPath $entry.path -Force -ErrorAction Stop
  if ($fileInfo.PSIsContainer -or ($fileInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "Portable package manifest entry must be a real file: $relativePath"
  }
  if ([long]$fileInfo.Length -ne [long]$entry.byteLength) {
    throw "Portable package byte length mismatch: $relativePath"
  }
  $actualHash = (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne $entry.sha256) {
    throw "Portable package SHA-256 mismatch: $relativePath"
  }
}

foreach ($scriptPath in @("resolve-device-id.ps1", "start.ps1", "verify.ps1")) {
  Assert-Utf8Bom (Join-Path $rootPath $scriptPath) $scriptPath
}

foreach ($runtimeName in $packagedRuntimes) {
  $runtimeRoot = "runtime/$runtimeName"
  $runtimeManifestPath = "$runtimeRoot/runtime-manifest.json"
  $runtimeManifest = Get-Content -LiteralPath (Join-Path $rootPath $runtimeManifestPath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)) -Raw -Encoding utf8 | ConvertFrom-Json
  if ($runtimeManifest.schemaVersion -ne 4 -or $runtimeManifest.runtime -cne "local-asr-engine" -or
      $runtimeManifest.protocol -cne "local-asr-jsonl-v2" -or
      $runtimeManifest.startupTimeoutMs -isnot [int64] -or
      $runtimeManifest.startupTimeoutMs -lt 1000 -or $runtimeManifest.startupTimeoutMs -gt 300000 -or
      $null -eq $runtimeManifest.files) {
    throw "Portable package contains an invalid Local ASR runtime manifest: $runtimeManifestPath"
  }
  $runtimePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  [void]$runtimePaths.Add($runtimeManifestPath)
  foreach ($property in $runtimeManifest.files.PSObject.Properties) {
    $runtimeRelativePath = [string]$property.Name
    $runtimeParts = $runtimeRelativePath.Split("/")
    if (-not $runtimeRelativePath -or $runtimeRelativePath.Contains("\") -or
        $runtimeParts.Where({ -not $_ -or $_ -eq "." -or $_ -eq ".." }).Count -gt 0 -or
        [string]$property.Value -cnotmatch "^[a-f0-9]{64}$") {
      throw "Portable package runtime manifest contains an invalid file entry: $runtimeManifestPath -> $runtimeRelativePath"
    }
    $packagePath = "$runtimeRoot/$runtimeRelativePath"
    Assert-AllowedProductPath $packagePath
    if (-not $runtimePaths.Add($packagePath)) {
      throw "Portable package runtime manifest contains a duplicate file entry: $packagePath"
    }
    if (-not $manifestPaths.Contains($packagePath)) {
      throw "Portable package runtime manifest file is missing from package manifest: $packagePath"
    }
    if ($manifestEntries[$packagePath].sha256 -cne [string]$property.Value) {
      throw "Portable package runtime/package manifest SHA-256 mismatch: $packagePath"
    }
  }
  foreach ($packagePath in $manifestPaths) {
    if ($packagePath.StartsWith("$runtimeRoot/", [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $runtimePaths.Contains($packagePath)) {
      throw "Portable package runtime contains a file outside its runtime manifest: $packagePath"
    }
  }
}

[pscustomobject][ordered]@{
  ok = $true
  product = $manifest.product
  version = $manifest.version
  sourceRevision = $manifest.sourceRevision
  packageRoot = $rootPath
  fileCount = $manifestCount
  totalBytes = $manifestTotal
} | ConvertTo-Json -Compress
