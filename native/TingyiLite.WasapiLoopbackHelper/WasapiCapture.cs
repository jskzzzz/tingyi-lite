using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
[Flags] public enum CLSCTX : uint { ALL = 0x17 }
[Flags] public enum AUDCLNT_STREAMFLAGS : uint { NONE = 0, LOOPBACK = 0x00020000 }
public enum AUDCLNT_SHAREMODE { SHARED = 0, EXCLUSIVE = 1 }

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  [PreserveSig]
  int EnumAudioEndpoints();
  [PreserveSig]
  int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  [PreserveSig]
  int Activate(ref Guid iid, CLSCTX clsctx, IntPtr activationParams, out IAudioClient ppInterface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
  [PreserveSig]
  int Initialize(AUDCLNT_SHAREMODE shareMode, AUDCLNT_STREAMFLAGS streamFlags, long bufferDuration, long periodicity, IntPtr format, ref Guid sessionGuid);
  [PreserveSig]
  int GetBufferSize(out uint bufferFrames);
  [PreserveSig]
  int GetStreamLatency(out long latency);
  [PreserveSig]
  int GetCurrentPadding(out uint paddingFrames);
  [PreserveSig]
  int IsFormatSupported(AUDCLNT_SHAREMODE shareMode, IntPtr format, IntPtr closestMatch);
  [PreserveSig]
  int GetMixFormat(out IntPtr deviceFormat);
  [PreserveSig]
  int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
  [PreserveSig]
  int Start();
  [PreserveSig]
  int Stop();
  [PreserveSig]
  int Reset();
  [PreserveSig]
  int SetEventHandle(IntPtr eventHandle);
  [PreserveSig]
  int GetService(ref Guid iid, out IAudioCaptureClient captureClient);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
  [PreserveSig]
  int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig]
  int ReleaseBuffer(uint frames);
  [PreserveSig]
  int GetNextPacketSize(out uint packetFrames);
}

public sealed class WasapiFormatInfo {
  public int Channels;
  public int SampleRate;
  public int BitsPerSample;
  public int BlockAlign;
  public bool IsFloat;
  public bool IsPcm;
  public string SourceFormat;
}

public static class TingyiWasapiRenderLoopback {
  const int WAVE_FORMAT_PCM = 1;
  const int WAVE_FORMAT_IEEE_FLOAT = 3;
  const int WAVE_FORMAT_EXTENSIBLE = 65534;
  const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
  static readonly Guid AudioClientGuid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
  static readonly Guid CaptureClientGuid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
  static readonly Guid PcmGuid = new Guid("00000001-0000-0010-8000-00aa00389b71");
  static readonly Guid FloatGuid = new Guid("00000003-0000-0010-8000-00aa00389b71");

  public static void CaptureStream(int segmentDurationMs, int targetSampleRate) {
    IMMDeviceEnumerator enumerator = null;
    IMMDevice device = null;
    IAudioClient audioClient = null;
    IAudioCaptureClient captureClient = null;
    IntPtr mixFormatPtr = IntPtr.Zero;
    bool started = false;
    int stopRequested = 0;
    try {
      enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      ThrowIfFailed(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device), "GetDefaultAudioEndpoint");
      Guid audioClientGuid = AudioClientGuid;
      ThrowIfFailed(device.Activate(ref audioClientGuid, CLSCTX.ALL, IntPtr.Zero, out audioClient), "Activate IAudioClient");
      ThrowIfFailed(audioClient.GetMixFormat(out mixFormatPtr), "GetMixFormat");
      WasapiFormatInfo format = ReadFormat(mixFormatPtr);
      Guid sessionGuid = Guid.Empty;
      ThrowIfFailed(
        audioClient.Initialize(AUDCLNT_SHAREMODE.SHARED, AUDCLNT_STREAMFLAGS.LOOPBACK, 10000000, 0, mixFormatPtr, ref sessionGuid),
        "Initialize"
      );
      Guid captureClientGuid = CaptureClientGuid;
      ThrowIfFailed(audioClient.GetService(ref captureClientGuid, out captureClient), "GetService IAudioCaptureClient");

      Thread stopThread = new Thread(delegate() {
        try {
          while (true) {
            string line = Console.In.ReadLine();
            if (line == null || line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase)) {
              Interlocked.Exchange(ref stopRequested, 1);
              return;
            }
          }
        } catch {
          Interlocked.Exchange(ref stopRequested, 1);
        }
      });
      stopThread.IsBackground = true;
      stopThread.Start();

      int durationMs = Math.Max(1, segmentDurationMs);
      int sourceFramesPerSegment = Math.Max(1, (int)Math.Round(format.SampleRate * (double)durationMs / 1000.0));
      List<float> monoSamples = new List<float>(sourceFramesPerSegment + format.SampleRate);
      Stopwatch segmentStopwatch = Stopwatch.StartNew();

      ThrowIfFailed(audioClient.Start(), "Start");
      started = true;
      WriteEvent("ready");

      while (Interlocked.CompareExchange(ref stopRequested, 0, 0) == 0) {
        uint packetFrames;
        ThrowIfFailed(captureClient.GetNextPacketSize(out packetFrames), "GetNextPacketSize");
        if (packetFrames == 0) {
          if (segmentStopwatch.ElapsedMilliseconds >= durationMs) {
            PadToSegment(monoSamples, sourceFramesPerSegment);
            WriteSegment(format, monoSamples.GetRange(0, sourceFramesPerSegment).ToArray(), targetSampleRate);
            monoSamples.RemoveRange(0, sourceFramesPerSegment);
            segmentStopwatch.Restart();
          } else {
            Thread.Sleep(5);
          }
          continue;
        }

        while (packetFrames > 0) {
          IntPtr data;
          uint frames;
          uint flags;
          ulong devicePosition;
          ulong qpcPosition;
          ThrowIfFailed(captureClient.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
          try {
            AppendFrames(monoSamples, data, frames, flags, format);
          } finally {
            ThrowIfFailed(captureClient.ReleaseBuffer(frames), "ReleaseBuffer");
          }
          while (monoSamples.Count >= sourceFramesPerSegment) {
            WriteSegment(format, monoSamples.GetRange(0, sourceFramesPerSegment).ToArray(), targetSampleRate);
            monoSamples.RemoveRange(0, sourceFramesPerSegment);
            segmentStopwatch.Restart();
          }
          ThrowIfFailed(captureClient.GetNextPacketSize(out packetFrames), "GetNextPacketSize");
        }
      }
      if (monoSamples.Count > 0) {
        PadToSegment(monoSamples, sourceFramesPerSegment);
        WriteSegment(format, monoSamples.GetRange(0, sourceFramesPerSegment).ToArray(), targetSampleRate);
      }
      WriteEvent("completed");
    } finally {
      if (started && audioClient != null) {
        audioClient.Stop();
      }
      if (mixFormatPtr != IntPtr.Zero) {
        Marshal.FreeCoTaskMem(mixFormatPtr);
      }
      ReleaseCom(captureClient);
      ReleaseCom(audioClient);
      ReleaseCom(device);
      ReleaseCom(enumerator);
    }
  }

  static void PadToSegment(List<float> samples, int targetFrames) {
    while (samples.Count < targetFrames) {
      samples.Add(0);
    }
  }

  static void WriteEvent(string eventName) {
    Console.WriteLine("{\"event\":\"" + eventName + "\"}");
    Console.Out.Flush();
  }

  static void WriteSegment(WasapiFormatInfo format, float[] sourceSamples, int targetSampleRate) {
    float[] output = Resample(sourceSamples, format.SampleRate, targetSampleRate);
    byte[] pcm = FloatToPcm16(output);
    string rms = CalculateRms(output).ToString("R", CultureInfo.InvariantCulture);
    Console.WriteLine(
      "{\"event\":\"segment\"" +
      ",\"sampleRate\":" + targetSampleRate.ToString(CultureInfo.InvariantCulture) +
      ",\"channels\":1" +
      ",\"bitsPerSample\":16" +
      ",\"sampleCount\":" + output.Length +
      ",\"rms\":" + rms +
      ",\"pcmBase64\":\"" + Convert.ToBase64String(pcm) + "\"}"
    );
    Console.Out.Flush();
  }

  static WasapiFormatInfo ReadFormat(IntPtr ptr) {
    ushort formatTag = (ushort)Marshal.ReadInt16(ptr, 0);
    ushort channels = (ushort)Marshal.ReadInt16(ptr, 2);
    int sampleRate = Marshal.ReadInt32(ptr, 4);
    ushort blockAlign = (ushort)Marshal.ReadInt16(ptr, 12);
    ushort bitsPerSample = (ushort)Marshal.ReadInt16(ptr, 14);
    bool isFloat = formatTag == WAVE_FORMAT_IEEE_FLOAT;
    bool isPcm = formatTag == WAVE_FORMAT_PCM;
    string sourceFormat = formatTag.ToString(CultureInfo.InvariantCulture);
    if (formatTag == WAVE_FORMAT_EXTENSIBLE) {
      Guid subFormat = (Guid)Marshal.PtrToStructure(IntPtr.Add(ptr, 24), typeof(Guid));
      isFloat = subFormat == FloatGuid;
      isPcm = subFormat == PcmGuid;
      sourceFormat = "extensible:" + subFormat.ToString();
    }
    if (channels <= 0 || sampleRate <= 0 || blockAlign <= 0) {
      throw new InvalidOperationException("WASAPI returned an invalid mix format.");
    }
    if (isFloat && bitsPerSample != 32) {
      throw new InvalidOperationException("Unsupported WASAPI float sample width: " + bitsPerSample);
    }
    if (isPcm && bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32) {
      throw new InvalidOperationException("Unsupported WASAPI PCM sample width: " + bitsPerSample);
    }
    if (!isFloat && !isPcm) {
      throw new InvalidOperationException("Unsupported WASAPI mix format: " + sourceFormat);
    }
    return new WasapiFormatInfo {
      Channels = channels,
      SampleRate = sampleRate,
      BitsPerSample = bitsPerSample,
      BlockAlign = blockAlign,
      IsFloat = isFloat,
      IsPcm = isPcm,
      SourceFormat = sourceFormat
    };
  }

  static void AppendFrames(List<float> samples, IntPtr data, uint frames, uint flags, WasapiFormatInfo format) {
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero) {
      for (uint frame = 0; frame < frames; frame++) {
        samples.Add(0);
      }
      return;
    }
    int byteCount = checked((int)(frames * (uint)format.BlockAlign));
    byte[] buffer = new byte[byteCount];
    Marshal.Copy(data, buffer, 0, byteCount);
    int bytesPerSample = Math.Max(1, format.BitsPerSample / 8);
    for (uint frame = 0; frame < frames; frame++) {
      double sum = 0;
      int frameOffset = checked((int)frame * format.BlockAlign);
      for (int channel = 0; channel < format.Channels; channel++) {
        sum += ReadSample(buffer, frameOffset + channel * bytesPerSample, bytesPerSample, format);
      }
      samples.Add((float)(sum / format.Channels));
    }
  }

  static double ReadSample(byte[] buffer, int offset, int bytesPerSample, WasapiFormatInfo format) {
    if (format.IsFloat) {
      return Math.Max(-1, Math.Min(1, BitConverter.ToSingle(buffer, offset)));
    }
    if (bytesPerSample == 2) {
      return BitConverter.ToInt16(buffer, offset) / 32768.0;
    }
    if (bytesPerSample == 3) {
      int value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
      if ((value & 0x800000) != 0) {
        value |= unchecked((int)0xff000000);
      }
      return value / 8388608.0;
    }
    if (bytesPerSample == 4) {
      return BitConverter.ToInt32(buffer, offset) / 2147483648.0;
    }
    throw new InvalidOperationException("Unsupported WASAPI PCM sample width: " + bytesPerSample);
  }

  static float[] Resample(float[] input, int inputSampleRate, int outputSampleRate) {
    if (input.Length == 0) {
      return new float[0];
    }
    if (inputSampleRate == outputSampleRate) {
      return input;
    }
    int outputLength = Math.Max(1, (int)Math.Round(input.Length * (double)outputSampleRate / inputSampleRate));
    float[] output = new float[outputLength];
    for (int index = 0; index < outputLength; index++) {
      double position = index * (double)inputSampleRate / outputSampleRate;
      int left = Math.Min((int)Math.Floor(position), input.Length - 1);
      int right = Math.Min(left + 1, input.Length - 1);
      double ratio = position - left;
      output[index] = (float)(input[left] * (1 - ratio) + input[right] * ratio);
    }
    return output;
  }

  static byte[] FloatToPcm16(float[] samples) {
    byte[] bytes = new byte[samples.Length * 2];
    for (int index = 0; index < samples.Length; index++) {
      double value = Math.Max(-1, Math.Min(1, samples[index]));
      short sample = (short)Math.Round(value * 32767);
      bytes[index * 2] = (byte)(sample & 0xff);
      bytes[index * 2 + 1] = (byte)((sample >> 8) & 0xff);
    }
    return bytes;
  }

  static double CalculateRms(float[] samples) {
    if (samples.Length == 0) {
      return 0;
    }
    double sum = 0;
    foreach (float sample in samples) {
      sum += sample * sample;
    }
    return Math.Sqrt(sum / samples.Length);
  }

  static void ThrowIfFailed(int hresult, string operation) {
    if (hresult < 0) {
      Marshal.ThrowExceptionForHR(hresult);
    }
    if (hresult != 0) {
      throw new InvalidOperationException(operation + " failed with HRESULT 0x" + hresult.ToString("x8"));
    }
  }

  static void ReleaseCom(object value) {
    if (value != null && Marshal.IsComObject(value)) {
      Marshal.ReleaseComObject(value);
    }
  }
}
