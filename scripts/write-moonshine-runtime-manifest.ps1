[CmdletBinding()]
param(
  [string]$RuntimeRoot = "runtime/moonshine-cpp",
  [string]$Version = "0.0.62",
  [string]$Model = "tiny-streaming-en/quantized",
  [string]$ModelSource = "https://download.moonshine.ai/model/tiny-streaming-en/quantized",
  [ValidateSet("tiny", "base", "tiny-streaming", "base-streaming", "small-streaming", "medium-streaming")]
  [string]$Arch = "tiny-streaming"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$repoRoot = Split-Path -Parent $PSScriptRoot
$root = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RuntimeRoot))
$requiredFiles = @(
  "tingyi-moonshine-helper.exe",
  "moonshine.dll",
  "onnxruntime.dll",
  "concrt140.dll",
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "LICENSE.moonshine-voice.txt",
  "LICENSE.onnxruntime.txt",
  "THIRD-PARTY-NOTICES.md",
  "models/adapter.ort",
  "models/cross_kv.ort",
  "models/decoder_kv.ort",
  "models/decoder_kv_with_attention.ort",
  "models/encoder.ort",
  "models/frontend.ort",
  "models/streaming_config.json",
  "models/tokenizer.bin"
)

$files = [ordered]@{}
foreach ($relativePath in $requiredFiles) {
  $absolutePath = Join-Path $root $relativePath
  $item = Get-Item -LiteralPath $absolutePath -Force
  if (-not $item.PSIsContainer -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    $files[$relativePath] = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
    continue
  }
  throw "Moonshine runtime entry must be a regular file: $relativePath"
}

$manifest = [ordered]@{
  schemaVersion = 4
  runtime = "local-asr-engine"
  engineId = "moonshine-tiny-en"
  displayName = "Moonshine Tiny 英文"
  language = "en"
  protocol = "local-asr-jsonl-v2"
  startupTimeoutMs = 30000
  command = "tingyi-moonshine-helper.exe"
  args = @("{modelDir}", "--arch", $Arch)
  modelDir = "models"
  platforms = @(
    [ordered]@{ os = "win32"; arch = "x64" }
  )
  capabilities = [ordered]@{
    input = "wav-pcm16-mono"
    sampleRateHz = 24000
    streaming = [ordered]@{
      enabled = $true
      partialResults = $true
    }
    endpoint = [ordered]@{
      managedBy = "runtime"
      minSpeechMs = 0
      trailingSilenceMs = 900
      finalPaddingMs = 0
      maxUtteranceMs = 30000
    }
  }
  smoke = @(
    [ordered]@{ command = "npm"; args = @("run", "moonshine:smoke") }
    [ordered]@{ command = "npm"; args = @("run", "moonshine:server-smoke") }
  )
  provenance = [ordered]@{
    runtime = [ordered]@{
      name = "moonshine-voice"
      version = $Version
      source = "https://github.com/moonshine-ai/moonshine"
      license = "MIT"
      licenseFile = "LICENSE.moonshine-voice.txt"
    }
    model = [ordered]@{
      name = $Model
      version = $Version
      source = $ModelSource
      license = "MIT"
      licenseFile = "LICENSE.moonshine-voice.txt"
    }
  }
  files = $files
}

$manifestPath = Join-Path $root "runtime-manifest.json"
$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($manifestPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Moonshine runtime manifest written: $manifestPath"
