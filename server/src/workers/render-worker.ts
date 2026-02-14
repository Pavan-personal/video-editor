import { Worker } from 'bullmq';
import { connection } from '../config/redis';
import { renderProject } from '../services/render-service';
import { updateExportProgress, completeExport, failExport } from '../services/export-service';
import dotenv from 'dotenv';

dotenv.config();

const worker = new Worker(
  'video-render',
  async (job) => {
    const { exportId, projectId } = job.data;

    console.log(`[Worker] Starting render for export ${exportId}`);

    try {
      // Update status to RUNNING
      await updateExportProgress(exportId, 0, 'RUNNING');

      // Render the project
      const outputPath = await renderProject(exportId, projectId);

      // Mark as complete
      await completeExport(exportId, outputPath);

      console.log(`[Worker] Completed render for export ${exportId}`);
      
      return { success: true, outputPath };
    } catch (error: any) {
      console.error(`[Worker] Failed render for export ${exportId}:`, error);
      
      await failExport(exportId, error.message);
      
      throw error;
    }
  },
  {
    connection: connection,
    concurrency: 1, // Process one video at a time
  }
);

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err);
});

console.log('[Worker] Render worker started');
