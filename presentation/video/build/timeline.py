"""Lay the synthesised segments out on one timeline.

Reads build/segments.json, build/tts/*.wav and build/tts/words.json; writes
video/narration.wav (16 kHz mono) and build/timeline.json with every cue's
start/end, every [[mark]] time and every scene's span.
"""
import difflib
import json
import re
import sys
import wave
from pathlib import Path

import numpy as np

BUILD = Path(__file__).parent
VIDEO = BUILD.parent
sys.path.insert(0, str(BUILD))
from script_data import SCENES  # noqa: E402

SR = 16000
INTRO = 1.0          # silence before the first word (title animates in)
BASE_GAP = 0.22      # silence between cues, on top of each cue's own pause
MARK = re.compile(r"\[\[(\w+)\]\]")


def norm(tok):
    return re.sub(r"[^a-z0-9]", "", tok.lower())


def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def speech_bounds(a):
    """First/last sample of audible speech (10 ms RMS above ~-42 dBFS), with a small margin."""
    hop = SR // 100
    n = len(a) // hop
    rms = np.sqrt((a[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    loud = np.where(rms > 0.008)[0]
    s = max(0, (loud[0] - 3) * hop)
    e = min(len(a), (loud[-1] + 5) * hop)
    return s, e


def tokens_with_marks(cues):
    """Spoken word tokens for a segment, plus {name: token index} for cue starts and marks."""
    toks, marks = [], {}
    for cue in cues:
        marks[cue["id"]] = len(toks)
        say = cue.get("say", cue["show"])
        for part in MARK.sub(lambda m: f" [[{m.group(1)}]] ", say).split():
            m = MARK.fullmatch(part)
            if m:
                marks[m.group(1)] = len(toks)
            else:
                toks.append(part)
    return toks, marks


def align(mine, engine):
    """Map each of my token indices to an engine word index (nearest following match)."""
    sm = difflib.SequenceMatcher(a=[norm(t) for t in mine], b=[norm(w["text"]) for w in engine], autojunk=False)
    exact = {}
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            exact[blk.a + k] = blk.b + k
    mapping = {}
    for i in range(len(mine)):
        j = next((exact[k] for k in range(i, len(mine)) if k in exact), len(engine) - 1)
        mapping[i] = j
    return mapping, len(exact) / max(1, len(mine))


def main():
    segments = json.loads((BUILD / "segments.json").read_text(encoding="utf-8"))
    words = json.loads((BUILD / "tts" / "words.json").read_text(encoding="utf-8"))
    cue_by_id, scene_of = {}, {}
    for scene in SCENES:
        for cue in scene["cues"]:
            cue_by_id[cue["id"]] = cue
            scene_of[cue["id"]] = scene["id"]

    out = [np.zeros(int(INTRO * SR), dtype=np.float32)]
    t = INTRO
    cues_out, marks_out = [], {}
    for seg in segments:
        cues = [cue_by_id[c] for c in seg["cues"]]
        audio = read_wav(BUILD / "tts" / f"{seg['id']}.wav")
        s, e = speech_bounds(audio)
        lead = s / SR
        speech = audio[s:e]
        eng = words[seg["id"]]
        toks, mk = tokens_with_marks(cues)
        mapping, quality = align(toks, eng)
        if quality < 0.8:
            print(f"warning: weak word alignment in {seg['id']} ({quality:.0%})")

        def at(tok_index):
            if tok_index >= len(toks):
                return t + len(speech) / SR
            return t + max(0.0, eng[mapping[tok_index]]["t"] - lead)

        starts = [t if i == 0 else at(mk[c["id"]]) for i, c in enumerate(cues)]
        seg_end = t + len(speech) / SR
        for i, c in enumerate(cues):
            end = starts[i + 1] - 0.05 if i + 1 < len(cues) else seg_end
            cues_out.append({"id": c["id"], "scene": scene_of[c["id"]], "show": c["show"],
                             "start": round(starts[i], 3), "end": round(end, 3)})
        for name, idx in mk.items():
            if name not in cue_by_id:
                marks_out[name] = round(at(idx), 3)
        out.append(speech)
        gap = BASE_GAP + cues[-1].get("pause", 0) / 1000
        out.append(np.zeros(int(gap * SR), dtype=np.float32))
        t = seg_end + gap

    for c in cues_out:
        marks_out[c["id"]] = c["start"]
        marks_out[c["id"] + "_end"] = c["end"]
    audio = np.concatenate(out)
    duration = len(audio) / SR

    scenes_out = {}
    for scene in SCENES:
        first = next(c for c in cues_out if c["scene"] == scene["id"])
        scenes_out[scene["id"]] = {"start": round(max(0.0, first["start"] - 0.5), 3)}
    ids = [s["id"] for s in SCENES]
    scenes_out[ids[0]]["start"] = 0.0
    for a, b in zip(ids, ids[1:]):
        scenes_out[a]["end"] = scenes_out[b]["start"]
    scenes_out[ids[-1]]["end"] = round(duration, 3)

    with wave.open(str(VIDEO / "narration.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    (BUILD / "timeline.json").write_text(json.dumps(
        {"duration": round(duration, 3), "cues": cues_out, "marks": marks_out, "scenes": scenes_out},
        indent=1), encoding="utf-8")
    print(f"duration {duration:.2f}s ({int(duration // 60)}:{duration % 60:05.2f})")
    for sid, sc in scenes_out.items():
        print(f"  {sid:9s} {sc['start']:7.2f} - {sc['end']:7.2f}  ({sc['end'] - sc['start']:.1f}s)")


if __name__ == "__main__":
    main()
