import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import projectRoutes from './routes/projects';
import assetRoutes from './routes/assets';
import clipRoutes from './routes/clips';
import overlayRoutes from './routes/overlays';
import exportRoutes from './routes/exports';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (thumbnails, assets)
import { UPLOAD_DIR, EXPORT_DIR } from './config/storage';
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/exports', express.static(EXPORT_DIR));

// Routes
app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/clips', clipRoutes);
app.use('/api/overlays', overlayRoutes);
app.use('/api/exports', exportRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});
