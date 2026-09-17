import argparse
import base64
import io
import json
import sys
import wave

from vosk import KaldiRecognizer, Model, SetLogLevel


PROTOCOL = "local-asr-jsonl-v2"
LANGUAGE = "zh"

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def emit(record: dict) -> None:
    sys.stdout.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def transcript_record(options, request, state, status, text=None):
    state["revision"] += 1
    record = {
        "type": "transcript",
        "protocol": PROTOCOL,
        "engineId": options.engine_id,
        "language": LANGUAGE,
        "requestId": request["requestId"],
        "sourceId": request["sourceId"],
        "utteranceId": f'{request["sourceId"]}:{state["utterance"]}',
        "revision": state["revision"],
        "state": status,
    }
    if status != "clear":
        record.update({
            "text": text,
            "startMs": state["start_ms"],
            "endMs": request["endMs"],
        })
    return record


def result_record(options, request, ok=True, error=None):
    record = {
        "type": "result",
        "protocol": PROTOCOL,
        "engineId": options.engine_id,
        "language": LANGUAGE,
        "requestId": request.get("requestId", ""),
        "sourceId": request.get("sourceId", ""),
        "ok": ok,
    }
    if error:
        record["error"] = error
    return record


def pcm_from_wav(audio_base64, sample_rate):
    with wave.open(io.BytesIO(base64.b64decode(audio_base64)), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != sample_rate:
            raise ValueError("audio must be mono PCM16 WAV at the configured sample rate")
        return audio.readframes(audio.getnframes())


def create_source(model, sample_rate, sequence):
    return {
        "recognizer": KaldiRecognizer(model, sample_rate),
        "sequence": sequence,
        "utterance": 1,
        "revision": 0,
        "start_ms": None,
        "partial": "",
    }


def handle_audio(options, model, sources, request):
    source_id = request["sourceId"]
    sequence = request["sequence"]
    state = sources.get(source_id)
    if state is None:
        state = create_source(model, options.sample_rate_hz, sequence)
        sources[source_id] = state
    if sequence != state["sequence"]:
        raise ValueError("audio sequence is not contiguous")
    state["sequence"] += 1
    if state["start_ms"] is None:
        state["start_ms"] = request["startMs"]
    pcm = pcm_from_wav(request["audioBase64"], options.sample_rate_hz)
    if state["recognizer"].AcceptWaveform(pcm):
        text = json.loads(state["recognizer"].Result()).get("text", "").strip()
        if text:
            emit(transcript_record(options, request, state, "final", text))
        elif state["partial"]:
            emit(transcript_record(options, request, state, "clear"))
        state.update({"utterance": state["utterance"] + 1, "revision": 0, "start_ms": None, "partial": ""})
    else:
        text = json.loads(state["recognizer"].PartialResult()).get("partial", "").strip()
        if text and text != state["partial"]:
            state["partial"] = text
            emit(transcript_record(options, request, state, "partial", text))
    emit(result_record(options, request))


def handle_drain(options, sources, request):
    state = sources.pop(request["sourceId"], None)
    if state is not None:
        text = json.loads(state["recognizer"].FinalResult()).get("text", "").strip()
        if text:
            emit(transcript_record(options, request, state, "final", text))
        elif state["partial"]:
            emit(transcript_record(options, request, state, "clear"))
    emit(result_record(options, request))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--engine-id", required=True)
    parser.add_argument("--sample-rate-hz", type=int, default=16000)
    options = parser.parse_args()
    SetLogLevel(-1)
    model = Model(options.model)
    sources = {}
    emit({
        "type": "ready",
        "ok": True,
        "protocol": PROTOCOL,
        "engineId": options.engine_id,
        "language": LANGUAGE,
        "sampleRateHz": options.sample_rate_hz,
    })
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("command") == "audio":
                handle_audio(options, model, sources, request)
            elif request.get("command") == "drain":
                handle_drain(options, sources, request)
            elif request.get("command") == "shutdown":
                emit(result_record(options, request))
                return
            else:
                raise ValueError("unsupported command")
        except Exception as error:
            emit(result_record(options, request, False, str(error)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "startup_error", "protocol": PROTOCOL, "error": str(error)})
        raise
