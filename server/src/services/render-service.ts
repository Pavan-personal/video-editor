import ffmpeg from 'fluent-ffmpeg';
import prisma from '../config/database';
import { getExportPath, UPLOAD_DIR } from '../config/storage';
import { v4 as uuidv4 } from 'uuid';
import { evaluateSpeedRamp, SpeedKeyframe } from '../utils/time-engine';
import path from 'path';
import fs from 'fs';

interface RenderContext {
  exportId: string;
  projectId: string;
  outputPath: string;
}

/**
 * Resolve asset filepath - handles both absolute and relative paths
 */
function resolveAssetPath(filepath: string): string {
  if (path.isAbsolute(filepath)) return filepath;
  // If relative (e.g. "uploads/xxx.mp4"), resolve from working directory
  return path.resolve(filepath);
}

export async function renderProject(exportId: string, projectId: string): Promise<string> {
  // Fetch project data
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      clips: {
        include: { asset: true },
        orderBy: { startTime: 'asc' },
      },
      overlays: {
        orderBy: { startTime: 'asc' },
      },
    },
  });

  if (!project) throw new Error('Project not found');

  const outputFilename = `export_${uuidv4()}.mp4`;
  const outputPath = getExportPath(outputFilename);

  const ctx: RenderContext = { exportId, projectId, outputPath };

  // Strategy: Render video tracks first, then composite overlays
  await renderVideoTracks(ctx, project);

  return outputPath;
}

async function renderVideoTracks(ctx: RenderContext, project: any) {
  const { clips } = project;

  if (clips.length === 0) {
    throw new Error('No clips to render');
  }

  // Group clips by track
  const trackA = clips.filter((c: any) => c.track === 'video_a');
  const trackB = clips.filter((c: any) => c.track === 'video_b');

  // For simplicity: render track A first, then overlay track B
  const tempFiles: string[] = [];

  try {
    // Render each clip with speed ramps
    const renderedClips: { path: string; startTime: number; duration: number }[] = [];

    for (const clip of trackA) {
      const rendered = await renderClipWithSpeedRamp(clip);
      renderedClips.push({
        path: rendered,
        startTime: clip.startTime,
        duration: clip.endTime - clip.startTime,
      });
      tempFiles.push(rendered);
    }

    // Concatenate clips on timeline
    const concatenated = await concatenateClips(renderedClips);
    tempFiles.push(concatenated);

    // Apply overlays
    const withOverlays = await applyOverlays(concatenated, project.overlays);
    tempFiles.push(withOverlays);

    // Move final output
    fs.renameSync(withOverlays, ctx.outputPath);

  } finally {
    // Cleanup temp files
    tempFiles.forEach(file => {
      if (fs.existsSync(file) && file !== ctx.outputPath) {
        fs.unlinkSync(file);
      }
    });
  }
}

async function renderClipWithSpeedRamp(clip: any): Promise<string> {
  const speedKeyframes: SpeedKeyframe[] = clip.speedKeyframes as SpeedKeyframe[];
  const sourcePath = resolveAssetPath(clip.asset.filepath);
  const outputPath = getExportPath(`temp_clip_${uuidv4()}.mp4`);

  // If no speed keyframes, simple trim
  if (speedKeyframes.length === 0) {
    return new Promise((resolve, reject) => {
      const duration = clip.endTime - clip.startTime;
      
      ffmpeg(sourcePath)
        .setStartTime(clip.trimStart)
        .setDuration(duration)
        .output(outputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
    });
  }

  // With speed ramps: segment-based rendering
  return renderClipWithSegments(clip, speedKeyframes, outputPath);
}

async function renderClipWithSegments(
  clip: any,
  keyframes: SpeedKeyframe[],
  outputPath: string
): Promise<string> {
  const segments: string[] = [];
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  try {
    // Create segments between keyframes
    for (let i = 0; i < sorted.length; i++) {
      const kf = sorted[i];
      const nextKf = sorted[i + 1];
      
      const segmentStart = kf.time;
      const segmentEnd = nextKf ? nextKf.time : (clip.endTime - clip.startTime);
      const segmentDuration = segmentEnd - segmentStart;

      if (segmentDuration <= 0) continue;

      const speed = kf.speed;
      const sourceStart = clip.trimStart + evaluateSpeedRamp(segmentStart, sorted);

      const segmentPath = getExportPath(`segment_${uuidv4()}.mp4`);
      segments.push(segmentPath);

      await renderSegment(resolveAssetPath(clip.asset.filepath), sourceStart, segmentDuration, speed, segmentPath);
    }

    // Concatenate segments
    if (segments.length === 1) {
      fs.renameSync(segments[0], outputPath);
      return outputPath;
    }

    await concatenateFiles(segments, outputPath);
    return outputPath;

  } finally {
    segments.forEach(seg => {
      if (fs.existsSync(seg) && seg !== outputPath) {
        fs.unlinkSync(seg);
      }
    });
  }
}

async function renderSegment(
  sourcePath: string,
  sourceStart: number,
  duration: number,
  speed: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Handle hold (0x speed) - freeze frame
    if (speed === 0 || speed < 0.01) {
      ffmpeg(sourcePath)
        .setStartTime(sourceStart)
        .frames(1)
        .output(outputPath.replace('.mp4', '_frame.png'))
        .on('end', () => {
          // Create video from single frame
          ffmpeg(outputPath.replace('.mp4', '_frame.png'))
            .loop(duration)
            .outputOptions(['-t', String(duration)])
            .output(outputPath)
            .videoCodec('libx264')
            .outputOptions(['-pix_fmt', 'yuv420p'])
            .on('end', () => {
              // Cleanup frame
              const framePath = outputPath.replace('.mp4', '_frame.png');
              if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
              resolve();
            })
            .on('error', reject)
            .run();
        })
        .on('error', reject)
        .run();
      return;
    }

    const sourceDuration = duration * speed;

    let cmd = ffmpeg(sourcePath)
      .setStartTime(sourceStart)
      .setDuration(sourceDuration);

    // Apply speed filter
    if (speed !== 1) {
      const videoFilter = `setpts=${1/speed}*PTS`;
      
      // atempo only supports 0.5 to 2.0, chain for wider range
      const audioFilters: string[] = [];
      let remaining = speed;
      while (remaining > 2.0) {
        audioFilters.push('atempo=2.0');
        remaining /= 2.0;
      }
      while (remaining < 0.5) {
        audioFilters.push('atempo=0.5');
        remaining /= 0.5;
      }
      audioFilters.push(`atempo=${remaining}`);
      
      cmd = cmd
        .videoFilters(videoFilter)
        .audioFilters(audioFilters.join(','));
    }

    cmd
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

async function concatenateFiles(files: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const listFile = getExportPath(`concat_${uuidv4()}.txt`);
    
    // Use absolute paths in concat file
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

async function concatenateClips(
  clips: { path: string; startTime: number; duration: number }[]
): Promise<string> {
  if (clips.length === 1) return clips[0].path;

  const outputPath = getExportPath(`concat_timeline_${uuidv4()}.mp4`);
  const files = clips.map(c => c.path);
  await concatenateFiles(files, outputPath);
  return outputPath;
}

async function applyOverlays(videoPath: string, overlays: any[]): Promise<string> {
  if (overlays.length === 0) return videoPath;

  const outputPath = getExportPath(`with_overlays_${uuidv4()}.mp4`);

  // Simplified: apply text overlays only (image overlays similar)
  const textOverlays = overlays.filter(o => o.type === 'text');

  if (textOverlays.length === 0) return videoPath;

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(videoPath);

    // Build drawtext filters
    const filters: string[] = [];
    textOverlays.forEach(overlay => {
      const posKf = overlay.positionKeyframes[0] || { x: 100, y: 100 };
      const opacityKf = overlay.opacityKeyframes[0] || { opacity: 1 };
      
      filters.push(
        `drawtext=text='${overlay.content}':x=${posKf.x}:y=${posKf.y}:fontsize=${overlay.fontSize || 24}:fontcolor=${overlay.color || 'white'}:alpha=${opacityKf.opacity}`
      );
    });

    cmd
      .videoFilters(filters)
      .output(outputPath)
      .videoCodec('libx264')
      .audioCodec('copy')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}
