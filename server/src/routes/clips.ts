import { Router } from 'express';
import prisma from '../config/database';

const router = Router();

// Create clip
router.post('/', async (req, res) => {
  try {
    const { projectId, assetId, track, startTime, endTime, trimStart, trimEnd, speedKeyframes } = req.body;

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
    const { startTime, endTime, trimStart, trimEnd, speedKeyframes } = req.body;

    const clip = await prisma.clip.update({
      where: { id: req.params.id },
      data: {
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(trimStart !== undefined && { trimStart }),
        ...(trimEnd !== undefined && { trimEnd }),
        ...(speedKeyframes !== undefined && { speedKeyframes }),
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

export default router;
