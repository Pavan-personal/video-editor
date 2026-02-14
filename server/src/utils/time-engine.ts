/**
 * Time Engine - Core timeline evaluation system
 * 
 * Handles deterministic mapping: timeline_time → clip_local_time → source_time
 * Supports speed ramps with keyframes and holds
 */

export interface SpeedKeyframe {
  time: number;  // time in clip's local timeline (seconds)
  speed: number; // 0x (hold) to 8x
}

export interface TransformKeyframe {
  time: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

/**
 * Evaluate speed-ramped time for a clip
 * 
 * @param clipLocalTime - Time within the clip (0 to clip duration)
 * @param keyframes - Speed keyframes sorted by time
 * @returns Source time in the original asset
 */
export function evaluateSpeedRamp(
  clipLocalTime: number,
  keyframes: SpeedKeyframe[]
): number {
  if (keyframes.length === 0) {
    return clipLocalTime; // No speed ramp, 1:1 mapping
  }

  // Sort keyframes by time (defensive)
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // Before first keyframe
  if (clipLocalTime <= sorted[0].time) {
    return clipLocalTime * sorted[0].speed;
  }

  // After last keyframe
  if (clipLocalTime >= sorted[sorted.length - 1].time) {
    const lastKf = sorted[sorted.length - 1];
    const timeFromLast = clipLocalTime - lastKf.time;
    const sourceTimeAtLast = getSourceTimeAtKeyframe(sorted, sorted.length - 1);
    return sourceTimeAtLast + timeFromLast * lastKf.speed;
  }

  // Between keyframes - find the segment
  for (let i = 0; i < sorted.length - 1; i++) {
    const kf1 = sorted[i];
    const kf2 = sorted[i + 1];

    if (clipLocalTime >= kf1.time && clipLocalTime <= kf2.time) {
      const segmentProgress = (clipLocalTime - kf1.time) / (kf2.time - kf1.time);
      
      // Linear interpolation of speed
      const speed = kf1.speed + (kf2.speed - kf1.speed) * segmentProgress;
      
      // Calculate source time at kf1
      const sourceTimeAtKf1 = getSourceTimeAtKeyframe(sorted, i);
      
      // Integrate speed over the segment
      const segmentDuration = kf2.time - kf1.time;
      const avgSpeed = (kf1.speed + speed) / 2; // Trapezoidal integration
      const sourceOffset = (clipLocalTime - kf1.time) * avgSpeed;
      
      return sourceTimeAtKf1 + sourceOffset;
    }
  }

  return clipLocalTime; // Fallback
}

/**
 * Calculate accumulated source time at a specific keyframe
 */
function getSourceTimeAtKeyframe(keyframes: SpeedKeyframe[], index: number): number {
  let sourceTime = 0;

  for (let i = 0; i < index; i++) {
    const kf1 = keyframes[i];
    const kf2 = keyframes[i + 1];
    const segmentDuration = kf2.time - kf1.time;
    const avgSpeed = (kf1.speed + kf2.speed) / 2;
    sourceTime += segmentDuration * avgSpeed;
  }

  // Add time before first keyframe
  if (keyframes.length > 0) {
    sourceTime += keyframes[0].time * keyframes[0].speed;
  }

  return sourceTime;
}

/**
 * Interpolate transform value at a given time
 */
export function interpolateKeyframes(
  time: number,
  keyframes: TransformKeyframe[],
  property: keyof TransformKeyframe
): number | undefined {
  if (keyframes.length === 0) return undefined;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // Before first keyframe
  if (time <= sorted[0].time) {
    return sorted[0][property] as number;
  }

  // After last keyframe
  if (time >= sorted[sorted.length - 1].time) {
    return sorted[sorted.length - 1][property] as number;
  }

  // Between keyframes
  for (let i = 0; i < sorted.length - 1; i++) {
    const kf1 = sorted[i];
    const kf2 = sorted[i + 1];

    if (time >= kf1.time && time <= kf2.time) {
      const progress = (time - kf1.time) / (kf2.time - kf1.time);
      const val1 = kf1[property] as number;
      const val2 = kf2[property] as number;
      
      if (val1 === undefined || val2 === undefined) return undefined;
      
      return val1 + (val2 - val1) * progress;
    }
  }

  return undefined;
}

/**
 * Timeline evaluation at a specific time
 */
export interface TimelineState {
  time: number;
  activeClips: {
    clipId: string;
    track: string;
    assetId: string;
    sourceTime: number;
    clipLocalTime: number;
  }[];
  activeOverlays: {
    overlayId: string;
    type: string;
    content: string;
    transform: {
      x: number;
      y: number;
      scale: number;
      rotation: number;
      opacity: number;
    };
  }[];
}

export interface ClipData {
  id: string;
  track: string;
  assetId: string;
  startTime: number;
  endTime: number;
  trimStart: number;
  speedKeyframes: SpeedKeyframe[];
}

export interface OverlayData {
  id: string;
  type: string;
  track: string;
  startTime: number;
  endTime: number;
  content: string;
  positionKeyframes: TransformKeyframe[];
  scaleKeyframes: TransformKeyframe[];
  rotationKeyframes: TransformKeyframe[];
  opacityKeyframes: TransformKeyframe[];
}

/**
 * Evaluate timeline at a specific time
 */
export function evaluateTimeline(
  time: number,
  clips: ClipData[],
  overlays: OverlayData[]
): TimelineState {
  const state: TimelineState = {
    time,
    activeClips: [],
    activeOverlays: [],
  };

  // Find active clips
  for (const clip of clips) {
    if (time >= clip.startTime && time < clip.endTime) {
      const clipLocalTime = time - clip.startTime;
      const sourceTime = clip.trimStart + evaluateSpeedRamp(clipLocalTime, clip.speedKeyframes);

      state.activeClips.push({
        clipId: clip.id,
        track: clip.track,
        assetId: clip.assetId,
        sourceTime,
        clipLocalTime,
      });
    }
  }

  // Find active overlays
  for (const overlay of overlays) {
    if (time >= overlay.startTime && time < overlay.endTime) {
      const overlayLocalTime = time - overlay.startTime;

      state.activeOverlays.push({
        overlayId: overlay.id,
        type: overlay.type,
        content: overlay.content,
        transform: {
          x: interpolateKeyframes(overlayLocalTime, overlay.positionKeyframes, 'x') ?? 0,
          y: interpolateKeyframes(overlayLocalTime, overlay.positionKeyframes, 'y') ?? 0,
          scale: interpolateKeyframes(overlayLocalTime, overlay.scaleKeyframes, 'scale') ?? 1,
          rotation: interpolateKeyframes(overlayLocalTime, overlay.rotationKeyframes, 'rotation') ?? 0,
          opacity: interpolateKeyframes(overlayLocalTime, overlay.opacityKeyframes, 'opacity') ?? 1,
        },
      });
    }
  }

  return state;
}
