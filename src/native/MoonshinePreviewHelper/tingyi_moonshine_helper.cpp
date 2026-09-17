#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "moonshine-c-api.h"

namespace {

struct MoonshineRuntime {
  HMODULE library = nullptr;
  int32_t (*getVersion)() = nullptr;
  const char *(*errorToString)(int32_t) = nullptr;
  int32_t (*loadTranscriberFromFiles)(const char *, uint32_t, const moonshine_option_t *, uint64_t, int32_t) = nullptr;
  void (*freeTranscriber)(int32_t) = nullptr;
  int32_t (*transcribeWithoutStreaming)(int32_t, const float *, uint64_t, int32_t, uint32_t, transcript_t **) = nullptr;
  int32_t (*createStream)(int32_t, uint32_t) = nullptr;
  int32_t (*freeStream)(int32_t, int32_t) = nullptr;
  int32_t (*startStream)(int32_t, int32_t) = nullptr;
  int32_t (*stopStream)(int32_t, int32_t) = nullptr;
  int32_t (*addAudioToStream)(int32_t, int32_t, const float *, uint64_t, int32_t, uint32_t) = nullptr;
  int32_t (*transcribeStream)(int32_t, int32_t, uint32_t, transcript_t **) = nullptr;
};

std::wstring widenUtf8(const std::string &value) {
  if (value.empty()) {
    return L"";
  }
  int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) {
    throw std::runtime_error("failed to convert UTF-8 path");
  }
  std::wstring wide(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), wide.data(), size);
  return wide;
}

std::string narrowUtf8(const std::wstring &value) {
  if (value.empty()) {
    return "";
  }
  int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) {
    throw std::runtime_error("failed to convert UTF-16 path");
  }
  std::string narrow(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), narrow.data(), size, nullptr, nullptr);
  return narrow;
}

std::string directoryOfExecutable() {
  std::wstring buffer(MAX_PATH, L'\0');
  DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  while (length == buffer.size()) {
    buffer.resize(buffer.size() * 2);
    length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  }
  if (length == 0) {
    return ".";
  }
  buffer.resize(length);
  size_t slash = buffer.find_last_of(L"\\/");
  if (slash == std::wstring::npos) {
    return ".";
  }
  return narrowUtf8(buffer.substr(0, slash));
}

std::string pathJoin(const std::string &left, const std::string &right) {
  if (left.empty() || left == ".") {
    return right;
  }
  char tail = left.back();
  if (tail == '\\' || tail == '/') {
    return left + right;
  }
  return left + "\\" + right;
}

template <typename Function>
Function requireProc(HMODULE library, const char *name) {
  FARPROC proc = GetProcAddress(library, name);
  if (!proc) {
    throw std::runtime_error(std::string("moonshine.dll missing export: ") + name);
  }
  return reinterpret_cast<Function>(proc);
}

MoonshineRuntime loadMoonshineRuntime() {
  const std::string dllPath = pathJoin(directoryOfExecutable(), "moonshine.dll");
  HMODULE library = LoadLibraryW(widenUtf8(dllPath).c_str());
  if (!library) {
    throw std::runtime_error("failed to load Moonshine runtime: " + dllPath);
  }
  MoonshineRuntime runtime;
  runtime.library = library;
  runtime.getVersion = requireProc<int32_t (*)()>(library, "moonshine_get_version");
  runtime.errorToString = requireProc<const char *(*)(int32_t)>(library, "moonshine_error_to_string");
  runtime.loadTranscriberFromFiles = requireProc<int32_t (*)(const char *, uint32_t, const moonshine_option_t *, uint64_t, int32_t)>(
      library, "moonshine_load_transcriber_from_files");
  runtime.freeTranscriber = requireProc<void (*)(int32_t)>(library, "moonshine_free_transcriber");
  runtime.transcribeWithoutStreaming = requireProc<int32_t (*)(int32_t, const float *, uint64_t, int32_t, uint32_t, transcript_t **)>(
      library, "moonshine_transcribe_without_streaming");
  runtime.createStream = requireProc<int32_t (*)(int32_t, uint32_t)>(library, "moonshine_create_stream");
  runtime.freeStream = requireProc<int32_t (*)(int32_t, int32_t)>(library, "moonshine_free_stream");
  runtime.startStream = requireProc<int32_t (*)(int32_t, int32_t)>(library, "moonshine_start_stream");
  runtime.stopStream = requireProc<int32_t (*)(int32_t, int32_t)>(library, "moonshine_stop_stream");
  runtime.addAudioToStream = requireProc<int32_t (*)(int32_t, int32_t, const float *, uint64_t, int32_t, uint32_t)>(
      library, "moonshine_transcribe_add_audio_to_stream");
  runtime.transcribeStream = requireProc<int32_t (*)(int32_t, int32_t, uint32_t, transcript_t **)>(library, "moonshine_transcribe_stream");
  if (runtime.getVersion() != MOONSHINE_HEADER_VERSION) {
    throw std::runtime_error("moonshine.dll version does not match helper header");
  }
  return runtime;
}

struct WavAudio {
  int32_t sampleRate = 0;
  std::vector<float> samples;
};

const int64_t RESET_GAP_MS = 1500;
const char *LOCAL_ASR_PROTOCOL = "local-asr-jsonl-v2";
const char *ENGINE_ID = "moonshine-tiny-en";
const char *ENGINE_LANGUAGE = "en";
const double SILENCE_THRESHOLD = 0.001;
const int64_t SILENCE_RESET_MS = 900;
const int TENTATIVE_MIN_WORDS = 5;
const size_t TENTATIVE_HISTORY = 2;
const int TENTATIVE_DROP_WORDS = 3;
const std::regex WORD_PATTERN("[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*");
const std::vector<std::string> INCOMPLETE_TRAILING_TOKENS = {
    "a",     "an",    "and",   "are",  "as",    "at",   "be",    "by",   "can",
    "could", "for",   "from",  "how",  "i",     "in",   "is",    "it",   "many",
    "my",    "much",  "of",    "on",   "or",    "our",  "that",  "the",  "this",
    "to",    "what",  "when",  "where", "which", "who",  "why",   "we",   "will",
    "with",  "would", "you",   "your"};

struct SourceStreamState {
  int32_t streamHandle = -1;
  bool started = false;
  int64_t expectedSequence = 0;
  int64_t utteranceIndex = 1;
  int64_t revision = 0;
  int64_t utteranceStartMs = -1;
  int64_t lastEndMs = -1;
  int64_t silentMs = 0;
  bool hasSpeech = false;
  std::string text;
  std::string stableText;
  std::string stableComparableText;
  std::string stability = "stable";
  std::vector<std::string> incompleteHistory;
};

struct PreviewResultPayload {
  std::string text;
  bool stable = false;
};

std::string trim(const std::string &value) {
  size_t start = 0;
  while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) {
    start += 1;
  }
  size_t end = value.size();
  while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) {
    end -= 1;
  }
  return value.substr(start, end - start);
}

std::string normalizeText(const std::string &value) {
  std::string withoutTokens = std::regex_replace(value, std::regex("<\\|[^|]*\\|>"), " ");
  std::ostringstream output;
  bool previousSpace = true;
  for (unsigned char ch : withoutTokens) {
    if (std::isspace(ch)) {
      if (!previousSpace) {
        output << ' ';
      }
      previousSpace = true;
    } else {
      output << ch;
      previousSpace = false;
    }
  }
  return trim(output.str());
}

std::vector<std::string> textWords(const std::string &value) {
  std::vector<std::string> words;
  const std::string text = normalizeText(value);
  auto begin = std::sregex_iterator(text.begin(), text.end(), WORD_PATTERN);
  auto end = std::sregex_iterator();
  for (auto iterator = begin; iterator != end; ++iterator) {
    std::string word = iterator->str();
    std::transform(word.begin(), word.end(), word.begin(), [](unsigned char ch) {
      return static_cast<char>(std::tolower(ch));
    });
    words.push_back(word);
  }
  return words;
}

std::string comparableText(const std::string &value) {
  const std::vector<std::string> words = textWords(value);
  std::ostringstream output;
  for (const std::string &word : words) {
    if (output.tellp() > 0) {
      output << ' ';
    }
    output << word;
  }
  return output.str();
}

PreviewResultPayload selectPreviewResult(
    const std::string &currentText,
    const std::string &publishedStableText) {
  if (!normalizeText(publishedStableText).empty()) {
    return {publishedStableText, true};
  }
  return {currentText, false};
}

std::string originalWordPrefix(const std::string &value, int wordCount) {
  const std::string text = normalizeText(value);
  if (wordCount <= 0 || text.empty()) {
    return "";
  }
  std::vector<std::smatch> matches;
  auto begin = std::sregex_iterator(text.begin(), text.end(), WORD_PATTERN);
  auto end = std::sregex_iterator();
  for (auto iterator = begin; iterator != end; ++iterator) {
    matches.push_back(*iterator);
  }
  if (matches.empty()) {
    return "";
  }
  if (static_cast<int>(matches.size()) < wordCount) {
    return text;
  }
  size_t start = static_cast<size_t>(matches.front().position());
  size_t prefixEnd = static_cast<size_t>(matches[static_cast<size_t>(wordCount - 1)].position() + matches[static_cast<size_t>(wordCount - 1)].length());
  while (prefixEnd < text.size()) {
    const char ch = text[prefixEnd];
    if (ch != '.' && ch != ',' && ch != '!' && ch != '?' && ch != ';' && ch != ':' && ch != ')' && ch != ']' &&
        ch != '}' && ch != '"' && ch != '\'') {
      break;
    }
    prefixEnd += 1;
  }
  return normalizeText(text.substr(start, prefixEnd - start));
}

std::vector<std::string> commonWordPrefix(const std::vector<std::string> &texts) {
  std::vector<std::string> prefix;
  bool initialized = false;
  for (const std::string &text : texts) {
    if (normalizeText(text).empty()) {
      continue;
    }
    std::vector<std::string> words = textWords(text);
    if (!initialized) {
      prefix = words;
      initialized = true;
      continue;
    }
    size_t size = 0;
    while (size < prefix.size() && size < words.size() && prefix[size] == words[size]) {
      size += 1;
    }
    prefix.resize(size);
    if (prefix.empty()) {
      break;
    }
  }
  return prefix;
}

bool isIncompleteTrailingToken(const std::string &token) {
  return std::find(INCOMPLETE_TRAILING_TOKENS.begin(), INCOMPLETE_TRAILING_TOKENS.end(), token) != INCOMPLETE_TRAILING_TOKENS.end();
}

std::vector<std::string> stripUnstableTail(std::vector<std::string> tokens) {
  if (tokens.size() > static_cast<size_t>(TENTATIVE_DROP_WORDS)) {
    tokens.resize(tokens.size() - static_cast<size_t>(TENTATIVE_DROP_WORDS));
  } else {
    tokens.clear();
  }
  while (!tokens.empty() && isIncompleteTrailingToken(tokens.back())) {
    tokens.pop_back();
  }
  return tokens;
}

std::string jsonEscape(const std::string &value) {
  std::ostringstream output;
  for (unsigned char ch : value) {
    switch (ch) {
      case '"':
        output << "\\\"";
        break;
      case '\\':
        output << "\\\\";
        break;
      case '\b':
        output << "\\b";
        break;
      case '\f':
        output << "\\f";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (ch < 0x20) {
          const char *hex = "0123456789abcdef";
          output << "\\u00" << hex[(ch >> 4) & 0x0f] << hex[ch & 0x0f];
        } else {
          output << ch;
        }
        break;
    }
  }
  return output.str();
}

void emit(const std::string &json) {
  std::cout << json << std::endl;
}

std::string fieldString(const std::string &json, const std::string &key) {
  const std::string needle = "\"" + key + "\"";
  size_t position = json.find(needle);
  if (position == std::string::npos) {
    return "";
  }
  position = json.find(':', position + needle.size());
  if (position == std::string::npos) {
    return "";
  }
  position += 1;
  while (position < json.size() && std::isspace(static_cast<unsigned char>(json[position]))) {
    position += 1;
  }
  if (position >= json.size() || json[position] != '"') {
    return "";
  }
  position += 1;
  std::string result;
  while (position < json.size()) {
    char ch = json[position++];
    if (ch == '"') {
      return result;
    }
    if (ch == '\\' && position < json.size()) {
      char escaped = json[position++];
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          result.push_back(escaped);
          break;
        case 'b':
          result.push_back('\b');
          break;
        case 'f':
          result.push_back('\f');
          break;
        case 'n':
          result.push_back('\n');
          break;
        case 'r':
          result.push_back('\r');
          break;
        case 't':
          result.push_back('\t');
          break;
        default:
          result.push_back(escaped);
          break;
      }
    } else {
      result.push_back(ch);
    }
  }
  return "";
}

std::string fieldNumberText(const std::string &json, const std::string &key) {
  const std::string needle = "\"" + key + "\"";
  size_t position = json.find(needle);
  if (position == std::string::npos) {
    return "";
  }
  position = json.find(':', position + needle.size());
  if (position == std::string::npos) {
    return "";
  }
  position += 1;
  while (position < json.size() && std::isspace(static_cast<unsigned char>(json[position]))) {
    position += 1;
  }
  size_t start = position;
  while (position < json.size() &&
         (std::isdigit(static_cast<unsigned char>(json[position])) || json[position] == '-' || json[position] == '+' ||
          json[position] == '.' || json[position] == 'e' || json[position] == 'E')) {
    position += 1;
  }
  return json.substr(start, position - start);
}

int64_t fieldInteger(const std::string &json, const std::string &key, int64_t fallback) {
  const std::string value = fieldNumberText(json, key);
  if (value.empty()) {
    return fallback;
  }
  try {
    return std::stoll(value);
  } catch (...) {
    return fallback;
  }
}

double fieldDouble(const std::string &json, const std::string &key, double fallback) {
  const std::string value = fieldNumberText(json, key);
  if (value.empty()) {
    return fallback;
  }
  try {
    return std::stod(value);
  } catch (...) {
    return fallback;
  }
}

std::string sourceIdFromRequest(const std::string &json) {
  std::string sourceId = fieldString(json, "sourceId");
  return sourceId.empty() ? "default" : sourceId;
}

std::vector<uint8_t> base64Decode(const std::string &input) {
  static const signed char lookup[256] = {
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1, -1, 63,
      52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -2, -1, -1,
      -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
      15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1, -1,
      -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
  std::vector<uint8_t> output;
  int buffer = 0;
  int bits = -8;
  for (unsigned char ch : input) {
    if (std::isspace(ch)) {
      continue;
    }
    if (ch == '=') {
      break;
    }
    int value = lookup[ch];
    if (value < 0) {
      throw std::runtime_error("invalid base64 payload");
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 0) {
      output.push_back(static_cast<uint8_t>((buffer >> bits) & 0xff));
      bits -= 8;
    }
  }
  return output;
}

uint16_t readU16(const std::vector<uint8_t> &bytes, size_t offset) {
  if (offset + 2 > bytes.size()) {
    throw std::runtime_error("truncated wav");
  }
  return static_cast<uint16_t>(bytes[offset] | (bytes[offset + 1] << 8));
}

uint32_t readU32(const std::vector<uint8_t> &bytes, size_t offset) {
  if (offset + 4 > bytes.size()) {
    throw std::runtime_error("truncated wav");
  }
  return static_cast<uint32_t>(bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24));
}

bool tagEquals(const std::vector<uint8_t> &bytes, size_t offset, const char *tag) {
  return offset + 4 <= bytes.size() && std::memcmp(bytes.data() + offset, tag, 4) == 0;
}

WavAudio decodeWav(const std::vector<uint8_t> &bytes) {
  if (bytes.size() < 44 || !tagEquals(bytes, 0, "RIFF") || !tagEquals(bytes, 8, "WAVE")) {
    throw std::runtime_error("expected RIFF/WAVE PCM16 audio");
  }
  uint16_t channels = 0;
  uint16_t audioFormat = 0;
  uint16_t bitsPerSample = 0;
  uint32_t sampleRate = 0;
  size_t dataOffset = 0;
  uint32_t dataSize = 0;
  size_t offset = 12;
  while (offset + 8 <= bytes.size()) {
    uint32_t chunkSize = readU32(bytes, offset + 4);
    size_t chunkData = offset + 8;
    if (chunkData + chunkSize > bytes.size()) {
      throw std::runtime_error("invalid wav chunk size");
    }
    if (tagEquals(bytes, offset, "fmt ")) {
      if (chunkSize < 16) {
        throw std::runtime_error("invalid wav fmt chunk");
      }
      audioFormat = readU16(bytes, chunkData);
      channels = readU16(bytes, chunkData + 2);
      sampleRate = readU32(bytes, chunkData + 4);
      bitsPerSample = readU16(bytes, chunkData + 14);
    } else if (tagEquals(bytes, offset, "data")) {
      dataOffset = chunkData;
      dataSize = chunkSize;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }
  if (audioFormat != 1 || bitsPerSample != 16 || channels == 0 || sampleRate == 0 || dataOffset == 0) {
    throw std::runtime_error("only PCM16 wav audio is supported");
  }
  WavAudio audio;
  audio.sampleRate = static_cast<int32_t>(sampleRate);
  const size_t frameCount = dataSize / (2 * channels);
  audio.samples.reserve(frameCount);
  for (size_t frame = 0; frame < frameCount; frame += 1) {
    int32_t total = 0;
    for (uint16_t channel = 0; channel < channels; channel += 1) {
      size_t sampleOffset = dataOffset + (frame * channels + channel) * 2;
      int16_t sample = static_cast<int16_t>(readU16(bytes, sampleOffset));
      total += sample;
    }
    float mono = static_cast<float>(total / static_cast<int32_t>(channels)) / 32768.0f;
    audio.samples.push_back(std::clamp(mono, -1.0f, 1.0f));
  }
  return audio;
}

std::vector<uint8_t> readFileBytes(const std::string &path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    throw std::runtime_error("failed to open audio file: " + path);
  }
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
}

uint32_t modelArchFromName(const std::string &name) {
  std::string normalized;
  normalized.reserve(name.size());
  for (char ch : name) {
    normalized.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  if (normalized == "tiny") {
    return MOONSHINE_MODEL_ARCH_TINY;
  }
  if (normalized == "base") {
    return MOONSHINE_MODEL_ARCH_BASE;
  }
  if (normalized == "tiny-streaming" || normalized == "tiny_streaming" || normalized == "tiny-streaming-en") {
    return MOONSHINE_MODEL_ARCH_TINY_STREAMING;
  }
  if (normalized == "base-streaming" || normalized == "base_streaming" || normalized == "base-streaming-en") {
    return MOONSHINE_MODEL_ARCH_BASE_STREAMING;
  }
  if (normalized == "small-streaming" || normalized == "small_streaming" || normalized == "small-streaming-en") {
    return MOONSHINE_MODEL_ARCH_SMALL_STREAMING;
  }
  if (normalized == "medium-streaming" || normalized == "medium_streaming" || normalized == "medium-streaming-en") {
    return MOONSHINE_MODEL_ARCH_MEDIUM_STREAMING;
  }
  throw std::runtime_error("unsupported Moonshine model arch: " + name);
}

std::string transcriptText(const transcript_t *transcript) {
  if (!transcript || !transcript->lines || transcript->line_count == 0) {
    return "";
  }
  std::ostringstream output;
  for (uint64_t index = 0; index < transcript->line_count; index += 1) {
    const char *text = transcript->lines[index].text;
    if (!text || !*text) {
      continue;
    }
    if (output.tellp() > 0) {
      output << ' ';
    }
    output << text;
  }
  return trim(output.str());
}

std::string latestCompletedText(const transcript_t *transcript) {
  if (!transcript || !transcript->lines || transcript->line_count == 0) {
    return "";
  }
  std::string latest;
  for (uint64_t index = 0; index < transcript->line_count; index += 1) {
    const transcript_line_t &line = transcript->lines[index];
    const char *text = line.text;
    if (text && *text && line.is_complete) {
      latest = normalizeText(text);
    }
  }
  return latest;
}

std::string latestIncompleteText(const transcript_t *transcript) {
  if (!transcript || !transcript->lines || transcript->line_count == 0) {
    return "";
  }
  for (uint64_t offset = 0; offset < transcript->line_count; offset += 1) {
    const uint64_t index = transcript->line_count - 1 - offset;
    const transcript_line_t &line = transcript->lines[index];
    const char *text = line.text;
    if (text && *text && !line.is_complete) {
      return normalizeText(text);
    }
  }
  return "";
}

void checkMoonshineError(const MoonshineRuntime &runtime, int32_t error, const std::string &action) {
  if (error != 0) {
    throw std::runtime_error(action + ": " + runtime.errorToString(error));
  }
}

void freeStreamIfNeeded(const MoonshineRuntime &runtime, int32_t handle, SourceStreamState &state) {
  if (state.streamHandle >= 0) {
    if (state.started) {
      runtime.stopStream(handle, state.streamHandle);
    }
    runtime.freeStream(handle, state.streamHandle);
  }
  state.streamHandle = -1;
  state.started = false;
}

void startSourceStream(const MoonshineRuntime &runtime, int32_t handle, SourceStreamState &state) {
  int32_t stream = runtime.createStream(handle, 0);
  if (stream < 0) {
    throw std::runtime_error(std::string("create stream: ") + runtime.errorToString(stream));
  }
  checkMoonshineError(runtime, runtime.startStream(handle, stream), "start stream");
  state.streamHandle = stream;
  state.started = true;
  state.silentMs = 0;
}

void resetSourceStream(const MoonshineRuntime &runtime, int32_t handle, SourceStreamState &state, bool clearText, bool stopExisting) {
  if (state.streamHandle >= 0) {
    if (state.started && stopExisting) {
      runtime.stopStream(handle, state.streamHandle);
    }
    runtime.freeStream(handle, state.streamHandle);
    state.streamHandle = -1;
    state.started = false;
  }
  startSourceStream(runtime, handle, state);
  if (clearText) {
    state.text.clear();
    state.stableText.clear();
    state.stableComparableText.clear();
    state.stability = "stable";
    state.incompleteHistory.clear();
  }
}

std::string utteranceId(const std::string &sourceId, const SourceStreamState &state) {
  return sourceId + ":" + std::to_string(state.utteranceIndex);
}

void emitTranscript(
    const std::string &requestId,
    const std::string &sourceId,
    SourceStreamState &state,
    const std::string &status,
    const std::string &text,
    int64_t endMs) {
  ++state.revision;
  std::ostringstream output;
  output << "{\"type\":\"transcript\",\"protocol\":\"" << LOCAL_ASR_PROTOCOL
         << "\",\"engineId\":\"" << ENGINE_ID << "\",\"language\":\"" << ENGINE_LANGUAGE
         << "\",\"requestId\":\"" << jsonEscape(requestId)
         << "\",\"sourceId\":\"" << jsonEscape(sourceId)
         << "\",\"utteranceId\":\"" << jsonEscape(utteranceId(sourceId, state))
         << "\",\"revision\":" << state.revision
         << ",\"state\":\"" << status << "\"";
  if (status != "clear") {
    output << ",\"text\":\"" << jsonEscape(text)
           << "\",\"startMs\":" << std::max<int64_t>(0, state.utteranceStartMs)
           << ",\"endMs\":" << endMs;
  }
  output << "}";
  emit(output.str());
}

void emitResult(const std::string &requestId, const std::string &sourceId, bool ok, const std::string &error = "") {
  std::ostringstream output;
  output << "{\"type\":\"result\",\"protocol\":\"" << LOCAL_ASR_PROTOCOL
         << "\",\"engineId\":\"" << ENGINE_ID << "\",\"language\":\"" << ENGINE_LANGUAGE
         << "\",\"requestId\":\"" << jsonEscape(requestId)
         << "\",\"sourceId\":\"" << jsonEscape(sourceId)
         << "\",\"ok\":" << (ok ? "true" : "false");
  if (!error.empty()) {
    output << ",\"error\":\"" << jsonEscape(error) << "\"";
  }
  output << "}";
  emit(output.str());
}

void advanceUtterance(SourceStreamState &state) {
  ++state.utteranceIndex;
  state.revision = 0;
  state.utteranceStartMs = -1;
  state.hasSpeech = false;
  state.text.clear();
  state.stableText.clear();
  state.stability = "stable";
  state.incompleteHistory.clear();
}

std::string publishStableIfNew(
    const std::string &requestId,
    const std::string &sourceId,
    SourceStreamState &state,
    const std::string &text,
    int64_t endMs) {
  const std::string bestText = normalizeText(text);
  const std::string bestComparableText = comparableText(bestText);
  if (!bestComparableText.empty() && bestComparableText != state.stableComparableText) {
    state.stableText = bestText;
    state.stableComparableText = bestComparableText;
    state.text = bestText;
    state.stability = "stable";
    emitTranscript(requestId, sourceId, state, "final", bestText, endMs);
    advanceUtterance(state);
  }
  return state.text.empty() ? bestText : state.text;
}

std::string publishTentativeIfNew(
    const std::string &requestId,
    const std::string &sourceId,
    SourceStreamState &state,
    const std::string &text,
    int64_t endMs) {
  const std::string bestText = normalizeText(text);
  if (!bestText.empty() && bestText != state.text && bestText != state.stableText) {
    state.text = bestText;
    state.stability = "tentative";
    emitTranscript(requestId, sourceId, state, "partial", bestText, endMs);
  }
  return state.text.empty() ? bestText : state.text;
}

std::string tentativeCandidate(SourceStreamState &state, const std::string &text) {
  const std::string incompleteText = normalizeText(text);
  if (incompleteText.empty()) {
    state.incompleteHistory.clear();
    return "";
  }
  state.incompleteHistory.push_back(incompleteText);
  while (state.incompleteHistory.size() > TENTATIVE_HISTORY) {
    state.incompleteHistory.erase(state.incompleteHistory.begin());
  }
  if (state.incompleteHistory.size() < TENTATIVE_HISTORY) {
    return "";
  }
  std::vector<std::string> candidateTokens = stripUnstableTail(commonWordPrefix(state.incompleteHistory));
  if (candidateTokens.size() < static_cast<size_t>(TENTATIVE_MIN_WORDS)) {
    return "";
  }
  return originalWordPrefix(state.incompleteHistory.back(), static_cast<int>(candidateTokens.size()));
}

std::string transcribe(const MoonshineRuntime &runtime, int32_t handle, const std::vector<uint8_t> &audioBytes) {
  WavAudio audio = decodeWav(audioBytes);
  if (audio.samples.empty()) {
    return "";
  }
  transcript_t *transcript = nullptr;
  int32_t error = runtime.transcribeWithoutStreaming(
      handle,
      audio.samples.data(),
      static_cast<uint64_t>(audio.samples.size()),
      audio.sampleRate,
      0,
      &transcript);
  if (error != 0) {
    throw std::runtime_error(runtime.errorToString(error));
  }
  return transcriptText(transcript);
}

void runCliMode(const MoonshineRuntime &runtime, int32_t handle, const std::string &audioPath) {
  std::string text = transcribe(runtime, handle, readFileBytes(audioPath));
  emit("{\"ok\":true,\"text\":\"" + jsonEscape(text) + "\"}");
}

void previewStreamingSegment(
    const MoonshineRuntime &runtime,
    int32_t handle,
    std::map<std::string, SourceStreamState> &states,
    const std::string &line) {
  const std::string requestId = fieldString(line, "requestId");
  const std::string sourceId = sourceIdFromRequest(line);
  SourceStreamState &state = states[sourceId];
  const int64_t sequence = fieldInteger(line, "sequence", -1);
  const int64_t startMs = fieldInteger(line, "startMs", 0);
  const int64_t endMs = fieldInteger(line, "endMs", startMs);
  const int64_t durationMs = std::max<int64_t>(0, endMs - startMs);
  if (sequence != state.expectedSequence) {
    throw std::runtime_error("audio sequence is not contiguous");
  }
  ++state.expectedSequence;
  const std::string audioBase64 = fieldString(line, "audioBase64");
  if (audioBase64.empty()) {
    throw std::runtime_error("missing segment.audioBase64");
  }
  WavAudio audio = decodeWav(base64Decode(audioBase64));
  if (audio.samples.empty()) {
    emitResult(requestId, sourceId, true);
    return;
  }
  if (audio.sampleRate != 24000) {
    throw std::runtime_error("audio sample rate does not match the runtime manifest");
  }
  const double rms = fieldDouble(line, "rms", -1.0);
  const double level = rms >= 0.0 ? rms : fieldDouble(line, "level", -1.0);
  const bool audible = level < 0.0 || level >= SILENCE_THRESHOLD;
  const bool needsReset = state.streamHandle < 0 || state.lastEndMs < 0
      || startMs < state.lastEndMs || startMs - state.lastEndMs > RESET_GAP_MS;
  if (!audible && (!state.hasSpeech || needsReset)) {
    state.lastEndMs = endMs;
    emitResult(requestId, sourceId, true);
    return;
  }
  if (needsReset) {
    resetSourceStream(runtime, handle, state, true, true);
  }
  if (audible) {
    state.hasSpeech = true;
    if (state.utteranceStartMs < 0) {
      state.utteranceStartMs = startMs;
    }
  }
  state.lastEndMs = endMs;

  checkMoonshineError(
      runtime,
      runtime.addAudioToStream(
          handle,
          state.streamHandle,
          audio.samples.data(),
          static_cast<uint64_t>(audio.samples.size()),
          audio.sampleRate,
          0),
      "add stream audio");
  transcript_t *transcript = nullptr;
  checkMoonshineError(runtime, runtime.transcribeStream(handle, state.streamHandle, 0, &transcript), "update stream transcript");

  publishStableIfNew(requestId, sourceId, state, latestCompletedText(transcript), endMs);
  if (state.utteranceStartMs < 0) {
    state.utteranceStartMs = startMs;
  }
  const std::string tentative = tentativeCandidate(state, latestIncompleteText(transcript));
  if (!tentative.empty()) {
    publishTentativeIfNew(requestId, sourceId, state, tentative, endMs);
  }

  if (!audible) {
    state.silentMs += durationMs;
    if (state.silentMs >= SILENCE_RESET_MS) {
      checkMoonshineError(runtime, runtime.stopStream(handle, state.streamHandle), "stop stream");
      state.started = false;
      transcript_t *finalTranscript = nullptr;
      checkMoonshineError(runtime, runtime.transcribeStream(handle, state.streamHandle, 0, &finalTranscript), "flush stream transcript");
      std::string finalText = latestCompletedText(finalTranscript);
      if (finalText.empty()) {
        finalText = latestIncompleteText(finalTranscript);
      }
      if (finalText.empty() && state.stability == "tentative") {
        finalText = state.text;
      }
      publishStableIfNew(requestId, sourceId, state, finalText, endMs);
      state.incompleteHistory.clear();
      resetSourceStream(runtime, handle, state, true, false);
      state.hasSpeech = false;
      state.lastEndMs = endMs;
    }
  } else {
    state.silentMs = 0;
  }

  emitResult(requestId, sourceId, true);
}

void drainSource(
    const MoonshineRuntime &runtime,
    int32_t handle,
    std::map<std::string, SourceStreamState> &states,
    const std::string &line) {
  const std::string requestId = fieldString(line, "requestId");
  const std::string sourceId = sourceIdFromRequest(line);
  const int64_t endMs = fieldInteger(line, "endMs", 0);
  const auto item = states.find(sourceId);
  if (item != states.end()) {
    SourceStreamState &state = item->second;
    if (state.streamHandle >= 0 && state.started) {
      checkMoonshineError(runtime, runtime.stopStream(handle, state.streamHandle), "stop stream");
      state.started = false;
      transcript_t *transcript = nullptr;
      checkMoonshineError(runtime, runtime.transcribeStream(handle, state.streamHandle, 0, &transcript), "drain stream transcript");
      std::string finalText = latestCompletedText(transcript);
      if (finalText.empty()) {
        finalText = latestIncompleteText(transcript);
      }
      if (finalText.empty() && state.stability == "tentative") {
        finalText = state.text;
      }
      publishStableIfNew(requestId, sourceId, state, finalText, std::max(endMs, state.lastEndMs));
    }
    freeStreamIfNeeded(runtime, handle, state);
    states.erase(item);
  }
  emitResult(requestId, sourceId, true);
}

void runHelperMode(const MoonshineRuntime &runtime, int32_t handle) {
  emit("{\"type\":\"ready\",\"ok\":true,\"protocol\":\"local-asr-jsonl-v2\",\"engineId\":\"moonshine-tiny-en\",\"language\":\"en\",\"sampleRateHz\":24000}");
  std::map<std::string, SourceStreamState> states;
  std::string line;
  while (std::getline(std::cin, line)) {
    line = trim(line);
    if (line.empty()) {
      continue;
    }
    const std::string command = fieldString(line, "command");
    const std::string id = fieldString(line, "requestId");
    const std::string sourceId = fieldString(line, "sourceId");
    try {
      if (command == "audio") {
        previewStreamingSegment(runtime, handle, states, line);
      } else if (command == "drain") {
        drainSource(runtime, handle, states, line);
      } else if (command == "shutdown") {
        emitResult(id, sourceId, true);
        break;
      } else {
        throw std::runtime_error("unsupported command");
      }
    } catch (const std::exception &error) {
      emitResult(id, sourceId, false, error.what());
    }
  }
  for (auto &entry : states) {
    freeStreamIfNeeded(runtime, handle, entry.second);
  }
}

}  // namespace

int main(int argc, char **argv) {
  try {
    std::ios::sync_with_stdio(false);
    if (argc < 2) {
      std::cerr << "usage: tingyi-moonshine-helper.exe <model_dir> [audio.wav] [--arch tiny|base|tiny-streaming|base-streaming|small-streaming|medium-streaming]\n";
      return 2;
    }
    if (argc == 2 && std::string(argv[1]) == "--self-test-result-selection") {
      const PreviewResultPayload stableAfterTentative = selectPreviewResult("Next tentative words", "Completed sentence.");
      const PreviewResultPayload tentativeOnly = selectPreviewResult("Next tentative words", "");
      emit("{\"ok\":true,\"stableAfterTentative\":{\"text\":\"" + jsonEscape(stableAfterTentative.text) +
           "\",\"stable\":" + (stableAfterTentative.stable ? "true" : "false") +
           "},\"tentativeOnly\":{\"text\":\"" + jsonEscape(tentativeOnly.text) +
           "\",\"stable\":" + (tentativeOnly.stable ? "true" : "false") + "}}");
      return stableAfterTentative.stable && stableAfterTentative.text == "Completed sentence." &&
              !tentativeOnly.stable && tentativeOnly.text == "Next tentative words"
          ? 0
          : 1;
    }
    std::string modelDir = argv[1];
    std::string audioPath;
    std::string archName = "tiny-streaming";
    for (int index = 2; index < argc; index += 1) {
      std::string arg = argv[index];
      if (arg == "--arch" && index + 1 < argc) {
        archName = argv[++index];
      } else if (arg.rfind("--arch=", 0) == 0) {
        archName = arg.substr(7);
      } else if (audioPath.empty()) {
        audioPath = arg;
      }
    }
    MoonshineRuntime runtime = loadMoonshineRuntime();
    int32_t handle = runtime.loadTranscriberFromFiles(
        modelDir.c_str(), modelArchFromName(archName), nullptr, 0, MOONSHINE_HEADER_VERSION);
    if (handle < 0) {
      std::string message = runtime.errorToString(handle);
      if (audioPath.empty()) {
        emit("{\"type\":\"startup_error\",\"ok\":false,\"error\":\"" + jsonEscape(message) + "\"}");
        return 1;
      }
      std::cerr << message << "\n";
      return 1;
    }
    if (!audioPath.empty()) {
      runCliMode(runtime, handle, audioPath);
    } else {
      runHelperMode(runtime, handle);
    }
    runtime.freeTranscriber(handle);
    FreeLibrary(runtime.library);
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
