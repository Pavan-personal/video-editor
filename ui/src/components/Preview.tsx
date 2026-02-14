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

function lerp(kfs: TransformKeyframe[], t: number, p: keyof TransformKeyframe): number {
  if (!kfs.length) return 0;
  const s = [...kfs].sort((a, b) => a.time - b.time);
  if (t <= s[0].time) return (s[0][p] as number) ?? 0;
  if (t >= s[s.length - 1].time) return (s[s.length - 1][p] as number) ?? 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].time && t <= s[i + 1].time) {
      const pr = (t - s[i].time) / (s[i + 1].time - s[i].time);
      const a = (s[i][p] as number) ?? 0, b = (s[i + 1][p] as number) ?? 0;
      return a + (b - a) * pr;
    }
  }
  return 0;
}

// Text animation helper — returns CSS style for the overlay based on animation type and local progress
function getTextAnimation(animation: string | undefined, localTime: number, duration: number): React.CSSProperties {
  if (!animation || animation === 'none') return {};
  const progress = Math.min(1, localTime / Math.min(0.5, duration)); // 0.5s entrance
  const exitStart = duration - 0.5;
  const exitProgress = localTime > exitStart ? Math.min(1, (localTime - exitStart) / 0.5) : 0;

  switch (animation) {
    case 'fade': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
    };
    case 'slide-up': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      transform: exitProgress > 0
        ? `translateY(${-30 * exitProgress}px)`
        : `translateY(${30 * (1 - progress)}px)`,
    };
    case 'slide-left': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      transform: exitProgress > 0
        ? `translateX(${-60 * exitProgress}px)`
        : `translateX(${60 * (1 - progress)}px)`,
    };
    case 'scale': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      transform: exitProgress > 0
        ? `scale(${1 + exitProgress * 0.5})`
        : `scale(${0.3 + 0.7 * progress})`,
    };
    case 'typewriter': {
      const charProgress = Math.floor(progress * 20);
      return { '--tw-chars': charProgress } as React.CSSProperties;
    }
    case 'bounce': {
      const bounce = progress < 1 ? Math.abs(Math.sin(progress * Math.PI * 3)) * (1 - progress) * 20 : 0;
      return {
        opacity: exitProgress > 0 ? 1 - exitProgress : Math.min(1, progress * 2),
        transform: `translateY(${-bounce}px)`,
      };
    }
    case 'blur': return {
      opacity: exitProgress > 0 ? 1 - exitProgress : progress,
      filter: exitProgress > 0
        ? `blur(${exitProgress * 8}px)`
        : `blur(${(1 - progress) * 8}px)`,
    };
    default: return {};
  }
}

export default function Preview({ clips, overlays, assets, currentTime, onTimeChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevAssetId = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false); // start unmuted
  const [volume, setVolume] = useState(0.8);
  const animRef = useRef<number>(0);
  const lastFrameTime = useRef<number>(0);

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

  // Video source + seek + audio
  // Key insight: during playback, let the <video> play naturally.
  // Only seek when: clip changes, user scrubs, or drift > threshold.
  const isSeeking = useRef(false);
  const prevSourceTime = useRef(0);
  const prevPlaying = useRef(false);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    if (activeAsset && activeAsset.type === 'video') {
      const filename = activeAsset.filepath.split('/').pop();
      const url = `/uploads/${filename}`;

      // Load new source if asset changed
      if (prevAssetId.current !== activeAsset.id) {
        vid.src = url;
        vid.load();
        prevAssetId.current = activeAsset.id;
        isSeeking.current = false;
      }

      vid.muted = muted;
      vid.volume = volume;

      if (playing) {
        // During playback: only seek if drift is large (>0.3s) or we just started playing
        const drift = Math.abs(vid.currentTime - sourceTime);
        if (!prevPlaying.current || drift > 0.3) {
          vid.currentTime = sourceTime;
        }
        if (vid.paused) vid.play().catch(() => {});
      } else {
        // Paused / scrubbing: always seek to exact position
        if (vid.currentTime !== sourceTime) {
          vid.currentTime = sourceTime;
        }
        if (!vid.paused) vid.pause();
      }

      prevPlaying.current = playing;
      prevSourceTime.current = sourceTime;
    } else if (prevAssetId.current) {
      vid.removeAttribute('src');
      vid.load();
      prevAssetId.current = null;
      prevPlaying.current = false;
    }
  }, [activeAsset, sourceTime, muted, playing, volume]);

  const togglePlay = () => setPlaying(p => !p);
  const skipBack = () => { onTimeChange(Math.max(0, currentTime - 5)); };
  const skipFwd = () => { onTimeChange(Math.min(maxTime, currentTime + 5)); };

  return (
    <div className="flex-1 flex flex-col bg-black min-h-0">
      {/* Video area */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 p-3 overflow-hidden">
        <video ref={videoRef} className="max-w-full max-h-full rounded bg-neutral-950" playsInline preload="auto"
          style={{ display: activeAsset ? 'block' : 'none' }} />
        {!activeAsset && (
          <div className="text-neutral-600 text-sm select-none">No clip at current time</div>
        )}
        {/* Text overlays with animation */}
        {activeOverlays.map(ov => {
          const lt = currentTime - ov.startTime;
          const dur = ov.endTime - ov.startTime;
          const x = lerp(ov.positionKeyframes, lt, 'x');
          const y = lerp(ov.positionKeyframes, lt, 'y');
          const scale = lerp(ov.scaleKeyframes, lt, 'scale') || 1;
          const rotation = lerp(ov.rotationKeyframes, lt, 'rotation');
          const opacity = lerp(ov.opacityKeyframes, lt, 'opacity');
          // animation is stored in content as "text|||animation" or just "text"
          const parts = (ov.content || '').split('|||');
          const text = parts[0];
          const animation = parts[1] || 'none';
          const animStyle = getTextAnimation(animation, lt, dur);

          // For typewriter, show partial text
          let displayText = text;
          if (animation === 'typewriter') {
            const charCount = Math.min(text.length, Math.floor((lt / Math.min(2, dur)) * text.length));
            displayText = text.slice(0, charCount) + (charCount < text.length ? '▌' : '');
          }

          return (
            <div key={ov.id} className="absolute pointer-events-none"
              style={{
                left: x, top: y,
                transform: `scale(${scale}) rotate(${rotation}deg)`,
                opacity: opacity || 1,
                transition: 'filter 0.05s',
                ...animStyle,
              }}>
              {ov.type === 'text' && (
                <span style={{
                  fontSize: ov.fontSize || 24,
                  color: ov.color || '#fff',
                  backgroundColor: ov.bgColor || 'rgba(0,0,0,0.7)',
                  padding: '4px 12px',
                  borderRadius: 4,
                  whiteSpace: 'pre',
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                }}>
                  {displayText}
                </span>
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

        {/* Volume */}
        <div className="flex items-center gap-1 ml-3">
          <button onClick={() => setMuted(m => !m)} className="p-2 hover:bg-neutral-800 rounded-full transition" title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={16} className="text-neutral-500" /> : <Volume2 size={16} />}
          </button>
          <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
            onChange={e => { setVolume(+e.target.value); if (+e.target.value > 0) setMuted(false); }}
            className="w-16 h-1 accent-white cursor-pointer" aria-label="Volume" />
        </div>

        {/* Scrub bar */}
        <div className="flex-1 mx-4 flex items-center gap-2">
          <span className="text-[10px] font-mono text-neutral-500 w-12 text-right">{currentTime.toFixed(1)}s</span>
          <input type="range" min={0} max={maxTime} step={0.05} value={currentTime}
            onChange={e => { setPlaying(false); onTimeChange(+e.target.value); }}
            className="flex-1 h-1 accent-red-500 cursor-pointer" aria-label="Scrub timeline" />
          <span className="text-[10px] font-mono text-neutral-500 w-12">{maxTime.toFixed(1)}s</span>
        </div>
      </div>
    </div>
  );
}
