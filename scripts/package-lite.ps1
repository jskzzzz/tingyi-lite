[CmdletBinding()]
param(
  [string]$OutputRoot = "artifacts/portable/tingyi-lite"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "package-lite.ps1 requires PowerShell 7 or newer."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputPath = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
  [System.IO.Path]::GetFullPath($OutputRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
}
$outputParent = Split-Path -Parent $outputPath
$outputLeaf = Split-Path -Leaf $outputPath
if (-not $outputParent -or -not $outputLeaf) {
  throw "Portable output must be a named directory below an existing filesystem root: $outputPath"
}
$buildRoot = Join-Path $repoRoot "artifacts/portable-build"
$serverBuild = Join-Path $buildRoot "server/index.mjs"
$helperBuild = Join-Path $buildRoot "system-captions"
$overlayBuild = Join-Path $buildRoot "overlay"
$wasapiBuild = Join-Path $buildRoot "wasapi-loopback"

function Assert-RealDirectoryChain([string]$Path) {
  $current = $Path
  while (-not (Test-Path -LiteralPath $current)) {
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) {
      throw "Portable output path has no existing directory ancestor: $Path"
    }
    $current = $parent
  }
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Portable output path must not traverse a reparse point: $current"
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) {
      break
    }
    $current = $parent
  }
}

function Get-SourceRevision {
  $revision = (& git -C $repoRoot rev-parse --verify HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $revision -cnotmatch "^[a-f0-9]{40,64}$") {
    throw "Portable packaging requires a valid Git HEAD revision."
  }
  return $revision
}

function Get-PackagedAsrRuntimes {
  $runtimeContainer = Join-Path $repoRoot "runtime"
  $runtimes = @()
  if (Test-Path -LiteralPath $runtimeContainer) {
    foreach ($directory in @(Get-ChildItem -LiteralPath $runtimeContainer -Directory | Sort-Object Name)) {
      $manifestPath = Join-Path $directory.FullName "runtime-manifest.json"
      if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        continue
      }
      $identity = $null
      try {
        $identity = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
      } catch {
        continue
      }
      if ($identity.schemaVersion -ne 4 -or $identity.runtime -ne "local-asr-engine" -or $identity.protocol -ne "local-asr-jsonl-v2") {
        continue
      }
      $runtimes += [pscustomobject][ordered]@{ Name = $directory.Name; Root = $directory.FullName; Manifest = $identity }
    }
  }
  if ($runtimes.Count -eq 0) {
    throw "Portable packaging requires at least one local ASR runtime declaring schemaVersion 4 under $runtimeContainer."
  }
  return $runtimes
}

function Invoke-AsrRuntimeSmoke([pscustomobject]$Runtime) {
  foreach ($smoke in @($Runtime.Manifest.smoke)) {
    if ($null -eq $smoke) {
      continue
    }
    $arguments = @($smoke.args | ForEach-Object { ([string]$_).Replace("{runtimeRoot}", [string]$Runtime.Root) })
    Write-Host "ASR runtime smoke [$($Runtime.Name)]: $($smoke.command) $($arguments -join ' ')"
    & $smoke.command @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Local ASR runtime smoke failed for $($Runtime.Name): $($smoke.command) $($arguments -join ' ')"
    }
  }
}

function Assert-SourceTree([string]$ExpectedRevision, [string]$AllowedGeneratedPath = "") {
  $currentRevision = Get-SourceRevision
  if ($currentRevision -cne $ExpectedRevision) {
    throw "Git HEAD changed during portable packaging."
  }
  & git -C $repoRoot diff-index --quiet HEAD --
  if ($LASTEXITCODE -ne 0) {
    throw "Portable packaging requires all tracked source changes to be committed first."
  }
  $untrackedPaths = @(& git -C $repoRoot ls-files --others --exclude-standard)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect untracked files before packaging."
  }
  $allowedUntrackedPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  [void]$allowedUntrackedPaths.Add("test.mp3")
  [void]$allowedUntrackedPaths.Add("test.mp4")
  $allowedGeneratedPrefix = ""
  if ($AllowedGeneratedPath) {
    $relativeGeneratedPath = [System.IO.Path]::GetRelativePath($repoRoot, $AllowedGeneratedPath).Replace("\", "/")
    if (-not $relativeGeneratedPath.StartsWith("../") -and $relativeGeneratedPath -ne "..") {
      $allowedGeneratedPrefix = $relativeGeneratedPath.TrimEnd("/") + "/"
    }
  }
  $unexpectedUntrackedPaths = @($untrackedPaths | Where-Object {
    -not $allowedUntrackedPaths.Contains($_) -and
    (-not $allowedGeneratedPrefix -or -not $_.StartsWith($allowedGeneratedPrefix, [System.StringComparison]::Ordinal))
  })
  if ($unexpectedUntrackedPaths.Count -gt 0) {
    throw "Portable packaging refuses unexpected untracked files: $($unexpectedUntrackedPaths -join ', ')"
  }
}

Assert-RealDirectoryChain $outputPath
if (Test-Path -LiteralPath $outputPath) {
  $outputInfo = Get-Item -LiteralPath $outputPath -Force
  if (-not $outputInfo.PSIsContainer -or ($outputInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "Portable output path must be a real directory: $outputPath"
  }
  if ((Get-ChildItem -LiteralPath $outputPath -Force | Select-Object -First 1)) {
    throw "Portable output directory must be empty: $outputPath"
  }
} else {
  New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
}
Assert-RealDirectoryChain $outputParent

$sourceRevision = Get-SourceRevision
Assert-SourceTree $sourceRevision
$asrRuntimes = @(Get-PackagedAsrRuntimes)

Push-Location $repoRoot
try {
  if (Test-Path -LiteralPath $buildRoot) {
    Assert-RealDirectoryChain $buildRoot
    $buildInfo = Get-Item -LiteralPath $buildRoot -Force
    if (-not $buildInfo.PSIsContainer -or ($buildInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Portable build root must be a real directory: $buildRoot"
    }
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
  }
  & npm test
  if ($LASTEXITCODE -ne 0) { throw "Test suite failed." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed." }
  & npm run build:server
  if ($LASTEXITCODE -ne 0) { throw "Server bundle build failed." }
  & dotnet publish native/TingyiLite.SystemCaptionsHelper/TingyiLite.SystemCaptionsHelper.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o $helperBuild
  if ($LASTEXITCODE -ne 0) { throw "System captions helper publish failed." }
  & dotnet publish native/TingyiLite.Overlay/TingyiLite.Overlay.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o $overlayBuild
  if ($LASTEXITCODE -ne 0) { throw "Native overlay publish failed." }
  & dotnet publish native/TingyiLite.WasapiLoopbackHelper/TingyiLite.WasapiLoopbackHelper.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=None -p:DebugSymbols=false -o $wasapiBuild
  if ($LASTEXITCODE -ne 0) { throw "WASAPI loopback helper publish failed." }
  foreach ($runtime in $asrRuntimes) {
    Invoke-AsrRuntimeSmoke $runtime
  }
} finally {
  Pop-Location
}

$required = @(
  (Join-Path $repoRoot "dist/index.html"),
  $serverBuild,
  (Join-Path $helperBuild "TingyiLite.SystemCaptionsHelper.exe"),
  (Join-Path $overlayBuild "TingyiLite.Overlay.exe"),
  (Join-Path $wasapiBuild "TingyiLite.WasapiLoopbackHelper.exe"),
  (Get-Command node -ErrorAction Stop).Source
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Portable build input is missing: $path"
  }
}

$systemCaptionsHelper = Join-Path $helperBuild "TingyiLite.SystemCaptionsHelper.exe"
& $systemCaptionsHelper --self-test
if ($LASTEXITCODE -ne 0) {
  throw "System captions helper self-test failed."
}

function Copy-Directory([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

function Copy-Utf8BomFile([string]$Source, [string]$Destination) {
  $content = Get-Content -LiteralPath $Source -Raw -Encoding utf8
  [System.IO.File]::WriteAllText($Destination, $content, [System.Text.UTF8Encoding]::new($true))
}

Assert-SourceTree $sourceRevision
Assert-RealDirectoryChain $outputParent
$stagingPath = Join-Path $outputParent ".$outputLeaf.staging-$([Guid]::NewGuid().ToString('N'))"
if (Test-Path -LiteralPath $stagingPath) {
  throw "Portable staging path unexpectedly exists: $stagingPath"
}
New-Item -ItemType Directory -Path $stagingPath | Out-Null
$published = $false
try {
  Copy-Directory (Join-Path $repoRoot "dist") (Join-Path $stagingPath "web")
  New-Item -ItemType Directory -Force -Path (Join-Path $stagingPath "server") | Out-Null
  Copy-Item -LiteralPath $serverBuild -Destination (Join-Path $stagingPath "server/index.mjs") -Force
  Copy-Directory $helperBuild (Join-Path $stagingPath "native/system-captions")
  Copy-Directory $overlayBuild (Join-Path $stagingPath "native/overlay")
  Copy-Directory $wasapiBuild (Join-Path $stagingPath "native/wasapi-loopback")
  foreach ($runtime in $asrRuntimes) {
    Copy-Directory $runtime.Root (Join-Path $stagingPath "runtime/$($runtime.Name)")
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $stagingPath "runtime/node") | Out-Null
  Copy-Item -LiteralPath (Get-Command node -ErrorAction Stop).Source -Destination (Join-Path $stagingPath "runtime/node/node.exe") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "scripts/portable-start.cmd") -Destination (Join-Path $stagingPath "start.cmd") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "scripts/portable-start.mjs") -Destination (Join-Path $stagingPath "start.mjs") -Force
  Copy-Utf8BomFile (Join-Path $repoRoot "scripts/portable-start.ps1") (Join-Path $stagingPath "start.ps1")
  Copy-Utf8BomFile (Join-Path $repoRoot "scripts/resolve-device-id.ps1") (Join-Path $stagingPath "resolve-device-id.ps1")
  Copy-Utf8BomFile (Join-Path $repoRoot "scripts/verify-lite-package.ps1") (Join-Path $stagingPath "verify.ps1")
  Copy-Item -LiteralPath (Join-Path $repoRoot "scripts/PORTABLE-README.md") -Destination (Join-Path $stagingPath "README.md") -Force

  $package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding utf8 | ConvertFrom-Json
  $totalBytes = [long]0
  $fileEntries = @(
    Get-ChildItem -LiteralPath $stagingPath -Recurse -File |
      Where-Object Name -ne "package-manifest.json" |
      Sort-Object FullName |
      ForEach-Object {
        $length = [long]$_.Length
        $totalBytes += $length
        [pscustomobject][ordered]@{
          path = $_.FullName.Substring($stagingPath.Length).TrimStart("\", "/").Replace("\", "/")
          byteLength = $length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
      }
  )
  $manifest = [ordered]@{
    schemaVersion = 2
    product = "tingyi-lite-portable"
    version = $package.version
    sourceRevision = $sourceRevision
    generatedAt = [DateTime]::UtcNow.ToString("o")
    fileCount = $fileEntries.Count
    totalBytes = $totalBytes
    files = $fileEntries
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText((Join-Path $stagingPath "package-manifest.json"), "$manifestJson`n", [System.Text.UTF8Encoding]::new($false))
  $verifier = Join-Path $stagingPath "verify.ps1"
  & $verifier -PackageRoot $stagingPath
  $smoke = Join-Path $repoRoot "scripts/smoke-lite-package.ps1"
  & $smoke -PackageRoot $stagingPath
  & $verifier -PackageRoot $stagingPath
  Assert-SourceTree $sourceRevision $stagingPath

  Assert-RealDirectoryChain $outputPath
  if (Test-Path -LiteralPath $outputPath) {
    $outputInfo = Get-Item -LiteralPath $outputPath -Force
    if (-not $outputInfo.PSIsContainer -or ($outputInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Portable output path changed before publication: $outputPath"
    }
    if ((Get-ChildItem -LiteralPath $outputPath -Force | Select-Object -First 1)) {
      throw "Portable output directory changed during build: $outputPath"
    }
    Remove-Item -LiteralPath $outputPath
  }
  Move-Item -LiteralPath $stagingPath -Destination $outputPath
  $published = $true
  Write-Host "听译 Lite 便携包已生成：$outputPath"
  Write-Host "文件数：$($manifest.fileCount)，总字节：$($manifest.totalBytes)"
} finally {
  if (-not $published -and (Test-Path -LiteralPath $stagingPath)) {
    $stagingInfo = Get-Item -LiteralPath $stagingPath -Force
    if ($stagingInfo.PSIsContainer -and -not ($stagingInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      Remove-Item -LiteralPath $stagingPath -Recurse -Force
    } else {
      Write-Warning "Unsafe staging path was not removed: $stagingPath"
    }
  }
}
