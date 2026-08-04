# Prompt Video Editor

**Local-first, prompt-driven video editing. Your footage never leaves your machine.**

Turn a 30-minute raw recording into a labeled, speed-ramped edit by *talking to it* —
"key parts 1×, everything else 10× with labels", then "actually 6×", then "keep
anything with the drill at 1×". Everything expensive (transcription, analysis,
retiming, rendering) runs locally and is free. The only thing that can ever cross
the network is a small text digest — and you see it before it sends.

> Status: **early**. The deterministic editing engine (`@pve/core`) is built and
> tested and runs the flagship loop end-to-end today in heuristic mode. The native
> import pipeline (whisper/ffmpeg) and desktop shell are next. See [Milestones](#milestones).

## The core idea

The agent edits a **document about the video** — an EDL (edit decision list), a
list of `{start, end, speed, label}` blocks. The machine renders that document
**exactly once**, at export. The agent never touches pixels, never runs mid-loop,
and a bad model response can at worst be *rejected* — it can't corrupt footage or
half-apply an edit.

```
you type → agent proposes ops → validated → patch applied to EDL → you tweak → repeat
                                                                                    ↓
                                                                        single export render
```

**The LLM is the smallest, most replaceable part of the system.** It does judgment
only — *which* segments matter, *what* the labels say, parsing your instruction. It
returns candidate **IDs, never timestamps**; an unknown ID is rejected on sight.

| Job | Where | Cost |
|---|---|---|
| Decode · transcribe (Whisper) · analyze · segment · retime · label · **render** | **Local** | $0 |
| Decide which segments / write labels / parse the instruction | LLM (BYO key **or** local Ollama **or** no-LLM heuristic) | ~$0.01–0.05/session, or $0 |

Three interchangeable intelligence backends, selectable in settings:
- **Remote** (BYO OpenAI-compatible / Gemini key; key in OS keychain; direct to provider — no server of ours)
- **Ollama** (local endpoint, $0, loopback only)
- **Heuristic** (no LLM at all — every op still reachable; reduced intelligence, not reduced function)

## System requirements (enforced)

The app runs a **mandatory preflight** and refuses to start if a required native
dependency is missing — no half-working state, no failing three steps into a
render. Requirement definitions live in `@pve/core` (`preflight.ts`) so every
entry point — CLI today, desktop shell later — shares one source of truth.

```bash
npm run doctor    # report readiness; exit 0 = ready, 1 = something required is missing
```

| Requirement | Required | For |
|---|---|---|
| Node.js ≥ 20 | yes | runtime |
| ffmpeg / ffprobe | yes | decode, retime, label burn, export encode; container scan |
| whisper.cpp + model | yes | local word-level transcription |
| hardware encoder (VideoToolbox/NVENC/QSV) | no | fast export (falls back to libx264) |

The editor (and the REPL) will not launch until `doctor` is green. For
engine-only development against the synthetic sample, set `PVE_DEV_SYNTHETIC=1`
to run in an explicit, clearly-labeled degraded mode.

## Try it now (no media, no keys, no ffmpeg)

```bash
npm install
npm run demo      # drives the full interactive loop in heuristic mode
npm test          # engine test suite
```

The demo builds a synthetic 2-minute "build log", prints the digest (the only
thing that would cross the wire), then runs four instructions in sequence —
classify+retime+label, "actually 6×", "keep the drill at 1×", and inserting a
title card — showing the EDL after each, an undo, and the generated ffmpeg render
plan.

## Edit a REAL video (M1 pipeline)

Once the system check is green (`npm run doctor`), you can import an actual
recording, edit it by prompt, and render an output file:

```bash
bash scripts/make-sample.sh                          # optional: a reproducible test clip
npx tsx packages/cli/src/repl.ts samples/buildlog.mp4
```

Then type instructions and `:export`:

```
▸ key parts 1x, rest 8x, label the fast parts
▸ :export                     # renders samples/buildlog.edit.mp4 (single ffmpeg encode)
▸ :quit
```

The import pass (`@pve/import`) runs a container scan (ffprobe → activity curve +
scene cuts, no decode) and local whisper.cpp transcription, caches the result by
file hash (re-import is instant), and hands the engine a real `Analysis`. Object
detection / VLM captions (the sparse visual pass) are P1 — the engine runs fine
without them, you just don't get object-based rules yet.

**One-time setup** (macOS):

```bash
brew install ffmpeg whisper-cpp
mkdir -p models && curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

> Label burn needs an ffmpeg built with libfreetype (`drawtext`). If yours lacks
> it, `doctor` flags it and export degrades gracefully — it renders the
> speed-ramped cut without burned labels; labels still appear in the EDL and
> chapter export.

## Repository layout

```
packages/
  core/      @pve/core — the deterministic engine (no native deps, fully tested)
    src/
      types.ts        data model: Analysis, Atom, Candidate, Digest, EDL, Op
      segment.ts      atoms (cut points) → candidates (agent's unit)
      digest.ts       the ONLY artifact permitted to cross the network
      edl.ts          initial EDL + duration math
      validate.ts     the hard contract: unknown id / malformed op → reject
      apply.ts        apply validated ops to the EDL, respecting pinning
      postprocess.ts  flip tiny islands, snap cuts to atom boundaries
      history.ts      one undo/redo stack across prompts AND manual edits
      session.ts      the interactive loop: plan → validate → apply → commit
      render.ts       single-encode ffmpeg plan + chapter/description export
      preflight.ts    mandatory system-check definitions + evaluation
      import.ts       interface where whisper/ffmpeg plug in
      intelligence/   Backend interface + heuristic / remote / ollama
      tools/read.ts   read-only query tools the agent uses (lazy digest)
  import/    @pve/import — M1 native pass: ffprobe scan + whisper.cpp + ffmpeg render
    src/
      scan.ts         ffprobe container scan → activity curve + scene cuts
      transcribe.ts   16 kHz extract → whisper.cpp → word-level transcript
      render-exec.ts  run the single ffmpeg encode (drawtext-aware degradation)
      index.ts        FfmpegImporter + file-hash Analysis cache
  cli/       @pve/cli — demo, interactive REPL, and the `doctor` system check
```

## Guarantees the engine enforces

- **No cut lands off an atom boundary** — atoms only break at silences, sentence
  ends, and scene cuts, so you never cut mid-word.
- **Unknown ID or malformed op ⇒ visible error, zero change to the EDL.**
- **Manual edits are pinned** — a hand-adjusted segment is untouched by later
  prompts unless the instruction *explicitly names* it.
- **One Ctrl-Z reverts a whole prompt turn**, on the same stack as manual edits.
- **Nothing renders until export**, and merging/optimization is a render-time
  concern — the EDL always keeps one targetable entry per candidate.

## Privacy

No telemetry, no account, no server component. The default build makes **zero
network calls** until you configure a remote backend. Only the digest + your
prompt may cross; never video, frames, audio, thumbnails, or file paths. The
outbound-review pane (shows the exact outgoing text, with send/cancel) is a P0
feature, not polish.

## Milestones

- **M1** — import pass + transcript view + silence-cut + manual EDL + render. *No
  LLM anywhere; already a usable manual editor.*
- **M2** — digest + backends + command bar + classify/retime/overlay/insert. The
  flagship prompt works end to end. **← the engine for this is built.**
- **M3** — P1 ops (retake removal, reorder-by-topic, vertical reframe), polish,
  packaging, open-source release.

## License

MIT (code). FFmpeg build-flag/licensing decision (LGPL vs GPL) is tracked as an
open question before the first binary release.
