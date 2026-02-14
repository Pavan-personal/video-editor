import { Router } from 'express';
import prisma from '../config/database';

const router = Router();

// Create clip
router.post('/', async (req, res) => {
  try {
    const { projectId, assetId, track, startTime, endTime, trimStart, trimEnd, speedKeyframes } = req.body;

    if (!projectId || !assetId || !track) {
      return res.status(400).json({ error: 'Missing required fields: projectId, assetId, track' });
    }

    if (startTime === undefined || endTime === undefined || endTime <= startTime) {
      return res.status(400).json({ error: 'Invalid time range' });
    }

    const validTracks = ['video_a', 'video_b', 'audio'];
    if (!validTracks.includes(track)) {
      return res.status(400).json({ error: `Invalid track. Must be one of: ${validTracks.join(', ')}` });
    }

    // Validate speed keyframes
    if (speedKeyframes && Array.isArray(speedKeyframes)) {
      for (const kf of speedKeyframes) {
        if (kf.speed < 0 || kf.speed > 8) {
          return res.status(400).json({ error: 'Speed must be between 0 and 8' });
        }
      }
    }

    const clip = await prisma.clip.create({
      data: {
        projectId,
        assetId,
        track,
        startTime,
        endTime,
        trimStart: trimStart || 0,
        trimEnd,
        speedKeyframes: speedKeyframes || [],
      },
      include: { asset: true },
    });

    res.json(clip);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create clip' });
  }
});

// Update clip
router.patch('/:id', async (req, res) => {
  try {
    const { startTime, endTime, trimStart, trimEnd, speedKeyframes, track } = req.body;

    const clip = await prisma.clip.update({
      where: { id: req.params.id },
      data: {
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(trimStart !== undefined && { trimStart }),
        ...(trimEnd !== undefined && { trimEnd }),
        ...(speedKeyframes !== undefined && { speedKeyframes }),
        ...(track !== undefined && { track }),
      },
      include: { asset: true },
    });

    res.json(clip);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update clip' });
  }
});

// Delete clip
router.delete('/:id', async (req, res) => {
  try {
    await prisma.clip.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete clip' });
  }
});

// Split clip at playhead
router.post('/:id/split', async (req, res) => {
  try {
    const { time } = req.body; // timeline time to split at

    if (time === undefined) {
      return res.status(400).json({ error: 'Missing split time' });
    }

    const clip = await prisma.clip.findUnique({
      where: { id: req.params.id },
      include: { asset: true },
    });

    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    if (time <= clip.startTime || time >= clip.endTime) {
      return res.status(400).json({ error: 'Split time must be within clip bounds' });
    }

    const splitLocalTime = time - clip.startTime;

    // Update original clip to end at split point
    const leftClip = await prisma.clip.update({
      where: { id: clip.id },
      data: {
        endTime: time,
      },
      include: { asset: true },
    });

    // Create new clip starting at split point
    const rightClip = await prisma.clip.create({
      data: {
        projectId: clip.projectId,
        assetId: clip.assetId,
        track: clip.track,
        startTime: time,
        endTime: clip.endTime,
        trimStart: clip.trimStart + splitLocalTime,
        trimEnd: clip.trimEnd,
        speedKeyframes: clip.speedKeyframes || [],
      },
      include: { asset: true },
    });

    res.json({ left: leftClip, right: rightClip });
  } catch (error) {
    res.status(500).json({ error: 'Failed to split clip' });
  }
});

export default router;
