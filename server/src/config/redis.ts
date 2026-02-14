import { Queue } from 'bullmq';

// BullMQ connection config (not an instance)
const connectionConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
};

export const renderQueue = new Queue('video-render', { connection: connectionConfig });

export { connectionConfig as connection };
