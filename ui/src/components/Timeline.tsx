import { useRef, useState, useCallback, useMemo } from 'react';
import { Trash2, Zap, Diamond, ZoomIn, ZoomOut } from 'lucide-react';
import type { Clip, Overlay, Asset } from '../api/client';

type DragMode = 'move' | 'trim-left' | 'trim-right';

interface DragState {
  id: string;
  kind: 'clip' | 'overlay';
  mode: DragMode;
  startX: number;
  origStart: number;
  origEnd: number;
}

interface Props {
  clips: Clip[];
  overlays: Overlay[];
  assets: Asset[];
  currentTime: number;
  onTimeChange: (t: number) => void;
  onClipUpdate: (id: string, updates: Partial<Clip>) => void;
  onClipDelete: (id: string) => void;
  onSelectClip: (c: Clip | null) => void;
  onSelectOverlay: (o: Overlay | null) => void;
  onOverlayDelete: (id: string) => void;
  onOverlayUpdate: (id: string, updates: Partial<Overlay>) => void;
  selectedClipId: string | null;
  selectedOverlayId: string | null;
}

const TRACKS = [
  { id: 'video_a', label: 'Video', color: 'bg-blue-600', border: 'border-blue-400', hover: 'hover:bg-blue-500', ring: 'ring-blue-400' },
  { id: 'video_b', label: 'PiP', color: 'bg-amber-600', border: 'border-amber-400', hover: 'hover:bg-amber-500', ring: 'ring-amber-400' },
  { id: 'overlay_1', label: 'Text', color: 'bg-purple-600', border: 'border-purple-400', hover: 'hover:bg-purple-500', ring: 'ring-purple-400' },
  { id: 'audio', label: 'Audio', color: 'bg-emerald-600', border: 'border-emerald-400', hover: 'hover:bg-emerald-500', ring: 'ring-emerald-400' },
];

const ZOOM_LEVELS = [20, 40, 60, 80, 120, 160, 240];
const DEFAULT_ZOOM = 3; // index into ZOOM_LEVELS → 80px/s
const TRACK_H = 44;
const HANDLE_W = 8;
const LABEL_W = 56;
const SNAP_THRESHOLD = 6;

function displayContent(content: string | undefined): string {
  if (!content) return 'overlay';
  return content.split('|||')[0] || 'overlay';
}

export default function Timeline({
  clips, overlays, assets, currentTime, onTimeChange,
  onClipUpdate, onClipDelete, onSelectClip, onSelectOverlay, onOverlayDelete, onOverlayUpdate,
  selectedClipId, selectedOverlayId,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM);
  const PX = ZOOM_LEVELS[zoomIdx];

  const zoomIn = () => setZoomIdx(i => Math.min(i + 1, ZOOM_LEVELS.length - 1));
  const zoomOut = () => setZoomIdx(i => Math.max(i - 1, 0));

  // Build asset duration lookup: assetId → duration
  const assetDurations = useMemo(() => {
    const map = new Map<string, number>();
    assets.forEach(a => { if (a.duration != null) map.set(a.id, a.duration); });
    return map;
  }, [assets]);

  const contentEnd = Math.max(
    ...clips.map(c => c.endTime),
    ...overlays.map(o => o.endTime),
    currentTime, 0,
  );
  const maxTime = contentEnd + 2;
  // Ensure timeline fills at least the visible viewport width
  const viewportTrackW = typeof window !== 'undefined' ? window.innerWidth - LABEL_W : 800;
  const contentW = maxTime * PX;
  const totalW = Math.max(contentW, viewportTrackW);

  // Snap points
  const snapPoints: number[] = [0, currentTime];
  clips.forEach(c => { snapPoints.push(c.startTime, c.endTime); });
  overlays.forEach(o => { snapPoints.push(o.startTime, o.endTime); });

  const snapTime = (t: number): number => {
    let best = t, bestDist = SNAP_THRESHOLD / PX;
    for (const sp of snapPoints) {
      const dist = Math.abs(t - sp);
      if (dist < bestDist && dist > 0.001) { best = sp; bestDist = dist; }
    }
    return best;
  };

  const getTimeFromX = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft - LABEL_W) / PX);
  }, [PX]);

  const startDrag = (e: React.PointerEvent, id: string, kind: 'clip' | 'overlay', mode: DragMode, startTime: number, endTime: number) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, kind, mode, startX: e.clientX, origStart: startTime, origEnd: endTime });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dt = dx / PX;

    if (drag.kind === 'clip') {
      const thisClip = clips.find(c => c.id === drag.id);
      if (!thisClip) return;
      const siblings = clips.filter(c => c.id !== drag.id && c.track === thisClip.track);

      if (drag.mode === 'move') {
        let newStart = snapTime(Math.max(0, drag.origStart + dt));
        const dur = drag.origEnd - drag.origStart;
        let newEnd = newStart + dur;
        for (const sib of siblings) {
          if (newEnd > sib.startTime && newStart < sib.startTime) { newEnd = sib.startTime; newStart = newEnd - dur; }
          if (newStart < sib.endTime && newEnd > sib.endTime) { newStart = sib.endTime; newEnd = newStart + dur; }
        }
        newStart = Math.max(0, newStart);
        onClipUpdate(drag.id, { startTime: newStart, endTime: newStart + dur });
      } else if (drag.mode === 'trim-left') {
        let newStart = snapTime(Math.min(drag.origEnd - 0.1, Math.max(0, drag.origStart + dt)));
        for (const sib of siblings) { if (sib.endTime <= drag.origEnd && sib.endTime > newStart) newStart = sib.endTime; }
        onClipUpdate(drag.id, { startTime: newStart });
      } else {
        let newEnd = snapTime(Math.max(drag.origStart + 0.1, drag.origEnd + dt));
        for (const sib of siblings) { if (sib.startTime >= drag.origStart && sib.startTime < newEnd) newEnd = sib.startTime; }
        // Cap at asset duration so clip can't exceed source length
        const assetDur = assetDurations.get(thisClip.assetId) ?? thisClip.asset?.duration;
        if (assetDur != null && assetDur > 0) {
          const maxEnd = thisClip.startTime + (assetDur - (thisClip.trimStart || 0));
          if (newEnd > maxEnd) newEnd = maxEnd;
        }
        onClipUpdate(drag.id, { endTime: newEnd });
      }
    } else {
      if (drag.mode === 'move') {
        const newStart = snapTime(Math.max(0, drag.origStart + dt));
        const dur = drag.origEnd - drag.origStart;
        onOverlayUpdate(drag.id, { startTime: newStart, endTime: newStart + dur });
      } else if (drag.mode === 'trim-left') {
        const newStart = snapTime(Math.min(drag.origEnd - 0.1, Math.max(0, drag.origStart + dt)));
        onOverlayUpdate(drag.id, { startTime: newStart });
      } else {
        const newEnd = snapTime(Math.max(drag.origStart + 0.1, drag.origEnd + dt));
        onOverlayUpdate(drag.id, { endTime: newEnd });
      }
    }
  };

  const onPointerUp = () => setDrag(null);

  const handleTrackClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.track) {
      onTimeChange(getTimeFromX(e.clientX));
      onSelectClip(null); onSelectOverlay(null);
    }
  };

  // Collect speed keyframe markers for selected clip
  const selectedClip = clips.find(c => c.id === selectedClipId);
  const speedKfMarkers: { time: number; speed: number }[] = [];
  if (selectedClip && selectedClip.speedKeyframes.length > 1) {
    selectedClip.speedKeyframes.forEach(kf => {
      speedKfMarkers.push({ time: selectedClip.startTime + kf.time, speed: kf.speed });
    });
  }

  // Collect overlay keyframe markers for selected overlay
  const selectedOv = overlays.find(o => o.id === selectedOverlayId);
  const overlayKfTimes: number[] = [];
  if (selectedOv) {
    const allKfs = [
      ...selectedOv.positionKeyframes,
      ...selectedOv.scaleKeyframes,
      ...selectedOv.rotationKeyframes,
      ...selectedOv.opacityKeyframes,
    ];
    const seen = new Set<string>();
    allKfs.forEach(kf => {
      const abs = selectedOv.startTime + kf.time;
      const key = abs.toFixed(3);
      if (!seen.has(key)) { seen.add(key); overlayKfTimes.push(abs); }
    });
    overlayKfTimes.sort((a, b) => a - b);
  }

  // Ruler tick interval based on zoom
  const rulerStep = PX >= 120 ? 1 : PX >= 60 ? 2 : 5;

  const renderBlock = (
    id: string, kind: 'clip' | 'overlay', startTime: number, endTime: number,
    label: string, trackDef: typeof TRACKS[0], isSelected: boolean,
    onSelect: () => void, onDelete: () => void, extra?: React.ReactNode,
  ) => {
    const left = startTime * PX;
    const w = Math.max((endTime - startTime) * PX, 12);
    const isDragging = drag?.id === id;

    return (
      <div key={id}
        className={`absolute top-1 rounded-md flex items-center text-[10px] text-white/90 border transition-colors group
          ${trackDef.color} ${isSelected ? `border-white ring-1 ${trackDef.ring} z-10` : trackDef.border} ${trackDef.hover}
          ${isDragging ? 'opacity-60' : ''}`}
        style={{ left, width: w, height: TRACK_H - 8 }}
        onClick={e => { e.stopPropagation(); onSelect(); }}>

        {/* Trim left handle */}
        <div className="absolute left-0 top-0 h-full cursor-col-resize z-20 flex items-center"
          style={{ width: HANDLE_W }}
          onPointerDown={e => startDrag(e, id, kind, 'trim-left', startTime, endTime)}>
          <div className="w-[3px] h-3/5 bg-white/20 rounded-full ml-0.5 group-hover:bg-white/50 transition" />
        </div>

        {/* Body */}
        <div className="flex-1 flex items-center gap-1 px-2.5 truncate cursor-grab active:cursor-grabbing min-w-0"
          onPointerDown={e => startDrag(e, id, kind, 'move', startTime, endTime)}>
          <span className="truncate font-medium">{label}</span>
          {extra}
        </div>

        {/* Speed keyframe diamonds inside clip block */}
        {kind === 'clip' && isSelected && speedKfMarkers.length > 0 && (
          speedKfMarkers.map((kf, i) => {
            const kfLeft = (kf.time - startTime) * PX;
            if (kfLeft < 0 || kfLeft > w) return null;
            return (
              <div key={`skf-${i}`} className="absolute bottom-0.5 z-20 pointer-events-none"
                style={{ left: kfLeft - 4 }} title={`${kf.speed}x @ ${kf.time.toFixed(1)}s`}>
                <Diamond size={8} className="text-amber-300 fill-amber-400" />
              </div>
            );
          })
        )}

        {/* Trim right handle */}
        <div className="absolute right-0 top-0 h-full cursor-col-resize z-20 flex items-center justify-end"
          style={{ width: HANDLE_W }}
          onPointerDown={e => startDrag(e, id, kind, 'trim-right', startTime, endTime)}>
          <div className="w-[3px] h-3/5 bg-white/20 rounded-full mr-0.5 group-hover:bg-white/50 transition" />
        </div>

        {isSelected && w > 30 && (
          <button onClick={e => { e.stopPropagation(); onDelete(); }}
            className="absolute -top-2 -right-2 p-0.5 bg-red-600 rounded-full hover:bg-red-500 transition z-30" title="Delete">
            <Trash2 size={8} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="shrink-0 bg-neutral-950 border-t border-neutral-800 flex flex-col select-none"
      style={{ height: TRACKS.length * TRACK_H + 26 + 28 }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp}>

      {/* Zoom controls bar */}
      <div className="flex items-center gap-1.5 px-2 h-7 bg-neutral-900 border-b border-neutral-800 shrink-0">
        <button onClick={zoomOut} disabled={zoomIdx === 0}
          className="p-0.5 hover:bg-neutral-800 rounded transition disabled:opacity-20" title="Zoom out">
          <ZoomOut size={12} />
        </button>
        <div className="w-16 h-1 bg-neutral-800 rounded-full relative">
          <div className="absolute top-0 left-0 h-full bg-neutral-600 rounded-full transition-all"
            style={{ width: `${(zoomIdx / (ZOOM_LEVELS.length - 1)) * 100}%` }} />
        </div>
        <button onClick={zoomIn} disabled={zoomIdx === ZOOM_LEVELS.length - 1}
          className="p-0.5 hover:bg-neutral-800 rounded transition disabled:opacity-20" title="Zoom in">
          <ZoomIn size={12} />
        </button>
        <span className="text-[9px] text-neutral-600 ml-1">{PX}px/s</span>

        {/* Jump between keyframes */}
        {(speedKfMarkers.length > 0 || overlayKfTimes.length > 0) && (
          <>
            <div className="w-px h-3 bg-neutral-800 mx-1" />
            <span className="text-[9px] text-neutral-500">KF:</span>
            <button onClick={() => {
              const allTimes = [...speedKfMarkers.map(k => k.time), ...overlayKfTimes].sort((a, b) => a - b);
              const prev = [...allTimes].reverse().find(t => t < currentTime - 0.05);
              if (prev !== undefined) onTimeChange(prev);
            }} className="px-1.5 py-0.5 text-[9px] bg-neutral-800 hover:bg-neutral-700 rounded transition text-neutral-400"
              title="Previous keyframe">◀</button>
            <button onClick={() => {
              const allTimes = [...speedKfMarkers.map(k => k.time), ...overlayKfTimes].sort((a, b) => a - b);
              const next = allTimes.find(t => t > currentTime + 0.05);
              if (next !== undefined) onTimeChange(next);
            }} className="px-1.5 py-0.5 text-[9px] bg-neutral-800 hover:bg-neutral-700 rounded transition text-neutral-400"
              title="Next keyframe">▶</button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden scrollbar-hide" ref={scrollRef}>
        <div style={{ width: totalW + LABEL_W }}>
          {/* Ruler */}
          <div className="flex sticky top-0 z-20">
            <div className="shrink-0 bg-neutral-900 border-b border-r border-neutral-800" style={{ width: LABEL_W, height: 22 }} />
            <div className="relative bg-neutral-900 border-b border-neutral-800 cursor-pointer"
              style={{ width: totalW, height: 22 }}
              onClick={e => onTimeChange(getTimeFromX(e.clientX))}>
              {Array.from({ length: Math.ceil(totalW / PX / rulerStep) + 1 }, (_, i) => {
                const t = i * rulerStep;
                return (
                  <div key={t} className="absolute top-0 flex flex-col items-start" style={{ left: t * PX }}>
                    <div className="w-px h-2 bg-neutral-700" />
                    <span className="text-[8px] text-neutral-600 ml-0.5 leading-none mt-px">{t}s</span>
                  </div>
                );
              })}
              {/* Keyframe markers on ruler */}
              {speedKfMarkers.map((kf, i) => (
                <div key={`rkf-${i}`} className="absolute top-0 z-10 pointer-events-none"
                  style={{ left: kf.time * PX - 3 }}>
                  <Diamond size={7} className="text-amber-400 fill-amber-400 mt-0.5" />
                </div>
              ))}
              {overlayKfTimes.map((t, i) => (
                <div key={`okf-${i}`} className="absolute top-0 z-10 pointer-events-none"
                  style={{ left: t * PX - 3 }}>
                  <Diamond size={7} className="text-fuchsia-400 fill-fuchsia-400 mt-0.5" />
                </div>
              ))}
              <div className="absolute top-0 w-0.5 h-full bg-red-500 z-30 pointer-events-none" style={{ left: currentTime * PX }}>
                <div className="absolute -top-px -left-[4px] w-0 h-0 border-l-[5px] border-r-[5px] border-t-[5px] border-l-transparent border-r-transparent border-t-red-500" />
              </div>
            </div>
          </div>

          {/* Tracks */}
          {TRACKS.map((track, ti) => (
            <div key={track.id} className="flex" style={{ height: TRACK_H }}>
              <div className={`shrink-0 flex items-center px-2 text-[9px] font-semibold uppercase tracking-wider border-r border-b border-neutral-800 ${ti % 2 === 0 ? 'bg-neutral-950 text-neutral-500' : 'bg-neutral-900/80 text-neutral-500'}`}
                style={{ width: LABEL_W }}>
                {track.label}
              </div>
              <div className={`relative border-b border-neutral-800 cursor-crosshair ${ti % 2 === 0 ? 'bg-neutral-950' : 'bg-[#0c0c0c]'}`}
                style={{ width: totalW, height: TRACK_H }}
                data-track={track.id}
                onClick={handleTrackClick}>

                {clips.filter(c => c.track === track.id).map(clip =>
                  renderBlock(
                    clip.id, 'clip', clip.startTime, clip.endTime,
                    clip.id.slice(0, 6), track, clip.id === selectedClipId,
                    () => { onSelectClip(clip); onSelectOverlay(null); },
                    () => onClipDelete(clip.id),
                    (clip.speedKeyframes[0]?.speed !== undefined && clip.speedKeyframes[0].speed !== 1) ? (
                      <span className="flex items-center gap-0.5 text-[8px] bg-black/30 px-1 rounded shrink-0">
                        <Zap size={7} />{clip.speedKeyframes[0].speed}x
                      </span>
                    ) : undefined,
                  )
                )}

                {overlays.filter(o => o.track === track.id).map(ov =>
                  renderBlock(
                    ov.id, 'overlay', ov.startTime, ov.endTime,
                    displayContent(ov.content),
                    { ...track, color: 'bg-purple-600', border: 'border-purple-400', hover: 'hover:bg-purple-500', ring: 'ring-purple-400' },
                    ov.id === selectedOverlayId,
                    () => { onSelectOverlay(ov); onSelectClip(null); },
                    () => onOverlayDelete(ov.id),
                  )
                )}

                {/* Overlay keyframe markers on track */}
                {overlayKfTimes.map((t, i) => {
                  if (track.id !== selectedOv?.track) return null;
                  return (
                    <div key={`tkf-${i}`} className="absolute top-0 z-15 pointer-events-none"
                      style={{ left: t * PX - 0.5, height: TRACK_H }}>
                      <div className="w-px h-full bg-fuchsia-500/40" />
                    </div>
                  );
                })}

                <div className="absolute top-0 w-0.5 h-full bg-red-500/50 pointer-events-none z-20"
                  style={{ left: currentTime * PX }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
