# Contributing

Thanks for wanting to build on this. A few things keep the project coherent:

## Ground rules (the product premise)

1. **Local-first is non-negotiable.** No telemetry, no accounts, no server component. Only digest-derived *text* may ever cross the network, only to a user-configured endpoint, and the outbound-review gate must show it first. PRs that widen egress will be declined.
2. **The agent edits a document, never pixels.** All mutations go through the op DSL → validator → EDL. Rendering happens once, at export. Don't add code paths that mutate media mid-loop.
3. **The validator contract is sacred.** Unknown id / malformed op → reject with zero EDL change. New ops must add validation + tests before UI.

## Dev setup

```bash
npm install
npm run doctor        # system check (ffmpeg, whisper, etc.)
npm test              # engine test suite — must stay green
npm run repl          # drive the engine in a terminal, no GUI
npm run start --workspace @pve/desktop   # the app
```

The engine (`@pve/core`) has no native dependencies — most logic changes can be developed and tested with `npm test` alone. `@pve/import` wraps ffmpeg/whisper/Ollama; `@pve/desktop` is the Electron shell.

## Making changes

- **Engine first**: new capabilities usually mean a new op or session method in `core`, with tests, then IPC + UI.
- **Tests**: `packages/core/test/` uses vitest against a synthetic fixture — no media files needed. Add cases for both the happy path and the rejection path.
- **Model changes**: if you touch prompts or backends, run the benchmark pattern in the repo history (easy suite + hard suite against a real long-video digest) and include numbers in your PR description. Claims about model quality need measurements.
- **No committed binaries**: media, models, and caches are git-ignored. Keep it that way; `scripts/make-sample.sh` regenerates the test clip.

## Good first areas

- Streaming chat responses (renderer + backends)
- faster-whisper / whisper.cpp alternatives behind the `Importer` interface
- New ops (retake removal, reorder-by-topic) — spec them against the validator first
- The distillation pipeline: teacher-data generation + eval harness (see README roadmap)

## Reporting issues

Include: OS, `npm run doctor` output, the instruction you typed, what happened vs what you expected, and (if relevant) the digest size (segment count). Never include your video content — that's the point of the tool.
