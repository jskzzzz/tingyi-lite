#!/usr/bin/env python3
import argparse
import base64
import io
import json
import re
import sys
import wave
from array import array


PROTOCOL = "local-asr-jsonl-v2"
ENGINE_ID = "funasr-paraformer-zh-two-pass"
LANGUAGE = "zh"
SAMPLE_RATE_HZ = 16000


def emit(record):
    print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), flush=True)


def normalize_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    elif isinstance(value, list):
        text = "".join(normalize_text(item) for item in value)
    elif isinstance(value, dict):
        text = ""
        for key in ("text", "value", "transcript", "result", "sentence"):
            if key in value:
                text = normalize_text(value[key])
                if text:
                    break
        if not text:
            for key in ("sentences", "results", "output"):
                if key in value:
                    text = normalize_text(value[key])
                    if text:
                        break
    else:
        text = str(value)
    text = re.sub(r"<\|[^|]*\|>", "", text)
    return re.sub(r"\s+", "", text).strip()


def merge_streaming_text(previous, next_text):
    previous = normalize_text(previous)
    next_text = normalize_text(next_text)
    if not next_text:
        return previous
    if not previous or next_text.startswith(previous):
        return next_text
    if previous.endswith(next_text):
        return previous
    overlap = min(len(previous), len(next_text))
    while overlap > 0 and previous[-overlap:] != next_text[:overlap]:
        overlap -= 1
    return previous + next_text[overlap:]


def decode_pcm16_mono_wav(audio_base64):
    raw = base64.b64decode(audio_base64, validate=True)
    with wave.open(io.BytesIO(raw), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != SAMPLE_RATE_HZ:
            raise ValueError("audio must be 16 kHz mono PCM16 WAV")
        frames = wav.readframes(wav.getnframes())
    samples = array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


class SourceState:
    def __init__(self, source_id, utterance_index, start_ms):
        self.source_id = source_id
        self.utterance_id = f"{source_id}:{utterance_index}"
        self.start_ms = start_ms
        self.end_ms = start_ms
        self.next_sequence = 0
        self.revision = 0
        self.online_cache = {}
        self.online_text = ""
        self.samples = array("h")


class FunAsrTwoPassHelper:
    def __init__(self, args):
        import numpy as np
        from funasr import AutoModel

        self.np = np
        common = {"device": args.device, "disable_update": True}
        self.online_model = AutoModel(model=args.online_model, **common)
        self.offline_model = AutoModel(model=args.offline_model, **common)
        self.chunk_size = [int(value.strip()) for value in args.chunk_size.split(",")]
        if len(self.chunk_size) != 3 or any(value < 0 for value in self.chunk_size):
            raise ValueError("--chunk-size must contain three non-negative integers")
        self.encoder_chunk_look_back = args.encoder_chunk_look_back
        self.decoder_chunk_look_back = args.decoder_chunk_look_back
        self.states = {}
        self.utterance_indexes = {}

    def handle_audio(self, request):
        source_id = required_string(request, "sourceId")
        sequence = required_non_negative_int(request, "sequence")
        start_ms = required_non_negative_int(request, "startMs")
        end_ms = required_non_negative_int(request, "endMs")
        if end_ms < start_ms:
            raise ValueError("endMs must be greater than or equal to startMs")
        state = self.states.get(source_id)
        if state is None:
            utterance_index = self.utterance_indexes.get(source_id, 0) + 1
            self.utterance_indexes[source_id] = utterance_index
            state = SourceState(source_id, utterance_index, start_ms)
            self.states[source_id] = state
        if sequence != state.next_sequence:
            raise ValueError(f"unexpected sequence {sequence}; expected {state.next_sequence}")
        state.next_sequence += 1
        samples = decode_pcm16_mono_wav(required_string(request, "audioBase64"))
        state.samples.extend(samples)
        state.end_ms = end_ms
        if samples:
            audio = self.np.asarray(samples, dtype=self.np.float32) / 32768.0
            result = self.online_model.generate(
                input=audio,
                cache=state.online_cache,
                is_final=False,
                chunk_size=self.chunk_size,
                encoder_chunk_look_back=self.encoder_chunk_look_back,
                decoder_chunk_look_back=self.decoder_chunk_look_back,
            )
            next_text = merge_streaming_text(state.online_text, normalize_text(result))
            if next_text and next_text != state.online_text:
                state.online_text = next_text
                state.revision += 1
                self.emit_transcript(request, state, "partial", next_text)
        self.emit_result(request, True)

    def handle_drain(self, request):
        source_id = required_string(request, "sourceId")
        state = self.states.get(source_id)
        if state is None:
            self.emit_result(request, True)
            return
        requested_end_ms = required_non_negative_int(request, "endMs")
        state.end_ms = max(state.end_ms, requested_end_ms)
        if state.samples:
            audio = self.np.asarray(state.samples, dtype=self.np.float32) / 32768.0
            result = self.offline_model.generate(input=audio, batch_size_s=60)
            final_text = normalize_text(result)
        else:
            final_text = ""
        if final_text:
            state.revision += 1
            self.emit_transcript(request, state, "final", final_text)
        elif state.online_text:
            state.revision += 1
            self.emit_transcript(request, state, "clear", "")
        del self.states[source_id]
        self.emit_result(request, True)

    def emit_transcript(self, request, state, transcript_state, text):
        record = self.identity(request)
        record.update({
            "type": "transcript",
            "utteranceId": state.utterance_id,
            "revision": state.revision,
            "state": transcript_state,
        })
        if transcript_state != "clear":
            record.update({"text": text, "startMs": state.start_ms, "endMs": state.end_ms})
        emit(record)

    def emit_result(self, request, ok, error=None):
        record = self.identity(request)
        record.update({"type": "result", "ok": ok})
        if error:
            record["error"] = error
        emit(record)

    @staticmethod
    def identity(request):
        return {
            "requestId": request.get("requestId", ""),
            "sourceId": request.get("sourceId", ""),
            "protocol": PROTOCOL,
            "engineId": ENGINE_ID,
            "language": LANGUAGE,
        }


def required_string(record, key):
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def required_non_negative_int(record, key):
    value = record.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def parse_args():
    parser = argparse.ArgumentParser(description="Resident FunASR Paraformer two-pass candidate helper")
    parser.add_argument("--online-model", required=True)
    parser.add_argument("--offline-model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--chunk-size", default="0,10,5")
    parser.add_argument("--encoder-chunk-look-back", type=int, default=4)
    parser.add_argument("--decoder-chunk-look-back", type=int, default=1)
    return parser.parse_args()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        helper = FunAsrTwoPassHelper(parse_args())
    except Exception as error:
        emit({"type": "startup_error", "ok": False, "error": str(error)})
        return 1
    emit({
        "type": "ready",
        "ok": True,
        "protocol": PROTOCOL,
        "engineId": ENGINE_ID,
        "language": LANGUAGE,
        "sampleRateHz": SAMPLE_RATE_HZ,
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            command = request.get("command")
            if command == "audio":
                helper.handle_audio(request)
            elif command == "drain":
                helper.handle_drain(request)
            elif command == "shutdown":
                helper.emit_result(request, True)
                return 0
            else:
                raise ValueError(f"unsupported command: {command}")
        except Exception as error:
            helper.emit_result(request, False, str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
