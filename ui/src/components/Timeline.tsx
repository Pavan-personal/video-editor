import { useRef, useState, useCallback } from 'react';
import { Trash2, Zap } from 'lucide-react';
import type { Clip, Overlay } from '../api/client';

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
  { id: 'video_a', label: 'Video', color: 'bg-blue-700', border: 'border-blue-500', hover: 'hover:bg-blue-600' },
  { id: 'video_b', label: 'PiP', color: 'bg-amber-700', border: 'border-amber-500', hover: 'hover:bg-amber-600' },
  { id: 'overlay_1', label: 'Text', color: 'bg-purple-700', border: 'border-purple-500', hover: 'hover:bg-purple-600' },
  { id: 'audio', label: 'Audio', color: 'bg-emerald-700', border: 'border-emerald-500', hover: 'hover:bg-emerald-600' },
];

const PX = 80;
const TRACK_H = 48;
const HANDLE_W = 8;
const LABEL_W = 64;

export default function Timeline({
  clips, overlays, currentTime, onTimeChange,
  onClipUpdate, onClipDelete, onSelectClip, onSelectOverlay, onOverlayDelete, onOverlayUpdate,
  selectedClipId, selectedOverlayId,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const maxTime = Math.max(30, ...clips.map(c => c.endTime), ...overlays.map(o => o.endTime), currentTime + 10);
  const totalW = maxTime * PX;

  const getTimeFromX = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft - LABEL_W) / PX);
  }, []);

  const startDrag = (e: React.PointerEvent, id: string, kind: 'clip' | 'overlay', mode: DragMode, startTime: number, endTime: number) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, kind, mode, startX: e.clientX, origStart: startTime, origEnd: endTime });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dt = dx / PX;

    if (drag.kind === 'clip') {
      // Find the clip being dragged and siblings on same track
      const thisClip = clips.find(c => c.id === drag.id);
      if (!thisClip) return;
      const siblings = clips.filter(c => c.id !== drag.id && c.track === thisClip.track);

      if (drag.mode === 'move') {
        let newStart = Math.max(0, drag.origStart + dt);
        const dur = drag.origEnd - drag.origStart;
        let newEnd = newStart + dur;

        // Collision: clamp so we don't overlap siblings
        for (const sib of siblings) {
          // Moving right into a sibling
          if (newEnd > sib.startTime && newStart < sib.startTime) {
            newEnd = sib.startTime;
            newStart = newEnd - dur;
          }
          // Moving left into a sibling
          if (newStart < sib.endTime && newEnd > sib.endTime) {
            newStart = sib.endTime;
            newEnd = newStart + dur;
          }
        }
        newStart = Math.max(0, newStart);
        onClipUpdate(drag.id, { startTime: newStart, endTime: newStart + dur });

      } else if (drag.mode === 'trim-left') {
        let newStart = Math.min(drag.origEnd - 0.1, Math.max(0, drag.origStart + dt));
        // Don't trim into a sibling on the left
        for (const sib of siblings) {
          if (sib.endTime <= drag.origEnd && sib.endTime > newStart) {
            newStart = sib.endTime;
          }
        }
        onClipUpdate(drag.id, { startTime: newStart });

      } else {
        let newEnd = Math.max(drag.origStart + 0.1, drag.origEnd + dt);
        // Don't trim into a sibling on the right
        for (const sib of siblings) {
          if (sib.startTime >= drag.origStart && sib.startTime < newEnd) {
            newEnd = sib.startTime;
          }
        }
        onClipUpdate(drag.id, { endTime: newEnd });
      }
    } else {
      // Overlays can overlap freely (they're layered text)
      if (drag.mode === 'move') {
        const newStart = Math.max(0, drag.origStart + dt);
        const dur = drag.origEnd - drag.origStart;
        onOverlayUpdate(drag.id, { startTime: newStart, endTime: newStart + dur });
      } else if (drag.mode === 'trim-left') {
        const newStart = Math.min(drag.origEnd - 0.1, Math.max(0, drag.origStart + dt));
        onOverlayUpdate(drag.id, { startTime: newStart });
      } else {
        const newEnd = Math.max(drag.origStart + 0.1, drag.origEnd + dt);
        onOverlayUpdate(drag.id, { endTime: newEnd });
      }
    }
  };

  const onPointerUp = () => setDrag(null);

  const handleTrackClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.track) {
      onTimeChange(getTimeFromX(e.clientX));
      onSelectClip(null);
      onSelectOverlay(null);
    }
  };

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
        className={`absolute top-1 rounded flex items-center text-[10px] text-white/90 border transition-colors group
          ${trackDef.color} ${isSelected ? 'border-white ring-1 ring-white/40 z-10' : trackDef.border} ${trackDef.hover}
          ${isDragging ? 'opacity-60' : ''}`}
        style={{ left, width: w, height: TRACK_H - 8 }}
        onClick={e => { e.stopPropagation(); onSelect(); }}>

        {/* Left trim handle */}
        <div className="absolute left-0 top-0 h-full cursor-col-resize z-20 flex items-center"
          style={{ width: HANDLE_W }}
          onPointerDown={e => startDrag(e, id, kind, 'trim-left', startTime, endTime)}>
          <div className="w-[3px] h-3/5 bg-white/20 rounded-full ml-0.5 group-hover:bg-white/50 transition" />
        </div>

        {/* Move area */}
        <div className="flex-1 flex items-center gap-1 px-3 truncate cursor-grab active:cursor-grabbing min-w-0"
          onPointerDown={e => startDrag(e, id, kind, 'move', startTime, endTime)}>
          <span className="truncate">{label}</span>
          {extra}
        </div>

        {/* Right trim handle */}
        <div className="absolute right-0 top-0 h-full cursor-col-resize z-20 flex items-center justify-end"
          style={{ width: HANDLE_W }}
          onPointerDown={e => startDrag(e, id, kind, 'trim-right', startTime, endTime)}>
          <div className="w-[3px] h-3/5 bg-white/20 rounded-full mr-0.5 group-hover:bg-white/50 transition" />
        </div>

        {/* Delete button on selected */}
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
      style={{ height: TRACKS.length * TRACK_H + 28 }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp}>

      <div className="flex-1 overflow-x-auto overflow-y-hidden" ref={scrollRef}>
        <div style={{ width: totalW + LABEL_W, minWidth: '100%' }}>
          {/* Ruler */}
          <div className="flex sticky top-0 z-20">
            <div className="shrink-0 bg-neutral-900 border-b border-r border-neutral-800" style={{ width: LABEL_W }} />
            <div className="relative bg-neutral-900 border-b border-neutral-800 cursor-pointer flex-1"
              style={{ width: totalW, height: 24 }}
              onClick={e => onTimeChange(getTimeFromX(e.clientX))}>
              {Array.from({ length: Math.ceil(maxTime) + 1 }, (_, i) => (
                <div key={i} className="absolute top-0 flex flex-col items-start" style={{ left: i * PX }}>
                  <div className="w-px h-2.5 bg-neutral-700" />
                  <span className="text-[8px] text-neutral-600 ml-0.5 leading-none mt-px">{i}s</span>
                </div>
              ))}
              {/* Playhead on ruler */}
              <div className="absolute top-0 w-0.5 h-full bg-red-500 z-30 pointer-events-none" style={{ left: currentTime * PX }}>
                <div className="absolute -top-px -left-[4px] w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-red-500" />
              </div>
            </div>
          </div>

          {/* Tracks */}
          {TRACKS.map((track, ti) => (
            <div key={track.id} className="flex" style={{ height: TRACK_H }}>
              <div className={`shrink-0 flex items-center px-2 text-[9px] font-medium uppercase tracking-wider border-r border-b border-neutral-800 ${ti % 2 === 0 ? 'bg-neutral-950 text-neutral-500' : 'bg-neutral-900 text-neutral-500'}`}
                style={{ width: LABEL_W }}>
                {track.label}
              </div>
              <div className={`relative border-b border-neutral-800 cursor-crosshair ${ti % 2 === 0 ? 'bg-neutral-950' : 'bg-[#0d0d0d]'}`}
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
                    ov.content || 'overlay',
                    { ...track, color: 'bg-purple-700', border: 'border-purple-500', hover: 'hover:bg-purple-600' },
                    ov.id === selectedOverlayId,
                    () => { onSelectOverlay(ov); onSelectClip(null); },
                    () => onOverlayDelete(ov.id),
                  )
                )}

                {/* Playhead line through each track */}
                <div className="absolute top-0 w-0.5 h-full bg-red-500/60 pointer-events-none z-20"
                  style={{ left: currentTime * PX }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
