[CmdletBinding()]
param(
  [string]$SdkRoot = ".moonshine-runtime/sdk/moonshine-voice-windows-x86_64",
  [string]$ModelSource = ".demo-runtime/asr-eval/moonshine/models/download.moonshine.ai/model/tiny-streaming-en/quantized",
  [string]$MoonshineRuntimeSource = ".demo-runtime/asr-eval/moonshine/venv/Lib/site-packages/moonshine_voice",
  [string]$LicenseSource = "third_party/moonshine-voice/LICENSE.txt",
  [string]$OnnxLicenseSource = "third_party/onnxruntime/LICENSE.txt",
  [string]$OutputRoot = "runtime/moonshine-cpp",
  [string]$VisualStudioRoot = "",
  [string]$Arch = "tiny-streaming"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$repoRoot = Split-Path -Parent $PSScriptRoot
$sdkPath = Resolve-Path -LiteralPath (Join-Path $repoRoot $SdkRoot)
$modelPath = Resolve-Path -LiteralPath (Join-Path $repoRoot $ModelSource)
$moonshineRuntimePath = Resolve-Path -LiteralPath (Join-Path $repoRoot $MoonshineRuntimeSource)
$licensePath = Resolve-Path -LiteralPath (Join-Path $repoRoot $LicenseSource)
$onnxLicensePath = Resolve-Path -LiteralPath (Join-Path $repoRoot $OnnxLicenseSource)
$noticesPath = Resolve-Path -LiteralPath (Join-Path $repoRoot "third_party/MOONSHINE-RUNTIME-NOTICES.md")
$outputPath = Join-Path $repoRoot $OutputRoot
$modelsOutputPath = Join-Path $outputPath "models"
$sourcePath = Join-Path $repoRoot "src/native/MoonshinePreviewHelper/tingyi_moonshine_helper.cpp"
$compatSourcePath = Join-Path $repoRoot "src/native/MoonshinePreviewHelper/msvc_stl_compat.cpp"
$exePath = Join-Path $outputPath "tingyi-moonshine-helper.exe"

function Resolve-VsInstallationPath {
  param([string]$ConfiguredRoot)

  if ($ConfiguredRoot) {
    return (Resolve-Path -LiteralPath $ConfiguredRoot).Path
  }
  $vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio/Installer/vswhere.exe")
  )
  foreach ($candidate in $vswhereCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      $path = & $candidate -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
      if ($LASTEXITCODE -eq 0 -and $path) {
        return $path.Trim()
      }
    }
  }
  throw "Visual Studio C++ Build Tools not found."
}

$vsPath = Resolve-VsInstallationPath $VisualStudioRoot
$vcVarsPath = Join-Path $vsPath "VC/Auxiliary/Build/vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcVarsPath)) {
  throw "vcvars64.bat not found: $vcVarsPath"
}

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
New-Item -ItemType Directory -Force -Path $modelsOutputPath | Out-Null

Get-ChildItem -LiteralPath $modelsOutputPath -Force | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $modelPath -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $modelsOutputPath -Recurse -Force
}

$sdkInclude = Join-Path $sdkPath "include"
Copy-Item -LiteralPath (Join-Path $moonshineRuntimePath "moonshine.dll") -Destination (Join-Path $outputPath "moonshine.dll") -Force
Copy-Item -LiteralPath (Join-Path $moonshineRuntimePath "onnxruntime.dll") -Destination (Join-Path $outputPath "onnxruntime.dll") -Force
Copy-Item -LiteralPath $licensePath -Destination (Join-Path $outputPath "LICENSE.moonshine-voice.txt") -Force
Copy-Item -LiteralPath $onnxLicensePath -Destination (Join-Path $outputPath "LICENSE.onnxruntime.txt") -Force
Copy-Item -LiteralPath $noticesPath -Destination (Join-Path $outputPath "THIRD-PARTY-NOTICES.md") -Force

$vcRedistRoot = Join-Path $vsPath "VC/Redist/MSVC"
$vcRuntimePath = $null
if (Test-Path -LiteralPath $vcRedistRoot) {
  $vcRuntimePath = Get-ChildItem -LiteralPath $vcRedistRoot -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "x64/Microsoft.VC143.CRT" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
}
if ($vcRuntimePath) {
  foreach ($dll in @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll")) {
    $dllPath = Join-Path $vcRuntimePath $dll
    if (Test-Path -LiteralPath $dllPath) {
      Copy-Item -LiteralPath $dllPath -Destination (Join-Path $outputPath $dll) -Force
    }
  }
}

$compileScript = @"
call "$vcVarsPath" >nul
cl.exe /nologo /MD /utf-8 /EHsc /std:c++17 /O2 /W4 /WX /I"$sdkInclude" /Fe:"$exePath" "$sourcePath" "$compatSourcePath" /link
"@
$cmdFile = Join-Path $outputPath "build-moonshine-helper.cmd"
[System.IO.File]::WriteAllText($cmdFile, $compileScript, [System.Text.UTF8Encoding]::new($false))
try {
  & cmd.exe /d /c "`"$cmdFile`""
  if ($LASTEXITCODE -ne 0) {
    throw "cl.exe failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $cmdFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $repoRoot "tingyi_moonshine_helper.obj") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $repoRoot "msvc_stl_compat.obj") -Force -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath (Join-Path $outputPath "tingyi-moonshine-helper.lib") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $outputPath "tingyi-moonshine-helper.exp") -Force -ErrorAction SilentlyContinue

$manifestWriter = Join-Path $PSScriptRoot "write-moonshine-runtime-manifest.ps1"
& $manifestWriter -RuntimeRoot $OutputRoot -Version "0.0.62" -Model "tiny-streaming-en/quantized" -ModelSource "https://download.moonshine.ai/model/tiny-streaming-en/quantized" -Arch $Arch
if ($LASTEXITCODE -ne 0) {
  throw "Moonshine runtime manifest generation failed."
}

Write-Host "Moonshine C++ runtime built: $exePath"
