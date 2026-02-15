import ffmpeg from 'fluent-ffmpeg';
import prisma from '../config/database';
import { getExportPath } from '../config/storage';
import { v4 as uuidv4 } from 'uuid';
import { evaluateSpeedRamp, SpeedKeyframe } from '../utils/time-engine';
import { updateExportProgress } from './export-service';
import path from 'path';
import fs from 'fs';

interface RenderContext {
  exportId: string;
  projectId: string;
  outputPath: string;
}

function resolveAssetPath(filepath: string): string {
  if (path.isAbsolute(filepath)) return filepath;
  return path.resolve(filepath);
}

// Sanitize text for FFmpeg drawtext (prevent injection)
function sanitizeText(text: string): string {
  return text.replace(/[':;\\]/g, '').replace(/\n/g, ' ');
}

// Convert CSS hex color (#rrggbb) to FFmpeg color format (0xRRGGBB)
function cssToFfmpegColor(cssColor: string): string {
  if (cssColor.startsWith('#')) return '0x' + cssColor.slice(1);
  return cssColor;
}

export async function renderProject(exportId: string, projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      clips: { include: { asset: true }, orderBy: { startTime: 'asc' } },
      overlays: { orderBy: { startTime: 'asc' } },
    },
  });

  if (!project) throw new Error('Project not found');

  const outputFilename = `export_${uuidv4()}.mp4`;
  const outputPath = getExportPath(outputFilename);
  const ctx: RenderContext = { exportId, projectId, outputPath };
  const tempFiles: string[] = [];

  try {
    await updateExportProgress(exportId, 5, 'RUNNING');

    const { clips, overlays } = project;
    if (clips.length === 0) throw new Error('No clips to render');

    const trackA = clips.filter((c: any) => c.track === 'video_a');
    const trackB = clips.filter((c: any) => c.track === 'video_b');
    const audioClips = clips.filter((c: any) => c.track === 'audio');

    // Step 1: Render Track A clips
    await updateExportProgress(exportId, 10);
    let baseVideo: string | null = null;
    if (trackA.length > 0) {
      baseVideo = await renderTrackClips(trackA, tempFiles);
      tempFiles.push(baseVideo);
    }

    if (!baseVideo) throw new Error('No video clips on Track A');

    // Compute the maximum end time across all clips and overlays
    const allEnds = [
      ...clips.map((c: any) => c.endTime),
      ...overlays.map((o: any) => o.endTime),
    ];
    const projectDuration = Math.max(...allEnds);

    // Get base video duration
    const baseDuration = await getVideoDuration(baseVideo);

    // If overlays extend beyond the video, pad the video with black frames
    if (projectDuration > baseDuration + 0.1) {
      const padded = await padVideoToLength(baseVideo, projectDuration, tempFiles);
      tempFiles.push(padded);
      baseVideo = padded;
    }

    // Step 2: Composite Track B on top of Track A
    await updateExportProgress(exportId, 30);
    if (trackB.length > 0) {
      const trackBVideo = await renderTrackClips(trackB, tempFiles);
      tempFiles.push(trackBVideo);

      const composited = await compositeTrackB(baseVideo, trackBVideo, trackB, tempFiles);
      tempFiles.push(composited);
      baseVideo = composited;
    }

    // Step 3: Apply text overlays with animated keyframes
    await updateExportProgress(exportId, 50);
    const textOverlays = overlays.filter((o: any) => o.type === 'text');
    if (textOverlays.length > 0) {
      const withText = await applyTextOverlays(baseVideo, textOverlays);
      tempFiles.push(withText);
      baseVideo = withText;
    }

    // Step 4: Apply image overlays with animated keyframes
    await updateExportProgress(exportId, 70);
    const imageOverlays = overlays.filter((o: any) => o.type === 'image');
    if (imageOverlays.length > 0) {
      const withImages = await applyImageOverlays(baseVideo, imageOverlays);
      tempFiles.push(withImages);
      baseVideo = withImages;
    }

    // Step 5: Mix audio track if present
    await updateExportProgress(exportId, 85);
    if (audioClips.length > 0) {
      const withAudio = await mixAudioTrack(baseVideo, audioClips);
      tempFiles.push(withAudio);
      baseVideo = withAudio;
    }

    // Move final output
    await updateExportProgress(exportId, 95);
    fs.copyFileSync(baseVideo, ctx.outputPath);

    return ctx.outputPath;
  } finally {
    tempFiles.forEach(file => {
      try {
        if (fs.existsSync(file) && file !== ctx.outputPath) fs.unlinkSync(file);
      } catch {}
    });
  }
}

// ============================================
// Track Rendering
// ============================================

async function renderTrackClips(clips: any[], tempFiles: string[]): Promise<string> {
  const renderedClips: string[] = [];

  for (const clip of clips) {
    const rendered = await renderClipWithSpeedRamp(clip);
    renderedClips.push(rendered);
    tempFiles.push(rendered);
  }

  if (renderedClips.length === 1) return renderedClips[0];

  const output = getExportPath(`track_${uuidv4()}.mp4`);
  await concatenateFiles(renderedClips, output);
  return output;
}

async function renderClipWithSpeedRamp(clip: any): Promise<string> {
  const speedKeyframes: SpeedKeyframe[] = clip.speedKeyframes as SpeedKeyframe[];
  const sourcePath = resolveAssetPath(clip.asset.filepath);
  const outputPath = getExportPath(`clip_${uuidv4()}.mp4`);
  const duration = clip.endTime - clip.startTime;

  if (speedKeyframes.length === 0) {
    return renderSimpleClip(sourcePath, clip.trimStart, duration, outputPath);
  }

  return renderSegmentedClip(clip, speedKeyframes, outputPath);
}

async function renderSimpleClip(
  sourcePath: string, trimStart: number, duration: number, outputPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(trimStart)
      .setDuration(duration)
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset', 'fast'])
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

async function renderSegmentedClip(
  clip: any, keyframes: SpeedKeyframe[], outputPath: string
): Promise<string> {
  const segments: string[] = [];
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const clipDuration = clip.endTime - clip.startTime;

  try {
    for (let i = 0; i < sorted.length; i++) {
      const kf = sorted[i];
      const nextKf = sorted[i + 1];
      const segStart = kf.time;
      const segEnd = nextKf ? nextKf.time : clipDuration;
      const segDuration = segEnd - segStart;

      if (segDuration <= 0) continue;

      const sourceStart = clip.trimStart + evaluateSpeedRamp(segStart, sorted);
      const segPath = getExportPath(`seg_${uuidv4()}.mp4`);
      segments.push(segPath);

      await renderSegment(
        resolveAssetPath(clip.asset.filepath),
        sourceStart, segDuration, kf.speed, segPath
      );
    }

    if (segments.length === 1) {
      fs.renameSync(segments[0], outputPath);
      return outputPath;
    }

    await concatenateFiles(segments, outputPath);
    return outputPath;
  } finally {
    segments.forEach(seg => {
      try {
        if (fs.existsSync(seg) && seg !== outputPath) fs.unlinkSync(seg);
      } catch {}
    });
  }
}

async function renderSegment(
  sourcePath: string, sourceStart: number, duration: number,
  speed: number, outputPath: string
): Promise<void> {
  // Hold (freeze frame)
  if (speed < 0.01) {
    return renderFreezeFrame(sourcePath, sourceStart, duration, outputPath);
  }

  return new Promise((resolve, reject) => {
    const sourceDuration = duration * speed;

    let cmd = ffmpeg(sourcePath)
      .setStartTime(sourceStart)
      .setDuration(sourceDuration);

    if (speed !== 1) {
      cmd = cmd.videoFilters(`setpts=${1 / speed}*PTS`);

      // atempo supports 0.5-2.0, chain for wider range
      const audioFilters = buildAtempoChain(speed);
      cmd = cmd.audioFilters(audioFilters);
    }

    cmd
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset', 'fast'])
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

function buildAtempoChain(speed: number): string {
  // Clamp to safe range
  const clampedSpeed = Math.max(0.5, Math.min(8, speed));
  const filters: string[] = [];
  let remaining = clampedSpeed;
  
  // atempo supports 0.5-100.0 per filter, chain for wider range
  while (remaining > 2.0 + 0.001) { filters.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5 - 0.001) { filters.push('atempo=0.5'); remaining /= 0.5; }
  
  remaining = Math.max(0.5, Math.min(2.0, remaining));
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(',');
}

async function renderFreezeFrame(
  sourcePath: string, sourceStart: number, duration: number, outputPath: string
): Promise<void> {
  const framePath = outputPath.replace('.mp4', '_frame.png');

  return new Promise((resolve, reject) => {
    // Extract single frame
    ffmpeg(sourcePath)
      .setStartTime(sourceStart)
      .frames(1)
      .output(framePath)
      .on('end', () => {
        // Create video from single frame
        ffmpeg(framePath)
          .loop(duration)
          .outputOptions(['-t', String(duration), '-pix_fmt', 'yuv420p'])
          .output(outputPath)
          .videoCodec('libx264')
          .outputOptions(['-preset', 'fast'])
          .on('end', () => {
            if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
            resolve();
          })
          .on('error', reject)
          .run();
      })
      .on('error', reject)
      .run();
  });
}

// ============================================
// Track B Compositing
// ============================================

async function compositeTrackB(
  baseVideo: string, trackBVideo: string, trackBClips: any[], tempFiles: string[]
): Promise<string> {
  const outputPath = getExportPath(`composite_${uuidv4()}.mp4`);

  return new Promise((resolve, reject) => {
    // Overlay Track B on Track A (top track wins)
    const startTime = trackBClips[0]?.startTime || 0;

    ffmpeg(baseVideo)
      .input(trackBVideo)
      .complexFilter([
        `[1:v]setpts=PTS+${startTime}/TB[bv]`,
        `[0:v][bv]overlay=enable='between(t,${startTime},${startTime + 999})'[outv]`
      ], 'outv')
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset', 'fast'])
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        // Fallback: just use Track A if compositing fails
        console.error('[Render] Track B composite failed, using Track A only:', err.message);
        fs.copyFileSync(baseVideo, outputPath);
        resolve(outputPath);
      })
      .run();
  });
}

// ============================================
// Text Overlays (Animated with Keyframes + Animation Presets)
// ============================================

/**
 * Compute animation effects for a text overlay at a given local time.
 * Returns adjustments to x, y, alpha, and fontSize that replicate the CSS animations.
 */
function computeTextAnimation(
  animation: string, localTime: number, duration: number,
  baseX: number, baseY: number, baseAlpha: number, baseFontSize: number
): { x: number; y: number; alpha: number; fontSize: number } {
  const entranceDur = Math.min(0.5, duration);
  const progress = Math.min(1, localTime / entranceDur);
  const exitStart = duration - 0.5;
  const exitProgress = localTime > exitStart ? Math.min(1, (localTime - exitStart) / 0.5) : 0;

  let x = baseX, y = baseY, alpha = baseAlpha, fontSize = baseFontSize;

  switch (animation) {
    case 'fade':
      alpha *= exitProgress > 0 ? (1 - exitProgress) : progress;
      break;
    case 'slide-up':
      alpha *= exitProgress > 0 ? (1 - exitProgress) : progress;
      y += exitProgress > 0 ? (-30 * exitProgress) : (30 * (1 - progress));
      break;
    case 'slide-left':
      alpha *= exitProgress > 0 ? (1 - exitProgress) : progress;
      x += exitProgress > 0 ? (-60 * exitProgress) : (60 * (1 - progress));
      break;
    case 'scale': {
      alpha *= exitProgress > 0 ? (1 - exitProgress) : progress;
      const scaleFactor = exitProgress > 0
        ? (1 + exitProgress * 0.5)
        : (0.3 + 0.7 * progress);
      fontSize = Math.round(baseFontSize * scaleFactor);
      break;
    }
    case 'bounce': {
      alpha *= exitProgress > 0 ? (1 - exitProgress) : Math.min(1, progress * 2);
      const bounce = progress < 1
        ? Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress) * 20
        : 0;
      y += -bounce;
      break;
    }
    case 'blur':
      // FFmpeg drawtext doesn't support blur, approximate with alpha fade
      alpha *= exitProgress > 0 ? (1 - exitProgress) : progress;
      break;
    default:
      break;
  }

  return { x: Math.round(x), y: Math.round(y), alpha: Math.max(0, Math.min(1, alpha)), fontSize };
}

async function applyTextOverlays(videoPath: string, overlays: any[]): Promise<string> {
  const outputPath = getExportPath(`text_overlay_${uuidv4()}.mp4`);
  const dim = await getVideoDimensions(videoPath);
  const sx = dim.width / REF_W;
  const sy = dim.height / REF_H;

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(videoPath);
    const filters: string[] = [];

    overlays.forEach((overlay) => {
      const rawContent = overlay.content || '';
      const parts = rawContent.split('|||');
      const text = sanitizeText(parts[0]);
      const animation = parts[1] || 'none';
      const fontSize = Math.round((overlay.fontSize || 24) * sx);
      const color = cssToFfmpegColor(overlay.color || '#ffffff');
      const bgColor = cssToFfmpegColor(overlay.bgColor || '#000000');
      const start = overlay.startTime;
      const end = overlay.endTime;
      const duration = end - start;

      // Base drawtext params with background box
      const boxParams = `box=1:boxcolor=${bgColor}@0.8:boxborderw=6`;

      const posKfs = overlay.positionKeyframes || [];
      const opacityKfs = overlay.opacityKeyframes || [];
      const scaleKfs = overlay.scaleKeyframes || [];

      const hasAnimation = animation !== 'none';
      const hasKeyframeAnimation = posKfs.length >= 2 || opacityKfs.length >= 2 || scaleKfs.length >= 2;

      if (hasAnimation || hasKeyframeAnimation) {
        const stepsPerSec = hasAnimation ? 10 : 2;
        const steps = Math.min(Math.ceil(duration * stepsPerSec), 60);
        const stepDuration = duration / steps;

        for (let s = 0; s < steps; s++) {
          const t = s * stepDuration;
          const tEnd = (s + 1) * stepDuration;
          const absStart = start + t;
          const absEnd = start + tEnd;

          let x = Math.round(interpolateValue(posKfs, 'x', t, 100) * sx);
          let y = Math.round(interpolateValue(posKfs, 'y', t, 100) * sy);
          let alpha = interpolateValue(opacityKfs, 'opacity', t, 1);
          const kfScale = interpolateValue(scaleKfs, 'scale', t, 1);
          let fs = Math.round(fontSize * kfScale);

          let stepText = text;
          if (animation === 'typewriter') {
            const revealDur = Math.min(2, duration);
            const charCount = Math.min(text.length, Math.floor((t / revealDur) * text.length));
            stepText = sanitizeText(text.slice(0, Math.max(1, charCount)));
          }

          if (hasAnimation && animation !== 'typewriter') {
            const anim = computeTextAnimation(animation, t, duration, x, y, alpha, fs);
            x = anim.x;
            y = anim.y;
            alpha = anim.alpha;
            fs = anim.fontSize;
          }

          filters.push(
            `drawtext=text='${animation === 'typewriter' ? stepText : text}':x=${x}-tw/2:y=${y}-th/2:fontsize=${fs}:fontcolor=${color}:alpha=${alpha.toFixed(2)}:${boxParams}:enable='between(t\\,${absStart.toFixed(3)}\\,${absEnd.toFixed(3)})'`
          );
        }
      } else {
        const x = Math.round((posKfs[0]?.x ?? 100) * sx);
        const y = Math.round((posKfs[0]?.y ?? 100) * sy);
        const alpha = opacityKfs[0]?.opacity ?? 1;
        const kfScale = scaleKfs[0]?.scale ?? 1;
        const fs = Math.round(fontSize * kfScale);

        filters.push(
          `drawtext=text='${text}':x=${x}-tw/2:y=${y}-th/2:fontsize=${fs}:fontcolor=${color}:alpha=${alpha}:${boxParams}:enable='between(t\\,${start}\\,${end})'`
        );
      }
    });

    cmd
      .videoFilters(filters)
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('copy')
      .outputOptions(['-preset', 'fast'])
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

/**
 * Simple linear interpolation for a property at a given local time
 */
function interpolateValue(keyframes: any[], prop: string, time: number, defaultVal: number): number {
  if (keyframes.length === 0) return defaultVal;
  
  const sorted = [...keyframes].sort((a: any, b: any) => a.time - b.time);
  
  if (time <= sorted[0].time) return sorted[0][prop] ?? defaultVal;
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1][prop] ?? defaultVal;

  for (let i = 0; i < sorted.length - 1; i++) {
    if (time >= sorted[i].time && time <= sorted[i + 1].time) {
      const t1 = sorted[i].time;
      const t2 = sorted[i + 1].time;
      const v1 = sorted[i][prop] ?? defaultVal;
      const v2 = sorted[i + 1][prop] ?? defaultVal;
      const progress = (time - t1) / (t2 - t1);
      return v1 + (v2 - v1) * progress;
    }
  }

  return defaultVal;
}

async function getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return resolve({ width: 1280, height: 720 });
      const vs = meta.streams.find(s => s.codec_type === 'video');
      resolve({ width: vs?.width || 1280, height: vs?.height || 720 });
    });
  });
}

// Reference coordinate system used by the UI
const REF_W = 1280;
const REF_H = 720;

// ============================================
// Image Overlays (Animated with Keyframes)
// ============================================

async function applyImageOverlays(videoPath: string, overlays: any[]): Promise<string> {
  let currentVideo = videoPath;
  const dim = await getVideoDimensions(videoPath);
  const sx = dim.width / REF_W;
  const sy = dim.height / REF_H;

  for (const overlay of overlays) {
    const rawContent = (overlay.content || '').split('|||')[0];
    const imagePath = resolveAssetPath(rawContent);
    if (!fs.existsSync(imagePath)) continue;

    const outputPath = getExportPath(`img_overlay_${uuidv4()}.mp4`);
    const start = overlay.startTime;
    const end = overlay.endTime;

    const posKfs = overlay.positionKeyframes || [];
    const scaleKfs = overlay.scaleKeyframes || [];
    const rotKfs = overlay.rotationKeyframes || [];
    const opacityKfs = overlay.opacityKeyframes || [];

    const x = Math.round((posKfs[0]?.x ?? 100) * sx);
    const y = Math.round((posKfs[0]?.y ?? 100) * sy);
    const scale = scaleKfs[0]?.scale ?? 1;
    const rotation = rotKfs[0]?.rotation ?? 0;
    const opacity = opacityKfs[0]?.opacity ?? 1;

    const hasAnimatedKfs = posKfs.length >= 2 || scaleKfs.length >= 2 || rotKfs.length >= 2 || opacityKfs.length >= 2;

    // Base image width in the 1280×720 canvas = 200px, scaled to actual video size.
    const BASE_IMG_W = Math.round(200 * sx);

    if (hasAnimatedKfs) {
      const xExpr = buildInterpolationExpr(posKfs, 'x', start, 100, sx);
      const yExpr = buildInterpolationExpr(posKfs, 'y', start, 100, sy);
      const midTime = (end - start) / 2;
      const midScale = interpolateValue(scaleKfs, 'scale', midTime, 1);
      const midRotation = interpolateValue(rotKfs, 'rotation', midTime, 0);
      const midOpacity = interpolateValue(opacityKfs, 'opacity', midTime, 1);

      await new Promise<void>((resolve, reject) => {
        const targetW = Math.round(BASE_IMG_W * midScale);
        const rotRad = (midRotation * Math.PI / 180).toFixed(4);
        const rotFilter = midRotation !== 0 ? `,rotate=${rotRad}:fillcolor=none:ow=rotw(${rotRad}):oh=roth(${rotRad})` : '';
        const alphaF = midOpacity < 1 ? `,colorchannelmixer=aa=${midOpacity.toFixed(2)}` : '';
        ffmpeg(currentVideo)
          .input(imagePath)
          .complexFilter([
            `[1:v]scale=${targetW}:-1,format=rgba${rotFilter}${alphaF}[img]`,
            `[0:v][img]overlay=x='(${xExpr})-overlay_w/2':y='(${yExpr})-overlay_h/2':enable='between(t,${start},${end})'[outv]`
          ], 'outv')
          .output(outputPath)
          .videoCodec('libx264')
          .audioCodec('copy')
          .outputOptions(['-preset', 'fast'])
          .on('end', () => resolve())
          .on('error', reject)
          .run();
      });
    } else {
      // Static overlay
      const targetW = Math.round(BASE_IMG_W * scale);
      const rotRad = (rotation * Math.PI / 180).toFixed(4);
      const rotFilter = rotation !== 0 ? `,rotate=${rotRad}:fillcolor=none:ow=rotw(${rotRad}):oh=roth(${rotRad})` : '';
      const alphaFilter = opacity < 1 ? `,colorchannelmixer=aa=${opacity.toFixed(2)}` : '';
      const ox = `${x}-overlay_w/2`;
      const oy = `${y}-overlay_h/2`;

      await new Promise<void>((resolve, reject) => {
        ffmpeg(currentVideo)
          .input(imagePath)
          .complexFilter([
            `[1:v]scale=${targetW}:-1,format=rgba${rotFilter}${alphaFilter}[img]`,
            `[0:v][img]overlay=x='${ox}':y='${oy}':enable='between(t\\,${start}\\,${end})'[outv]`
          ], 'outv')
          .output(outputPath)
          .videoCodec('libx264')
          .audioCodec('copy')
          .outputOptions(['-preset', 'fast'])
          .on('end', () => resolve())
          .on('error', reject)
          .run();
      });
    }

    currentVideo = outputPath;
  }

  return currentVideo;
}

/**
 * Build an FFmpeg expression string that linearly interpolates between keyframes.
 * Uses FFmpeg's `t` variable (current time in seconds) and `if()`/`between()` functions.
 * `absOffset` is the overlay's startTime so we can use absolute time `t`.
 */
function buildInterpolationExpr(keyframes: any[], prop: string, absOffset: number, defaultVal: number, scaleFactor = 1): string {
  if (keyframes.length === 0) return String((defaultVal * scaleFactor).toFixed(3));

  const sorted = [...keyframes].sort((a: any, b: any) => a.time - b.time);

  if (sorted.length === 1) return String(((sorted[0][prop] ?? defaultVal) * scaleFactor).toFixed(3));

  const lt = `(t-${absOffset.toFixed(3)})`;

  let expr = String(((sorted[sorted.length - 1][prop] ?? defaultVal) * scaleFactor).toFixed(3));

  for (let i = sorted.length - 2; i >= 0; i--) {
    const t1 = sorted[i].time;
    const t2 = sorted[i + 1].time;
    const v1 = (sorted[i][prop] ?? defaultVal) * scaleFactor;
    const v2 = (sorted[i + 1][prop] ?? defaultVal) * scaleFactor;
    const dt = t2 - t1;

    if (dt <= 0) continue;

    const lerpExpr = `${v1.toFixed(3)}+${(v2 - v1).toFixed(3)}*(${lt}-${t1.toFixed(3)})/${dt.toFixed(3)}`;

    if (i === 0) {
      expr = `if(lt(${lt},${t2.toFixed(3)}),if(lt(${lt},${t1.toFixed(3)}),${v1.toFixed(3)},${lerpExpr}),${expr})`;
    } else {
      expr = `if(lt(${lt},${t2.toFixed(3)}),${lerpExpr},${expr})`;
    }
  }

  return expr;
}

// ============================================
// Audio Mixing
// ============================================

async function mixAudioTrack(videoPath: string, audioClips: any[]): Promise<string> {
  const outputPath = getExportPath(`with_audio_${uuidv4()}.mp4`);
  const audioPath = resolveAssetPath(audioClips[0].asset.filepath);

  if (!fs.existsSync(audioPath)) return videoPath;

  // Check if base video has an audio stream
  const hasVideoAudio = await new Promise<boolean>((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return resolve(false);
      resolve(meta.streams.some(s => s.codec_type === 'audio'));
    });
  });

  return new Promise((resolve, reject) => {
    if (hasVideoAudio) {
      // Mix both audio streams
      ffmpeg(videoPath)
        .input(audioPath)
        .complexFilter([
          '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]'
        ], undefined)
        .outputOptions(['-map', '0:v', '-map', '[aout]'])
        .output(outputPath)
        .videoCodec('copy')
        .audioCodec('aac')
        .on('end', () => resolve(outputPath))
        .on('error', (err) => {
          console.error('[Render] Audio mix failed:', err.message);
          fs.copyFileSync(videoPath, outputPath);
          resolve(outputPath);
        })
        .run();
    } else {
      // No audio in video — just add the audio track directly
      ffmpeg(videoPath)
        .input(audioPath)
        .outputOptions(['-map', '0:v', '-map', '1:a', '-shortest'])
        .output(outputPath)
        .videoCodec('copy')
        .audioCodec('aac')
        .on('end', () => resolve(outputPath))
        .on('error', (err) => {
          console.error('[Render] Audio add failed:', err.message);
          fs.copyFileSync(videoPath, outputPath);
          resolve(outputPath);
        })
        .run();
    }
  });
}

// ============================================
// Utilities
// ============================================

async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return resolve(0);
      resolve(meta.format.duration || 0);
    });
  });
}

async function padVideoToLength(videoPath: string, targetDuration: number, tempFiles: string[]): Promise<string> {
  const outputPath = getExportPath(`padded_${uuidv4()}.mp4`);

  // Use tpad filter to extend video with black frames — handles format matching automatically
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const currentDuration = meta.format.duration || 0;
      const padDuration = targetDuration - currentDuration;
      if (padDuration <= 0) return resolve(videoPath);

      const hasAudio = meta.streams.some(s => s.codec_type === 'audio');

      const cmd = ffmpeg(videoPath)
        .videoFilters(`tpad=stop_mode=clone:stop_duration=${padDuration.toFixed(3)}`);

      if (hasAudio) {
        cmd.audioFilters(`apad=pad_dur=${padDuration.toFixed(3)}`);
      }

      cmd
        .output(outputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset', 'fast'])
        .on('end', () => resolve(outputPath))
        .on('error', (padErr) => {
          // Fallback: just use original if padding fails
          console.error('[Render] Padding failed:', padErr.message);
          resolve(videoPath);
        })
        .run();
    });
  });
}

async function concatenateFiles(files: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const listFile = getExportPath(`concat_${uuidv4()}.txt`);
    const content = files.map(f => `file '${path.resolve(f)}'`).join('\n');

    try {
      fs.writeFileSync(listFile, content);
    } catch (err) {
      return reject(new Error(`Failed to write concat file: ${err}`));
    }

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .output(outputPath)
      .videoCodec('copy')
      .audioCodec('copy')
      .on('end', () => {
        if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
        resolve();
      })
      .on('error', (err) => {
        if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
        reject(err);
      })
      .run();
  });
}
