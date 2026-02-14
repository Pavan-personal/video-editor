import { Router } from 'express';
import { createExportJob, getExportStatus } from '../services/export-service';
import path from 'path';
import fs from 'fs';

const router = Router();

// Create export job
router.post('/', async (req, res) => {
  try {
    const { projectId } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'Missing projectId' });
    }

    const exportJob = await createExportJob(projectId);

    res.json(exportJob);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create export' });
  }
});

// Get export status
router.get('/:id', async (req, res) => {
  try {
    const exportJob = await getExportStatus(req.params.id);

    if (!exportJob) {
      return res.status(404).json({ error: 'Export not found' });
    }

    res.json(exportJob);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch export status' });
  }
});

// Download export
router.get('/:id/download', async (req, res) => {
  try {
    const exportJob = await getExportStatus(req.params.id);

    if (!exportJob || exportJob.status !== 'COMPLETE' || !exportJob.outputPath) {
      return res.status(404).json({ error: 'Export not ready' });
    }

    if (!fs.existsSync(exportJob.outputPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(exportJob.outputPath, path.basename(exportJob.outputPath));
  } catch (error) {
    res.status(500).json({ error: 'Failed to download export' });
  }
});

export default router;
