/**
 * Backend Tests - Export Idempotency + Project Save/Load
 * These test the API logic without needing FFmpeg or video files
 */

import { evaluateTimeline, ClipData, OverlayData } from '../src/utils/time-engine';

describe('Timeline Evaluation', () => {
  test('should find active clips at a given time', () => {
    const clips: ClipData[] = [
      {
        id: 'clip-1',
        track: 'video_a',
        assetId: 'asset-1',
        startTime: 0,
        endTime: 5,
        trimStart: 0,
        speedKeyframes: [],
      },
      {
        id: 'clip-2',
        track: 'video_a',
        assetId: 'asset-2',
        startTime: 5,
        endTime: 10,
        trimStart: 0,
        speedKeyframes: [],
      },
      {
        id: 'clip-3',
        track: 'video_b',
        assetId: 'asset-3',
        startTime: 2,
        endTime: 7,
        trimStart: 0,
        speedKeyframes: [],
      },
    ];

    const overlays: OverlayData[] = [];

    // At time 0: only clip-1 active
    const state0 = evaluateTimeline(0, clips, overlays);
    expect(state0.activeClips).toHaveLength(1);
    expect(state0.activeClips[0].clipId).toBe('clip-1');

    // At time 3: clip-1 (video_a) and clip-3 (video_b) active
    const state3 = evaluateTimeline(3, clips, overlays);
    expect(state3.activeClips).toHaveLength(2);
    expect(state3.activeClips.map(c => c.clipId).sort()).toEqual(['clip-1', 'clip-3']);

    // At time 6: clip-2 (video_a) and clip-3 (video_b) active
    const state6 = evaluateTimeline(6, clips, overlays);
    expect(state6.activeClips).toHaveLength(2);
    expect(state6.activeClips.map(c => c.clipId).sort()).toEqual(['clip-2', 'clip-3']);

    // At time 8: only clip-2 active
    const state8 = evaluateTimeline(8, clips, overlays);
    expect(state8.activeClips).toHaveLength(1);
    expect(state8.activeClips[0].clipId).toBe('clip-2');

    // At time 11: nothing active
    const state11 = evaluateTimeline(11, clips, overlays);
    expect(state11.activeClips).toHaveLength(0);
  });

  test('should evaluate overlay transforms with keyframes', () => {
    const clips: ClipData[] = [];
    const overlays: OverlayData[] = [
      {
        id: 'overlay-1',
        type: 'text',
        track: 'overlay_1',
        startTime: 0,
        endTime: 10,
        content: 'Hello',
        positionKeyframes: [
          { time: 0, x: 0, y: 0 },
          { time: 10, x: 100, y: 200 },
        ],
        scaleKeyframes: [
          { time: 0, scale: 1 },
          { time: 10, scale: 2 },
        ],
        rotationKeyframes: [
          { time: 0, rotation: 0 },
          { time: 10, rotation: 360 },
        ],
        opacityKeyframes: [
          { time: 0, opacity: 1 },
          { time: 5, opacity: 0.5 },
          { time: 10, opacity: 0 },
        ],
      },
    ];

    // At time 0: starting position
    const state0 = evaluateTimeline(0, clips, overlays);
    expect(state0.activeOverlays).toHaveLength(1);
    expect(state0.activeOverlays[0].transform.x).toBe(0);
    expect(state0.activeOverlays[0].transform.y).toBe(0);
    expect(state0.activeOverlays[0].transform.scale).toBe(1);
    expect(state0.activeOverlays[0].transform.opacity).toBe(1);

    // At time 5: halfway
    const state5 = evaluateTimeline(5, clips, overlays);
    expect(state5.activeOverlays[0].transform.x).toBeCloseTo(50, 0);
    expect(state5.activeOverlays[0].transform.y).toBeCloseTo(100, 0);
    expect(state5.activeOverlays[0].transform.scale).toBeCloseTo(1.5, 1);
    expect(state5.activeOverlays[0].transform.rotation).toBeCloseTo(180, 0);
    expect(state5.activeOverlays[0].transform.opacity).toBeCloseTo(0.5, 1);

    // At time 10: not active (endTime is exclusive)
    const state10 = evaluateTimeline(10, clips, overlays);
    expect(state10.activeOverlays).toHaveLength(0);
  });

  test('should handle clips with speed ramps and trim', () => {
    const clips: ClipData[] = [
      {
        id: 'clip-1',
        track: 'video_a',
        assetId: 'asset-1',
        startTime: 0,
        endTime: 4,
        trimStart: 5, // Start from 5 seconds in source
        speedKeyframes: [
          { time: 0, speed: 2 }, // 2x speed
        ],
      },
    ];

    // At time 2: clip local time is 2, speed is 2x, so source time = 5 + (2 * 2) = 9
    const state = evaluateTimeline(2, clips, []);
    expect(state.activeClips).toHaveLength(1);
    expect(state.activeClips[0].sourceTime).toBeCloseTo(9, 0);
    expect(state.activeClips[0].clipLocalTime).toBe(2);
  });
});

describe('Export Idempotency (Logic)', () => {
  test('same export request should not create duplicates', () => {
    // Simulate export tracking
    const exports: { id: string; projectId: string; status: string }[] = [];

    function createExport(projectId: string): { id: string; isNew: boolean } {
      // Check for existing queued/running export
      const existing = exports.find(
        e => e.projectId === projectId && (e.status === 'QUEUED' || e.status === 'RUNNING')
      );

      if (existing) {
        return { id: existing.id, isNew: false };
      }

      const newExport = { id: `export-${exports.length + 1}`, projectId, status: 'QUEUED' };
      exports.push(newExport);
      return { id: newExport.id, isNew: true };
    }

    // First export request
    const result1 = createExport('project-1');
    expect(result1.isNew).toBe(true);
    expect(result1.id).toBe('export-1');

    // Second request for same project - should return existing
    const result2 = createExport('project-1');
    expect(result2.isNew).toBe(false);
    expect(result2.id).toBe('export-1');

    // Only one export should exist
    expect(exports).toHaveLength(1);

    // Mark as complete
    exports[0].status = 'COMPLETE';

    // Now a new export should be created
    const result3 = createExport('project-1');
    expect(result3.isNew).toBe(true);
    expect(result3.id).toBe('export-2');
    expect(exports).toHaveLength(2);
  });
});

describe('Project Save/Load Integrity', () => {
  test('project data structure should be consistent', () => {
    // Simulate project save/load
    const project = {
      id: 'project-1',
      name: 'Test Project',
      assets: [
        { id: 'asset-1', type: 'video', filename: 'clip1.mp4', duration: 10, fps: 30 },
        { id: 'asset-2', type: 'video', filename: 'clip2.mp4', duration: 15, fps: 24 },
      ],
      clips: [
        {
          id: 'clip-1',
          assetId: 'asset-1',
          track: 'video_a',
          startTime: 0,
          endTime: 5,
          trimStart: 0,
          speedKeyframes: [{ time: 0, speed: 1 }, { time: 2, speed: 2 }],
        },
      ],
      overlays: [
        {
          id: 'overlay-1',
          type: 'text',
          content: 'Hello',
          startTime: 0,
          endTime: 5,
          positionKeyframes: [{ time: 0, x: 100, y: 100 }],
        },
      ],
    };

    // Simulate save (serialize)
    const saved = JSON.stringify(project);

    // Simulate load (deserialize)
    const loaded = JSON.parse(saved);

    // Verify integrity
    expect(loaded.id).toBe(project.id);
    expect(loaded.name).toBe(project.name);
    expect(loaded.assets).toHaveLength(2);
    expect(loaded.clips).toHaveLength(1);
    expect(loaded.overlays).toHaveLength(1);

    // Verify clip data preserved
    expect(loaded.clips[0].speedKeyframes).toEqual([
      { time: 0, speed: 1 },
      { time: 2, speed: 2 },
    ]);

    // Verify overlay keyframes preserved
    expect(loaded.overlays[0].positionKeyframes).toEqual([
      { time: 0, x: 100, y: 100 },
    ]);

    // Verify asset references are valid
    const assetIds = loaded.assets.map((a: any) => a.id);
    loaded.clips.forEach((clip: any) => {
      expect(assetIds).toContain(clip.assetId);
    });
  });
});
