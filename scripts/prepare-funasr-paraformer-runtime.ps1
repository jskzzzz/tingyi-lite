[CmdletBinding()]
param(
  [string]$OutputRoot = "runtime/funasr-paraformer-zh-2pass",
  [string]$WorkRoot = ".runs/funasr-paraformer-runtime",
  [string]$SourceRoot = "",
  [string]$BuildRoot = "",
  [string]$ModelRoot = "",
  [string]$OnnxRuntimeRoot = "",
  [string]$VisualStudioRoot = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$funAsrCommit = "79a0ed22e14ca74d728bf77d7df0ef0c463a9680"
$funAsrSourceUrl = "https://github.com/modelscope/FunASR/archive/$funAsrCommit.zip"
$funAsrSourceSha256 = "07fabd234c0f58e06e3ef55c1f8df1ecfa7e34c2efef6e5fd6188c6107fcd903"
$onnxRuntimeVersion = "1.16.1"
$onnxRuntimeUrl = "https://github.com/microsoft/onnxruntime/releases/download/v$onnxRuntimeVersion/onnxruntime-win-x64-$onnxRuntimeVersion.zip"
$onnxRuntimeSha256 = "05a972384c73c05bce51ffd3e15b1e78325ea9fa652573113159b5cac547ecce"
$glogLicenseUrl = "https://raw.githubusercontent.com/google/glog/v0.7.0/COPYING"
$glogLicenseSha256 = "136d48dea7a681413691f3db3098f6cf5ffaa3119d96d97bb83b8cff3ce38c4a"
$yamlCppLicenseUrl = "https://raw.githubusercontent.com/jbeder/yaml-cpp/yaml-cpp-0.6.0/LICENSE"
$yamlCppLicenseSha256 = "aa6fcc27be034e41e21dd832f9175bfe694a48491d9e14ff0fa278e19ad14f1b"
$apacheLicenseUrl = "https://www.apache.org/licenses/LICENSE-2.0.txt"
$apacheLicenseSha256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"

$modelSets = [ordered]@{
  online = [ordered]@{
    model = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx"
    files = [ordered]@{
      "am.mvn" = "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5"
      "config.yaml" = "35e6bf41f8c7eaf9a0f787af7fdc8fc5ed75fa8009ade7d3c2f3ef5bce20c648"
      "configuration.json" = "cbf1c4e973cbb914d5c3aa24dcb30468bccc3abef60c1b9f9bb28b1f75c81255"
      "decoder_quant.onnx" = "873d21ee80c7345bfc27944b843699fe16bba021fd020747d38aef2dfc103681"
      "model_quant.onnx" = "dd4121cf45102018c26f9256f0b862df416edfcd06b0863ef4ce378a63c7d5e2"
      "README.md" = "2d00a193907b9df59b791a956efbd932bd60fbf136927e2bd2c80af947b52268"
      "tokens.json" = "2b20c2b12572d682afff84ce1c8d560f67b8b32a4c1f21567411d141ed352127"
    }
  }
  offline = [ordered]@{
    model = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx"
    files = [ordered]@{
      "am.mvn" = "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5"
      "config.yaml" = "bfd424b9f61846aac63591e96fe24d66b35f4643bddcb4b9bb759db8f987ab79"
      "configuration.json" = "825265e469592ee4e28911fec85cbccc9ed778b12066b9af0dbdfb0bd65c8453"
      "model_quant.onnx" = "c3a06538f867c8e3d9bb9c9e1b44b126a50d732862f6c428b1b5896ee9be65c5"
      "README.md" = "1ab1f3225e04ba4b731c819a15d498825e52cd13aac80f5d457d4d7e37aab76f"
      "tokens.json" = "2b20c2b12572d682afff84ce1c8d560f67b8b32a4c1f21567411d141ed352127"
    }
  }
  vad = [ordered]@{
    model = "iic/speech_fsmn_vad_zh-cn-16k-common-onnx"
    files = [ordered]@{
      "am.mvn" = "6820fef9687708c4fc3fab2530179c8fcea6262daa25514380056cd8f6eb1754"
      "config.yaml" = "2ef334f2d7776edd86ed696296774f87550206c256bfabc597872ad861831589"
      "configuration.json" = "f62fcbcebbaade798714b34c521cad87d869ee6a327ceed948e01ff2336bbfc0"
      "model_quant.onnx" = "5289eb2aa3c9af2d7a4284bcfa7c3ceb81d360814ed4203239b6c5d0569da8a1"
      "README.md" = "310324d715f5bb5da898d1e9876a4f2fadf1f9bd9e71b77aaa6d2581707bb267"
    }
  }
  punc = [ordered]@{
    model = "iic/punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727-onnx"
    files = [ordered]@{
      "config.yaml" = "4b57cf5d7a3310937ac2d73aa0ea89770e022d62c99dcf3e247f7dbeb0b0260d"
      "configuration.json" = "7c7884ea9e28c103034672afc1f8d37e8758af6d1eeeaf3a40396ef89975b9cd"
      "model_quant.onnx" = "a167b716ac5ade229b45c0e5c8fafc935cf65abda8b37597c781332ec2970a89"
      "README.md" = "a2ea16da3740ba67cc8d84e730a04d45e7895c83d12c334ad7969c4fa01cfb48"
      "tokens.json" = "c960ab87bccea4aa15cf49a59f71973c2c330b46668048cd8da253749ec71ee3"
    }
  }
  itn = [ordered]@{
    model = "thuduj12/fst_itn_zh"
    files = [ordered]@{
      "configuration.json" = "52f2864a0245fd59162431fb54fcda8a083729183c86532037d6bcaa6df9d7e6"
      "README.md" = "099fe4aaa32cabf5f603abce2d008ba973aee1e1b67fa21320fe757c4ce29141"
      "zh_itn_tagger.fst" = "b6e7f892c1fd1b313ea94215d529160c237b2d575b2b98969ed5ca0c10ff7300"
      "zh_itn_verbalizer.fst" = "de9d39002de8d73e97e3740d98d037c4aa8f421881a62baa3f0e022add994a34"
    }
  }
}

$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
$workPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $WorkRoot))
$repoPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $outputPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "FunASR runtime output must remain inside the repository: $outputPath"
}

function Resolve-VsInstallationPath([string]$ConfiguredRoot) {
  if ($ConfiguredRoot) {
    return (Resolve-Path -LiteralPath $ConfiguredRoot).Path
  }
  foreach ($candidate in @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"),
    (Join-Path $env:ProgramFiles "Microsoft Visual Studio/Installer/vswhere.exe")
  )) {
    if (Test-Path -LiteralPath $candidate) {
      $path = & $candidate -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
      if ($LASTEXITCODE -eq 0 -and $path) { return $path.Trim() }
    }
  }
  throw "Visual Studio C++ Build Tools not found."
}

function Get-VerifiedFile([string]$Uri, [string]$Sha256, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    & curl.exe -L --fail --retry 5 --retry-delay 2 --connect-timeout 20 --max-time 1800 -o $Destination $Uri
    if ($LASTEXITCODE -ne 0) { throw "curl.exe failed to download $Uri" }
  }
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "SHA-256 mismatch: $Destination" }
}

function Resolve-ConfiguredPath([string]$ConfiguredPath) {
  if ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
    return (Resolve-Path -LiteralPath $ConfiguredPath).Path
  }
  return (Resolve-Path -LiteralPath (Join-Path $repoRoot $ConfiguredPath)).Path
}

function Copy-VerifiedModelFile(
  [string]$SetName,
  [string]$ModelId,
  [string]$FileName,
  [string]$Sha256,
  [string]$Destination
) {
  if ($ModelRoot) {
    $source = Join-Path (Resolve-ConfiguredPath $ModelRoot) "$SetName/$FileName"
    $actual = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "Prepared model SHA-256 mismatch: $source" }
    Copy-Item -LiteralPath $source -Destination $Destination -Force
    return
  }
  $encodedFile = [Uri]::EscapeDataString($FileName)
  $url = "https://www.modelscope.cn/api/v1/models/$ModelId/repo?Revision=master&FilePath=$encodedFile"
  $cache = Join-Path $workPath "downloads/models/$SetName/$FileName"
  Get-VerifiedFile -Uri $url -Sha256 $Sha256 -Destination $cache
  Copy-Item -LiteralPath $cache -Destination $Destination -Force
}

New-Item -ItemType Directory -Force -Path $workPath | Out-Null
$sourcePath = if ($SourceRoot) {
  Resolve-ConfiguredPath $SourceRoot
} else {
  $archive = Join-Path $workPath "downloads/FunASR-$funAsrCommit.zip"
  Get-VerifiedFile -Uri $funAsrSourceUrl -Sha256 $funAsrSourceSha256 -Destination $archive
  $extractRoot = Join-Path $workPath "sources"
  $resolved = Join-Path $extractRoot "FunASR-$funAsrCommit"
  if (-not (Test-Path -LiteralPath $resolved)) {
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    & tar.exe -xf $archive -C $extractRoot
    if ($LASTEXITCODE -ne 0) { throw "tar.exe failed to extract $archive" }
  }
  (Resolve-Path -LiteralPath $resolved).Path
}

$onnxPath = if ($OnnxRuntimeRoot) {
  Resolve-ConfiguredPath $OnnxRuntimeRoot
} else {
  $archive = Join-Path $workPath "downloads/onnxruntime-win-x64-$onnxRuntimeVersion.zip"
  Get-VerifiedFile -Uri $onnxRuntimeUrl -Sha256 $onnxRuntimeSha256 -Destination $archive
  $extractRoot = Join-Path $workPath "dependencies"
  $resolved = Join-Path $extractRoot "onnxruntime-win-x64-$onnxRuntimeVersion"
  if (-not (Test-Path -LiteralPath $resolved)) {
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
  }
  (Resolve-Path -LiteralPath $resolved).Path
}

$buildPath = if ($BuildRoot) {
  Resolve-ConfiguredPath $BuildRoot
} else {
  $resolved = Join-Path $workPath "build"
  New-Item -ItemType Directory -Force -Path $resolved | Out-Null
  & cmake.exe -S (Join-Path $sourcePath "runtime/onnxruntime") -B $resolved -A x64 `
    "-DONNXRUNTIME_DIR=$onnxPath" -DENABLE_FST=ON -DENABLE_FFMPEG=OFF -DGPU=OFF -DFUNASR_BUILD_TESTS=OFF
  if ($LASTEXITCODE -ne 0) { throw "FunASR CMake configure failed." }
  & cmake.exe --build $resolved --config Release --target funasr --parallel
  if ($LASTEXITCODE -ne 0) { throw "FunASR native runtime build failed." }
  (Resolve-Path -LiteralPath $resolved).Path
}

$vsPath = Resolve-VsInstallationPath $VisualStudioRoot
$vcVarsPath = Join-Path $vsPath "VC/Auxiliary/Build/vcvars64.bat"
$vcRedistRoot = Join-Path $vsPath "VC/Redist/MSVC"
$vcRuntimePath = Get-ChildItem -LiteralPath $vcRedistRoot -Directory |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName "x64/Microsoft.VC143.CRT" } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $vcRuntimePath) { throw "Visual C++ x64 redistributable files were not found." }

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
if (Get-ChildItem -LiteralPath $outputPath -Force | Select-Object -First 1) {
  throw "FunASR runtime output directory must be empty: $outputPath"
}
$modelsPath = Join-Path $outputPath "models"
New-Item -ItemType Directory -Force -Path $modelsPath | Out-Null

$sourceFile = Join-Path $repoRoot "src/native/FunAsrLocalAsrHelper/tingyi_funasr_helper.cpp"
$exePath = Join-Path $outputPath "tingyi-funasr-helper.exe"
$importLibrary = Join-Path $buildPath "src/Release/funasr.lib"
$includePath = Join-Path $sourcePath "runtime/onnxruntime/include"
$compileScript = @"
call "$vcVarsPath" >nul
cl.exe /nologo /MD /utf-8 /EHsc /std:c++14 /O2 /W4 /WX /I"$includePath" /Fe:"$exePath" "$sourceFile" /link /LIBPATH:"$(Split-Path -Parent $importLibrary)" funasr.lib
"@
$cmdPath = Join-Path $workPath "build-tingyi-funasr-helper.cmd"
[System.IO.File]::WriteAllText($cmdPath, $compileScript, [System.Text.UTF8Encoding]::new($false))
try {
  & cmd.exe /d /c "`"$cmdPath`""
  if ($LASTEXITCODE -ne 0) { throw "FunASR helper cl.exe build failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $cmdPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $repoRoot "tingyi_funasr_helper.obj") -Force -ErrorAction SilentlyContinue
}

$funAsrBin = Join-Path $buildPath "bin/Release"
foreach ($file in @("funasr.dll", "glog.dll", "yaml-cpp.dll")) {
  Copy-Item -LiteralPath (Join-Path $funAsrBin $file) -Destination (Join-Path $outputPath $file) -Force
}
foreach ($file in @("onnxruntime.dll", "onnxruntime_providers_shared.dll")) {
  Copy-Item -LiteralPath (Join-Path $onnxPath "lib/$file") -Destination (Join-Path $outputPath $file) -Force
}
foreach ($file in @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
  Copy-Item -LiteralPath (Join-Path $vcRuntimePath $file) -Destination (Join-Path $outputPath $file) -Force
}

foreach ($entry in $modelSets.GetEnumerator()) {
  $destination = Join-Path $modelsPath $entry.Key
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  foreach ($file in $entry.Value.files.GetEnumerator()) {
    if ($file.Key -eq "README.md") { continue }
    Copy-VerifiedModelFile -SetName $entry.Key -ModelId $entry.Value.model -FileName $file.Key `
      -Sha256 $file.Value -Destination (Join-Path $destination $file.Key)
  }
  $cardDestination = Join-Path $outputPath "MODEL-CARD.$($entry.Key).md"
  Copy-VerifiedModelFile -SetName $entry.Key -ModelId $entry.Value.model -FileName "README.md" `
    -Sha256 $entry.Value.files["README.md"] -Destination $cardDestination
}

Copy-Item -LiteralPath (Join-Path $sourcePath "LICENSE") -Destination (Join-Path $outputPath "LICENSE.funasr.txt") -Force
Copy-Item -LiteralPath (Join-Path $sourcePath "MODEL_LICENSE") -Destination (Join-Path $outputPath "LICENSE.funasr-models.txt") -Force
Copy-Item -LiteralPath (Join-Path $onnxPath "LICENSE") -Destination (Join-Path $outputPath "LICENSE.onnxruntime.txt") -Force
Copy-Item -LiteralPath (Join-Path $sourcePath "runtime/onnxruntime/third_party/gflags/COPYING.txt") `
  -Destination (Join-Path $outputPath "LICENSE.gflags.txt") -Force
Copy-Item -LiteralPath (Join-Path $sourcePath "runtime/onnxruntime/third_party/json/LICENSE.MIT") `
  -Destination (Join-Path $outputPath "LICENSE.nlohmann-json.txt") -Force
$glogLicense = Join-Path $workPath "downloads/licenses/LICENSE.glog.txt"
$yamlCppLicense = Join-Path $workPath "downloads/licenses/LICENSE.yaml-cpp.txt"
$apacheLicense = Join-Path $workPath "downloads/licenses/LICENSE.apache-2.0.txt"
Get-VerifiedFile -Uri $glogLicenseUrl -Sha256 $glogLicenseSha256 -Destination $glogLicense
Get-VerifiedFile -Uri $yamlCppLicenseUrl -Sha256 $yamlCppLicenseSha256 -Destination $yamlCppLicense
Get-VerifiedFile -Uri $apacheLicenseUrl -Sha256 $apacheLicenseSha256 -Destination $apacheLicense
Copy-Item -LiteralPath $glogLicense -Destination (Join-Path $outputPath "LICENSE.glog.txt") -Force
Copy-Item -LiteralPath $yamlCppLicense -Destination (Join-Path $outputPath "LICENSE.yaml-cpp.txt") -Force
Copy-Item -LiteralPath $apacheLicense -Destination (Join-Path $outputPath "LICENSE.apache-2.0.txt") -Force

$notice = @'
# Third-party notices

- `FunASR` source commit {FUNASR_COMMIT} is distributed under MIT; its license is retained as `LICENSE.funasr.txt`.
- ONNX Runtime {ONNXRUNTIME_VERSION} is distributed under MIT; its license is retained as `LICENSE.onnxruntime.txt`.
- glog 0.7.0, yaml-cpp 0.6.0, gflags and nlohmann-json retain their upstream licenses as separate `LICENSE.*.txt` files.
- OpenFst, Kaldi and kaldi-native-fbank are distributed under Apache-2.0; the complete text is retained as `LICENSE.apache-2.0.txt`.
- The online/offline Paraformer, FSMN VAD, CT-Transformer punctuation and FST ITN model cards each declare Apache License 2.0 and are retained separately.
- The FunASR repository-level `MODEL_LICENSE` is also retained as `LICENSE.funasr-models.txt`; redistribution must satisfy both the specific model-card terms and this upstream notice.
- Model weights and configs are downloaded from the ModelScope IDs named in their model cards and pinned by SHA-256 in `runtime-manifest.json`.
- The Tingyi helper links dynamically to `funasr.dll`; no Python, PyTorch, ModelScope SDK, CUDA or external model service is required at runtime.
'@
$notice = $notice.Replace("{FUNASR_COMMIT}", $funAsrCommit).Replace("{ONNXRUNTIME_VERSION}", $onnxRuntimeVersion)
[System.IO.File]::WriteAllText((Join-Path $outputPath "THIRD-PARTY-NOTICES.md"), "$notice`n", [System.Text.UTF8Encoding]::new($false))

& (Join-Path $PSScriptRoot "write-funasr-paraformer-runtime-manifest.ps1") -RuntimeRoot $OutputRoot
if ($LASTEXITCODE -ne 0) { throw "FunASR Paraformer manifest generation failed." }
Write-Host "FunASR Paraformer runtime prepared: $outputPath"
