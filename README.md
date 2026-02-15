# Web Video Editor

A browser-based video editor inspired by KineMaster, featuring timeline editing, speed ramping, animated overlays, per-property keyframe editing, and server-side FFmpeg export. Built with React 19 + TypeScript on the frontend and Node.js + Express on the backend, orchestrated via Docker Compose.

## Quick Start

```bash
docker-compose up --build
```

- UI: http://localhost:3000
- API: http://localhost:3001

Seed demo data (after containers are running):

```bash
docker-compose exec server npx tsx src/seed.ts
```

Place `sample.mp4` in the repo root before seeding, or drop videos into `server/uploads/`.

---

## Architecture

### System Overview

```mermaid
graph LR
    subgraph Browser
        A[Asset Panel<br/>Upload Video/Image/Audio] --> B[React 19 + Vite 7<br/>Tailwind CSS]
        C[Timeline<br/>4 Tracks · Zoom · Snap] --> B
        D[Preview<br/>Video + Audio + Overlays] --> B
    end

    subgraph Docker Compose
        E[Express API :3001]
        F[PostgreSQL :5432]
        G[Redis :6379]
        H[Render Worker]
    end

    B -->|REST API| E
    E -->|Prisma ORM| F
    E -->|BullMQ Jobs| G
    G -->|Consume Jobs| H
    H -->|FFmpeg Pipeline| I[Exported MP4]
    E -->|Poll Status| B
```

### Export Pipeline Flow

```mermaid
flowchart TD
    A[POST /api/exports] -->|Create BullMQ Job| B[Render Worker Picks Up Job]
    B --> C[Render Track A Clips]
    C --> C1{Speed Keyframes?}
    C1 -->|Yes| C2[Segment-Based Rendering<br/>setpts + atempo per segment]
    C1 -->|No| C3[Simple Trim + Encode]
    C2 --> C4[Concatenate Segments]
    C3 --> D
    C4 --> D

    D{Overlays Extend<br/>Beyond Video?}
    D -->|Yes| D1[Pad Video with tpad]
    D -->|No| E
    D1 --> E

    E{Track B Clips?}
    E -->|Yes| E1[Render Track B<br/>Composite with overlay filter]
    E -->|No| F
    E1 --> F

    F{Text Overlays?}
    F -->|Yes| F1[Apply drawtext Filters<br/>Sub-segmented for Animation]
    F -->|No| G
    F1 --> G

    G{Image Overlays?}
    G -->|Yes| G1[Apply overlay Filter<br/>Expression-Based Position]
    G -->|No| H
    G1 --> H

    H{Audio Clips?}
    H -->|Yes| H1[Mix Audio<br/>amix or direct add]
    H -->|No| I
    H1 --> I

    I[Final MP4<br/>H.264 + AAC]

    style A fill:#ef4444,color:#fff
    style I fill:#22c55e,color:#fff
```

### Request Flow

```mermaid
sequenceDiagram
    participant U as Browser UI
    participant A as Express API
    participant DB as PostgreSQL
    participant R as Redis
    participant W as Render Worker

    U->>A: Upload Asset (multipart)
    A->>A: FFmpeg: extract metadata + thumbnail
    A->>DB: Save Asset record
    A-->>U: Asset with metadata

    U->>A: Create/Update Clips & Overlays
    A->>DB: Persist timeline state
    A-->>U: Updated entities

    U->>A: POST /exports
    A->>DB: Create Export (QUEUED)
    A->>R: Enqueue render job
    A-->>U: Export ID

    W->>R: Pick up job
    W->>DB: Update status → RUNNING
    W->>W: FFmpeg pipeline (7 steps)
    W->>DB: Update status → COMPLETE

    loop Every 1s
        U->>A: GET /exports/:id
        A->>DB: Read status + progress
        A-->>U: Progress %
    end

    U->>A: GET /exports/:id/download
    A-->>U: MP4 file stream
```

### Tech Stack

| Layer    | Tech                                                      |
|----------|-----------------------------------------------------------|
| Frontend | React 19, TypeScript, Vite 7, Tailwind CSS, lucide-react  |
| Backend  | Node.js, Express, TypeScript                              |
| Database | PostgreSQL 16 + Prisma ORM                                |
| Queue    | Redis 7 + BullMQ                                          |
| Render   | FFmpeg (fluent-ffmpeg)                                    |
| Infra    | Docker Compose (4 services: API, Worker, Postgres, Redis) |

---

## Features

### Timeline Editing

- 4-track timeline: Video (Track A), PiP (Track B), Text/Image Overlays, Audio
- 7-level zoom (20px/s to 240px/s) with keyboard shortcuts (`+`/`-`)
- Clip snapping to playhead and adjacent clip edges
- Collision prevention — clips cannot overlap on the same track
- Trim handles on both ends of every clip
- Move clips by dragging (constrained to track boundaries)
- Split at playhead (`S` key)
- Duplicate clip (`D` key)
- Delete clip (`Delete`/`Backspace`)
- Timeline footer width matches actual content length (minimum 100vw)
- Hidden scrollbar for clean appearance
- Playhead with red vertical line and timecode ruler

### Speed Ramps

- Per-clip speed keyframes from 0x (freeze frame) to 8x
- Multi-keyframe support with visual keyframe editor
- Presets: Slow-mo (0.5x), Normal (1x), Fast (2x), Ramp Up (0.5→2x), Ramp Down (2→0.5x)
- Freeze frame (0x) holds a single frame for the keyframe duration
- Deterministic time mapping via trapezoidal integration (no drift)

### Text Overlays

- Add text with custom content, font size, color, and background color
- 8 animation presets: None, Fade, Slide Up, Slide Left, Scale, Typewriter, Bounce, Blur
- Animation suffix stored as `text|||animation` in content field
- Per-property keyframe editing (position, scale, rotation, opacity)
- Background box rendered in both preview and export

### Image Overlays

- Upload images (PNG, JPG, AVIF) via dedicated Image button
- Auto-added as overlays (not video clips)
- Per-property keyframe editing (position, scale, rotation, opacity)
- 200px base width in the 1280×720 reference coordinate system

### Audio Track

- Dedicated Audio upload button (accepts audio files and video files)
- Audio extraction from video files — when a video is uploaded via the Audio button, FFmpeg strips the video stream and extracts 192kbps MP3
- Audio playback synced with timeline transport (play/pause/seek)
- Drift correction (0.3s threshold) keeps audio in sync
- Volume control and mute toggle

### Overlay Positioning System

Both the preview and export use a shared 1280×720 reference coordinate system:

```
Preview:
  REF_W = 1280, REF_H = 720
  ResizeObserver measures actual <video> element size
  scaleX = videoElement.width / 1280
  scaleY = videoElement.height / 720
  All overlay positions: pixelX = vidRect.left + refX * scaleX
  Overlays center-anchored with translate(-50%, -50%)

Export:
  FFmpeg probes actual video dimensions (e.g. 1920×1080)
  sx = videoWidth / 1280, sy = videoHeight / 720
  All overlay x/y multiplied by sx/sy
  Font sizes multiplied by sx
  Image base width multiplied by sx
```

This ensures overlays appear in the same relative position regardless of video resolution.

### Alignment Presets

3×3 grid of alignment presets in the Overlay Keyframes modal:

```
┌────┬────┬────┐
│ TL │ T  │ TR │   TL = (160, 90)     T = (640, 90)     TR = (1120, 90)
├────┼────┼────┤
│ L  │ C  │ R  │   L  = (160, 360)    C = (640, 360)    R  = (1120, 360)
├────┼────┼────┤
│ BL │ B  │ BR │   BL = (160, 630)    B = (640, 630)    BR = (1120, 630)
└────┴────┴────┘
```

All values in the 1280×720 reference space, center-anchored.

### Separate Upload Buttons

Three distinct import buttons in the Asset Panel:
- **Video** — accepts video formats (mp4, mov, avi, mkv)
- **Image** — accepts image formats (png, jpg, jpeg)
- **Audio** — accepts audio formats (mp3, wav) AND video formats (for audio extraction)

Upload intent is tracked so the backend knows whether to extract audio from a video file.

### Per-Property Keyframe Editing

Modal-based keyframe editor for overlays with independent tracks for:
- Position (x, y) — in 1280×720 reference coordinates
- Scale (multiplier, default 1.0)
- Rotation (degrees)
- Opacity (0.0 to 1.0)

Each property can have multiple keyframes with linear interpolation between them.

### Undo/Redo

Full undo/redo stack for timeline operations with keyboard shortcuts (`Ctrl+Z` / `Ctrl+Shift+Z`).

### Export

- One-click export via REST API
- Async BullMQ job with progress polling (1s interval)
- Progress bar in UI with percentage
- Download button appears on completion
- Exported as H.264/AAC MP4

---

## Time Engine

The core of the editor is a deterministic timeline evaluation engine (`server/src/utils/time-engine.ts`).

### Mapping: `timeline_time → clip_local_time → source_time`

1. A clip sits on the timeline at `[startTime, endTime]`
2. `clipLocalTime = timelineTime - clip.startTime`
3. Speed keyframes define a piecewise-linear speed curve over clip-local time
4. Source time is computed via trapezoidal integration of the speed curve:

```
For keyframes [kf_i, kf_{i+1}]:
  speed(t) = lerp(kf_i.speed, kf_{i+1}.speed, progress)
  sourceTime += (t - kf_i.time) × avgSpeed   // trapezoidal rule
```

### Speed Ramp Behavior

- Before first keyframe: `sourceTime = t × firstKeyframe.speed`
- Between keyframes: trapezoidal integration of linearly interpolated speed
- After last keyframe: accumulated source time + `(t - lastKf.time) × lastKf.speed`
- Hold (0x): freeze frame — source time stops advancing

---

## Export Pipeline

Server-side FFmpeg render triggered via `POST /api/exports`. Runs as an async BullMQ job in a dedicated worker process.

### Pipeline Steps

```
1. Render Track A clips ──────────────── (segment-based speed ramp rendering)
2. Pad video if overlays extend beyond ─ (tpad filter with clone mode)
3. Composite Track B (PiP) ───────────── (overlay filter with timing)
4. Apply text overlays ───────────────── (drawtext with sub-segmented animation)
5. Apply image overlays ──────────────── (overlay filter with expression-based position)
6. Mix audio track ───────────────────── (amix or direct add if no video audio)
7. Output final MP4 ──────────────────── (H.264 + AAC)
```

### Speed Ramp Rendering

For clips with speed keyframes:
- Split into segments between consecutive keyframes
- Each segment rendered at the keyframe's speed using `setpts` and `atempo` filters
- `atempo` chained for speeds outside 0.5–2.0 range
- Segments concatenated with FFmpeg concat demuxer
- Holds (0x speed) rendered by extracting a single frame and looping it

### Text Overlay Export

- `|||animation` suffix stripped from content before rendering
- `computeTextAnimation()` mirrors CSS animation math for: fade, slide-up, slide-left, scale, bounce, blur (→fade)
- 10fps step rate for animated text (up to 60 steps max)
- Typewriter: per-step partial text rendering
- Scale animation changes font size per step
- Background box: `box=1:boxcolor=<color>@0.8:boxborderw=6`
- CSS hex colors converted to FFmpeg format via `cssToFfmpegColor()`

### Image Overlay Export

- Images scaled to 200px base width (matching preview) before user scale applied
- Rotation via FFmpeg `rotate` filter with `fillcolor=none:ow=rotw():oh=roth()`
- Animated position uses FFmpeg expression-based interpolation (`buildInterpolationExpr`)
- Animated scale/opacity use midpoint values (FFmpeg filter context limitation)
- Single-pass FFmpeg expressions instead of sequential re-encodes

### Audio Mixing

- Detects whether base video has an audio stream
- If yes: `amix=inputs=2:duration=first:dropout_transition=2`
- If no: adds audio track directly with `-map 0:v -map 1:a -shortest`
- Graceful fallback on mixing failure

### Job States

`QUEUED → RUNNING → COMPLETE | FAILED`

- Progress updates at each pipeline stage (5% → 95%)
- Idempotent: same export ID won't spawn duplicate jobs
- Polling from UI every 1s

---

## Data Model

```mermaid
erDiagram
    Project ||--o{ Asset : has
    Project ||--o{ Clip : has
    Project ||--o{ Overlay : has
    Project ||--o{ Export : has
    Asset ||--o{ Clip : referenced_by

    Project {
        uuid id PK
        string name
        datetime createdAt
        datetime updatedAt
    }

    Asset {
        uuid id PK
        uuid projectId FK
        string type "video | audio | image"
        string filename
        string filepath
        float duration
        float fps
        int width
        int height
        boolean hasAudio
        string thumbnailPath
    }

    Clip {
        uuid id PK
        uuid projectId FK
        uuid assetId FK
        string track "video_a | video_b | audio"
        float startTime
        float endTime
        float trimStart
        json speedKeyframes
    }

    Overlay {
        uuid id PK
        uuid projectId FK
        string type "text | image"
        string track "overlay_1 | overlay_2"
        float startTime
        float endTime
        string content
        int fontSize
        string color
        string bgColor
        json positionKeyframes
        json scaleKeyframes
        json rotationKeyframes
        json opacityKeyframes
    }

    Export {
        uuid id PK
        uuid projectId FK
        string status "QUEUED | RUNNING | COMPLETE | FAILED"
        float progress
        string outputPath
        string errorMessage
    }
```

All keyframes stored as JSON columns in PostgreSQL via Prisma. Cascade deletes from Project down.

---

## REST API

| Method | Endpoint                      | Description                          |
|--------|-------------------------------|--------------------------------------|
| POST   | `/api/projects`               | Create project                       |
| GET    | `/api/projects`               | List projects                        |
| GET    | `/api/projects/:id`           | Get project with assets/clips/overlays |
| DELETE | `/api/projects/:id`           | Delete project                       |
| POST   | `/api/assets`                 | Upload asset (multipart, extractAudio flag) |
| GET    | `/api/assets/project/:id`     | List assets for project              |
| POST   | `/api/clips`                  | Create clip                          |
| PATCH  | `/api/clips/:id`              | Update clip                          |
| DELETE | `/api/clips/:id`              | Delete clip                          |
| POST   | `/api/clips/:id/split`        | Split clip at time                   |
| POST   | `/api/overlays`               | Create overlay                       |
| PATCH  | `/api/overlays/:id`           | Update overlay                       |
| DELETE | `/api/overlays/:id`           | Delete overlay                       |
| POST   | `/api/exports`                | Start export job                     |
| GET    | `/api/exports/:id`            | Get export status/progress           |
| GET    | `/api/exports/:id/download`   | Download exported MP4                |
| GET    | `/api/timeline/:projectId/evaluate` | Evaluate timeline at time      |

---

## Project Structure

```
server/
  src/
    config/          # DB, Redis, storage config
    routes/          # REST endpoints
    services/
      asset-service.ts    # Upload, metadata extraction, audio extraction
      render-service.ts   # FFmpeg export pipeline (800+ lines)
      export-service.ts   # Job management
    utils/
      time-engine.ts      # Deterministic timeline evaluation
    workers/
      render-worker.ts    # BullMQ job consumer
  prisma/
    schema.prisma         # 5 models: Project, Asset, Clip, Overlay, Export
    migrations/           # PostgreSQL migration
  tests/
    time-engine.test.ts   # Speed ramp + hold tests
    backend.test.ts       # Export + project integrity tests

ui/
  src/
    api/
      client.ts           # Axios API client with types
    components/
      AssetPanel.tsx       # 3 upload buttons + asset library
      Preview.tsx          # Video/audio playback + overlay rendering
      Timeline.tsx         # 4-track timeline with zoom/snap/trim/split
      Modal.tsx            # Reusable modal component
      Toast.tsx            # Toast notifications
    App.tsx               # Main editor — all state, undo/redo, keyboard shortcuts
```

---

## Tests

```bash
# Backend (9 tests)
cd server && npx jest

# Frontend (3 tests)
cd ui && npx vitest --run
```

### Test Coverage

- **Time engine**: speed ramp evaluation with multiple keyframes, hold (0x) freeze behavior
- **Backend**: export job idempotency, project save/load data integrity
- **Frontend**: track rendering, clip display, overlay text stripping (`|||animation` suffix)

---

## Known Limitations

- PiP (Track B) preview doesn't render in browser — only visible in exported video
- Blur animation in export falls back to fade (FFmpeg drawtext limitation)
- Typewriter animation in export is stepped, not smooth character-by-character
- Animated image scale/opacity keyframes use midpoint value in export (position animates correctly via FFmpeg expressions)
- Text scale animation changes font size per-step rather than smooth CSS-style scaling
- Very long overlays (30+ seconds) with animation generate many drawtext filter steps

---

## Environment Variables

See `server/.env.example`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/video_editor
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3001
```

---

**This feature is not implemented**: Track B (PiP) not visible in browser preview — the spec says "If both video tracks have content at the same time: Track B overlays Track A." This works in export but not in the live preview. The preview only shows Track A video.

---

## AI Usage

This project was built with AI assistance (Kiro / Claude). Here's how AI was used:

- **Architecture design**: Time engine with trapezoidal integration, segment-based render pipeline, 1280×720 reference coordinate system, BullMQ job queue pattern
- **Code generation**: All source files were generated with AI, then iteratively refined through testing and debugging
- **Bug fixing**: Overlay positioning (random → coordinate-scaled), audio playback sync, export text animations not rendering, image overlay scale/rotation in export, audio mixing when base video has no audio stream, video padding for overlays extending beyond clips
- **Feature iteration**: Started with basic timeline → added speed ramps → overlays → keyframe editing → animation presets → audio extraction → alignment presets → coordinate scaling for different resolutions
- **Manual verification**: Docker builds, FFmpeg output quality, browser preview behavior, export correctness, and all test results were verified by running the actual application
- **What AI didn't do**: Visual design direction (KineMaster-inspired look), feature prioritization, and final acceptance testing were human-directed
