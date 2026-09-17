[CmdletBinding()]
param(
  [string]$RuntimeRoot = "runtime/funasr-paraformer-zh-2pass"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$repoRoot = Split-Path -Parent $PSScriptRoot
$root = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RuntimeRoot))
$requiredFiles = @(
  "tingyi-funasr-helper.exe",
  "funasr.dll",
  "glog.dll",
  "yaml-cpp.dll",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "LICENSE.funasr.txt",
  "LICENSE.funasr-models.txt",
  "LICENSE.onnxruntime.txt",
  "LICENSE.apache-2.0.txt",
  "LICENSE.gflags.txt",
  "LICENSE.glog.txt",
  "LICENSE.nlohmann-json.txt",
  "LICENSE.yaml-cpp.txt",
  "MODEL-CARD.itn.md",
  "MODEL-CARD.offline.md",
  "MODEL-CARD.online.md",
  "MODEL-CARD.punc.md",
  "MODEL-CARD.vad.md",
  "THIRD-PARTY-NOTICES.md",
  "models/itn/configuration.json",
  "models/itn/zh_itn_tagger.fst",
  "models/itn/zh_itn_verbalizer.fst",
  "models/offline/am.mvn",
  "models/offline/config.yaml",
  "models/offline/configuration.json",
  "models/offline/model_quant.onnx",
  "models/offline/tokens.json",
  "models/online/am.mvn",
  "models/online/config.yaml",
  "models/online/configuration.json",
  "models/online/decoder_quant.onnx",
  "models/online/model_quant.onnx",
  "models/online/tokens.json",
  "models/punc/config.yaml",
  "models/punc/configuration.json",
  "models/punc/model_quant.onnx",
  "models/punc/tokens.json",
  "models/vad/am.mvn",
  "models/vad/config.yaml",
  "models/vad/configuration.json",
  "models/vad/model_quant.onnx"
)

$files = [ordered]@{}
foreach ($relativePath in $requiredFiles) {
  $absolutePath = Join-Path $root $relativePath
  $item = Get-Item -LiteralPath $absolutePath -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "FunASR runtime entry must be a regular file: $relativePath"
  }
  $files[$relativePath] = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

$manifest = [ordered]@{
  schemaVersion = 4
  runtime = "local-asr-engine"
  engineId = "funasr-paraformer-zh-2pass"
  displayName = "FunASR Paraformer 2-pass 中文"
  language = "zh"
  protocol = "local-asr-jsonl-v2"
  startupTimeoutMs = 60000
  command = "tingyi-funasr-helper.exe"
  args = @(
    "--engine-id", "funasr-paraformer-zh-2pass",
    "--online-model-dir", "{modelDir}/online",
    "--offline-model-dir", "{modelDir}/offline",
    "--vad-model-dir", "{modelDir}/vad",
    "--punc-model-dir", "{modelDir}/punc",
    "--itn-model-dir", "{modelDir}/itn",
    "--use-itn", "true",
    "--sample-rate-hz", "16000",
    "--threads", "4"
  )
  modelDir = "models"
  platforms = @(
    [ordered]@{ os = "win32"; arch = "x64" }
  )
  capabilities = [ordered]@{
    input = "wav-pcm16-mono"
    sampleRateHz = 16000
    streaming = [ordered]@{
      enabled = $true
      partialResults = $true
    }
    endpoint = [ordered]@{
      managedBy = "runtime"
      minSpeechMs = 150
      trailingSilenceMs = 800
      finalPaddingMs = 100
      maxUtteranceMs = 20000
    }
  }
  smoke = @(
    [ordered]@{ command = "npm"; args = @("run", "local-asr:zh-smoke") }
  )
  provenance = [ordered]@{
    runtime = [ordered]@{
      name = "FunASR ONNX Runtime C++"
      version = "79a0ed22e14ca74d728bf77d7df0ef0c463a9680 + ONNX Runtime 1.16.1"
      source = "https://github.com/modelscope/FunASR/commit/79a0ed22e14ca74d728bf77d7df0ef0c463a9680"
      license = "MIT"
      licenseFile = "LICENSE.funasr.txt"
    }
    model = [ordered]@{
      name = "Paraformer large online/offline quantized ONNX + CT-Transformer punctuation + FST ITN"
      version = "ModelScope files pinned by SHA-256 in this manifest"
      source = "https://www.modelscope.cn/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx/summary"
      license = "Apache-2.0 model cards; upstream FunASR MODEL_LICENSE retained"
      licenseFile = "LICENSE.funasr-models.txt"
    }
    endpoint = [ordered]@{
      name = "FSMN streaming VAD"
      version = "ModelScope files pinned by SHA-256 in this manifest"
      source = "https://www.modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/summary"
      license = "Apache-2.0 model card"
      licenseFile = "MODEL-CARD.vad.md"
    }
  }
  files = $files
}

$manifestPath = Join-Path $root "runtime-manifest.json"
$json = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($manifestPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "FunASR Paraformer runtime manifest written: $manifestPath"
