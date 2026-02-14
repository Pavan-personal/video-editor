import prisma from '../config/database';
import { renderQueue } from '../config/redis';

export async function createExportJob(projectId: string) {
  // Check for existing queued/running export
  const existing = await prisma.export.findFirst({
    where: {
      projectId,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
  });

  if (existing) {
    return existing; // Idempotent - return existing job
  }

  // Create new export record
  const exportRecord = await prisma.export.create({
    data: {
      projectId,
      status: 'QUEUED',
      progress: 0,
    },
  });

  // Add to queue
  await renderQueue.add('render-video', {
    exportId: exportRecord.id,
    projectId,
  });

  return exportRecord;
}

export async function getExportStatus(exportId: string) {
  return prisma.export.findUnique({
    where: { id: exportId },
  });
}

export async function updateExportProgress(
  exportId: string,
  progress: number,
  status?: string
) {
  return prisma.export.update({
    where: { id: exportId },
    data: {
      progress,
      ...(status && { status }),
    },
  });
}

export async function completeExport(exportId: string, outputPath: string) {
  return prisma.export.update({
    where: { id: exportId },
    data: {
      status: 'COMPLETE',
      progress: 100,
      outputPath,
    },
  });
}

export async function failExport(exportId: string, errorMessage: string) {
  return prisma.export.update({
    where: { id: exportId },
    data: {
      status: 'FAILED',
      errorMessage,
    },
  });
}
