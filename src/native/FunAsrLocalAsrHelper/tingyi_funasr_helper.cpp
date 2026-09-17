#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <fcntl.h>
#include <io.h>
#define NOMINMAX
#include <windows.h>

#include "com-define.h"
#include "funasrruntime.h"

namespace {

constexpr const char *kProtocol = "local-asr-jsonl-v2";
constexpr const char *kLanguage = "zh";

struct COptions {
  std::string engineId;
  std::string onlineModelDir;
  std::string offlineModelDir;
  std::string vadModelDir;
  std::string puncModelDir;
  std::string itnModelDir;
  std::string hotwordFile;
  int32_t sampleRateHz = 16000;
  int32_t threads = 4;
  bool useItn = false;
};

struct CWavAudio {
  int32_t sampleRateHz = 0;
  std::vector<uint8_t> pcm16;
};

struct CSourceState {
  FUNASR_HANDLE onlineHandle = nullptr;
  std::vector<std::vector<std::string>> puncCache{2};
  int64_t utteranceIndex = 1;
  int64_t revision = 0;
  int64_t expectedSequence = 0;
  int64_t timelineOriginMs = 0;
  int64_t submittedSamples = 0;
  int64_t utteranceStartMs = -1;
  int64_t vadStartMs = -1;
  int64_t lastEndMs = 0;
  int64_t lastFinalEndMs = 0;
  std::string partialText;
};

struct CTpassDeleter {
  void operator()(void *handle) const {
    if (handle) {
      FunTpassUninit(handle);
    }
  }
};

struct CDecoderDeleter {
  void operator()(void *handle) const {
    if (handle) {
      FunASRWfstDecoderUninit(handle);
    }
  }
};

using CTpassPtr = std::unique_ptr<void, CTpassDeleter>;
using CDecoderPtr = std::unique_ptr<void, CDecoderDeleter>;

std::string trim(const std::string &value) {
  size_t start = 0;
  while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
    ++start;
  }
  size_t end = value.size();
  while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
    --end;
  }
  return value.substr(start, end - start);
}

std::string jsonEscape(const std::string &value) {
  std::ostringstream output;
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\': output << "\\\\"; break;
      case '"': output << "\\\""; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (ch < 0x20) {
          const char *digits = "0123456789abcdef";
          output << "\\u00" << digits[(ch >> 4) & 0x0f] << digits[ch & 0x0f];
        } else {
          output << static_cast<char>(ch);
        }
    }
  }
  return output.str();
}

void emit(const std::string &record) {
  std::cout << record << '\n' << std::flush;
}

size_t findJsonValue(const std::string &json, const std::string &key) {
  const std::string needle = "\"" + key + "\"";
  size_t position = json.find(needle);
  if (position == std::string::npos) {
    return position;
  }
  position = json.find(':', position + needle.size());
  if (position == std::string::npos) {
    return position;
  }
  do {
    ++position;
  } while (position < json.size() && std::isspace(static_cast<unsigned char>(json[position])));
  return position;
}

std::string fieldString(const std::string &json, const std::string &key, bool required = true) {
  size_t position = findJsonValue(json, key);
  if (position == std::string::npos || position >= json.size() || json[position] != '"') {
    if (required) {
      throw std::runtime_error("missing string field: " + key);
    }
    return "";
  }
  std::string result;
  for (++position; position < json.size(); ++position) {
    const char ch = json[position];
    if (ch == '"') {
      return result;
    }
    if (ch != '\\') {
      result.push_back(ch);
      continue;
    }
    if (++position >= json.size()) {
      break;
    }
    switch (json[position]) {
      case '"': result.push_back('"'); break;
      case '\\': result.push_back('\\'); break;
      case '/': result.push_back('/'); break;
      case 'b': result.push_back('\b'); break;
      case 'f': result.push_back('\f'); break;
      case 'n': result.push_back('\n'); break;
      case 'r': result.push_back('\r'); break;
      case 't': result.push_back('\t'); break;
      default: throw std::runtime_error("unsupported JSON escape in field: " + key);
    }
  }
  throw std::runtime_error("unterminated string field: " + key);
}

int64_t fieldInteger(const std::string &json, const std::string &key) {
  const size_t position = findJsonValue(json, key);
  if (position == std::string::npos || position >= json.size()) {
    throw std::runtime_error("missing integer field: " + key);
  }
  char *end = nullptr;
  const int64_t value = std::strtoll(json.c_str() + position, &end, 10);
  if (end == json.c_str() + position) {
    throw std::runtime_error("invalid integer field: " + key);
  }
  return value;
}

std::vector<uint8_t> base64Decode(const std::string &input) {
  static int8_t table[256];
  static bool initialized = false;
  if (!initialized) {
    std::fill(std::begin(table), std::end(table), static_cast<int8_t>(-1));
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (size_t index = 0; index < alphabet.size(); ++index) {
      table[static_cast<unsigned char>(alphabet[index])] = static_cast<int8_t>(index);
    }
    initialized = true;
  }
  std::vector<uint8_t> output;
  int value = 0;
  int bits = -8;
  for (unsigned char ch : input) {
    if (ch == '=') {
      break;
    }
    const int decoded = table[ch];
    if (decoded < 0) {
      if (std::isspace(ch)) {
        continue;
      }
      throw std::runtime_error("invalid base64 audio");
    }
    value = (value << 6) | decoded;
    bits += 6;
    if (bits >= 0) {
      output.push_back(static_cast<uint8_t>((value >> bits) & 0xff));
      bits -= 8;
    }
  }
  return output;
}

uint16_t readU16(const std::vector<uint8_t> &bytes, size_t offset) {
  if (offset + 2 > bytes.size()) {
    throw std::runtime_error("truncated WAV data");
  }
  return static_cast<uint16_t>(bytes[offset] | (bytes[offset + 1] << 8));
}

uint32_t readU32(const std::vector<uint8_t> &bytes, size_t offset) {
  if (offset + 4 > bytes.size()) {
    throw std::runtime_error("truncated WAV data");
  }
  return static_cast<uint32_t>(bytes[offset]) |
      (static_cast<uint32_t>(bytes[offset + 1]) << 8) |
      (static_cast<uint32_t>(bytes[offset + 2]) << 16) |
      (static_cast<uint32_t>(bytes[offset + 3]) << 24);
}

CWavAudio decodeWav(const std::vector<uint8_t> &bytes) {
  if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
      std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    throw std::runtime_error("audio must be a RIFF/WAVE file");
  }
  uint16_t format = 0;
  uint16_t channels = 0;
  uint16_t bitsPerSample = 0;
  int32_t sampleRateHz = 0;
  size_t dataOffset = 0;
  size_t dataLength = 0;
  for (size_t offset = 12; offset + 8 <= bytes.size();) {
    const uint32_t length = readU32(bytes, offset + 4);
    const size_t start = offset + 8;
    if (start + length > bytes.size()) {
      throw std::runtime_error("truncated WAV chunk");
    }
    if (std::memcmp(bytes.data() + offset, "fmt ", 4) == 0 && length >= 16) {
      format = readU16(bytes, start);
      channels = readU16(bytes, start + 2);
      sampleRateHz = static_cast<int32_t>(readU32(bytes, start + 4));
      bitsPerSample = readU16(bytes, start + 14);
    } else if (std::memcmp(bytes.data() + offset, "data", 4) == 0) {
      dataOffset = start;
      dataLength = length;
    }
    offset = start + length + (length % 2);
  }
  if (format != 1 || channels != 1 || bitsPerSample != 16 || sampleRateHz <= 0 ||
      dataOffset == 0 || dataLength == 0 || dataLength % 2 != 0) {
    throw std::runtime_error("audio must be mono PCM16 WAV");
  }
  CWavAudio audio;
  audio.sampleRateHz = sampleRateHz;
  audio.pcm16.assign(bytes.begin() + static_cast<std::ptrdiff_t>(dataOffset),
                     bytes.begin() + static_cast<std::ptrdiff_t>(dataOffset + dataLength));
  return audio;
}

std::map<std::string, std::string> parseArguments(int argc, char **argv) {
  std::map<std::string, std::string> result;
  for (int index = 1; index < argc; index += 2) {
    const std::string key = argv[index];
    if (key.rfind("--", 0) != 0 || index + 1 >= argc) {
      throw std::runtime_error("arguments must use --name value pairs");
    }
    result[key.substr(2)] = argv[index + 1];
  }
  return result;
}

std::string requiredArgument(const std::map<std::string, std::string> &arguments, const std::string &key) {
  const auto item = arguments.find(key);
  if (item == arguments.end() || trim(item->second).empty()) {
    throw std::runtime_error("missing required argument: --" + key);
  }
  return item->second;
}

int32_t integerArgument(const std::map<std::string, std::string> &arguments, const std::string &key, int32_t defaultValue) {
  const auto item = arguments.find(key);
  if (item == arguments.end()) {
    return defaultValue;
  }
  char *end = nullptr;
  const long value = std::strtol(item->second.c_str(), &end, 10);
  if (!end || *end || value <= 0 || value > INT32_MAX) {
    throw std::runtime_error("invalid positive integer argument: --" + key);
  }
  return static_cast<int32_t>(value);
}

bool booleanArgument(const std::map<std::string, std::string> &arguments, const std::string &key, bool defaultValue) {
  const auto item = arguments.find(key);
  if (item == arguments.end()) {
    return defaultValue;
  }
  if (item->second == "true") {
    return true;
  }
  if (item->second == "false") {
    return false;
  }
  throw std::runtime_error("invalid boolean argument: --" + key);
}

COptions readOptions(int argc, char **argv) {
  const auto arguments = parseArguments(argc, argv);
  COptions options;
  options.engineId = requiredArgument(arguments, "engine-id");
  options.onlineModelDir = requiredArgument(arguments, "online-model-dir");
  options.offlineModelDir = requiredArgument(arguments, "offline-model-dir");
  options.vadModelDir = requiredArgument(arguments, "vad-model-dir");
  options.puncModelDir = requiredArgument(arguments, "punc-model-dir");
  const auto itn = arguments.find("itn-model-dir");
  options.itnModelDir = itn == arguments.end() ? "" : itn->second;
  const auto hotword = arguments.find("hotword-file");
  options.hotwordFile = hotword == arguments.end() ? "" : hotword->second;
  options.sampleRateHz = integerArgument(arguments, "sample-rate-hz", options.sampleRateHz);
  options.threads = integerArgument(arguments, "threads", options.threads);
  options.useItn = booleanArgument(arguments, "use-itn", options.useItn);
  if (options.sampleRateHz != 16000) {
    throw std::runtime_error("FunASR Paraformer 2-pass requires 16000 Hz audio");
  }
  if (options.useItn && options.itnModelDir.empty()) {
    throw std::runtime_error("--itn-model-dir is required when --use-itn is true");
  }
  return options;
}

std::map<std::string, std::string> modelPaths(const COptions &options) {
  std::map<std::string, std::string> paths{
      {OFFLINE_MODEL_DIR, options.offlineModelDir},
      {ONLINE_MODEL_DIR, options.onlineModelDir},
      {VAD_DIR, options.vadModelDir},
      {PUNC_DIR, options.puncModelDir},
      {QUANTIZE, "true"},
      {VAD_QUANT, "true"},
      {PUNC_QUANT, "true"},
      {ASR_MODE, "2pass"}};
  if (options.useItn) {
    paths[ITN_DIR] = options.itnModelDir;
  }
  return paths;
}

CTpassPtr createTpass(const COptions &options) {
  auto paths = modelPaths(options);
  FUNASR_HANDLE handle = FunTpassInit(paths, options.threads);
  if (!handle) {
    throw std::runtime_error("FunASR failed to initialize Paraformer 2-pass models");
  }
  return CTpassPtr(handle);
}

CDecoderPtr createDecoder(FUNASR_HANDLE tpass) {
  FUNASR_DEC_HANDLE handle = FunASRWfstDecoderInit(tpass, ASR_TWO_PASS, 3.0f, 3.0f, 10.0f);
  return CDecoderPtr(handle);
}

std::vector<std::string> readHotwords(const std::string &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("unable to open FunASR hotword file: " + path);
  }
  std::vector<std::string> hotwords;
  std::string line;
  while (std::getline(input, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    if (hotwords.empty() && line.size() >= 3 &&
        static_cast<unsigned char>(line[0]) == 0xef &&
        static_cast<unsigned char>(line[1]) == 0xbb &&
        static_cast<unsigned char>(line[2]) == 0xbf) {
      line.erase(0, 3);
    }
    line = trim(line);
    if (line.empty()) {
      continue;
    }
    if (line.find_first_of(" \t") != std::string::npos) {
      throw std::runtime_error("FunASR hotwords must contain one whitespace-free term per line");
    }
    if (std::find(hotwords.begin(), hotwords.end(), line) == hotwords.end()) {
      hotwords.push_back(line);
    }
  }
  if (!input.eof()) {
    throw std::runtime_error("unable to read FunASR hotword file: " + path);
  }
  if (hotwords.empty()) {
    throw std::runtime_error("FunASR hotword file contains no terms: " + path);
  }
  return hotwords;
}

std::vector<std::vector<float>> compileHotwordEmbeddings(
    FUNASR_HANDLE tpass,
    const std::string &path) {
  if (path.empty()) {
    return {{0.0f}};
  }
  const std::vector<std::string> hotwords = readHotwords(path);
  std::ostringstream joined;
  for (size_t index = 0; index < hotwords.size(); ++index) {
    if (index > 0) {
      joined << ' ';
    }
    joined << hotwords[index];
  }
  std::string value = joined.str();
  std::vector<std::vector<float>> embeddings =
      CompileHotwordEmbedding(tpass, value, ASR_TWO_PASS);
  if (embeddings.size() <= 1) {
    throw std::runtime_error(
        "configured FunASR model does not support contextual hotword embeddings");
  }
  return embeddings;
}

std::string utteranceId(const std::string &sourceId, const CSourceState &state) {
  return sourceId + ":" + std::to_string(state.utteranceIndex);
}

void emitTranscript(
    const COptions &options,
    const std::string &requestId,
    const std::string &sourceId,
    CSourceState &state,
    const std::string &status,
    const std::string &text,
    int64_t startMs,
    int64_t endMs) {
  ++state.revision;
  std::ostringstream output;
  output << "{\"type\":\"transcript\",\"protocol\":\"" << kProtocol
         << "\",\"engineId\":\"" << jsonEscape(options.engineId)
         << "\",\"language\":\"" << kLanguage
         << "\",\"requestId\":\"" << jsonEscape(requestId)
         << "\",\"sourceId\":\"" << jsonEscape(sourceId)
         << "\",\"utteranceId\":\"" << jsonEscape(utteranceId(sourceId, state))
         << "\",\"revision\":" << state.revision
         << ",\"state\":\"" << status << "\"";
  if (status != "clear") {
    output << ",\"text\":\"" << jsonEscape(text) << "\""
           << ",\"startMs\":" << std::max<int64_t>(0, startMs)
           << ",\"endMs\":" << endMs;
  }
  output << "}";
  emit(output.str());
}

void emitResult(
    const COptions &options,
    const std::string &requestId,
    const std::string &sourceId,
    bool ok,
    const std::string &error = "") {
  std::ostringstream output;
  output << "{\"type\":\"result\",\"protocol\":\"" << kProtocol
         << "\",\"engineId\":\"" << jsonEscape(options.engineId)
         << "\",\"language\":\"" << kLanguage
         << "\",\"requestId\":\"" << jsonEscape(requestId)
         << "\",\"sourceId\":\"" << jsonEscape(sourceId)
         << "\",\"ok\":" << (ok ? "true" : "false");
  if (!error.empty()) {
    output << ",\"error\":\"" << jsonEscape(error) << "\"";
  }
  output << "}";
  emit(output.str());
}

void destroySource(CSourceState &state) {
  if (state.onlineHandle) {
    FunTpassOnlineUninit(state.onlineHandle);
    state.onlineHandle = nullptr;
  }
}

void resetUtterance(CSourceState &state) {
  ++state.utteranceIndex;
  state.revision = 0;
  state.utteranceStartMs = -1;
  state.vadStartMs = -1;
  state.partialText.clear();
}

int64_t selectFinalStartMs(
    int64_t vadStartMs,
    int64_t partialStartMs,
    int64_t modelStartMs,
    int64_t endMs,
    int64_t lastFinalEndMs) {
  if (vadStartMs >= lastFinalEndMs && vadStartMs < endMs) {
    return vadStartMs;
  }
  if (partialStartMs >= lastFinalEndMs && partialStartMs < endMs) {
    return partialStartMs;
  }
  if (modelStartMs >= lastFinalEndMs && modelStartMs < endMs) {
    return modelStartMs;
  }
  if (lastFinalEndMs < endMs) {
    return lastFinalEndMs;
  }
  throw std::runtime_error(
      "FunASR final VAD range is invalid: vadStart=" + std::to_string(vadStartMs)
      + ", partialStart=" + std::to_string(partialStartMs)
      + ", modelStart=" + std::to_string(modelStartMs)
      + ", end=" + std::to_string(endMs)
      + ", lastFinalEnd=" + std::to_string(lastFinalEndMs));
}

bool containsNextUtteranceStart(
    int64_t modelStartMs,
    int64_t modelEndMs,
    int64_t lastFinalEndMs) {
  return modelEndMs > lastFinalEndMs && modelStartMs >= modelEndMs;
}

void runTimingSelfTest() {
  constexpr int64_t kLastFinalEndMs = 411625;
  constexpr int64_t kModelEndMs = 412235;
  constexpr int64_t kModelStartMs = 412515;
  constexpr int64_t kPartialStartMs = 412575;
  if (!containsNextUtteranceStart(kModelStartMs, kModelEndMs, kLastFinalEndMs)) {
    throw std::runtime_error("FunASR timing self-test did not detect a cross-utterance result");
  }
  const int64_t finalStartMs = selectFinalStartMs(
      -1,
      kPartialStartMs,
      kModelStartMs,
      kModelEndMs,
      kLastFinalEndMs);
  if (finalStartMs != kLastFinalEndMs) {
    throw std::runtime_error("FunASR timing self-test selected an invalid final start");
  }
  emit("{\"ok\":true,\"crossUtterance\":true,\"finalStartMs\":"
      + std::to_string(finalStartMs) + "}");
}

CSourceState &sourceState(
    FUNASR_HANDLE tpass,
    std::map<std::string, CSourceState> &sources,
    const std::string &sourceId,
    int64_t sequence,
    int64_t startMs) {
  CSourceState &state = sources[sourceId];
  if (!state.onlineHandle) {
    state.onlineHandle = FunTpassOnlineInit(tpass, {5, 10, 5});
    if (!state.onlineHandle) {
      throw std::runtime_error("FunASR failed to create a source stream");
    }
    state.expectedSequence = sequence;
    state.timelineOriginMs = startMs;
  }
  return state;
}

void consumeInferenceResult(
    const COptions &options,
    const std::string &requestId,
    const std::string &sourceId,
    CSourceState &state,
    FUNASR_RESULT result,
    int64_t requestStartMs,
    int64_t requestEndMs) {
  const int64_t modelStartMs = state.timelineOriginMs
      + std::max<int64_t>(0, FunASRGetTpassStart(result));
  const int64_t modelEndMs = state.timelineOriginMs
      + std::max<int64_t>(0, FunASRGetTpassEnd(result));
  // FunASR may return the previous end and the next start in the same inference result.
  const bool hasVadBoundary = modelStartMs > state.lastFinalEndMs
      || modelEndMs > state.lastFinalEndMs;
  const char *online = FunASRGetResult(result, 0);
  const std::string onlineDelta = trim(online ? online : "");
  const char *offline = FunASRGetTpassResult(result, 0);
  const std::string finalText = trim(offline ? offline : "");

  const auto updateVadStart = [&]() {
    if (hasVadBoundary
        && modelStartMs >= state.lastFinalEndMs
        && (state.vadStartMs < state.lastFinalEndMs || modelStartMs < state.vadStartMs)
        && (modelEndMs <= state.lastFinalEndMs || modelStartMs < modelEndMs)) {
      state.vadStartMs = modelStartMs;
    }
  };
  const auto emitOnlineDelta = [&]() {
    if (onlineDelta.empty()) {
      return;
    }
    if (state.utteranceStartMs < 0) {
      state.utteranceStartMs = requestStartMs;
    }
    state.partialText += onlineDelta;
    emitTranscript(
        options,
        requestId,
        sourceId,
        state,
        "partial",
        state.partialText,
        state.utteranceStartMs,
        requestEndMs);
  };
  const auto emitFinalText = [&]() {
    if (finalText.empty()) {
      return;
    }
    const int64_t endMs = modelEndMs;
    const int64_t startMs = selectFinalStartMs(
        state.vadStartMs,
        state.utteranceStartMs,
        modelStartMs,
        endMs,
        state.lastFinalEndMs);
    emitTranscript(options, requestId, sourceId, state, "final", finalText, startMs, endMs);
    state.lastFinalEndMs = endMs;
    resetUtterance(state);
  };

  if (!finalText.empty()
      && containsNextUtteranceStart(modelStartMs, modelEndMs, state.lastFinalEndMs)) {
    // Preserve utterance identity: the delayed final belongs before this result's next partial.
    emitFinalText();
    updateVadStart();
    emitOnlineDelta();
  } else {
    updateVadStart();
    emitOnlineDelta();
    emitFinalText();
  }
}

void infer(
    const COptions &options,
    FUNASR_HANDLE tpass,
    FUNASR_DEC_HANDLE decoder,
    const std::string &requestId,
    const std::string &sourceId,
    CSourceState &state,
    const std::vector<std::vector<float>> &hotwordEmbeddings,
    const uint8_t *pcm,
    size_t pcmBytes,
    bool inputFinished,
    int64_t startMs,
    int64_t endMs) {
  FUNASR_RESULT result = FunTpassInferBuffer(
      tpass,
      state.onlineHandle,
      reinterpret_cast<const char *>(pcm),
      static_cast<int>(pcmBytes),
      state.puncCache,
      inputFinished,
      options.sampleRateHz,
      "pcm",
      ASR_TWO_PASS,
      hotwordEmbeddings,
      options.useItn,
      decoder);
  if (!result) {
    throw std::runtime_error("FunASR 2-pass inference returned no result");
  }
  consumeInferenceResult(options, requestId, sourceId, state, result, startMs, endMs);
  FunASRFreeResult(result);
}

void handleAudio(
    const COptions &options,
    FUNASR_HANDLE tpass,
    FUNASR_DEC_HANDLE decoder,
    const std::vector<std::vector<float>> &hotwordEmbeddings,
    std::map<std::string, CSourceState> &sources,
    const std::string &line) {
  const std::string requestId = fieldString(line, "requestId");
  const std::string sourceId = fieldString(line, "sourceId");
  const int64_t sequence = fieldInteger(line, "sequence");
  const int64_t startMs = fieldInteger(line, "startMs");
  const int64_t endMs = fieldInteger(line, "endMs");
  if (sequence < 0 || startMs < 0 || endMs < startMs) {
    throw std::runtime_error("audio timing or sequence is invalid");
  }
  CSourceState &state = sourceState(tpass, sources, sourceId, sequence, startMs);
  if (sequence != state.expectedSequence) {
    throw std::runtime_error("audio sequence is not contiguous");
  }
  ++state.expectedSequence;
  const CWavAudio audio = decodeWav(base64Decode(fieldString(line, "audioBase64")));
  if (audio.sampleRateHz != options.sampleRateHz) {
    throw std::runtime_error("audio sample rate does not match the runtime manifest");
  }
  const int64_t modelStartMs = state.timelineOriginMs
      + state.submittedSamples * 1000 / options.sampleRateHz;
  state.submittedSamples += static_cast<int64_t>(audio.pcm16.size() / 2);
  const int64_t modelEndMs = state.timelineOriginMs
      + state.submittedSamples * 1000 / options.sampleRateHz;
  state.lastEndMs = modelEndMs;
  infer(
      options,
      tpass,
      decoder,
      requestId,
      sourceId,
      state,
      hotwordEmbeddings,
      audio.pcm16.data(),
      audio.pcm16.size(),
      false,
      modelStartMs,
      modelEndMs);
  emitResult(options, requestId, sourceId, true);
}

void handleDrain(
    const COptions &options,
    FUNASR_HANDLE tpass,
    FUNASR_DEC_HANDLE decoder,
    const std::vector<std::vector<float>> &hotwordEmbeddings,
    std::map<std::string, CSourceState> &sources,
    const std::string &line) {
  const std::string requestId = fieldString(line, "requestId");
  const std::string sourceId = fieldString(line, "sourceId");
  static_cast<void>(fieldInteger(line, "endMs"));
  const auto item = sources.find(sourceId);
  if (item != sources.end()) {
    CSourceState &state = item->second;
    const uint8_t silence[2] = {0, 0};
    infer(
        options,
        tpass,
        decoder,
        requestId,
        sourceId,
        state,
        hotwordEmbeddings,
        silence,
        sizeof(silence),
        true,
        state.lastEndMs,
        state.lastEndMs);
    if (!state.partialText.empty()) {
      throw std::runtime_error("FunASR drain completed without a final transcript for the pending partial");
    }
    destroySource(state);
    sources.erase(item);
  }
  emitResult(options, requestId, sourceId, true);
}

void runHelper(
    const COptions &options,
    FUNASR_HANDLE tpass,
    FUNASR_DEC_HANDLE decoder,
    const std::vector<std::vector<float>> &hotwordEmbeddings) {
  emit("{\"type\":\"ready\",\"ok\":true,\"protocol\":\"" + std::string(kProtocol) +
      "\",\"engineId\":\"" + jsonEscape(options.engineId) + "\",\"language\":\"" + kLanguage +
      "\",\"sampleRateHz\":" + std::to_string(options.sampleRateHz) + "}");
  std::map<std::string, CSourceState> sources;
  std::string line;
  while (std::getline(std::cin, line)) {
    line = trim(line);
    if (line.empty()) {
      continue;
    }
    std::string requestId;
    std::string sourceId;
    try {
      const std::string command = fieldString(line, "command");
      requestId = fieldString(line, "requestId");
      sourceId = fieldString(line, "sourceId", false);
      if (command == "audio") {
        handleAudio(options, tpass, decoder, hotwordEmbeddings, sources, line);
      } else if (command == "drain") {
        handleDrain(options, tpass, decoder, hotwordEmbeddings, sources, line);
      } else if (command == "shutdown") {
        emitResult(options, requestId, sourceId, true);
        break;
      } else {
        throw std::runtime_error("unsupported command");
      }
    } catch (const std::exception &error) {
      emitResult(options, requestId, sourceId, false, error.what());
    }
  }
  for (auto item = sources.begin(); item != sources.end(); ++item) {
    destroySource(item->second);
  }
}

}  // namespace

int main(int argc, char **argv) {
  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  try {
    if (argc == 2 && std::strcmp(argv[1], "--timing-self-test") == 0) {
      runTimingSelfTest();
      return 0;
    }
    const COptions options = readOptions(argc, argv);
    CTpassPtr tpass = createTpass(options);
    CDecoderPtr decoder = createDecoder(tpass.get());
    const std::vector<std::vector<float>> hotwordEmbeddings =
        compileHotwordEmbeddings(tpass.get(), options.hotwordFile);
    runHelper(options, tpass.get(), decoder.get(), hotwordEmbeddings);
    return 0;
  } catch (const std::exception &error) {
    emit("{\"type\":\"startup_error\",\"protocol\":\"" + std::string(kProtocol) +
        "\",\"error\":\"" + jsonEscape(error.what()) + "\"}");
    return 1;
  }
}
