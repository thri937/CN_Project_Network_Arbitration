"""Write video/script.md: the narration script with the timing of every line."""
import json
import re
import sys
from pathlib import Path

BUILD = Path(__file__).parent
sys.path.insert(0, str(BUILD))
from script_data import SCENES  # noqa: E402

BEATS = {"hook": "Hook — one shared link", "problem": "The problem", "solution": "The idea — business questions",
         "loop": "The 7-step loop, every 2 seconds", "decision": "A real decision on the live link",
         "new": "What's new, and what we measured", "future": "Today, the future, and the close"}


def ts(x):
    return f"{int(x // 60)}:{x % 60:04.1f}"


def main():
    tl = json.loads((BUILD / "timeline.json").read_text(encoding="utf-8"))
    cues = {c["id"]: c for c in tl["cues"]}
    words = sum(len(re.sub(r"\[\[\w+\]\]", "", c.get("say", c["show"])).split()) for s in SCENES for c in s["cues"])
    out = ["# Explainer video — narration script", "",
           "Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices: the real-network testbed, explained for complete beginners.",
           "",
           f"- **Length:** {ts(tl['duration'])} · **Spoken words:** {words}",
           "- **Voice:** Microsoft Zira (offline Windows voice), rate +2",
           "- **Subtitles:** each line below is one on-screen subtitle (also in `explainer.srt`)",
           "- Numbers are spoken in words (e.g. “nine hundred and fifty”) and shown as digits in the subtitles.",
           "- On-screen questions pause for the viewer: “Who would YOU slow down?” (3-2-1 countdown) and "
           "“Which slices should give it up?”",
           ""]
    for scene in SCENES:
        first, last = cues[scene["cues"][0]["id"]], cues[scene["cues"][-1]["id"]]
        out += [f"## {BEATS[scene['id']]}  ({ts(first['start'])}–{ts(last['end'])})", ""]
        for c in scene["cues"]:
            out.append(f"- `{ts(cues[c['id']]['start'])}` {c['show']}")
        out.append("")
    out += ["## How to rebuild", "",
            "Everything is generated from `build/script_data.py`:", "",
            "```bash", "python presentation/video/build/build_ssml.py", "```", "",
            "```bash", "powershell -ExecutionPolicy Bypass -File presentation/video/build/tts.ps1", "```", "",
            "```bash", "python presentation/video/build/timeline.py", "```", "",
            "```bash", "python presentation/video/build/render.py --video", "```", ""]
    (BUILD.parent / "script.md").write_text("\n".join(out), encoding="utf-8")


if __name__ == "__main__":
    main()
