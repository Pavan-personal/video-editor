import axios from 'axios';

const API_BASE_URL = '/api';
const SERVER_URL = 'http://localhost:3001';

export const api = axios.create({
  baseURL: API_BASE_URL,
});

// Types
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  projectId: string;
  type: string;
  filename: string;
  filepath: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  thumbnailPath?: string;
}

export interface SpeedKeyframe {
  time: number;
  speed: number;
}

export interface Clip {
  id: string;
  projectId: string;
  assetId: string;
  track: string;
  startTime: number;
  endTime: number;
  trimStart: number;
  trimEnd?: number;
  speedKeyframes: SpeedKeyframe[];
  asset?: Asset; // included from API joins
}

export interface TransformKeyframe {
  time: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

export interface Overlay {
  id: string;
  projectId: string;
  type: string;
  track: string;
  startTime: number;
  endTime: number;
  content?: string;
  fontSize?: number;
  color?: string;
  bgColor?: string;
  positionKeyframes: TransformKeyframe[];
  scaleKeyframes: TransformKeyframe[];
  rotationKeyframes: TransformKeyframe[];
  opacityKeyframes: TransformKeyframe[];
}

export interface Export {
  id: string;
  projectId: string;
  status: string;
  progress: number;
  outputPath?: string;
  errorMessage?: string;
}

// Backend returns project with includes at top level
export interface ProjectWithData extends Project {
  assets: Asset[];
  clips: Clip[];
  overlays: Overlay[];
}

// Helper to extract thumbnail URL from absolute path
export function getThumbnailUrl(thumbnailPath: string | null | undefined): string | null {
  if (!thumbnailPath) return null;
  // thumbnailPath is stored as absolute path like /app/uploads/thumb_xxx.png
  // Static serving is at /uploads/
  const filename = thumbnailPath.split('/').pop();
  return filename ? `${SERVER_URL}/uploads/${filename}` : null;
}

// API functions
export const projectsApi = {
  create: (name: string) => api.post<Project>('/projects', { name }),
  list: () => api.get<Project[]>('/projects'),
  get: (id: string) => api.get<ProjectWithData>(`/projects/${id}`),
  delete: (id: string) => api.delete(`/projects/${id}`),
};

export const assetsApi = {
  upload: (projectId: string, file: File, onProgress?: (pct: number) => void, extractAudio?: boolean) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('projectId', projectId);
    let type = 'video';
    if (file.type.startsWith('audio/')) type = 'audio';
    else if (file.type.startsWith('image/')) type = 'image';
    if (extractAudio) {
      type = 'audio';
      formData.append('extractAudio', 'true');
    }
    formData.append('type', type);
    return api.post<Asset>('/assets', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      maxBodyLength: 600 * 1024 * 1024, // 600MB
      maxContentLength: 600 * 1024 * 1024,
      timeout: 300000, // 5 min timeout for large files
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
  },
  list: (projectId: string) => api.get<Asset[]>(`/assets/project/${projectId}`),
};

export const clipsApi = {
  create: (data: Partial<Clip>) => api.post<Clip>('/clips', data),
  update: (id: string, data: Partial<Clip>) => api.patch<Clip>(`/clips/${id}`, data),
  delete: (id: string) => api.delete(`/clips/${id}`),
  split: (id: string, time: number) => api.post<{ left: Clip; right: Clip }>(`/clips/${id}/split`, { time }),
};

export const overlaysApi = {
  create: (data: Partial<Overlay>) => api.post<Overlay>('/overlays', data),
  update: (id: string, data: Partial<Overlay>) => api.patch<Overlay>(`/overlays/${id}`, data),
  delete: (id: string) => api.delete(`/overlays/${id}`),
};

export const exportsApi = {
  create: (projectId: string) => api.post<Export>('/exports', { projectId }),
  get: (id: string) => api.get<Export>(`/exports/${id}`),
  download: (id: string) => `${SERVER_URL}/api/exports/${id}/download`,
};
