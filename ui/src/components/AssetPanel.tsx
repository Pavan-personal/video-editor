import { useRef } from 'react';
import { Upload, Film, Music, Image } from 'lucide-react';
import type { Asset } from '../api/client';
import { getThumbnailUrl } from '../api/client';

interface Props {
  assets: Asset[];
  onUpload: (file: File) => void;
  uploadPct: number;
}

const typeIcon = (t: string) => {
  if (t === 'audio') return <Music size={12} />;
  if (t === 'image') return <Image size={12} />;
  return <Film size={12} />;
};

export default function AssetPanel({ assets, onUpload, uploadPct }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <aside className="w-52 bg-neutral-950 border-r border-neutral-800 flex flex-col shrink-0 overflow-y-auto">
      <div className="p-3 border-b border-neutral-800">
        <h3 className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2 font-semibold">Media</h3>
        <button onClick={() => ref.current?.click()} disabled={uploadPct >= 0}
          className="w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-neutral-700 rounded-lg text-xs text-neutral-400 hover:border-blue-500 hover:text-blue-400 hover:bg-blue-500/5 transition disabled:opacity-50 disabled:cursor-wait">
          <Upload size={14} />
          {uploadPct >= 0 ? `Uploading ${uploadPct}%` : 'Import Media'}
        </button>
        <input ref={ref} type="file" accept="video/*,audio/*,image/*" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
        {uploadPct >= 0 && (
          <div className="mt-2 h-1 bg-neutral-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${uploadPct}%` }} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 p-2">
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
    </aside>
  );
}
