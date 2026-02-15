import { useState, useEffect, useCallback } from 'react';
import { projectsApi, assetsApi, clipsApi, overlaysApi, exportsApi } from './api/client';
import type { Project, Asset, Clip, Overlay, SpeedKeyframe, TransformKeyframe } from './api/client';
import {
  FolderOpen, Plus, Type, Download, Gauge, Trash2, Scissors, Pencil,
  Copy, RotateCcw, RotateCw, Image, ChevronDown, Crosshair,
} from 'lucide-react';
import Timeline from './components/Timeline';
import Preview from './components/Preview';
import AssetPanel from './components/AssetPanel';
import Modal from './components/Modal';
import Toast from './components/Toast';

const TEXT_ANIMATIONS = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide Up' },
  { value: 'slide-left', label: 'Slide Left' },
  { value: 'scale', label: 'Scale' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'blur', label: 'Blur' },
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [time, setTime] = useState(0);
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const [selectedOverlay, setSelectedOverlay] = useState<Overlay | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [uploadPct, setUploadPct] = useState(-1);
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'success' } | null>(null);

  // Modals
  const [showNewProject, setShowNewProject] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showEditOverlay, setShowEditOverlay] = useState(false);
  const [showSpeedEdit, setShowSpeedEdit] = useState(false);
  const [showKeyframes, setShowKeyframes] = useState(false);
  const [showImageOverlay, setShowImageOverlay] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);

  // Form state
  const [newProjectName, setNewProjectName] = useState('');
  const [overlayText, setOverlayText] = useState('');
  const [overlayFontSize, setOverlayFontSize] = useState(48);
  const [overlayColor, setOverlayColor] = useState('#ffffff');
  const [overlayBgColor, setOverlayBgColor] = useState('#000000');
  const [overlayAnimation, setOverlayAnimation] = useState('none');

  // Speed keyframes for multi-keyframe editing
  const [speedKeyframes, setSpeedKeyframes] = useState<SpeedKeyframe[]>([{ time: 0, speed: 1 }]);

  // Overlay keyframes for editing
  const [posKfs, setPosKfs] = useState<TransformKeyframe[]>([]);
  const [scaleKfs, setScaleKfs] = useState<TransformKeyframe[]>([]);
  const [rotKfs, setRotKfs] = useState<TransformKeyframe[]>([]);
  const [opacityKfs, setOpacityKfs] = useState<TransformKeyframe[]>([]);

  // Undo/redo
  const [undoStack, setUndoStack] = useState<{ clips: Clip[]; overlays: Overlay[] }[]>([]);
  const [redoStack, setRedoStack] = useState<{ clips: Clip[]; overlays: Overlay[] }[]>([]);

  useEffect(() => { loadProjects(); }, []);

  const flash = (msg: string, type: 'error' | 'success' = 'error') => setToast({ msg, type });

  const pushUndo = () => {
    setUndoStack(s => [...s.slice(-30), { clips: [...clips], overlays: [...overlays] }]);
    setRedoStack([]);
  };

  const undo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack(s => [...s, { clips: [...clips], overlays: [...overlays] }]);
    setUndoStack(s => s.slice(0, -1));
    setClips(prev.clips); setOverlays(prev.overlays);
    setSelectedClip(null); setSelectedOverlay(null);
  };

  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack(s => [...s, { clips: [...clips], overlays: [...overlays] }]);
    setRedoStack(s => s.slice(0, -1));
    setClips(next.clips); setOverlays(next.overlays);
    setSelectedClip(null); setSelectedOverlay(null);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
        if (selectedClip) deleteClip(selectedClip.id);
        if (selectedOverlay) deleteOverlay(selectedOverlay.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const loadProjects = async () => {
    try { setProjects((await projectsApi.list()).data); } catch { flash('Cannot reach server'); }
  };

  const createProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const res = await projectsApi.create(newProjectName.trim());
      setProjects(p => [...p, res.data]);
      await openProject(res.data.id);
      setShowNewProject(false); setNewProjectName('');
      flash('Project created', 'success');
    } catch { flash('Failed to create project'); }
  };

  const openProject = async (id: string) => {
    try {
      const d = (await projectsApi.get(id)).data;
      setProject({ id: d.id, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt });
      setClips(d.clips || []); setOverlays(d.overlays || []); setAssets(d.assets || []);
      setTime(0); setSelectedClip(null); setSelectedOverlay(null);
      setUndoStack([]); setRedoStack([]);
      setShowProjectMenu(false);
    } catch { flash('Failed to load project'); }
  };

  // Upload + auto-add to timeline
  const upload = async (file: File, intent?: 'video' | 'image' | 'audio') => {
    if (!project) return;
    // If user clicked Audio button but picked a video file, extract audio
    const isVideoFile = file.type.startsWith('video/') || /\.(mp4|mov|avi|mkv)$/i.test(file.name);
    const extractAudio = intent === 'audio' && isVideoFile;
    try {
      setUploadPct(0);
      const res = await assetsApi.upload(project.id, file, pct => setUploadPct(pct), extractAudio);
      const asset = res.data;
      setAssets(a => [...a, asset]);
      setUploadPct(-1);

      if (asset.type === 'image') {
        // Images go as overlays, not clips
        pushUndo();
        const ovRes = await overlaysApi.create({
          projectId: project.id, type: 'image', track: 'overlay_1',
          startTime: time, endTime: time + 5, content: asset.filepath,
          positionKeyframes: [{ time: 0, x: 100, y: 100 }],
          scaleKeyframes: [{ time: 0, scale: 1 }],
          rotationKeyframes: [{ time: 0, rotation: 0 }],
          opacityKeyframes: [{ time: 0, opacity: 1 }],
        });
        setOverlays(o => [...o, ovRes.data]);
        flash('Image overlay added', 'success');
      } else {
        const track = asset.type === 'audio' ? 'audio' : 'video_a';
        const end = clips.filter(c => c.track === track).reduce((m, c) => Math.max(m, c.endTime), 0);
        const clipRes = await clipsApi.create({
          projectId: project.id, assetId: asset.id, track,
          startTime: end, endTime: end + (asset.duration || 5),
          trimStart: 0, speedKeyframes: [{ time: 0, speed: 1 }],
        });
        setClips(c => [...c, clipRes.data]);
        pushUndo();
        flash('Added to timeline', 'success');
      }
    } catch { setUploadPct(-1); flash('Upload failed'); }
  };

  const updateClip = async (id: string, updates: Partial<Clip>) => {
    try {
      const res = await clipsApi.update(id, updates);
      setClips(c => c.map(x => x.id === id ? res.data : x));
      if (selectedClip?.id === id) setSelectedClip(res.data);
    } catch { flash('Failed to update clip'); }
  };

  const deleteClip = async (id: string) => {
    try {
      pushUndo();
      await clipsApi.delete(id);
      setClips(c => c.filter(x => x.id !== id));
      if (selectedClip?.id === id) setSelectedClip(null);
    } catch { flash('Failed to delete clip'); }
  };

  const duplicateClip = async () => {
    if (!selectedClip || !project) return;
    const dur = selectedClip.endTime - selectedClip.startTime;
    try {
      pushUndo();
      const res = await clipsApi.create({
        projectId: project.id, assetId: selectedClip.assetId, track: selectedClip.track,
        startTime: selectedClip.endTime, endTime: selectedClip.endTime + dur,
        trimStart: selectedClip.trimStart, speedKeyframes: selectedClip.speedKeyframes,
      });
      setClips(c => [...c, res.data]);
      flash('Duplicated', 'success');
    } catch { flash('Failed to duplicate'); }
  };

  const splitClip = async () => {
    if (!selectedClip || time <= selectedClip.startTime || time >= selectedClip.endTime) {
      flash('Playhead must be inside the selected clip'); return;
    }
    try {
      pushUndo();
      const res = await clipsApi.split(selectedClip.id, time);
      setClips(c => c.map(x => x.id === selectedClip.id ? res.data.left : x).concat(res.data.right));
      setSelectedClip(res.data.left);
      flash('Split', 'success');
    } catch { flash('Failed to split'); }
  };

  // ---- Speed keyframe editing ----
  const openSpeedEdit = () => {
    if (!selectedClip) return;
    setSpeedKeyframes([...selectedClip.speedKeyframes]);
    setShowSpeedEdit(true);
  };

  const addSpeedKf = () => {
    const clipLocal = time - (selectedClip?.startTime ?? 0);
    if (clipLocal < 0) return;
    setSpeedKeyframes(kfs => [...kfs, { time: clipLocal, speed: 1 }].sort((a, b) => a.time - b.time));
  };

  const updateSpeedKf = (idx: number, field: 'time' | 'speed', val: number) => {
    setSpeedKeyframes(kfs => kfs.map((k, i) => i === idx ? { ...k, [field]: val } : k));
  };

  const removeSpeedKf = (idx: number) => {
    if (speedKeyframes.length <= 1) return;
    setSpeedKeyframes(kfs => kfs.filter((_, i) => i !== idx));
  };

  const applySpeed = async () => {
    if (!selectedClip) return;
    pushUndo();
    await updateClip(selectedClip.id, { speedKeyframes });
    setShowSpeedEdit(false);
  };

  // ---- Overlay CRUD ----
  const addOverlaySubmit = async () => {
    if (!project || !overlayText.trim()) return;
    try {
      pushUndo();
      const content = overlayAnimation !== 'none' ? `${overlayText.trim()}|||${overlayAnimation}` : overlayText.trim();
      const res = await overlaysApi.create({
        projectId: project.id, type: 'text', track: 'overlay_1',
        startTime: time, endTime: time + 5, content,
        fontSize: overlayFontSize, color: overlayColor, bgColor: overlayBgColor,
        positionKeyframes: [{ time: 0, x: 100, y: 100 }],
        scaleKeyframes: [{ time: 0, scale: 1 }],
        rotationKeyframes: [{ time: 0, rotation: 0 }],
        opacityKeyframes: [{ time: 0, opacity: 1 }],
      });
      setOverlays(o => [...o, res.data]);
      setShowOverlay(false); setOverlayText(''); setOverlayAnimation('none');
      flash('Text added', 'success');
    } catch { flash('Failed to add overlay'); }
  };

  // Image overlay
  const addImageOverlay = async (assetId: string) => {
    if (!project) return;
    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;
    try {
      pushUndo();
      const res = await overlaysApi.create({
        projectId: project.id, type: 'image', track: 'overlay_1',
        startTime: time, endTime: time + 5, content: asset.filepath,
        positionKeyframes: [{ time: 0, x: 100, y: 100 }],
        scaleKeyframes: [{ time: 0, scale: 1 }],
        rotationKeyframes: [{ time: 0, rotation: 0 }],
        opacityKeyframes: [{ time: 0, opacity: 1 }],
      });
      setOverlays(o => [...o, res.data]);
      setShowImageOverlay(false);
      flash('Image overlay added', 'success');
    } catch { flash('Failed to add image overlay'); }
  };

  const updateOverlay = async (id: string, updates: Partial<Overlay>) => {
    try {
      const res = await overlaysApi.update(id, updates);
      setOverlays(o => o.map(x => x.id === id ? res.data : x));
      if (selectedOverlay?.id === id) setSelectedOverlay(res.data);
    } catch { flash('Failed to update overlay'); }
  };

  const deleteOverlay = async (id: string) => {
    try {
      pushUndo();
      await overlaysApi.delete(id);
      setOverlays(o => o.filter(x => x.id !== id));
      if (selectedOverlay?.id === id) setSelectedOverlay(null);
    } catch { flash('Failed to delete overlay'); }
  };

  const openEditOverlay = () => {
    if (!selectedOverlay) return;
    const parts = (selectedOverlay.content || '').split('|||');
    setOverlayText(parts[0]);
    setOverlayAnimation(parts[1] || 'none');
    setOverlayFontSize(selectedOverlay.fontSize || 48);
    setOverlayColor(selectedOverlay.color || '#ffffff');
    setOverlayBgColor(selectedOverlay.bgColor || '#000000');
    setShowEditOverlay(true);
  };

  const saveEditOverlay = async () => {
    if (!selectedOverlay) return;
    pushUndo();
    if (selectedOverlay.type === 'image') {
      // Image overlays: don't touch content (it's a filepath), only save keyframes via Keyframes button
      setShowEditOverlay(false);
      return;
    }
    const content = overlayAnimation !== 'none' ? `${overlayText.trim()}|||${overlayAnimation}` : overlayText.trim();
    await updateOverlay(selectedOverlay.id, { content, fontSize: overlayFontSize, color: overlayColor, bgColor: overlayBgColor });
    setShowEditOverlay(false);
  };

  // ---- Overlay keyframe editing ----
  const openKeyframeEdit = () => {
    if (!selectedOverlay) return;
    setPosKfs([...selectedOverlay.positionKeyframes]);
    setScaleKfs([...selectedOverlay.scaleKeyframes]);
    setRotKfs([...selectedOverlay.rotationKeyframes]);
    setOpacityKfs([...selectedOverlay.opacityKeyframes]);
    setShowKeyframes(true);
  };

  const addKf = (setter: React.Dispatch<React.SetStateAction<TransformKeyframe[]>>, defaults: Partial<TransformKeyframe>) => {
    const lt = time - (selectedOverlay?.startTime ?? 0);
    setter(kfs => [...kfs, { time: Math.max(0, lt), ...defaults } as TransformKeyframe].sort((a, b) => a.time - b.time));
  };

  const saveKeyframes = async () => {
    if (!selectedOverlay) return;
    pushUndo();
    await updateOverlay(selectedOverlay.id, {
      positionKeyframes: posKfs, scaleKeyframes: scaleKfs,
      rotationKeyframes: rotKfs, opacityKeyframes: opacityKfs,
    });
    setShowKeyframes(false);
    flash('Keyframes saved', 'success');
  };

  const doExport = async () => {
    if (!project) return;
    setExporting(true); setExportPct(0);
    try {
      const eid = (await exportsApi.create(project.id)).data.id;
      const iv = setInterval(async () => {
        try {
          const s = (await exportsApi.get(eid)).data;
          setExportPct(Math.round(s.progress));
          if (s.status === 'COMPLETE') { clearInterval(iv); setExporting(false); window.open(exportsApi.download(eid), '_blank'); flash('Export done', 'success'); }
          else if (s.status === 'FAILED') { clearInterval(iv); setExporting(false); flash('Export failed: ' + (s.errorMessage || '')); }
        } catch { clearInterval(iv); setExporting(false); flash('Export error'); }
      }, 1000);
    } catch { setExporting(false); flash('Failed to start export'); }
  };

  const handleTimeChange = useCallback((t: number | ((prev: number) => number)) => {
    setTime(prev => typeof t === 'function' ? t(prev) : t);
  }, []);

  const canSplit = selectedClip && time > selectedClip.startTime && time < selectedClip.endTime;
  const imageAssets = assets.filter(a => a.type === 'image');

  // ---- Landing ----
  if (!project) {
    return (
      <div className="h-screen bg-black text-white flex flex-col items-center justify-center gap-6">
        <h1 className="text-4xl font-bold tracking-tight">Video Editor</h1>
        <p className="text-neutral-500 text-sm">Create or open a project</p>
        {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
        <button onClick={() => setShowNewProject(true)}
          className="flex items-center gap-2 px-6 py-2.5 bg-white text-black rounded-lg font-medium text-sm hover:bg-neutral-200 transition">
          <Plus size={16} /> New Project
        </button>
        {projects.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5 w-80">
            <p className="text-[10px] uppercase tracking-widest text-neutral-600 font-semibold mb-1">Recent</p>
            {projects.map(p => (
              <button key={p.id} onClick={() => openProject(p.id)}
                className="flex items-center gap-2 text-left px-4 py-2.5 bg-neutral-900 border border-neutral-800 rounded-lg text-sm hover:border-neutral-600 transition">
                <FolderOpen size={14} className="text-neutral-500 shrink-0" />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        )}
        <Modal open={showNewProject} onClose={() => setShowNewProject(false)} title="New Project">
          <div className="flex flex-col gap-3">
            <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)}
              placeholder="Project name" autoFocus onKeyDown={e => e.key === 'Enter' && createProject()}
              className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500" />
            <button onClick={createProject} className="w-full py-2 bg-white text-black rounded-lg text-sm font-medium hover:bg-neutral-200 transition">Create</button>
          </div>
        </Modal>
      </div>
    );
  }

  // ---- Editor ----
  return (
    <div className="h-screen bg-black text-white flex flex-col overflow-hidden">
      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* ---- Toolbar ---- */}
      <header className="flex items-center justify-between px-3 h-10 bg-neutral-900 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-tight text-red-500">VidEdit</span>
          <span className="text-neutral-700">/</span>
          {/* Project dropdown */}
          <div className="relative">
            <button onClick={() => setShowProjectMenu(p => !p)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md hover:border-neutral-600 transition">
              {project.name} <ChevronDown size={12} className="text-neutral-500" />
            </button>
            {showProjectMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProjectMenu(false)} />
                <div className="absolute top-full left-0 mt-1 w-48 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 py-1 max-h-60 overflow-y-auto">
                  {projects.map(p => (
                    <button key={p.id} onClick={() => openProject(p.id)}
                      className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-neutral-700 transition ${p.id === project.id ? 'text-blue-400' : 'text-neutral-300'}`}>
                      {p.name}
                    </button>
                  ))}
                  <div className="border-t border-neutral-700 mt-1 pt-1">
                    <button onClick={() => { setShowProjectMenu(false); setShowNewProject(true); }}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-400 hover:bg-neutral-700 transition flex items-center gap-1.5">
                      <Plus size={10} /> New Project
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={undo} disabled={!undoStack.length} title="Undo ⌘Z"
            className="p-1.5 hover:bg-neutral-800 rounded-md transition disabled:opacity-20">
            <RotateCcw size={13} />
          </button>
          <button onClick={redo} disabled={!redoStack.length} title="Redo ⌘⇧Z"
            className="p-1.5 hover:bg-neutral-800 rounded-md transition disabled:opacity-20">
            <RotateCw size={13} />
          </button>
          <div className="w-px h-4 bg-neutral-800 mx-1" />

          <button onClick={() => { setOverlayText(''); setOverlayAnimation('none'); setOverlayFontSize(48); setOverlayColor('#ffffff'); setOverlayBgColor('#000000'); setShowOverlay(true); }}
            className="flex items-center gap-1 px-2 py-1 text-[11px] bg-purple-600 hover:bg-purple-500 rounded-md transition">
            <Type size={11} /> Text
          </button>
          {imageAssets.length > 0 && (
            <button onClick={() => setShowImageOverlay(true)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] bg-indigo-600 hover:bg-indigo-500 rounded-md transition">
              <Image size={11} /> Image
            </button>
          )}

          {selectedClip && (
            <>
              <div className="w-px h-4 bg-neutral-800 mx-0.5" />
              <button onClick={openSpeedEdit}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-amber-600 hover:bg-amber-500 rounded-md transition">
                <Gauge size={11} /> Speed
              </button>
              <button onClick={splitClip} disabled={!canSplit}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-cyan-600 hover:bg-cyan-500 rounded-md transition disabled:opacity-30">
                <Scissors size={11} /> Split
              </button>
              <button onClick={duplicateClip}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 rounded-md transition">
                <Copy size={11} /> Duplicate
              </button>
            </>
          )}

          {selectedOverlay && (
            <>
              <div className="w-px h-4 bg-neutral-800 mx-0.5" />
              <button onClick={openEditOverlay}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-purple-600 hover:bg-purple-500 rounded-md transition">
                <Pencil size={11} /> Edit
              </button>
              <button onClick={openKeyframeEdit}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-fuchsia-600 hover:bg-fuchsia-500 rounded-md transition">
                <Crosshair size={11} /> Keyframes
              </button>
            </>
          )}

          <div className="w-px h-4 bg-neutral-800 mx-1" />
          <button onClick={doExport} disabled={exporting || clips.length === 0}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-red-600 hover:bg-red-500 rounded-md transition disabled:opacity-40">
            <Download size={11} /> {exporting ? `${exportPct}%` : 'Export'}
          </button>
        </div>
      </header>

      {/* ---- Main ---- */}
      <div className="flex flex-1 min-h-0">
        <AssetPanel assets={assets} onUpload={upload} uploadPct={uploadPct} />
        <Preview clips={clips} overlays={overlays} assets={assets} currentTime={time} onTimeChange={handleTimeChange} />
      </div>

      {/* ---- Selected item bar ---- */}
      {selectedClip && (
        <div className="flex items-center gap-3 px-4 py-1 bg-neutral-900 border-t border-neutral-800 shrink-0 text-[11px]">
          <span className="text-neutral-500">Clip</span>
          <span className="text-blue-400 font-mono">{selectedClip.id.slice(0, 8)}</span>
          <span className="text-neutral-600">|</span>
          <span className="text-neutral-400">{selectedClip.startTime.toFixed(1)}s → {selectedClip.endTime.toFixed(1)}s</span>
          <span className="text-neutral-600">|</span>
          <span className="text-amber-400">{selectedClip.speedKeyframes.length > 1 ? `${selectedClip.speedKeyframes.length} kfs` : `${selectedClip.speedKeyframes[0]?.speed ?? 1}x`}</span>
          {canSplit && <span className="text-cyan-400">Split @ {time.toFixed(1)}s</span>}
          <div className="ml-auto flex items-center gap-1">
            <button onClick={duplicateClip} className="flex items-center gap-1 px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 transition">
              <Copy size={10} /> Dup
            </button>
            <button onClick={() => deleteClip(selectedClip.id)} className="flex items-center gap-1 px-2 py-0.5 bg-red-900/60 hover:bg-red-800 rounded text-red-300 transition">
              <Trash2 size={10} /> Del
            </button>
          </div>
        </div>
      )}
      {selectedOverlay && (
        <div className="flex items-center gap-3 px-4 py-1 bg-neutral-900 border-t border-neutral-800 shrink-0 text-[11px]">
          <span className="text-neutral-500">{selectedOverlay.type === 'image' ? 'Image' : 'Text'}</span>
          <span className="text-purple-400">"{(selectedOverlay.content || '').split('|||')[0].slice(0, 20)}"</span>
          <span className="text-neutral-600">|</span>
          <span className="text-neutral-400">{selectedOverlay.startTime.toFixed(1)}s → {selectedOverlay.endTime.toFixed(1)}s</span>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={openEditOverlay} className="flex items-center gap-1 px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 transition">
              <Pencil size={10} /> Edit
            </button>
            <button onClick={openKeyframeEdit} className="flex items-center gap-1 px-2 py-0.5 bg-fuchsia-900/60 hover:bg-fuchsia-800 rounded text-fuchsia-300 transition">
              <Crosshair size={10} /> KFs
            </button>
            <button onClick={() => deleteOverlay(selectedOverlay.id)} className="flex items-center gap-1 px-2 py-0.5 bg-red-900/60 hover:bg-red-800 rounded text-red-300 transition">
              <Trash2 size={10} /> Del
            </button>
          </div>
        </div>
      )}

      {/* ---- Timeline ---- */}
      <Timeline
        clips={clips} overlays={overlays} assets={assets} currentTime={time}
        onTimeChange={handleTimeChange}
        onClipUpdate={updateClip} onClipDelete={deleteClip}
        onSelectClip={setSelectedClip} onSelectOverlay={setSelectedOverlay}
        onOverlayDelete={deleteOverlay} onOverlayUpdate={updateOverlay}
        selectedClipId={selectedClip?.id ?? null}
        selectedOverlayId={selectedOverlay?.id ?? null}
      />

      {/* ======== MODALS ======== */}

      <Modal open={showNewProject} onClose={() => setShowNewProject(false)} title="New Project">
        <div className="flex flex-col gap-3">
          <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)}
            placeholder="Project name" autoFocus onKeyDown={e => e.key === 'Enter' && createProject()}
            className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500" />
          <button onClick={createProject} className="w-full py-2 bg-white text-black rounded-lg text-sm font-medium hover:bg-neutral-200 transition">Create</button>
        </div>
      </Modal>

      {/* Add Text Overlay */}
      <Modal open={showOverlay} onClose={() => setShowOverlay(false)} title="Add Text Overlay">
        <div className="flex flex-col gap-3">
          <input value={overlayText} onChange={e => setOverlayText(e.target.value)}
            placeholder="Enter text" autoFocus onKeyDown={e => e.key === 'Enter' && addOverlaySubmit()}
            className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500" />
          <div>
            <span className="text-[10px] text-neutral-500 uppercase block mb-1">Animation</span>
            <div className="grid grid-cols-4 gap-1">
              {TEXT_ANIMATIONS.map(a => (
                <button key={a.value} onClick={() => setOverlayAnimation(a.value)}
                  className={`py-1 text-[10px] rounded-md border transition ${overlayAnimation === a.value ? 'bg-purple-600 border-purple-400 text-white' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] text-neutral-500 uppercase">Size</span>
              <input type="number" value={overlayFontSize} onChange={e => setOverlayFontSize(+e.target.value)}
                className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-white focus:outline-none focus:border-blue-500" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-500 uppercase">Color</span>
              <input type="color" value={overlayColor} onChange={e => setOverlayColor(e.target.value)}
                className="w-9 h-8 bg-neutral-800 border border-neutral-700 rounded-md cursor-pointer" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-500 uppercase">BG</span>
              <input type="color" value={overlayBgColor} onChange={e => setOverlayBgColor(e.target.value)}
                className="w-9 h-8 bg-neutral-800 border border-neutral-700 rounded-md cursor-pointer" />
            </label>
          </div>
          <div className="bg-neutral-800 rounded-lg p-3 flex items-center justify-center min-h-[50px]">
            <span style={{ fontSize: Math.min(overlayFontSize, 28), color: overlayColor, backgroundColor: overlayBgColor, padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {overlayText || 'Preview'}
            </span>
          </div>
          <button onClick={addOverlaySubmit} disabled={!overlayText.trim()}
            className="w-full py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition disabled:opacity-40">Add</button>
        </div>
      </Modal>

      {/* Edit Overlay */}
      <Modal open={showEditOverlay} onClose={() => setShowEditOverlay(false)} title={selectedOverlay?.type === 'image' ? 'Edit Image Overlay' : 'Edit Text Overlay'}>
        <div className="flex flex-col gap-3">
          {selectedOverlay?.type === 'text' && (
            <>
              <input value={overlayText} onChange={e => setOverlayText(e.target.value)}
                placeholder="Text" autoFocus onKeyDown={e => e.key === 'Enter' && saveEditOverlay()}
                className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500" />
              <div>
                <span className="text-[10px] text-neutral-500 uppercase block mb-1">Animation</span>
                <div className="grid grid-cols-4 gap-1">
                  {TEXT_ANIMATIONS.map(a => (
                    <button key={a.value} onClick={() => setOverlayAnimation(a.value)}
                      className={`py-1 text-[10px] rounded-md border transition ${overlayAnimation === a.value ? 'bg-purple-600 border-purple-400 text-white' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <label className="flex flex-col gap-1 flex-1">
                  <span className="text-[10px] text-neutral-500 uppercase">Size</span>
                  <input type="number" value={overlayFontSize} onChange={e => setOverlayFontSize(+e.target.value)}
                    className="px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-white focus:outline-none focus:border-blue-500" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-neutral-500 uppercase">Color</span>
                  <input type="color" value={overlayColor} onChange={e => setOverlayColor(e.target.value)}
                    className="w-9 h-8 bg-neutral-800 border border-neutral-700 rounded-md cursor-pointer" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-neutral-500 uppercase">BG</span>
                  <input type="color" value={overlayBgColor} onChange={e => setOverlayBgColor(e.target.value)}
                    className="w-9 h-8 bg-neutral-800 border border-neutral-700 rounded-md cursor-pointer" />
                </label>
              </div>
            </>
          )}
          {selectedOverlay?.type === 'image' && (
            <p className="text-neutral-400 text-sm">Use the Keyframes button to adjust position, scale, rotation, and opacity.</p>
          )}
          <button onClick={saveEditOverlay} className="w-full py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition">Save</button>
        </div>
      </Modal>

      {/* Image Overlay picker */}
      <Modal open={showImageOverlay} onClose={() => setShowImageOverlay(false)} title="Add Image Overlay">
        <div className="flex flex-col gap-2">
          {imageAssets.length === 0 && <p className="text-neutral-500 text-sm">Upload a PNG image first</p>}
          {imageAssets.map(a => (
            <button key={a.id} onClick={() => addImageOverlay(a.id)}
              className="flex items-center gap-2 px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-neutral-600 transition text-sm text-left">
              <Image size={14} className="text-indigo-400 shrink-0" />
              <span className="truncate">{a.filename}</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Speed Keyframes */}
      <Modal open={showSpeedEdit} onClose={() => setShowSpeedEdit(false)} title="Speed Keyframes">
        <div className="flex flex-col gap-3">
          <p className="text-[10px] text-neutral-500">Add keyframes to ramp speed over time. 0x = freeze frame.</p>
          <div className="max-h-48 overflow-y-auto flex flex-col gap-1.5">
            {speedKeyframes.map((kf, i) => (
              <div key={i} className="flex items-center gap-2 bg-neutral-800 rounded-md px-2 py-1.5">
                <label className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[9px] text-neutral-500">Time (s)</span>
                  <input type="number" step={0.1} min={0} value={kf.time}
                    onChange={e => updateSpeedKf(i, 'time', +e.target.value)}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:border-amber-500 w-full" />
                </label>
                <label className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[9px] text-neutral-500">Speed</span>
                  <input type="number" step={0.25} min={0} max={8} value={kf.speed}
                    onChange={e => updateSpeedKf(i, 'speed', +e.target.value)}
                    className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-xs text-white focus:outline-none focus:border-amber-500 w-full" />
                </label>
                <button onClick={() => removeSpeedKf(i)} disabled={speedKeyframes.length <= 1}
                  className="p-1 text-red-400 hover:text-red-300 disabled:opacity-20 mt-3">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          {/* Quick presets */}
          <div className="flex gap-1">
            {[0, 0.25, 0.5, 1, 2, 4, 8].map(v => (
              <button key={v} onClick={() => setSpeedKeyframes([{ time: 0, speed: v }])}
                className="flex-1 py-1 text-[9px] rounded border bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600 transition">
                {v === 0 ? 'Freeze' : `${v}x`}
              </button>
            ))}
          </div>
          <button onClick={addSpeedKf}
            className="w-full py-1.5 text-xs border border-dashed border-neutral-700 rounded-md text-neutral-400 hover:border-amber-500 hover:text-amber-400 transition">
            + Add Keyframe at Playhead
          </button>
          <button onClick={applySpeed} className="w-full py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-500 transition">Apply</button>
        </div>
      </Modal>

      {/* Overlay Keyframes */}
      <Modal open={showKeyframes} onClose={() => setShowKeyframes(false)} title="Overlay Keyframes">
        <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">

          {/* Position */}
          <section className="bg-neutral-800/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-blue-400 font-semibold tracking-wide">Position</span>
              <button onClick={() => addKf(setPosKfs, { x: 100, y: 100 })}
                className="text-[10px] px-2 py-0.5 bg-blue-600/20 text-blue-400 rounded-md hover:bg-blue-600/30 transition">+ Add</button>
            </div>
            {/* Alignment presets — based on 1280×720 canvas, center-anchored */}
            <div className="grid grid-cols-3 gap-1 mb-2">
              {([
                ['TL', 120, 80], ['T', 640, 80], ['TR', 1160, 80],
                ['L', 120, 360], ['C', 640, 360], ['R', 1160, 360],
                ['BL', 120, 640], ['B', 640, 640], ['BR', 1160, 640],
              ] as [string, number, number][]).map(([label, px, py]) => (
                <button key={label} onClick={() => {
                  if (posKfs.length === 0) setPosKfs([{ time: 0, x: px, y: py }]);
                  else setPosKfs(k => k.map((v, j) => j === 0 ? { ...v, x: px, y: py } : v));
                }}
                  className="py-1 text-[9px] rounded border bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-blue-500 hover:text-blue-400 transition">
                  {label}
                </button>
              ))}
            </div>
            {posKfs.map((kf, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[8px] text-neutral-500 uppercase">Time</span>
                  <input type="number" step={0.1} value={kf.time} onChange={e => setPosKfs(k => k.map((v, j) => j === i ? { ...v, time: +e.target.value } : v))}
                    className="w-14 px-2 py-1.5 bg-neutral-900 border border-neutral-700 rounded-md text-[11px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[8px] text-neutral-500 uppercase">X</span>
                  <input type="number" value={kf.x ?? 0} onChange={e => setPosKfs(k => k.map((v, j) => j === i ? { ...v, x: +e.target.value } : v))}
                    className="w-full px-2 py-1.5 bg-neutral-900 border border-neutral-700 rounded-md text-[11px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[8px] text-neutral-500 uppercase">Y</span>
                  <input type="number" value={kf.y ?? 0} onChange={e => setPosKfs(k => k.map((v, j) => j === i ? { ...v, y: +e.target.value } : v))}
                    className="w-full px-2 py-1.5 bg-neutral-900 border border-neutral-700 rounded-md text-[11px] text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30" />
                </div>
                <button onClick={() => setPosKfs(k => k.filter((_, j) => j !== i))}
                  className="mt-3 p-1 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition"><Trash2 size={12} /></button>
              </div>
            ))}
            {posKfs.length === 0 && <p className="text-[10px] text-neutral-600 italic">No keyframes</p>}
          </section>

          {/* Scale */}
          <section className="bg-neutral-800/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-amber-400 font-semibold tracking-wide">Scale</span>
              <button onClick={() => addKf(setScaleKfs, { scale: 1 })}
                className="text-[10px] px-2 py-0.5 bg-amber-600/20 text-amber-400 rounded-md hover:bg-amber-600/30 transition">+ Add</button>
            </div>
            {scaleKfs.map((kf, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[8px] text-neutral-500 uppercase">Time</span>
                  <input type="number" step={0.1} value={kf.time} onChange={e => setScaleKfs(k => k.map((v, j) => j === i ? { ...v, time: +e.target.value } : v))}
                    className="w-14 px-2 py-1.5 bg-neutral-900 border border-neutral-700 rounded-md text-[11px] text-white focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[8px] text-neutral-500 uppercase">Scale ({(kf.scale ?? 1).toFixed(1)}x)</span>
                  <input type="range" min={0} max={5} step={0.1} value={kf.scale ?? 1}
                    onChange={e => setScaleKfs(k => k.map((v, j) => j === i ? { ...v, scale: +e.target.value } : v))}
                    className="w-full h-1.5 accent-amber-500 cursor-pointer" />
                </div>
                <button onClick={() => setScaleKfs(k => k.filter((_, j) => j !== i))}
                  className="mt-3 p-1 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition"><Trash2 size={12} /></button>
              </div>
            ))}
            {scaleKfs.length === 0 && <p className="text-[10px] text-neutral-600 italic">No keyframes</p>}
          </section>

          {/* Rotation */}
          <section className="bg-neutral-800/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-emerald-400 font-semibold tracking-wide">Rotation</span>
              <button onClick={() => addKf(setRotKfs, { rotation: 0 })}
                className="text-[10px] px-2 py-0.5 bg-emerald-600/20 text-emerald-400 rounded-md hover:bg-emerald-600/30 transition">+ Add</button>
            </div>
            {rotKfs.map((kf, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[8px] text-neutral-500 uppercase">Time</span>
                  <input type="number" step={0.1} value={kf.time} onChange={e => setRotKfs(k => k.map((v, j) => j === i ? { ...v, time: +e.target.value } : v))}
                    className="w-14 px-2 py-1.5 bg-neutral-900 border border-neutral-700 rounded-md text-[11px] text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[8px] text-neutral-500 uppercase">Degrees ({kf.rotation ?? 0}°)</span>
                  <input type="range" min={-360} max={360} step={1} value={kf.rotation ?? 0}
                    onChange={e => setRotKfs(k => k.map((v, j) => j === i ? { ...v, rotation: +e.target.value } : v))}
                    className="w-full h-1.5 accent-emerald-500 cursor-pointer" />
                </div>
                <button onClick={() => setRotKfs(k => k.filter((_, j) => j !== i))}
                  className="mt-3 p-1 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition"><Trash2 size={12} /></button>
              </div>
            ))}
            {rotKfs.length === 0 && <p className="text-[10px] text-neutral-600 italic">No keyframes</p>}
          </section>

          {/* Opacity */}
          <section className="bg-neutral-800/50 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-purple-400 font-semibold tracking-wide">Opacity</span>
              <button onClick={() => addKf(setOpacityKfs, { opacity: 1 })}
                className="text-[10px] px-2 py-0.5 bg-purple-600/20 text-purple-400 rounded-md hover:bg-purple-600/30 transition">+ Add</button>
            </div>
            {opacityKfs.map((kf, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[8px] text-neutral-500 uppercase">Time</span>
                  <input type="number" step={0.1} value={kf.time} onChange={e => setOpacityKfs(k => k.map((v, j) => j === i ? { ...v, time: +e.target.value } : v))}
                    className="w-14 px-2 py-1.5 bg-neutral-900 border border-neutral-700 rounded-md text-[11px] text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500/30" />
                </div>
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-[8px] text-neutral-500 uppercase">Opacity ({((kf.opacity ?? 1) * 100).toFixed(0)}%)</span>
                  <input type="range" min={0} max={1} step={0.05} value={kf.opacity ?? 1}
                    onChange={e => setOpacityKfs(k => k.map((v, j) => j === i ? { ...v, opacity: +e.target.value } : v))}
                    className="w-full h-1.5 accent-purple-500 cursor-pointer" />
                </div>
                <button onClick={() => setOpacityKfs(k => k.filter((_, j) => j !== i))}
                  className="mt-3 p-1 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition"><Trash2 size={12} /></button>
              </div>
            ))}
            {opacityKfs.length === 0 && <p className="text-[10px] text-neutral-600 italic">No keyframes</p>}
          </section>

          <button onClick={saveKeyframes} className="w-full py-2.5 bg-fuchsia-600 text-white rounded-lg text-sm font-medium hover:bg-fuchsia-500 transition">Save Keyframes</button>
        </div>
      </Modal>
    </div>
  );
}
