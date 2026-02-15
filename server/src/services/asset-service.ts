import prisma from '../config/database';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { getAssetPath } from '../config/storage';
import { v4 as uuidv4 } from 'uuid';

interface VideoMetadata {
  duration: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
}

function parseFps(fpsString: string | undefined): number {
  if (!fpsString) return 30;
  const parts = fpsString.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return num / den;
  }
  return parseFloat(fpsString) || 30;
}

export async function extractVideoMetadata(filepath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

      if (!videoStream) {
        return reject(new Error('No video stream found'));
      }

      resolve({
        duration: metadata.format.duration || 0,
        fps: parseFps(videoStream.r_frame_rate),
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        codec: videoStream.codec_name || 'unknown',
        hasAudio: !!audioStream,
      });
    });
  });
}

export async function generateThumbnail(
  filepath: string,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(filepath)
      .screenshots({
        count: 1,
        folder: path.dirname(outputPath),
        filename: path.basename(outputPath),
        size: '320x180',
      })
      .on('end', () => resolve())
      .on('error', reject);
  });
}

export async function extractAudioFromVideo(videoPath: string, outputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate(192)
      .output(outputPath)
      .on('end', () => {
        // Get duration of extracted audio
        ffmpeg.ffprobe(outputPath, (err, meta) => {
          if (err) return resolve(0);
          resolve(meta.format.duration || 0);
        });
      })
      .on('error', reject)
      .run();
  });
}

export async function createAsset(
  projectId: string,
  file: Express.Multer.File,
  type: 'video' | 'audio' | 'image',
  extractAudio = false,
) {
  const filepath = file.path;
  
  let metadata: Partial<VideoMetadata> = {};
  let thumbnailPath: string | null = null;

  // If extractAudio is requested and file is a video, extract audio track
  if (extractAudio && type === 'audio') {
    const audioFilename = `${uuidv4()}.mp3`;
    const audioPath = path.join(path.dirname(filepath), audioFilename);
    const duration = await extractAudioFromVideo(filepath, audioPath);

    return prisma.asset.create({
      data: {
        projectId,
        type: 'audio',
        filename: file.originalname.replace(/\.[^.]+$/, '.mp3'),
        filepath: audioPath,
        duration,
        hasAudio: true,
      },
    });
  }

  if (type === 'video') {
    metadata = await extractVideoMetadata(filepath);
    
    // Generate thumbnail
    const thumbFilename = `thumb_${uuidv4()}.png`;
    thumbnailPath = getAssetPath(thumbFilename);
    await generateThumbnail(filepath, thumbnailPath);
  }

  return prisma.asset.create({
    data: {
      projectId,
      type,
      filename: file.originalname,
      filepath,
      duration: metadata.duration,
      fps: metadata.fps,
      width: metadata.width,
      height: metadata.height,
      codec: metadata.codec,
      hasAudio: metadata.hasAudio || false,
      thumbnailPath,
    },
  });
}
