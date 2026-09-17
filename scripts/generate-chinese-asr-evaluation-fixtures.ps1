[CmdletBinding()]
param(
  [string]$OutputRoot = ".runs/asr-evaluation-fixtures"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
if (-not $IsWindows) {
  throw "Chinese ASR evaluation fixtures require Windows SAPI."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$root = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
New-Item -ItemType Directory -Force -Path $root | Out-Null
Add-Type -AssemblyName System.Speech

function New-SapiFixture {
  param([string]$Name, [string]$Text, [int]$Volume = 100, [switch]$Ssml)
  $path = Join-Path $root "$Name.wav"
  $synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  try {
    $voice = @($synthesizer.GetInstalledVoices() | Where-Object {
      $_.Enabled -and $_.VoiceInfo.Culture.Name -eq "zh-CN"
    } | Select-Object -First 1)
    if (-not $voice) {
      throw "No enabled zh-CN SAPI voice is installed."
    }
    $synthesizer.SelectVoice($voice[0].VoiceInfo.Name)
    $synthesizer.Volume = $Volume
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
      16000,
      [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
      [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $synthesizer.SetOutputToWaveFile($path, $format)
    if ($Ssml) {
      $synthesizer.SpeakSsml($Text)
    } else {
      $synthesizer.Speak($Text)
    }
  } finally {
    $synthesizer.Dispose()
  }
  return $path
}

function Add-DeterministicBackground {
  param([string]$Source, [string]$Destination)
  $bytes = [System.IO.File]::ReadAllBytes($Source)
  $dataOffset = -1
  for ($offset = 12; $offset + 8 -le $bytes.Length;) {
    $length = [BitConverter]::ToUInt32($bytes, $offset + 4)
    if ([System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4) -eq "data") {
      $dataOffset = $offset + 8
      break
    }
    $offset += 8 + $length + ($length % 2)
  }
  if ($dataOffset -lt 0) {
    throw "SAPI fixture contains no data chunk: $Source"
  }
  $sampleIndex = 0
  for ($offset = $dataOffset; $offset + 1 -lt $bytes.Length; $offset += 2) {
    $time = $sampleIndex / 16000.0
    $envelope = 0.65 + 0.35 * [Math]::Sin(2 * [Math]::PI * 1.5 * $time)
    $background = 900 * $envelope * (
      [Math]::Sin(2 * [Math]::PI * 220 * $time) +
      0.7 * [Math]::Sin(2 * [Math]::PI * 330 * $time) +
      0.45 * [Math]::Sin(2 * [Math]::PI * 440 * $time)
    )
    $mixed = [Math]::Clamp([BitConverter]::ToInt16($bytes, $offset) + [int]$background, -32768, 32767)
    $encoded = [BitConverter]::GetBytes([int16]$mixed)
    $bytes[$offset] = $encoded[0]
    $bytes[$offset + 1] = $encoded[1]
    ++$sampleIndex
  }
  [System.IO.File]::WriteAllBytes($Destination, $bytes)
}

function Add-DeterministicMeetingNoise {
  param(
    [string]$Source,
    [string]$Destination,
    [double]$SpeechGain = 0.32,
    [int]$NoiseAmplitude = 1150
  )
  $bytes = [System.IO.File]::ReadAllBytes($Source)
  $dataOffset = -1
  for ($offset = 12; $offset + 8 -le $bytes.Length;) {
    $length = [BitConverter]::ToUInt32($bytes, $offset + 4)
    if ([System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4) -eq "data") {
      $dataOffset = $offset + 8
      break
    }
    $offset += 8 + $length + ($length % 2)
  }
  if ($dataOffset -lt 0) {
    throw "SAPI fixture contains no data chunk: $Source"
  }
  $sampleIndex = 0
  for ($offset = $dataOffset; $offset + 1 -lt $bytes.Length; $offset += 2) {
    $time = $sampleIndex / 16000.0
    $speech = [BitConverter]::ToInt16($bytes, $offset) * $SpeechGain
    $roomTone = $NoiseAmplitude * (
      0.52 * [Math]::Sin(2 * [Math]::PI * 173 * $time) +
      0.31 * [Math]::Sin(2 * [Math]::PI * 281 * $time) +
      0.17 * [Math]::Sin(2 * [Math]::PI * 617 * $time)
    )
    $modulation = 0.55 + 0.45 * [Math]::Sin(2 * [Math]::PI * 0.73 * $time)
    $mixed = [Math]::Clamp([int]($speech + $roomTone * $modulation), -32768, 32767)
    $encoded = [BitConverter]::GetBytes([int16]$mixed)
    $bytes[$offset] = $encoded[0]
    $bytes[$offset + 1] = $encoded[1]
    ++$sampleIndex
  }
  [System.IO.File]::WriteAllBytes($Destination, $bytes)
}

function New-SilenceFixture {
  param([string]$Path, [int]$DurationMs)
  $sampleCount = [Math]::Round(16000 * $DurationMs / 1000)
  $dataLength = $sampleCount * 2
  $stream = [System.IO.File]::Create($Path)
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF"))
    $writer.Write([int](36 + $dataLength))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("WAVEfmt "))
    $writer.Write([int]16)
    $writer.Write([int16]1)
    $writer.Write([int16]1)
    $writer.Write([int]16000)
    $writer.Write([int]32000)
    $writer.Write([int16]2)
    $writer.Write([int16]16)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("data"))
    $writer.Write([int]$dataLength)
    $writer.Write([byte[]]::new($dataLength))
  } finally {
    $writer.Dispose()
  }
}

$longText = "请把会议时间改到明天下午3点半，并提醒产品经理准备第二季度销售数据。"
$numbersText = "设备编号是20260808，当前温度23.5摄氏度。"
$termsText = "实时字幕需要准确识别人名、数字和专业术语，不能把系统配置写错。"
$meetingTermsText = "PLC和PCM算法参数还没确认，POC完成后通过RPC调用CheckInfo接口，把结果写入Excel表格。"
$shortPath = New-SapiFixture "short" "你好听译。"
$longPath = New-SapiFixture "continuous-long" "$longText$numbersText$termsText"
$pausesPath = New-SapiFixture "multiple-pauses" '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">实时字幕<break time="350ms"/>需要准确识别<break time="600ms"/>人名数字和专业术语<break time="900ms"/>不能把系统配置写错</speak>' -Ssml
$tailPath = New-SapiFixture "immediate-tail" "尾句现在结束。"
$weakPath = New-SapiFixture "weak-voice" $termsText -Volume 20
$backgroundSource = New-SapiFixture "background-source" $termsText
$backgroundPath = Join-Path $root "background-chords.wav"
Add-DeterministicBackground $backgroundSource $backgroundPath
$repeatPath = New-SapiFixture "repeated-sentence" '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">请确认测试开始<break time="1500ms"/>请确认测试开始</speak>' -Ssml
$meetingTermsPath = New-SapiFixture "meeting-terms" $meetingTermsText
$meetingTermsNoisyPath = Join-Path $root "meeting-terms-weak-noisy.wav"
Add-DeterministicMeetingNoise $meetingTermsPath $meetingTermsNoisyPath
$silencePath = Join-Path $root "silence.wav"
New-SilenceFixture $silencePath 5000

$cases = @(
  [ordered]@{ name = "short"; wavFile = [System.IO.Path]::GetFileName($shortPath); reference = "你好听译。" },
  [ordered]@{ name = "continuous-long"; wavFile = [System.IO.Path]::GetFileName($longPath); reference = "$longText$numbersText$termsText" },
  [ordered]@{ name = "multiple-pauses"; wavFile = [System.IO.Path]::GetFileName($pausesPath); reference = $termsText },
  [ordered]@{ name = "immediate-tail"; wavFile = [System.IO.Path]::GetFileName($tailPath); reference = "尾句现在结束。" },
  [ordered]@{ name = "weak-voice"; wavFile = [System.IO.Path]::GetFileName($weakPath); reference = $termsText },
  [ordered]@{ name = "background-chords"; wavFile = [System.IO.Path]::GetFileName($backgroundPath); reference = $termsText },
  [ordered]@{ name = "meeting-terms"; wavFile = [System.IO.Path]::GetFileName($meetingTermsPath); reference = $meetingTermsText },
  [ordered]@{ name = "meeting-terms-weak-noisy"; wavFile = [System.IO.Path]::GetFileName($meetingTermsNoisyPath); reference = $meetingTermsText },
  [ordered]@{ name = "silence"; wavFile = [System.IO.Path]::GetFileName($silencePath); reference = "" },
  [ordered]@{ name = "repeated-sentence"; wavFile = [System.IO.Path]::GetFileName($repeatPath); reference = "请确认测试开始请确认测试开始" }
)
$casesPath = Join-Path $root "cases.json"
[System.IO.File]::WriteAllText($casesPath, "$(ConvertTo-Json $cases -Depth 4)`n", [System.Text.UTF8Encoding]::new($false))
Write-Host $casesPath
