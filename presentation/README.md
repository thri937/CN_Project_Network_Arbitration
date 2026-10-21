# Presentation: slides and explainer video

These are for **this** project, the real-network testbed. The simulated platform has its own
deck and video in its own repository; the two are presented separately.

| What | Where |
|---|---|
| **Slide deck** (39 slides, with speaker notes) | Online: <https://claude.ai/artifact/YRVRR2ERkQstcceqN596Ye>. The source is in `deck/` (`deck.json` + one HTML file per slide) |
| **PowerPoint copy** | `Real-Network-Testbed-Slides.pptx` in this folder: every slide as a picture, with the speaker notes. For an editable PowerPoint, open the online deck and use Share → Export |
| **Explainer video** (about 3 minutes, narrated, with subtitles) | `video/explainer.mp4`, subtitles in `video/explainer.srt`, the script with timings in `video/script.md` |

The deck link is private to the account that made it. To show it to others, open it and use
**Share** (it can also be exported as PowerPoint or PDF from there).

## The deck, section by section

| Section | Slides | What it covers |
|---|---|---|
| Background | cover → problem | Network slicing, the seven departments, SLAs, 1,480 kbps promised on a 950 kbps link |
| The problem | problem → think-who → labels | The problem statement, a question for the audience, why labels fail (Canteen URLLC, Lab eMBB) |
| Our solution | questions → explains | Business questions, the 7-step loop, detection, scores, CBHA, the hard rules, the TC3 decision |
| The testbed | architecture → security | Four programs, tech stack and why, the gateway's data path, the southbound API, apply/recover, the two web apps |
| Measured | novelty → fair-share | Arbitration off vs on (Clinic 503 → 23 ms), every slice, and why fair queueing alone is not enough |
| Demo | demo-run → test-auto | Commands, the four-step live demo with phones, 460 automated tests + 6 live test cases |
| Limits and next | today → close | What is real and what is scaled down, honest limits, next steps |

Every number on the slides comes from `paper/results/` (the measured runs) or from the seeded
testbed catalogue.

## The video

The video uses the same pipeline as the first project's explainer, with this project's
narration and numbers: an offline Windows voice (Microsoft Zira), frames drawn in Python, and
subtitles that follow the voice word by word.

Rebuild it from the repository root (needs Windows, Python 3 with `numpy`, `Pillow` and
`imageio-ffmpeg`):

```bash
py presentation/video/build/build_ssml.py
```
```bash
powershell -ExecutionPolicy Bypass -File presentation/video/build/tts.ps1
```
```bash
py presentation/video/build/timeline.py
```
```bash
py presentation/video/build/render.py --video
```

The narration is in `video/build/script_data.py`: edit it there, then run all four steps again.
