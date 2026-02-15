import { useRef } from 'react';
import { Upload, Film, Music, Image } from 'lucide-react';
import type { Asset } from '../api/client';
import { getThumbnailUrl } from '../api/client';

interface Props {
  assets: Asset[];
  onUpload: (file: File, intent?: 'video' | 'image' | 'audio') => void;
  uploadPct: number;
}

const typeIcon = (t: string) => {
  if (t === 'audio') return <Music size={12} />;
  if (t === 'image') return <Image size={12} />;
  return <Film size={12} />;
};

export default function AssetPanel({ assets, onUpload, uploadPct }: Props) {
  const videoRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const intentRef = useRef<'video' | 'image' | 'audio'>('video');

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onUpload(f, intentRef.current);
    e.target.value = '';
  };

  const uploading = uploadPct >= 0;

  return (
    <aside className="w-52 bg-neutral-950 border-r border-neutral-800 flex flex-col shrink-0 overflow-y-auto">
      <div className="p-3 border-b border-neutral-800">
        <h3 className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 font-semibold">Import</h3>
        <div className="flex gap-1.5">
          <button onClick={() => { intentRef.current = 'video'; videoRef.current?.click(); }} disabled={uploading}
            className="flex-1 flex flex-col items-center gap-1 py-2 border border-dashed border-neutral-700 rounded-lg text-[10px] text-neutral-400 hover:border-blue-500 hover:text-blue-400 hover:bg-blue-500/5 transition disabled:opacity-40">
            <Film size={14} />
            Video
          </button>
          <button onClick={() => { intentRef.current = 'image'; imageRef.current?.click(); }} disabled={uploading}
            className="flex-1 flex flex-col items-center gap-1 py-2 border border-dashed border-neutral-700 rounded-lg text-[10px] text-neutral-400 hover:border-purple-500 hover:text-purple-400 hover:bg-purple-500/5 transition disabled:opacity-40">
            <Image size={14} />
            Image
          </button>
          <button onClick={() => { intentRef.current = 'audio'; audioRef.current?.click(); }} disabled={uploading}
            className="flex-1 flex flex-col items-center gap-1 py-2 border border-dashed border-neutral-700 rounded-lg text-[10px] text-neutral-400 hover:border-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/5 transition disabled:opacity-40">
            <Music size={14} />
            Audio
          </button>
        </div>
        <input ref={videoRef} type="file" accept="video/mp4,video/mov,video/avi,video/mkv,video/*" hidden onChange={handleFile} />
        <input ref={imageRef} type="file" accept="image/png,image/jpg,image/jpeg,image/*" hidden onChange={handleFile} />
        <input ref={audioRef} type="file" accept="audio/mp3,audio/wav,audio/mpeg,audio/*,video/mp4,video/*" hidden onChange={handleFile} />
        {uploading && (
          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[9px] text-neutral-500">Uploading</span>
              <span className="text-[9px] text-blue-400 font-mono">{uploadPct}%</span>
            </div>
            <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${uploadPct}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="p-2">
        <h3 className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5 font-semibold px-1">Library</h3>
        <div className="flex flex-col gap-1.5">
          {assets.map(a => {
            const thumb = getThumbnailUrl(a.thumbnailPath);
            return (
              <div key={a.id} className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
                {thumb && <img src={thumb} alt="" className="w-full h-20 object-cover" />}
                <div className="p-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                    {typeIcon(a.type)}
                    <span className="truncate">{a.filename}</span>
                  </div>
                  <div className="text-[10px] text-neutral-600 mt-0.5">
                    {a.duration != null && `${a.duration.toFixed(1)}s`}
                    {a.width ? ` · ${a.width}×${a.height}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
          {assets.length === 0 && (
            <div className="text-center py-8 text-neutral-700 text-xs">
              <Upload size={24} className="mx-auto mb-2 opacity-30" />
              No media yet
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
