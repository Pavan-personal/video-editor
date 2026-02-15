import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { Clip, Overlay, Asset, SpeedKeyframe, TransformKeyframe } from '../api/client';

interface Props {
  clips: Clip[];
  overlays: Overlay[];
  assets: Asset[];
  currentTime: number;
  onTimeChange: (t: number | ((prev: number) => number)) => void;
}

function evaluateSpeedRamp(t: number, kfs: SpeedKeyframe[]): number {
  if (!kfs.length) return t;
  const s = [...kfs].sort((a, b) => a.time - b.time);
  if (s.length === 1) return t * s[0].speed;
  if (t <= s[0].time) return t * s[0].speed;
  if (t >= s[s.length - 1].time) {
    let src = s[0].time * s[0].speed;
    for (let i = 0; i < s.length - 1; i++) src += (s[i + 1].time - s[i].time) * (s[i].speed + s[i + 1].speed) / 2;
    return src + (t - s[s.length - 1].time) * s[s.length - 1].speed;
  }
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].time && t <= s[i + 1].time) {
      let src = s[0].time * s[0].speed;
      for (let j = 0; j < i; j++) src += (s[j + 1].time - s[j].time) * (s[j].speed + s[j + 1].speed) / 2;
      const prog = (t - s[i].time) / (s[i + 1].time - s[i].time);
      const spd = s[i].speed + (s[i + 1].speed - s[i].speed) * prog;
      return src + (t - s[i].time) * (s[i].speed + spd) / 2;
    }
  }
  return t;
}

function lerp(kfs: TransformKeyframe[], t: number, p: keyof TransformKeyframe, defaultVal = 0): number {
  if (!kfs.length) return defaultVal;
  const s = [...kfs].sort((a, b) => a.time - b.time);
  if (t <= s[0].time) return (s[0][p] as number) ?? defaultVal;
  if (t >= s[s.length - 1].time) return (s[s.length - 1][p] as number) ?? defaultVal;
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].time && t <= s[i + 1].time) {
      const pr = (t - s[i].time) / (s[i + 1].time - s[i].time);
      const a = (s[i][p] as number) ?? defaultVal, b = (s[i + 1][p] as number) ?? defaultVal;
      return a + (b - a) * pr;
    }
  }
  return defaultVal;
}

function formatTimecode(seconds: number, fps = 30): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const frame = Math.floor((s % 1) * fps);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
}

function getTextAnimation(animation: string | undefined, localTime: number, duration: number): React.CSSProperties {
  if (!animation || animation === 'none') return {};
  const progress = Math.min(1, localTime / Math.min(0.5, duration));
  const exitStart = duration - 0.5;
  const exitProgress = localTime > exitStart ? Math.min(1, (localTime - exitStart) / 0.5) : 0;
  switch (animation) {
    case 'fade': return { opacity: exitProgress > 0 ? 1 - exitProgress : progress };
    case 'slide-up': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      transform: exitProgress > 0 ? `translateY(${-30 * exitProgress}px)` : `translateY(${30 * (1 - progress)}px)`,
    };
    case 'slide-left': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      transform: exitProgress > 0 ? `translateX(${-60 * exitProgress}px)` : `translateX(${60 * (1 - progress)}px)`,
    };
    case 'scale': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      transform: exitProgress > 0 ? `scale(${1 + exitProgress * 0.5})` : `scale(${0.3 + 0.7 * progress})`,
    };
    case 'typewriter': return {};
    case 'bounce': {
      const bounce = progress < 1 ? Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress) * 20 : 0;
      return { opacity: exitProgress > 0 ? 1 - exitProgress : Math.min(1, progress * 2), transform: `translateY(${-bounce}px)` };
    }
    case 'blur': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      filter: exitProgress > 0 ? `blur(${exitProgress * 8}px)` : `blur(${(1 - progress) * 8}px)`,
    };
    default: return {};
  }
}

// Reference resolution for overlay coordinate system (matches export)
const REF_W = 1280;
const REF_H = 720;

export default function Preview({ clips, overlays, assets, currentTime, onTimeChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevAssetId = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const animRef = useRef<number>(0);
  const lastFrameTime = useRef<number>(0);

  // Audio element for audio-track clips
  const audioRef = useRef<HTMLAudioElement>(null);
  const prevAudioAssetId = useRef<string | null>(null);

  // Track video element size for overlay scaling
  const [vidRect, setVidRect] = useState({ w: 0, h: 0, left: 0, top: 0 });

  const maxTime = useMemo(() => {
    const ends = [...clips.map(c => c.endTime), ...overlays.map(o => o.endTime)];
    return ends.length ? Math.max(...ends) : 0;
  }, [clips, overlays]);

  const activeClip = useMemo(() =>
    clips.find(c => c.track === 'video_a' && currentTime >= c.startTime && currentTime < c.endTime),
    [clips, currentTime]);

  const activeAsset = useMemo(() =>
    activeClip ? assets.find(a => a.id === activeClip.assetId) : null,
    [activeClip, assets]);

  const sourceTime = useMemo(() => {
    if (!activeClip) return 0;
    return activeClip.trimStart + evaluateSpeedRamp(currentTime - activeClip.startTime, activeClip.speedKeyframes);
  }, [activeClip, currentTime]);

  const activeOverlays = useMemo(() =>
    overlays.filter(o => currentTime >= o.startTime && currentTime < o.endTime),
    [overlays, currentTime]);

  // Active audio clip
  const activeAudioClip = useMemo(() =>
    clips.find(c => c.track === 'audio' && currentTime >= c.startTime && currentTime < c.endTime),
    [clips, currentTime]);

  const activeAudioAsset = useMemo(() =>
    activeAudioClip ? assets.find(a => a.id === activeAudioClip.assetId) : null,
    [activeAudioClip, assets]);

  // Measure video element to map overlay coordinates
  useEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      const vid = videoRef.current;

      // If video is visible and has dimensions, use its rect
      if (vid && activeAsset && vid.offsetWidth > 0 && vid.offsetHeight > 0) {
        const vr = vid.getBoundingClientRect();
        setVidRect({
          w: vr.width,
          h: vr.height,
          left: vr.left - cr.left,
          top: vr.top - cr.top,
        });
      } else {
        // No video visible — use container with 16:9 aspect ratio centered
        const containerW = cr.width - 24; // account for p-3 padding
        const containerH = cr.height - 24;
        const aspect = REF_W / REF_H;
        let w = containerW;
        let h = w / aspect;
        if (h > containerH) { h = containerH; w = h * aspect; }
        setVidRect({
          w,
          h,
          left: (cr.width - w) / 2,
          top: (cr.height - h) / 2,
        });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    if (videoRef.current) ro.observe(videoRef.current);
    return () => ro.disconnect();
  }, [activeAsset]);

  // Playback loop
  const tick = useCallback((ts: number) => {
    if (maxTime <= 0) return;
    if (!lastFrameTime.current) lastFrameTime.current = ts;
    const dt = (ts - lastFrameTime.current) / 1000;
    lastFrameTime.current = ts;
    onTimeChange((prev: number) => {
      const next = prev + dt;
      return next >= maxTime ? 0 : next;
    });
    animRef.current = requestAnimationFrame(tick);
  }, [maxTime, onTimeChange]);

  useEffect(() => {
    if (playing) {
      lastFrameTime.current = 0;
      animRef.current = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(animRef.current);
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [playing, tick]);

  // Video source + seek
  const isSeeking = useRef(false);
  const prevPlaying = useRef(false);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (activeAsset && activeAsset.type === 'video') {
      const filename = activeAsset.filepath.split('/').pop();
      const url = `/uploads/${filename}`;
      if (prevAssetId.current !== activeAsset.id) {
        vid.src = url;
        vid.load();
        prevAssetId.current = activeAsset.id;
        isSeeking.current = false;
      }
      vid.muted = muted;
      vid.volume = volume;
      if (playing) {
        const drift = Math.abs(vid.currentTime - sourceTime);
        if (!prevPlaying.current || drift > 0.3) vid.currentTime = sourceTime;
        if (vid.paused) vid.play().catch(() => {});
      } else {
        if (vid.currentTime !== sourceTime) vid.currentTime = sourceTime;
        if (!vid.paused) vid.pause();
      }
      prevPlaying.current = playing;
    } else if (prevAssetId.current) {
      vid.removeAttribute('src');
      vid.load();
      prevAssetId.current = null;
      prevPlaying.current = false;
    }
  }, [activeAsset, sourceTime, muted, playing, volume]);

  // Audio track playback
  useEffect(() => {
    const aud = audioRef.current;
    if (!aud) return;
    if (activeAudioAsset) {
      const filename = activeAudioAsset.filepath.split('/').pop();
      const url = `/uploads/${filename}`;
      if (prevAudioAssetId.current !== activeAudioAsset.id) {
        aud.src = url;
        aud.load();
        prevAudioAssetId.current = activeAudioAsset.id;
      }
      aud.volume = volume;
      aud.muted = muted;
      if (activeAudioClip) {
        const audioSourceTime = activeAudioClip.trimStart + (currentTime - activeAudioClip.startTime);
        if (playing) {
          const drift = Math.abs(aud.currentTime - audioSourceTime);
          if (drift > 0.3) aud.currentTime = audioSourceTime;
          if (aud.paused) aud.play().catch(() => {});
        } else {
          aud.currentTime = audioSourceTime;
          if (!aud.paused) aud.pause();
        }
      }
    } else {
      if (!aud.paused) aud.pause();
      if (prevAudioAssetId.current) {
        aud.removeAttribute('src');
        aud.load();
        prevAudioAssetId.current = null;
      }
    }
  }, [activeAudioAsset, activeAudioClip, currentTime, playing, muted, volume]);

  const togglePlay = () => setPlaying(p => !p);
  const skipBack = () => { onTimeChange(Math.max(0, currentTime - 5)); };
  const skipFwd = () => { onTimeChange(Math.min(maxTime, currentTime + 5)); };

  // Scale factor: map REF_W/REF_H coordinates to actual video element size
  const scaleX = vidRect.w > 0 ? vidRect.w / REF_W : 1;
  const scaleY = vidRect.h > 0 ? vidRect.h / REF_H : 1;

  return (
    <div className="flex-1 flex flex-col bg-black min-h-0">
      {/* Hidden audio element for audio track */}
      <audio ref={audioRef} preload="auto" style={{ display: 'none' }} />

      {/* Video area */}
      <div ref={containerRef} className="flex-1 flex items-center justify-center relative min-h-0 p-3 overflow-hidden">
        <video ref={videoRef} className="max-w-full max-h-full rounded bg-neutral-950" playsInline preload="auto"
          style={{ display: activeAsset ? 'block' : 'none' }} />
        {!activeAsset && (
          <div className="text-neutral-600 text-sm select-none">No clip at current time</div>
        )}

        {/* Overlays — positioned relative to video element using scaled coordinates */}
        {activeOverlays.map(ov => {
          const lt = currentTime - ov.startTime;
          const dur = ov.endTime - ov.startTime;
          // Get keyframe values in REF coordinate space
          const rawX = lerp(ov.positionKeyframes, lt, 'x');
          const rawY = lerp(ov.positionKeyframes, lt, 'y');
          const scale = lerp(ov.scaleKeyframes, lt, 'scale', 1);
          const rotation = lerp(ov.rotationKeyframes, lt, 'rotation');
          const opacity = lerp(ov.opacityKeyframes, lt, 'opacity', 1);
          const parts = (ov.content || '').split('|||');
          const text = parts[0];
          const animation = ov.type === 'text' ? (parts[1] || 'none') : 'none';
          const animStyle = getTextAnimation(animation, lt, dur);

          let displayText = text;
          if (animation === 'typewriter') {
            const charCount = Math.min(text.length, Math.floor((lt / Math.min(2, dur)) * text.length));
            displayText = text.slice(0, charCount) + (charCount < text.length ? '▌' : '');
          }

          const baseTransform = `scale(${scale}) rotate(${rotation}deg)`;
          const animTransform = animStyle.transform || '';
          const finalTransform = animTransform ? `${baseTransform} ${animTransform}` : baseTransform;
          const animOpacity = animStyle.opacity != null ? Number(animStyle.opacity) : 1;
          const finalOpacity = opacity * animOpacity;

          // Map from REF coordinates to actual video element position
          const pixelX = vidRect.left + rawX * scaleX;
          const pixelY = vidRect.top + rawY * scaleY;

          return (
            <div key={ov.id} className="absolute pointer-events-none"
              style={{
                left: pixelX, top: pixelY,
                transform: `translate(-50%, -50%) ${finalTransform}`,
                opacity: finalOpacity,
                filter: animStyle.filter,
                transformOrigin: 'center center',
              }}>
              {ov.type === 'text' && (
                <span style={{
                  fontSize: Math.max(8, (ov.fontSize || 24) * scaleX),
                  color: ov.color || '#fff',
                  backgroundColor: ov.bgColor || 'rgba(0,0,0,0.7)',
                  padding: `${2 * scaleY}px ${6 * scaleX}px`,
                  borderRadius: 4,
                  whiteSpace: 'pre',
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                }}>
                  {displayText}
                </span>
              )}
              {ov.type === 'image' && ov.content && (
                <img
                  src={`/uploads/${(ov.content.split('|||')[0]).split('/').pop()}`}
                  alt="overlay"
                  style={{ width: 200 * scaleX, height: 'auto', objectFit: 'contain' }}
                  draggable={false}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Transport controls */}
      <div className="flex items-center justify-center gap-1 px-4 py-2 bg-neutral-950 border-t border-neutral-800 shrink-0">
        <button onClick={skipBack} className="p-2 hover:bg-neutral-800 rounded-full transition" title="Back 5s" aria-label="Skip back 5 seconds">
          <SkipBack size={16} />
        </button>
        <button onClick={togglePlay}
          className="p-2.5 bg-white text-black rounded-full hover:bg-neutral-200 transition mx-1" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>
        <button onClick={skipFwd} className="p-2 hover:bg-neutral-800 rounded-full transition" title="Forward 5s" aria-label="Skip forward 5 seconds">
          <SkipForward size={16} />
        </button>
        <div className="flex items-center gap-1 ml-3">
          <button onClick={() => setMuted(m => !m)} className="p-2 hover:bg-neutral-800 rounded-full transition" title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={16} className="text-neutral-500" /> : <Volume2 size={16} />}
          </button>
          <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            onChange={e => { setVolume(+e.target.value); if (+e.target.value > 0) setMuted(false); }}
            className="w-16 h-1 accent-white cursor-pointer" aria-label="Volume" />
        </div>
        <div className="flex-1 mx-4 flex items-center gap-2">
          <span className="text-[10px] font-mono text-neutral-500 w-20 text-right">{formatTimecode(currentTime)}</span>
          <input type="range" min={0} max={maxTime} step={0.05} value={currentTime}
            onChange={e => { setPlaying(false); onTimeChange(+e.target.value); }}
            className="flex-1 h-1 accent-red-500 cursor-pointer" aria-label="Scrub timeline" />
          <span className="text-[10px] font-mono text-neutral-500 w-20">{formatTimecode(maxTime)}</span>
        </div>
      </div>
    </div>
  );
}
