import prisma from './config/database';
import path from 'path';
import fs from 'fs';
import { UPLOAD_DIR } from './config/storage';
import { extractVideoMetadata, generateThumbnail } from './services/asset-service';
import { v4 as uuidv4 } from 'uuid';

/**
 * Seed script — creates a demo project with sample assets, clips, overlays, and speed keyframes.
 * 
 * Place video files in server/uploads/ before running, or it will look for sample.mp4 in the repo root.
 * Usage: npx tsx src/seed.ts
 */
async function seed() {
  console.log('Seeding database...');

  // Clean existing data
  await prisma.export.deleteMany();
  await prisma.overlay.deleteMany();
  await prisma.clip.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.project.deleteMany();

  const project = await prisma.project.create({ data: { name: 'Demo Project' } });
  console.log(`Created project: ${project.name} (${project.id})`);

  // Find video files to use as assets
  const samplePaths: string[] = [];
  
  // Check for sample.mp4 in repo root
  const repoSample = path.resolve(__dirname, '../../..', 'sample.mp4');
  if (fs.existsSync(repoSample)) samplePaths.push(repoSample);

  // Check uploads dir for any existing videos
  if (fs.existsSync(UPLOAD_DIR)) {
    const files = fs.readdirSync(UPLOAD_DIR).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));
    for (const f of files.slice(0, 5)) {
      const full = path.join(UPLOAD_DIR, f);
      if (!samplePaths.includes(full)) samplePaths.push(full);
    }
  }

  if (samplePaths.length === 0) {
    console.log('No video files found. Place .mp4 files in server/uploads/ or sample.mp4 in repo root.');
    console.log('Project created but empty.');
    await prisma.$disconnect();
    return;
  }

  // Create assets from found videos
  const assets = [];
  for (let i = 0; i < Math.min(samplePaths.length, 3); i++) {
    const src = samplePaths[i];
    const ext = path.extname(src);
    const destName = `${uuidv4()}${ext}`;
    const destPath = path.join(UPLOAD_DIR, destName);

    // Copy to uploads if not already there
    if (!src.startsWith(UPLOAD_DIR)) {
      fs.copyFileSync(src, destPath);
    }
    const filepath = src.startsWith(UPLOAD_DIR) ? src : destPath;

    let metadata = { duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264', hasAudio: true };
    try {
      metadata = await extractVideoMetadata(filepath);
    } catch (e) {
      console.warn(`Could not extract metadata for ${path.basename(src)}, using defaults`);
    }

    let thumbnailPath: string | null = null;
    try {
      const thumbName = `thumb_${uuidv4()}.png`;
      thumbnailPath = path.join(UPLOAD_DIR, thumbName);
      await generateThumbnail(filepath, thumbnailPath);
    } catch {
      thumbnailPath = null;
    }

    const asset = await prisma.asset.create({
      data: {
        projectId: project.id,
        type: 'video',
        filename: path.basename(src),
        filepath,
        duration: metadata.duration,
        fps: metadata.fps,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        hasAudio: metadata.hasAudio,
        thumbnailPath,
      },
    });
    assets.push(asset);
    console.log(`  Asset ${i + 1}: ${asset.filename} (${metadata.duration.toFixed(1)}s)`);
  }

  // Create clips on timeline
  let timeOffset = 0;
  const clips = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const dur = Math.min(a.duration || 5, 10); // cap at 10s per clip for demo
    const clip = await prisma.clip.create({
      data: {
        projectId: project.id,
        assetId: a.id,
        track: 'video_a',
        startTime: timeOffset,
        endTime: timeOffset + dur,
        trimStart: 0,
        // First clip gets a speed ramp, others get normal speed
        speedKeyframes: i === 0
          ? [{ time: 0, speed: 1 }, { time: dur / 2, speed: 0.5 }, { time: dur, speed: 2 }]
          : [{ time: 0, speed: 1 }],
      },
    });
    clips.push(clip);
    console.log(`  Clip ${i + 1}: ${a.filename} @ ${timeOffset.toFixed(1)}s-${(timeOffset + dur).toFixed(1)}s${i === 0 ? ' (speed ramp: 1x→0.5x→2x)' : ''}`);
    timeOffset += dur;
  }

  // Create text overlay with animated keyframes
  const overlay = await prisma.overlay.create({
    data: {
      projectId: project.id,
      type: 'text',
      track: 'overlay_1',
      startTime: 1,
      endTime: 6,
      content: 'Demo Overlay|||fade',
      fontSize: 48,
      color: '#ffffff',
      bgColor: '#000000',
      positionKeyframes: [
        { time: 0, x: 100, y: 80 },
        { time: 5, x: 400, y: 200 },
      ],
      scaleKeyframes: [
        { time: 0, scale: 1 },
        { time: 2.5, scale: 1.5 },
        { time: 5, scale: 1 },
      ],
      rotationKeyframes: [
        { time: 0, rotation: 0 },
      ],
      opacityKeyframes: [
        { time: 0, opacity: 0 },
        { time: 0.5, opacity: 1 },
        { time: 4.5, opacity: 1 },
        { time: 5, opacity: 0 },
      ],
    },
  });
  console.log(`  Overlay: "${overlay.content}" @ 1s-6s with position + scale + opacity keyframes`);

  console.log('\nSeed complete!');
  console.log(`  ${assets.length} assets, ${clips.length} clips, 1 overlay`);
  console.log(`  Clip 1 has speed ramp: 1x → 0.5x → 2x`);
  console.log(`  Text overlay has animated position, scale, and opacity keyframes`);

  await prisma.$disconnect();
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
