"""Turn script_data.SCENES into TTS segments (one per subtitle cue, or a few cues joined
when a sentence runs across them) and print the spoken word count.

Writes build/segments.json: [{id, cues: [cue ids], ssml}].
"""
import json
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).parent))
from script_data import SCENES  # noqa: E402

BUILD = Path(__file__).parent
MARK = re.compile(r"\[\[(\w+)\]\]")


def spoken(cue):
    return MARK.sub("", cue.get("say", cue["show"])).strip()


def all_cues():
    for scene in SCENES:
        for cue in scene["cues"]:
            yield scene, cue


def segments():
    """Group cues: a cue whose spoken text ends mid-sentence (comma) joins the next one."""
    segs, cur = [], []
    for _, cue in all_cues():
        cur.append(cue)
        if not spoken(cue).endswith(","):
            segs.append(cur)
            cur = []
    if cur:
        segs.append(cur)
    return segs


def main():
    out, words = [], 0
    for group in segments():
        text = " ".join(spoken(c) for c in group)
        words += len(text.split())
        ssml = ('<?xml version="1.0"?><speak version="1.0" '
                'xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
                f"{escape(text)}</speak>")
        out.append({"id": group[0]["id"], "cues": [c["id"] for c in group], "ssml": ssml})
    (BUILD / "segments.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"segments: {len(out)}, spoken words: {words}")


if __name__ == "__main__":
    main()
