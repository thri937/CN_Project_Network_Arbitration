# Explainer video — narration script

Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices: the real-network testbed, explained for complete beginners.

- **Length:** 3:09.4 · **Spoken words:** 495
- **Voice:** Microsoft Zira (offline Windows voice), rate +2
- **Subtitles:** each line below is one on-screen subtitle (also in `explainer.srt`)
- Numbers are spoken in words (e.g. “nine hundred and fifty”) and shown as digits in the subtitles.
- On-screen questions pause for the viewer: “Who would YOU slow down?” (3-2-1 countdown) and “Which slices should give it up?”

## Hook — one shared link  (0:01.0–0:09.8)

- `0:01.0` One link. A whole company shares it.
- `0:03.6` Lunch hour. Everyone wants it at once.
- `0:06.4` Something has to slow down.
- `0:08.2` So… who would YOU slow down?

## The problem  (0:13.8–0:44.9)

- `0:13.8` Network slicing splits one network into reserved virtual lanes, called slices.
- `0:18.1` We built a real testbed: 7 departments, 7 slices, one 1-megabit link.
- `0:23.5` 950 kilobits are usable, but 1,480 were promised.
- `0:28.0` That's normal, like a gym selling more memberships than machines.
- `0:31.6` Normal networks decide with technical labels, set at install time.
- `0:35.2` The canteen screens are tagged URLLC, premium. The regulated quality lab, eMBB, standard.
- `0:42.1` So the network slows the lab… and protects the lunch menu.

## The idea — business questions  (0:45.8–1:02.9)

- `0:45.8` Our software ignores labels and asks business questions.
- `0:48.7` How critical is it? What does a minute of outage cost?
- `0:51.9` Factory line: £8,400. Canteen screens: £15.
- `0:57.2` Safety rules? Customer impact? How long can it cope? Was it slowed recently?

## The 7-step loop, every 2 seconds  (1:03.8–1:52.2)

- `1:03.8` Then a 7-step loop runs every 2 seconds.
- `1:06.4` 1. Measure real traffic, delay and lost data at the gateway.
- `1:10.5` 2. Detect: demand over 102% of the link, twice in a row.
- `1:15.5` One spike can't fool it.
- `1:17.0` 3. Score: each slice gets a business score, 0 to 100.
- `1:21.7` 4. Decide. Many small cuts beat one big cut. Harm grows faster than the cut.
- `1:27.6` One slice cut 60%: harm 0.36. Six slices cut 10%: just 0.06.
- `1:35.5` Life-safety slices are never touched. No slice drops below its minimum.
- `1:39.8` 5. Apply the new speed limits on the gateway.
- `1:43.0` 6. Restore bandwidth after each recovery window.
- `1:46.6` 7. Record a permanent explanation. Nobody can edit or delete it, not even an admin.

## A real decision on the live link  (1:53.1–2:19.8)

- `1:53.1` In the lunch-hour rush, demand hit 1,316 kilobits, with 950 usable.
- `1:59.0` With a safety margin, it had to free 251.5 kilobits.
- `2:03.3` Remember our question? The canteen screens took an 80% cut.
- `2:07.3` Office Wi-Fi lost 32%, the warehouse 24%, CCTV 12%. Patient monitoring: never cut.
- `2:14.4` Factory and lab: untouched. The gateway enforced it 4 seconds later, with no button pressed.

## What's new, and what we measured  (2:20.7–2:41.3)

- `2:20.7` What's new? Not slicing, not the sharing maths, but the combination.
- `2:25.3` Business value, not labels. Small cuts, not one deep cut.
- `2:29.8` Safety as a hard rule, not a weight.
- `2:32.2` And it is proved on real traffic, every 2 seconds recorded.
- `2:35.4` With arbitration off, the clinic waited half a second. On: 23 milliseconds, no loss.

## Today, the future, and the close  (2:42.2–3:06.7)

- `2:42.2` Today the link is real but small: 1 megabit, shaped in our own software.
- `2:46.3` Real traffic, measured delay, phones on a hotspot, and the full engine. 460 tests pass.
- `2:53.1` Next: seven phones measured, kernel shaping,
- `2:56.1` a real 5G core, and radio slicing.
- `2:59.2` When the link is full, it slows down what matters least to the business,
- `3:02.6` in small, fair, safe steps. And it explains every decision.

## How to rebuild

Everything is generated from `build/script_data.py`:

```bash
python presentation/video/build/build_ssml.py
```

```bash
powershell -ExecutionPolicy Bypass -File presentation/video/build/tts.ps1
```

```bash
python presentation/video/build/timeline.py
```

```bash
python presentation/video/build/render.py --video
```
