import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { UPLOAD_DIR, MAX_FILE_SIZE } from '../config/storage';
import { createAsset } from '../services/asset-service';

const router = Router();

// Configure multer
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mov|avi|mkv|mp3|wav|png|jpg|jpeg/;
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    
    if (allowedTypes.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

// Upload asset
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { projectId, type } = req.body;

    if (!projectId || !type) {
      return res.status(400).json({ error: 'Missing projectId or type' });
    }

    const asset = await createAsset(projectId, req.file, type);

    res.json(asset);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to upload asset' });
  }
});

// Get assets for project
router.get('/project/:projectId', async (req, res) => {
  try {
    const prisma = (await import('../config/database')).default;
    
    const assets = await prisma.asset.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(assets);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

export default router;
