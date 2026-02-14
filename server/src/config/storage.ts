import path from 'path';
import fs from 'fs';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
export const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, '../../exports');
export const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '524288000'); // 500MB

// Ensure directories exist
[UPLOAD_DIR, EXPORT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export function getAssetPath(filename: string): string {
  return path.join(UPLOAD_DIR, filename);
}

export function getExportPath(filename: string): string {
  return path.join(EXPORT_DIR, filename);
}
