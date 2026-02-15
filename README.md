# Web Video Editor

A browser-based video editor with timeline editing, speed ramping, motion graphics overlays, and server-side FFmpeg export.

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

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────┐
│   Browser    │     │           Docker Compose                 │
│              │     │                                          │
│  React 19   │────▶│  Express API (:3001)                     │
│  Vite 7     │     │    ├─ Routes (projects/assets/clips/...) │
│  Tailwind   │     │    ├─ Prisma ORM ──▶ PostgreSQL (:5432)  │
│  Timeline   │     │    └─ BullMQ ──────▶ Redis (:6379)       │
│  Preview    │     │                                          │
│             │◀────│  Render Worker                            │
│             │     │    └─ FFmpeg pipeline                     │
└─────────────┘     └──────────────────────────────────────────┘
```

### Stack

| Layer    | Tech                                      |
|----------|-------------------------------------------|
| Frontend | React 19, TypeScript, Vite 7, Tailwind CSS, lucide-react |
| Backend  | Node.js, Express, TypeScript              |
| Database | PostgreSQL 16 + Prisma ORM                |
| Queue    | Redis 7 + BullMQ                          |
| Render   | FFmpeg (fluent-ffmpeg)                    |
| Infra    | Docker Compose                            |

## Time Engine

The core of the editor is a deterministic timeline evaluation engine (`server/src/utils/time-engine.ts`).

### Mapping: `timeline_time → clip_local_time → source_time`

1. A clip sits on the timeline at `[startTime, endTime]`
2. `clipLocalTime = timelineTime - clip.startTime`
3. Speed keyframes define a piecewise-linear speed curve over clip-local time
4. Source time is computed via **trapezoidal integration** of the speed curve:

```
For keyframes [kf_i, kf_{i+1}]:
  speed(t) = lerp(kf_i.speed, kf_{i+1}.speed, progress)
  sourceTime += (t - kf_i.time) × avgSpeed   // trapezoidal rule
```

### Speed Ramps

- Range: 0x (freeze/hold) to 8x
- Keyframes are sorted by time; speed is linearly interpolated between them
- **Holds** (0x speed): freeze frame — duplicates a single frame for the hold duration
- **Ramps**: smooth acceleration/deceleration between keyframe speeds
- No drift: accumulated source time is computed from segment integrals, not incremental addition

### Overlay Transforms

Position, scale, rotation, and opacity are each keyframed independently with linear interpolation.

## Export Pipeline

Server-side FFmpeg render triggered via REST API. Runs as an async BullMQ job.

### Steps

1. **Render Track A clips** — each clip rendered with speed ramps via segment-based approach
2. **Composite Track B** — overlay Track B on Track A using FFmpeg `overlay` filter
3. **Apply text overlays** — `drawtext` filter with animated position/opacity (sub-segmented for keyframe interpolation)
4. **Apply image overlays** — `overlay` filter with enable timing
5. **Mix audio** — `amix` filter to blend video audio with audio track
6. **Output** — final MP4 with h264/aac

### Speed Ramp Rendering

For clips with multiple speed keyframes:
- Split into segments between consecutive keyframes
- Each segment rendered at the keyframe's speed using `setpts` and `atempo` filters
- Segments concatenated with `concat` demuxer
- Holds rendered by extracting a single frame and looping it

### Job States

`QUEUED → RUNNING → COMPLETE | FAILED`

- Progress updates at each pipeline stage (5% → 95%)
- Idempotent: same export ID won't spawn duplicate jobs
- Polling from UI every 1s

### Preview vs Export Gap

The browser preview uses HTML5 `<video>` with JavaScript-driven seeking for speed ramps. This is approximate — the video element's native playback rate isn't changed per-keyframe. The export uses FFmpeg and is frame-accurate. Text overlay animations match closely between preview (CSS) and export (drawtext with sub-segments).

## Data Model

```
Project
  ├── Asset[]        (video/audio/image files with extracted metadata)
  ├── Clip[]         (timeline placement + speed keyframes as JSON)
  ├── Overlay[]      (text/image + transform keyframes as JSON)
  └── Export[]       (job status + output path)
```

All keyframes stored as JSON columns in PostgreSQL via Prisma.

## Project Structure

```
server/
  src/
    config/          # DB, Redis, storage config
    routes/          # REST endpoints (projects, assets, clips, overlays, exports, timeline)
    services/        # Business logic (asset-service, render-service, export-service)
    utils/           # Time engine
    workers/         # BullMQ render worker
  prisma/            # Schema + migrations
  tests/             # Jest tests

ui/
  src/
    api/             # Axios API client
    components/      # Timeline, Preview, AssetPanel, Modal, Toast
    App.tsx          # Main editor with all state management
```

## Tests

```bash
# Backend (9 tests)
cd server && npx jest

# Frontend (3 tests)
cd ui && npx vitest --run
```

### Test Coverage

- **Time engine**: speed ramp evaluation, hold (0x) behavior
- **Backend**: export idempotency, project save/load integrity
- **Frontend**: track rendering, clip display, overlay text stripping

## Environment Variables

See `server/.env.example`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/video_editor
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3001
```

## AI Usage

This project was built with AI assistance (Kiro / Claude). Specifically:

- **Architecture design**: AI helped design the time engine, segment-based render pipeline, and data model
- **Code generation**: All source files were generated with AI, then reviewed and iterated on based on testing
- **Bug fixes**: Audio playback flickering, overlay text display bugs, timeline collision detection — all identified and fixed through AI-assisted debugging
- **Manual verification**: Docker builds, FFmpeg output, browser preview behavior, and all test results were verified by running the actual application
- **What AI didn't do**: Visual design decisions (KineMaster-inspired look) and feature prioritization were human-directed
