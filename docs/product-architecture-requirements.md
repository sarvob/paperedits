# PaperEdits — Product & Architecture Requirements

**Status:** Draft v0.1  
**Purpose:** Engineering source of truth and implementation tracking  
**Priority:** P0 = first usable product, P1 = next major capability, P2 = later/platform

## 1. Product purpose

**Build an AI-native general-purpose video editor that understands what is happening and being said in a video, then turns natural-language intent into precise, reversible edits — locally for privacy or in the cloud for speed and quality.**

Core primitive:

> Natural-language intent → identify relevant moments → reason about them → apply deterministic timeline operations.

Example:

> “Find the boring parts, speed them up 10x, put a 5–7 word description over them, and keep everything else at normal speed.”

The AI determines **what should be edited**. The editing engine determines **how the edit is executed**.

---

## 2. Product principles

| ID | Principle |
|---|---|
| PP-01 | Local and cloud are execution modes of the same product, not separate products. |
| PP-02 | The project format must never depend on a specific AI model. |
| PP-03 | Source media is immutable; all editing is non-destructive. |
| PP-04 | AI operates through typed editing tools, never arbitrary shell/FFmpeg generation. |
| PP-05 | Chat and manual timeline editing operate on the same project state. |
| PP-06 | Basic analysis happens progressively; expensive reasoning happens primarily when needed. |
| PP-07 | Every AI edit is inspectable, reversible, and manually adjustable. |
| PP-08 | Local mode must function without sending user media or metadata over the network. |
| PP-09 | Hosted mode optimizes for zero setup, speed, stronger models, collaboration, and managed compute. |
| PP-10 | Models are replaceable capability providers, not product architecture. |

---

## 3. Representative use cases

The same architecture must support these without separate hard-coded products:

- Podcast: “Remove obvious retakes and long dead air.”
- Podcast: “I explain the same idea three times. Keep the strongest explanation.”
- Tutorial: “Speed up every section where I’m waiting for the build.”
- Tutorial: “Whenever I type a terminal command, put it on screen.”
- Vlog: “Create a 90-second version showing the journey from the hotel to the summit.”
- Sports: “Create highlights whenever the crowd becomes excited.”
- Aviation: “Keep the plane flying left at 1x. Make the plane flying right 5x.”
- Product demo: “Make a 60-second version containing only the customer problem and actual demo.”
- Search: “Find every time Sarah raises her hand.”
- Search: “When does the laptop first show the error message?”

These are evaluation cases for the underlying platform, not individually hard-coded features.

---

## 4. Core product requirements

### 4.1 Media and project foundation

| ID | Pri | Requirement | Acceptance criteria |
|---|---:|---|---|
| MED-001 | P0 | Import common video/audio formats | MP4/MOV + H.264/H.265/AAC supported on reference platforms |
| MED-002 | P0 | Source media remains immutable | No editing operation modifies original bytes |
| MED-003 | P0 | Generate proxies/thumbnails as needed | Editing remains responsive with supported 4K source media |
| MED-004 | P1 | Multiple source files per project | User can combine multiple clips/audio assets |
| PROJ-001 | P0 | Portable project format | Same project opens locally or hosted without changing edit representation |
| PROJ-002 | P0 | Autosave | Project state survives crash/restart |
| PROJ-003 | P1 | Project version history | User can restore previous project versions |

### 4.2 Semantic video understanding

The core intelligence layer is the **Semantic Timeline**: timestamped observations about speech, scenes, objects, actions, OCR, audio, motion, and model-derived events.

Example conceptual record:

```json
{
  "start": 321.2,
  "end": 334.7,
  "speech": "Let me show you how this works",
  "speaker": "speaker_1",
  "visual_entities": ["person", "laptop", "dashboard"],
  "actions": ["person points at laptop"],
  "ocr": ["Analytics Dashboard"],
  "audio": {"speech": true, "music": false, "energy": 0.63},
  "motion_score": 0.31
}
```

Not every field must be populated during ingestion. Information is added progressively as user requests require deeper analysis.

| ID | Pri | Requirement | Acceptance criteria |
|---|---:|---|---|
| SEM-001 | P0 | Timestamped transcription | Word/sentence timestamps available for supported speech |
| SEM-002 | P0 | Speech/non-speech detection | Long silence and speech boundaries queryable |
| SEM-003 | P0 | Scene/shot boundaries | Major visual transitions indexed |
| SEM-004 | P0 | Keyframe generation | Representative frames available for semantic retrieval |
| SEM-005 | P0 | Visual embeddings | Text query can retrieve visually relevant moments |
| SEM-006 | P1 | OCR | Visible text searchable by timestamp |
| SEM-007 | P1 | Speaker segmentation | Different speakers represented independently |
| SEM-008 | P1 | Motion representation | Low/high motion and movement can be queried |
| SEM-009 | P1 | Object/action localization | Common objects/actions localized to video regions |
| SEM-010 | P0 | Deep clip reasoning | Selected temporal clips can be passed to a VLM |
| SEM-011 | P0 | Cross-modal reasoning | Agent can combine transcript, visuals, audio, and temporal context |
| SEM-012 | P0 | Semantic search API | Arbitrary natural-language queries return ranked timestamp ranges |
| SEM-013 | P0 | Query-driven analysis | Expensive models invoked only on candidate segments when possible |
| SEM-014 | P1 | Confidence/provenance | Semantic observations contain confidence and source/provider metadata |

### 4.3 Editing engine

AI never directly manipulates media. AI creates validated editing operations.

Initial tool surface:

```text
find_segments()
inspect_segment()
cut()
trim()
move()
set_speed()
freeze_frame()
mute()
set_volume()
replace_audio()
add_text()
add_caption()
crop()
zoom()
add_transition()
undo()
redo()
```

| ID | Pri | Requirement | Acceptance criteria |
|---|---:|---|---|
| EDT-001 | P0 | Trim/cut clips | Frame/time-accurate non-destructive trim |
| EDT-002 | P0 | Change playback speed | Supported arbitrary speed ranges with correct audio policy |
| EDT-003 | P0 | Mute/volume changes | Segment-specific audio controls |
| EDT-004 | P0 | Text overlays | Text positioned and timed on timeline |
| EDT-005 | P0 | Captions | Transcript-derived editable captions |
| EDT-006 | P1 | Crop/zoom | Spatial transforms represented as timeline operations |
| EDT-007 | P1 | Clip movement/reordering | Clips repositioned non-destructively |
| EDT-008 | P1 | Transitions | Basic configurable transitions |
| EDT-009 | P0 | Undo/redo | Every manual and AI edit reversible |
| EDT-010 | P0 | Manual timeline editing | AI-generated edits can be changed manually |
| EDT-011 | P0 | Source/edit time mapping | Original timestamps remain resolvable after timeline changes |
| EDT-012 | P0 | Deterministic execution | Same operation graph produces same timeline result |

### 4.4 Edit operation contract

Every edit becomes a typed operation:

```json
{
  "operation_id": "op_123",
  "type": "set_speed",
  "target": {"source_id": "video_1", "start": 218.2, "end": 253.7},
  "parameters": {"speed": 10.0},
  "created_by": "ai",
  "reason": "Low-information setup activity",
  "parent_revision": "rev_17"
}
```

This operation representation is the contract between AI planner, timeline engine, preview, renderer, and undo/redo.

### 4.5 AI agent

The AI agent is an **editing planner**, not the rendering engine.

```text
User intent
  ↓
Interpret objective
  ↓
Search semantic timeline
  ↓
Inspect ambiguous candidate segments
  ↓
Construct edit plan
  ↓
Call validated editing tools
  ↓
Timeline changes
  ↓
Preview
```

| ID | Pri | Requirement | Acceptance criteria |
|---|---:|---|---|
| AI-001 | P0 | Interpret editing intent | Converts supported prompts into structured goals |
| AI-002 | P0 | Semantic retrieval tool | Agent can query relevant timestamp ranges |
| AI-003 | P0 | Segment inspection | Agent can request deeper analysis of candidate clips |
| AI-004 | P0 | Typed editing tool calls | No arbitrary media/shell execution |
| AI-005 | P0 | Multi-step planning | One prompt can produce multiple coordinated edits |
| AI-006 | P0 | Existing-state awareness | Follow-ups modify current timeline rather than restart |
| AI-007 | P0 | Explain changes | User can see what the AI changed and why |
| AI-008 | P0 | Selective undo | User can undo one AI operation or an entire request |
| AI-009 | P1 | Clarification strategy | Ask only when ambiguity materially affects output |
| AI-010 | P1 | Project preference memory | Reuse established editing preferences within project |

---

## 5. Key end-to-end scenario

User:

> “Find the boring parts. Speed them up 10x. Put a 5–7 word explanation over them.”

Expected behavior:

1. Interpret “boring” as semantic editing intent.
2. Retrieve candidates using transcript semantics, pauses, repetition, motion, scene activity, and audio characteristics.
3. Inspect uncertain/high-value candidates using deeper reasoning.
4. Return candidate segments with start/end, reason, and short description.
5. Generate typed operations such as `set_speed`, `mute`, and `add_text`.
6. Update timeline without altering source media.
7. User previews result.
8. Follow-up “Make those 5x instead” updates only speed operations.
9. “Undo the second one” removes operations associated with that selected segment only.
10. No full re-analysis or full source render is required for steps 8–9.

---

## 6. CX requirements

| ID | Pri | Requirement | Acceptance criteria |
|---|---:|---|---|
| CX-001 | P0 | Playback before full indexing | User can inspect source while analysis continues |
| CX-002 | P0 | Progressive intelligence | Transcript/search capabilities become available incrementally |
| CX-003 | P0 | AI activity visibility | User can distinguish indexing, reasoning, and rendering |
| CX-004 | P0 | Proposed edits inspectable | User sees segment, action, and reason |
| CX-005 | P0 | Fast edit feedback | Timeline updates without final export |
| CX-006 | P0 | Chat ↔ timeline synchronization | Changes in either UI surface update same project state |
| CX-007 | P0 | Model complexity hidden | User selects modes like Local/Cloud rather than model IDs |
| CX-008 | P0 | Explicit privacy mode | Local mode can be verified to make no media-related network calls |
| CX-009 | P1 | AI/manual coexistence | User can manually refine any AI edit |

Primary interface:

```text
┌───────────────────────────────────────────┐
│                   VIDEO                   │
└───────────────────────────────────────────┘

┌───────────────────────────────────────────┐
│                  TIMELINE                 │
└───────────────────────────────────────────┘

┌─────────────────────┬─────────────────────┐
│ Transcript / Events │ AI                  │
│                     │                     │
│ 02:13 Product demo  │ Make this tighter   │
│ 03:42 Long pause    │                     │
│ 05:17 Sarah enters  │                     │
└─────────────────────┴─────────────────────┘
```

---

## 7. Reference architecture

```text
                         ┌───────────────┐
                         │     USER      │
                         └───────┬───────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                 Timeline                   Chat
                    │                         │
                    └────────────┬────────────┘
                                 │
                                 ▼
                       ┌──────────────────┐
                       │   AI PLANNER     │
                       └────────┬─────────┘
                                │
                 ┌──────────────┴─────────────┐
                 │                            │
                 ▼                            ▼
        ┌─────────────────┐          ┌─────────────────┐
        │ SEMANTIC QUERY  │          │ EDIT TOOL       │
        │ ENGINE          │          │ REGISTRY        │
        └────────┬────────┘          └────────┬────────┘
                 │                            │
                 ▼                            ▼
        ┌─────────────────┐          ┌─────────────────┐
        │ SEMANTIC        │          │ TIMELINE /      │
        │ TIMELINE        │          │ PROJECT ENGINE  │
        └────────┬────────┘          └────────┬────────┘
                 │                            │
       ┌─────────┴──────────┐                 │
       │ ANALYSIS           │                 │
       │ ORCHESTRATOR       │                 │
       └─────────┬──────────┘                 │
                 │                            │
       ┌─────────┴───────────────┐            │
       │ MODEL PROVIDER ADAPTERS │            │
       │ local/cloud speech      │            │
       │ embeddings              │            │
       │ CV/OCR                  │            │
       │ local/cloud VLM         │            │
       └─────────────────────────┘            │
                                              │
                                ┌─────────────┴──────────┐
                                │ PREVIEW / MEDIA ENGINE │
                                └─────────────┬──────────┘
                                              │
                                              ▼
                                      ┌──────────────┐
                                      │   RENDERER   │
                                      └──────────────┘
```

### 7.1 Project Engine owns

- sources
- tracks
- clips
- operations
- revisions
- timeline mapping
- undo/redo

It must contain **zero AI-specific logic**.

### 7.2 Semantic Timeline owns

- transcript
- speakers
- audio events
- shots
- keyframes
- visual embeddings
- OCR
- objects
- actions
- motion
- AI-generated semantic observations
- confidence/provenance

### 7.3 Analysis Orchestrator owns

- what has already been analyzed
- what can be answered cheaply
- what requires deeper reasoning
- which segments should be inspected
- which provider should perform analysis

This prevents every prompt from reprocessing the full video.

### 7.4 Model Provider layer

Example interfaces:

```text
SpeechProvider.transcribe()
EmbeddingProvider.embed_frame()
VideoReasoner.describe()
VideoReasoner.find_event()
VideoReasoner.compare_segments()
VideoReasoner.reason()
TextReasoner.plan()
```

Project and agent code must not depend directly on specific model APIs.

### 7.5 Edit Tool Registry

Every tool:

- has typed parameters
- validates input
- returns deterministic result
- creates reversible operations
- is independently testable

### 7.6 Renderer

Consumes project state and may use FFmpeg/native encoders internally. The AI never generates renderer commands directly.

---

## 8. Local vs hosted

### 8.1 Local mode

```text
media
 ↓
local preprocessing
 ↓
local semantic index
 ↓
local AI providers
 ↓
local project database
 ↓
local preview/render
```

| ID | Pri | Requirement |
|---|---:|---|
| LOC-001 | P0 | No media uploaded |
| LOC-002 | P0 | Local transcription |
| LOC-003 | P0 | Local semantic retrieval |
| LOC-004 | P0 | Local video reasoning |
| LOC-005 | P0 | Local agent |
| LOC-006 | P0 | Local rendering |
| LOC-007 | P1 | Automatic model download/management |
| LOC-008 | P1 | Hardware-based model selection |
| LOC-009 | P0 | BYO cloud API optional |

### 8.2 Hosted mode

```text
upload
 ↓
object storage
 ↓
parallel preprocessing
 ↓
managed semantic index
 ↓
cloud reasoning
 ↓
same project representation
 ↓
cloud preview/render
```

| ID | Pri | Requirement |
|---|---:|---|
| CLD-001 | P0 | User authentication |
| CLD-002 | P0 | Reliable resumable media upload |
| CLD-003 | P0 | Hosted semantic processing |
| CLD-004 | P0 | Cloud AI providers |
| CLD-005 | P0 | Cloud render workers |
| CLD-006 | P1 | Multi-device projects |
| CLD-007 | P1 | Collaboration |
| CLD-008 | P1 | Sharing/review links |
| CLD-009 | P1 | Billing/usage metering |

---

## 9. Initial model strategy

Models are defaults, not architecture requirements.

| Capability | Initial local direction | Hosted direction |
|---|---|---|
| Speech transcription | Whisper-compatible local runtime | Managed speech or multimodal model |
| VAD | Lightweight local VAD | Same/local |
| Image embeddings | OpenCLIP/SigLIP-class encoder | Hosted inference |
| Basic CV | OpenCV + detector/tracker | GPU workers |
| Deep video reasoning | Small/medium open-weight video VLM | Gemini-class or equivalent video VLM |
| Agent planning | Small local instruction model | Fast hosted LLM |
| Rendering | FFmpeg/native hardware acceleration | FFmpeg/GPU/CPU workers |

Do not fine-tune for the first release. First collect product feedback: AI suggestion → accepted / modified / rejected → later evaluate task-specific ranking or fine-tuning.

---

## 10. Golden evaluation suite

| Test | User command | Capability |
|---|---|---|
| GOLD-01 | “Remove long silence.” | Audio |
| GOLD-02 | “10x boring sections and explain them.” | Cross-modal |
| GOLD-03 | “Keep strongest version of repeated argument.” | Semantic speech |
| GOLD-04 | “Plane left 1x, plane right 5x.” | Temporal visual reasoning |
| GOLD-05 | “Create 60-second product demo.” | Narrative reasoning |
| GOLD-06 | “Find every time Sarah raises her hand.” | Visual event retrieval |
| GOLD-07 | “Remove waiting during software build.” | Screen + temporal understanding |
| GOLD-08 | “Create highlights when crowd gets excited.” | Audio + motion |

Every release should run against this suite.

---

## 11. Quality metrics

Initial targets should be baselined and adjusted after real-world testing.

| Metric | Definition | Initial goal |
|---|---|---|
| Retrieval Recall@K | Relevant moments retrieved | >90% on golden set |
| Temporal overlap | AI segment vs human segment | IoU >0.7 for high-confidence retrieval |
| Edit acceptance rate | AI edits accepted without meaningful change | >60% initially |
| Catastrophic edit rate | Important content incorrectly removed | <2% |
| Overlay groundedness | Overlay correctly describes segment | >90% human-rated |
| Undo integrity | Undo restores exact prior project state | 100% |
| Project determinism | Same operation graph gives same project timeline | 100% |
| Crash recovery | Autosaved project recoverable | >99.9% |
| Local privacy | Network calls containing project/media in local mode | 0 |
| A/V sync error | Exported synchronization drift | Imperceptible / within defined codec tolerance |

Primary product metric: **AI Edit Acceptance Rate**.

Secondary north-star metric: **Time from import → first accepted AI edit**.

### CX performance metrics

Track p50/p95 where relevant:

- time to playable preview
- transcription real-time factor
- baseline indexing factor
- semantic search latency
- AI prompt → proposed edit latency
- proposed edit → playable preview
- export real-time factor
- peak memory by hardware class
- GPU/CPU utilization
- hosted queue wait

---

## 12. Hosted cost requirements

| ID | Requirement |
|---|---|
| COST-001 | Track inference cost per project |
| COST-002 | Track storage cost per project |
| COST-003 | Track render compute per project |
| COST-004 | Track preprocessing compute per project |
| COST-005 | Cache reusable semantic results |
| COST-006 | Avoid full-video deep reasoning when targeted inspection suffices |
| COST-007 | Allow lower-cost provider/model routing |
| COST-008 | Establish per-user monthly cost guardrails |

Initial engineering target per hosted media hour:

```text
AI understanding       <$0.50 target
preprocessing           <$0.20
rendering               <$0.50
storage                 <$0.10 / retained month
agent requests          <$0.20

Target normal COGS:
~$0.50–$1.50 per processed media hour
```

These are engineering cost objectives, not production assumptions.

---

## 13. Open-source boundary

Open source includes:

- desktop editor
- project format
- semantic timeline
- local AI orchestration
- chat agent
- editing tools
- local renderer
- local model support
- BYO API support
- plugin interfaces
- privacy mode

Hosted monetizes:

- zero setup
- managed models
- faster inference
- stronger cloud reasoning
- cloud storage/rendering
- sync
- collaboration
- team permissions
- sharing
- managed updates
- higher compute limits

Principle: **charge for convenience, infrastructure, and managed intelligence — not for unlocking the basic editor.**

---

## 14. Engineering milestones

### M0 — Deterministic Editor Core

Must complete:

- MED-001
- MED-002
- PROJ-001
- EDT-001
- EDT-002
- EDT-003
- EDT-004
- EDT-009
- EDT-011
- EDT-012
- Preview
- Export

Exit demo:

> Load video → programmatically create speed/cut/text operations → preview → undo → export.

No AI required.

### M1 — Semantic Timeline

Must complete:

- SEM-001
- SEM-002
- SEM-003
- SEM-004
- SEM-005
- SEM-012

Exit demos:

- “Find where I talk about pricing.”
- “Show moments containing an airplane.”
- “Find long silences.”

### M2 — AI Editing Loop

Must complete:

- AI-001 through AI-008

Exit demo:

> “Remove long silences.”

Then:

> “Actually keep the third one.”

Then undo. All without re-rendering source media.

### M3 — General-Purpose Video Reasoning

Must complete:

- SEM-008
- SEM-009
- SEM-010
- SEM-011
- SEM-013

Must pass GOLD-02 through GOLD-06.

Hero demos:

- “Find the boring parts, speed them 10x, and put a short description over them.”
- “Plane left = 1x. Plane right = 5x.”

### M4 — Local OSS Product

Must complete LOC-001 through LOC-006, LOC-009, and CX-001 through CX-008.

Exit criterion: a technically competent user can install the open-source app and perform meaningful AI video editing without creating an account or sending video to a server.

### M5 — Hosted Product

Must complete CLD-001 through CLD-005 and COST-001 through COST-008.

Exit criterion: user can upload video, use managed AI, edit, preview, and export without installing local models.

---

## 15. MVP definition

MVP is **not** a full Descript replacement.

MVP succeeds when the same underlying system can reliably perform several fundamentally different semantic edits:

1. Remove long dead air.
2. Find boring/low-information sections, speed them up, and summarize with overlays.
3. Find repeated explanations and keep the strongest one.
4. Identify an object’s temporal behavior and edit based on that behavior.
5. Generate a shorter video based on a semantic objective.
6. Search arbitrary visual events using natural language.
7. Follow-up edit: “Make those 5x instead.”
8. Selective undo: “Undo the second edit.”

If these work across multiple content types, the architecture is demonstrating generality.

---

## 16. Explicitly out of scope for first product

- advanced color grading
- professional audio mastering
- large effects marketplace
- advanced compositing
- After Effects-style animation
- full Premiere keyboard compatibility
- multicam production suite
- custom model fine-tuning
- AI video generation
- large asset marketplace

These do not validate the central product hypothesis.

---

## 17. Central technical bet

```text
VIDEO
  ↓
SEMANTIC TIMELINE
  ↓
NATURAL-LANGUAGE QUERY
  ↓
RELEVANT TIME RANGES
  ↓
AI REASONING
  ↓
TYPED EDIT OPERATIONS
  ↓
DETERMINISTIC TIMELINE
  ↓
PREVIEW / EXPORT
```

If this layer is strong, podcast editing, tutorials, vlogs, sports, product demos, and other workflows become different uses of the same engine.

If we instead build separate “remove silence,” “podcast,” “sports,” and “boring detector” pipelines, we are overfitting the product.

---

## 18. Definition of done

A requirement is **Done** only when:

1. Implementation is merged.
2. Unit/integration coverage exists for deterministic behavior.
3. Telemetry/benchmarking exists where applicable.
4. Relevant golden tests pass.
5. Failure modes are surfaced to the user rather than silently ignored.
6. Undo/redo is validated for timeline-mutating features.
7. Local privacy behavior is validated where applicable.
8. Hosted cost instrumentation exists for server-side compute features.
9. The feature works through common project/tool contracts rather than a one-off path.

---

## 19. First engineering backlog

| Order | Epic | Deliverable |
|---:|---|---|
| 1 | Project Model | Source assets + project schema |
| 2 | Timeline Engine | Clips + operations + revisions |
| 3 | Playback | Preview source and edited timeline |
| 4 | Edit Tools | cut/speed/mute/text |
| 5 | Undo/Redo | Transactional operation history |
| 6 | Export | Deterministic FFmpeg/native compile |
| 7 | Transcription | Timestamped transcript |
| 8 | Semantic Index | Scenes/keyframes/embeddings |
| 9 | Search | `search_video(query)` |
| 10 | Deep Inspection | `inspect_segment()` |
| 11 | Agent | Prompt → search → tools |
| 12 | Hero Workflow | boring → 10x → overlay |
| 13 | Visual Reasoning | arbitrary temporal event search |
| 14 | Local Models | fully private processing path |
| 15 | Cloud Providers | managed inference path |
| 16 | Hosted Runtime | upload/jobs/storage/render |
| 17 | Cost Instrumentation | per-project COGS |
| 18 | OSS Packaging | install/model management/docs |

Do not start with polished UI.

The first technical proof is:

> Can one project model support arbitrary AI-created edits while preserving deterministic playback, undo/redo, source-time mapping, and export?

The second is:

> Can the semantic timeline reliably answer arbitrary questions about where something happens?

Once those two are strong, the chat agent becomes primarily orchestration rather than magic.
