import { Router } from 'express';
import prisma from '../config/database';

const router = Router();

// Create overlay
router.post('/', async (req, res) => {
  try {
    const {
      projectId,
      type,
      track,
      startTime,
      endTime,
      content,
      fontSize,
      color,
      bgColor,
      positionKeyframes,
      scaleKeyframes,
      rotationKeyframes,
      opacityKeyframes,
    } = req.body;

    if (!projectId || !type || !track) {
      return res.status(400).json({ error: 'Missing required fields: projectId, type, track' });
    }

    if (startTime === undefined || endTime === undefined || endTime <= startTime) {
      return res.status(400).json({ error: 'Invalid time range' });
    }

    const validTypes = ['text', 'image'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    }

    const validTracks = ['overlay_1', 'overlay_2'];
    if (!validTracks.includes(track)) {
      return res.status(400).json({ error: `Invalid track. Must be one of: ${validTracks.join(', ')}` });
    }

    const overlay = await prisma.overlay.create({
      data: {
        projectId,
        type,
        track,
        startTime,
        endTime,
        content,
        fontSize,
        color,
        bgColor,
        positionKeyframes: positionKeyframes || [],
        scaleKeyframes: scaleKeyframes || [],
        rotationKeyframes: rotationKeyframes || [],
        opacityKeyframes: opacityKeyframes || [],
      },
    });

    res.json(overlay);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create overlay' });
  }
});

// Update overlay
router.patch('/:id', async (req, res) => {
  try {
    const {
      startTime,
      endTime,
      content,
      fontSize,
      color,
      bgColor,
      positionKeyframes,
      scaleKeyframes,
      rotationKeyframes,
      opacityKeyframes,
    } = req.body;

    const overlay = await prisma.overlay.update({
      where: { id: req.params.id },
      data: {
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        ...(content !== undefined && { content }),
        ...(fontSize !== undefined && { fontSize }),
        ...(color !== undefined && { color }),
        ...(bgColor !== undefined && { bgColor }),
        ...(positionKeyframes !== undefined && { positionKeyframes }),
        ...(scaleKeyframes !== undefined && { scaleKeyframes }),
        ...(rotationKeyframes !== undefined && { rotationKeyframes }),
        ...(opacityKeyframes !== undefined && { opacityKeyframes }),
      },
    });

    res.json(overlay);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update overlay' });
  }
});

// Delete overlay
router.delete('/:id', async (req, res) => {
  try {
    await prisma.overlay.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete overlay' });
  }
});

export default router;
