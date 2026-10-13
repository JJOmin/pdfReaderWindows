"""XTTS-v2 speech helper. Started by the app's main process, never by hand.

usage: python -I -X utf8 xtts_helper.py <model dir>

Protocol: one JSON object per line. Nothing else may reach standard output, so the libraries'
own prints are sent to standard error instead.

  helper -> app   {"ready": true, "rate": 24000, "speakers": [...]}        once, after loading
  app -> helper   {"id": 7, "text": "...", "lang": "de", "speaker": "...", "speed": 1.0, "out": "x.wav"}
  helper -> app   {"id": 7, "ok": true, "seconds": 3.2, "rate": 24000}
                  {"id": 7, "ok": false, "error": "..."}

The audio goes to the file named by "out", so the pipe carries no audio. The helper exits when
standard input closes, which is also what happens when the app dies.
"""

import json
import os
import sys


def main() -> int:
    protocol = sys.stdout
    sys.stdout = sys.stderr
    # utf-8-sig: harmless for the app, and a hand-typed test through a Windows pipe adds a BOM.
    sys.stdin.reconfigure(encoding="utf-8-sig")

    def send(message: dict) -> None:
        protocol.write(json.dumps(message) + "\n")
        protocol.flush()

    import soundfile
    import torch
    from TTS.api import TTS

    if not torch.cuda.is_available():
        send({"ready": False, "error": "No CUDA GPU is available to PyTorch"})
        return 1

    model_dir = sys.argv[1]
    tts = TTS(model_path=model_dir, config_path=os.path.join(model_dir, "config.json")).to("cuda")
    model = tts.synthesizer.tts_model
    # The decoder's own rate. synthesizer.output_sample_rate reports the training rate (22050),
    # which would make every clip play about 8 % slow and low.
    rate = int(model.config.audio.output_sample_rate)
    send({"ready": True, "rate": rate, "speakers": sorted(model.speaker_manager.name_to_id)})

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            wav = tts.tts(
                text=request["text"],
                speaker=request["speaker"],
                language=request["lang"],
                speed=float(request.get("speed", 1.0)),
            )
            out = request["out"]
            # Written whole, then renamed: a half-written file must never look like a finished one.
            part = out + ".part"
            soundfile.write(part, wav, rate, subtype="PCM_16", format="WAV")
            os.replace(part, out)
            send({"id": request_id, "ok": True, "seconds": len(wav) / rate, "rate": rate})
        except Exception as error:  # noqa: BLE001 - one bad request must not end the helper
            send({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
