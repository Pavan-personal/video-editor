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
// Text Overlays (Animated with Keyframes)
// ============================================

async function applyTextOverlays(videoPath: string, overlays: any[]): Promise<string> {
  const outputPath = getExportPath(`text_overlay_${uuidv4()}.mp4`);

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(videoPath);
    const filters: string[] = [];

    overlays.forEach((overlay) => {
      const text = sanitizeText(overlay.content || '');
      const fontSize = overlay.fontSize || 24;
      const color = overlay.color || 'white';
      const start = overlay.startTime;
      const end = overlay.endTime;
      const duration = end - start;

      const posKfs = overlay.positionKeyframes || [];
      const opacityKfs = overlay.opacityKeyframes || [];

      // For animated overlays: split into sub-segments with interpolated values
      // Each segment gets a separate drawtext filter with enable timing
      if (posKfs.length >= 2 || opacityKfs.length >= 2) {
        const steps = Math.min(Math.ceil(duration * 2), 20); // 2 steps per second, max 20
        const stepDuration = duration / steps;

        for (let s = 0; s < steps; s++) {
          const t = s * stepDuration;
          const tEnd = (s + 1) * stepDuration;
          const absStart = start + t;
          const absEnd = start + tEnd;

          const x = interpolateValue(posKfs, 'x', t, 100);
          const y = interpolateValue(posKfs, 'y', t, 100);
          const alpha = interpolateValue(opacityKfs, 'opacity', t, 1);

          filters.push(
            `drawtext=text='${text}':x=${Math.round(x)}:y=${Math.round(y)}:fontsize=${fontSize}:fontcolor=${color}:alpha=${alpha.toFixed(2)}:enable='between(t\\,${absStart.toFixed(3)}\\,${absEnd.toFixed(3)})'`
          );
        }
      } else {
        // Static overlay
        const x = posKfs[0]?.x ?? 100;
        const y = posKfs[0]?.y ?? 100;
        const alpha = opacityKfs[0]?.opacity ?? 1;

        filters.push(
          `drawtext=text='${text}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${color}:alpha=${alpha}:enable='between(t\\,${start}\\,${end})'`
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

// ============================================
// Image Overlays (Animated with Keyframes)
// ============================================

async function applyImageOverlays(videoPath: string, overlays: any[]): Promise<string> {
  let currentVideo = videoPath;

  for (const overlay of overlays) {
    const imagePath = resolveAssetPath(overlay.content || '');
    if (!fs.existsSync(imagePath)) continue;

    const outputPath = getExportPath(`img_overlay_${uuidv4()}.mp4`);
    const start = overlay.startTime;
    const end = overlay.endTime;

    const posKfs = overlay.positionKeyframes || [];

    // Use first/last keyframe for static position (animated via enable segments)
    const x = posKfs[0]?.x ?? 100;
    const y = posKfs[0]?.y ?? 100;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(currentVideo)
        .input(imagePath)
        .complexFilter([
          `[1:v]format=rgba[img]`,
          `[0:v][img]overlay=x=${x}:y=${y}:enable='between(t\\,${start}\\,${end})'[outv]`
        ], 'outv')
        .output(outputPath)
        .videoCodec('libx264')
        .audioCodec('copy')
        .outputOptions(['-preset', 'fast'])
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });

    currentVideo = outputPath;
  }

  return currentVideo;
}

// ============================================
// Audio Mixing
// ============================================

async function mixAudioTrack(videoPath: string, audioClips: any[]): Promise<string> {
  const outputPath = getExportPath(`with_audio_${uuidv4()}.mp4`);
  const audioPath = resolveAssetPath(audioClips[0].asset.filepath);

  if (!fs.existsSync(audioPath)) return videoPath;

  return new Promise((resolve, reject) => {
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
        // Fallback: if mixing fails, keep original audio
        console.error('[Render] Audio mix failed:', err.message);
        fs.copyFileSync(videoPath, outputPath);
        resolve(outputPath);
      })
      .run();
  });
}

// ============================================
// Utilities
// ============================================

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
