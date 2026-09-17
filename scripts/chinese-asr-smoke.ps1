[CmdletBinding()]
param(
  [string]$RuntimeRoot = "runtime/funasr-paraformer-zh-2pass",
  [string]$Text,
  [string]$Expect,
  [string]$TestPhrase,
  [switch]$Loopback
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "chinese-asr-smoke.ps1 requires PowerShell 7 or newer."
}
if (-not $IsWindows) {
  throw "The real Chinese ASR smoke requires Windows SAPI."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedRuntime = if ([System.IO.Path]::IsPathRooted($RuntimeRoot)) {
  [System.IO.Path]::GetFullPath($RuntimeRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RuntimeRoot))
}
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "tingyi-chinese-asr-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$cases = if ($Text) {
  if (-not $Expect) {
    throw "-Expect is required when -Text is specified."
  }
  @([pscustomobject]@{ Name = "custom"; Text = $Text; TestPhrase = $TestPhrase; Expect = $Expect })
} else {
  @(
    [pscustomobject]@{
      Name = "long-schedule"
      Text = "请把会议时间改到明天下午3点半，并提醒产品经理准备第二季度销售数据。"
      TestPhrase = "请把会议时间改到明天3:30p.m.并提醒产品经理准备第2季度销售数据"
      Expect = "产品经理,第二季度|第2季度,销售数据"
    },
    [pscustomobject]@{
      Name = "numbers"
      Text = "设备编号是20260808，当前温度23.5摄氏度。"
      TestPhrase = "设备编号是20260808当前温度23.5°C"
      Expect = "20260808,23.5,°C|摄氏度"
    },
    [pscustomobject]@{
      Name = "terms"
      Text = "实时字幕需要准确识别人名、数字和专业术语，不能把系统配置写错。"
      TestPhrase = "实时字幕需要准确识别人名数字和专业术语不能把系统配置写错"
      Expect = "实时字幕,专业术语,系统配置"
    }
  )
}

try {
  Add-Type -AssemblyName System.Speech
  $synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    $voice = @($synthesizer.GetInstalledVoices() | Where-Object {
      $_.Enabled -and $_.VoiceInfo.Culture.Name -eq "zh-CN"
    } | Select-Object -First 1)
    if (-not $voice) {
      throw "No enabled zh-CN SAPI voice is installed."
    }
    $synthesizer.SelectVoice($voice[0].VoiceInfo.Name)
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
      16000,
      [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
      [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    foreach ($case in $cases) {
      $case | Add-Member -NotePropertyName WavPath -NotePropertyValue (Join-Path $tempRoot "sapi-zh-cn-$($case.Name).wav")
      $synthesizer.SetOutputToWaveFile($case.WavPath, $format)
      $synthesizer.Speak($case.Text)
      $synthesizer.SetOutputToNull()
    }
  } finally {
    $synthesizer.Dispose()
  }

  Push-Location $repoRoot
  try {
    foreach ($case in $cases) {
      & npx tsx scripts/local-asr-media-smoke.ts --runtime-root $resolvedRuntime --engine funasr-paraformer-zh-2pass --wav $case.WavPath --expect $case.Expect
      if ($LASTEXITCODE -ne 0) {
        throw "Chinese local ASR media smoke failed for case '$($case.Name)'."
      }
      if ($Loopback) {
        $loopbackArguments = @(
          "tsx", "scripts/local-asr-loopback-smoke.ts",
          "--runtime-root", $resolvedRuntime,
          "--engine", "funasr-paraformer-zh-2pass",
          "--wav", $case.WavPath,
          "--expect", $case.Expect
        )
        if ($case.TestPhrase) {
          $loopbackArguments += @("--test-phrase", $case.TestPhrase)
        }
        & npx @loopbackArguments
        if ($LASTEXITCODE -ne 0) {
          throw "Chinese local ASR WASAPI loopback smoke failed for case '$($case.Name)'."
        }
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
