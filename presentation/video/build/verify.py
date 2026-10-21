"""Check explainer.mp4: duration, streams, frames at sample times, and that the voice in the
final audio track starts where each subtitle starts."""
import json
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np

BUILD = Path(__file__).parent
VIDEO = BUILD.parent
FF = imageio_ffmpeg.get_ffmpeg_exe()
MP4 = VIDEO / "explainer.mp4"


def main(times):
    info = subprocess.run([FF, "-hide_banner", "-i", str(MP4)], capture_output=True, text=True).stderr
    for line in info.splitlines():
        if re.search(r"Duration|Stream", line):
            print(line.strip())
    out = BUILD / "check"
    out.mkdir(exist_ok=True)
    for t in times:
        subprocess.run([FF, "-y", "-loglevel", "error", "-ss", str(t), "-i", str(MP4), "-frames:v", "1",
                        str(out / f"f{t:07.2f}.png")], check=True)
    raw = subprocess.run([FF, "-loglevel", "error", "-i", str(MP4), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
    print(f"audio: {len(a) / 8000:.2f}s decoded, peak {np.abs(a).max():.2f}")
    hop = 80  # 10 ms
    n = len(a) // hop
    rms = np.sqrt((a[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    tl = json.loads((BUILD / "timeline.json").read_text(encoding="utf-8"))
    offsets = []
    for c in tl["cues"]:
        i0 = int(c["start"] * 100)
        window = rms[max(0, i0 - 50): i0 + 50]
        loud = np.where(window > 0.02)[0]
        if len(loud):
            offsets.append((loud[0] - min(50, i0)) / 100)
    offsets = np.array(offsets)
    print(f"voice onset vs subtitle start over {len(offsets)} cues: "
          f"median {np.median(offsets) * 1000:+.0f} ms, worst {offsets[np.abs(offsets).argmax()] * 1000:+.0f} ms")


if __name__ == "__main__":
    main([float(x) for x in sys.argv[1:]] or [2.0, 12.0, 40.5, 52.0, 70.8, 89.0, 120.5, 149.5, 176.0])
