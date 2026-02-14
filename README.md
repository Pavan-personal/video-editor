# Video Editor

A web-based video editor with multi-track timeline, speed ramping, motion graphics overlays, and server-side FFmpeg rendering.

## Architecture

```
┌─────────────┐
│   Frontend  │  React + TypeScript + Canvas
│   (Port     │  Timeline UI + Video Preview
│    3000)    │
└──────┬──────┘
       │ REST API
       ▼
┌─────────────┐
│   Backend   │  Node.js + Express + TypeScript
│   (Port     │  Prisma ORM + PostgreSQL
│    3001)    │
└──────┬──────┘
       │
       ├─────► PostgreSQL (Projects, Assets, Timeline, Exports)
       │
       ├─────► Redis + BullMQ (Async Job Queue)
       │
       └─────► FFmpeg Worker (Video Rendering)
                  │
                  ▼
              ┌──────────┐
              │  Worker  │  Background render process
              └──────────┘
```

## Setup Instructions

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local development / tests)
- 3+ sample video files (MP4 format) for demo

### Quick Start

```bash
# 1. Clone repo
git clone <repo-url>
cd video-editor

# 2. Create env file
cp server/.env.example server/.env

# 3. Start everything
docker-compose up --build

# This starts:
#   - PostgreSQL (port 5432)
#   - Redis (port 6379)
#   - Backend API (port 3001)
#   - Worker process
```

### Verify

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

### Run Tests

```bash
# Unit tests
cd server
npm install
npm test

# Full backend integration test (requires Docker running)
# Tests all APIs, upload, export pipeline, error handling
chmod +x scripts/test-backend.sh
./scripts/test-backend.sh
```

### Stop

```bash
docker-compose down        # Stop services
docker-compose down -v     # Stop + delete data
```

---

## Backend

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express |
| ORM | Prisma |
| Database | PostgreSQL 16 |
| Job Queue | BullMQ + Redis 7 |
| Video Processing | FFmpeg (fluent-ffmpeg) |
| File Upload | Multer |
| Containerization | Docker + Docker Compose |

### API Endpoints

#### Projects
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/projects` | Create project |
| GET | `/api/projects` | List all projects |
| GET | `/api/projects/:id` | Get project with timeline data |
| PATCH | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project (cascades) |

#### Assets
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/assets` | Upload asset (multipart/form-data) |
| GET | `/api/assets/project/:id` | List assets for project |

On video upload, the server extracts: duration, fps, resolution, codec, hasAudio, and generates a thumbnail.

#### Clips
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/clips` | Add clip to timeline |
| PATCH | `/api/clips/:id` | Update clip (trim, speed keyframes) |
| DELETE | `/api/clips/:id` | Remove clip |

#### Overlays
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/overlays` | Add text/image overlay |
| PATCH | `/api/overlays/:id` | Update overlay (keyframes) |
| DELETE | `/api/overlays/:id` | Remove overlay |

#### Exports
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/exports` | Start export job (idempotent) |
| GET | `/api/exports/:id` | Get export status + progress |
| GET | `/api/exports/:id/download` | Download rendered MP4 |

### Database Schema

5 models in PostgreSQL via Prisma:

- **Project** — Container for all timeline data
- **Asset** — Imported video/audio/image with extracted metadata
- **Clip** — Video clip on timeline with track, trim, and speed keyframes (JSON)
- **Overlay** — Text/image overlay with position, scale, rotation, opacity keyframes (JSON)
- **Export** — Render job with status tracking (QUEUED → RUNNING → COMPLETE/FAILED)

All relations use cascade delete. Indexes on projectId, assetId, and export status.

### Time Engine

The core of the editor is the Time Engine (`server/src/utils/time-engine.ts`).

#### Deterministic Mapping

```
timeline_time → clip_local_time → source_time
```

1. **Timeline time**: Absolute position on the timeline (seconds)
2. **Clip local time**: `timeline_time - clip.startTime`
3. **Source time**: `clip.trimStart + evaluateSpeedRamp(clipLocalTime, keyframes)`

#### Speed Ramp Evaluation

```typescript
evaluateSpeedRamp(clipLocalTime: number, keyframes: SpeedKeyframe[]): number
```

- Keyframes define speed at specific times: `[{time: 0, speed: 1}, {time: 2, speed: 2}]`
- Speed range: 0x (hold/freeze) to 8x
- Linear interpolation between keyframes
- Trapezoidal integration for accurate source time calculation
- No drift — accumulated source time is computed from keyframe 0

#### Hold (Freeze Frame)

When `speed: 0`, the source time stops advancing. The renderer extracts a single frame and loops it for the hold duration.

#### Transform Interpolation

```typescript
interpolateKeyframes(time: number, keyframes: TransformKeyframe[], property: string): number
```

Linear interpolation for overlay properties: position (x,y), scale, rotation, opacity.

#### Timeline Evaluation

```typescript
evaluateTimeline(time: number, clips: ClipData[], overlays: OverlayData[]): TimelineState
```

At any time T, returns:
- Active video clips on tracks A/B with computed source times
- Active overlays with interpolated transforms

### Export Pipeline

#### Strategy: Segment-Based Rendering

Due to FFmpeg limitations with dynamic speed curves:

1. **Split** clip at speed keyframes into segments
2. **Render** each segment with constant speed (`setpts` + `atempo` filters)
3. **Concatenate** segments using FFmpeg concat demuxer
4. **Composite** text overlays using `drawtext` filter
5. **Output** final MP4 (H.264 + AAC)

```
Source Video
    ↓
[Trim + Speed Filter] → Segment 1 (1x)
[Trim + Speed Filter] → Segment 2 (2x)
[Trim + Speed Filter] → Segment 3 (0.5x)
    ↓
[Concat] → Combined Video
    ↓
[Drawtext Filter] → Final MP4
```

#### Hold Rendering

For 0x speed segments: extract single frame as PNG, then loop it with `-loop 1 -t <duration>`.

#### Async Job Queue

- BullMQ + Redis for job management
- Worker process runs separately from API server
- Job states: QUEUED → RUNNING → COMPLETE/FAILED
- Progress polling via `GET /api/exports/:id`
- Idempotent: duplicate export requests return existing job

#### Limitations

- Speed changes are per-segment (not frame-perfect curves)
- Audio tempo adjustment limited to 0.5x–2.0x range (chained for wider)
- Text overlays use first keyframe position in export (animated keyframes simplified)
- Track B compositing not yet implemented in export
- Preview and export may differ slightly

### Security

- File upload validation: type whitelist (mp4, mov, avi, mkv, mp3, wav, png, jpg)
- File size limit: 500MB
- No arbitrary FFmpeg argument injection (all commands built programmatically)
- Cascade deletes prevent orphaned data
- Graceful error handling for corrupt/unsupported uploads

### Tests

```bash
cd server && npm test
```

| Test | Description |
|------|-------------|
| Speed ramp with acceleration | Verifies 1x→2x ramp produces correct source times |
| Hold (0x speed) | Verifies freeze frame stops source time advancement |
| No keyframes | Verifies 1:1 time mapping |
| Single keyframe | Verifies constant speed multiplication |

Additional tests via `test-backend.sh`:
- Export idempotency (same request = same job)
- Project save/load integrity (all data persists and reloads)
- Error handling (400/404 responses)

---

## Frontend

*Coming soon*

---

## AI Usage

### Tools Used
- **Kiro AI** — Project scaffolding, architecture, code generation, debugging
- **AI-assisted coding** — Used throughout for boilerplate, FFmpeg commands, and test writing

### Manual Verification
- Time engine math verified with unit tests
- FFmpeg pipeline tested with real video files
- API contracts tested with curl scripts
- Database migrations reviewed
- Docker configuration tested locally
- Export output visually verified

---

## License

MIT
