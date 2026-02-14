import { Router } from 'express';
import prisma from '../config/database';
import { evaluateTimeline, ClipData, OverlayData } from '../utils/time-engine';

const router = Router();

// Evaluate timeline at a specific time
router.get('/:projectId/evaluate', async (req, res) => {
  try {
    const { projectId } = req.params;
    const time = parseFloat(req.query.time as string);

    if (isNaN(time)) {
      return res.status(400).json({ error: 'Missing or invalid time parameter' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        clips: { include: { asset: true } },
        overlays: true,
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const clips: ClipData[] = project.clips.map((c) => ({
      id: c.id,
      track: c.track,
      assetId: c.assetId,
      startTime: c.startTime,
      endTime: c.endTime,
      trimStart: c.trimStart,
      speedKeyframes: (c.speedKeyframes as any[]) || [],
    }));

    const overlays: OverlayData[] = project.overlays.map((o) => ({
      id: o.id,
      type: o.type,
      track: o.track,
      startTime: o.startTime,
      endTime: o.endTime,
      content: o.content || '',
      positionKeyframes: (o.positionKeyframes as any[]) || [],
      scaleKeyframes: (o.scaleKeyframes as any[]) || [],
      rotationKeyframes: (o.rotationKeyframes as any[]) || [],
      opacityKeyframes: (o.opacityKeyframes as any[]) || [],
    }));

    const state = evaluateTimeline(time, clips, overlays);

    res.json(state);
  } catch (error) {
    res.status(500).json({ error: 'Failed to evaluate timeline' });
  }
});

export default router;
