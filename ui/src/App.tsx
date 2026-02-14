import { useState, useEffect, useCallback } from 'react';
import { projectsApi, assetsApi, clipsApi, overlaysApi, exportsApi } from './api/client';
import type { Project, Asset, Clip, Overlay } from './api/client';
import {
  FolderOpen, Plus, Type, Download, Gauge, Trash2, Scissors, Pencil,
  Copy, RotateCcw, RotateCw,
} from 'lucide-react';
import Timeline from './components/Timeline';
import Preview from './components/Preview';
import AssetPanel from './components/AssetPanel';
import Modal from './components/Modal';
import Toast from './components/Toast';

const TEXT_ANIMATIONS = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade In/Out' },
  { value: 'slide-up', label: 'Slide Up' },
  { value: 'slide-left', label: 'Slide Left' },
  { value: 'scale', label: 'Scale Pop' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'blur', label: 'Blur Reveal' },
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
  const [newProjectName, setNewProjectName] = useState('');
  const [overlayText, setOverlayText] = useState('');
  const [overlayFontSize, setOverlayFontSize] = useState(48);
  const [overlayColor, setOverlayColor] = useState('#ffffff');
  const [overlayBgColor, setOverlayBgColor] = useState('#000000');
  const [overlayAnimation, setOverlayAnimation] = useState('none');
  const [speedValue, setSpeedValue] = useState(1);

  // Undo/redo stacks
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
    setClips(prev.clips);
    setOverlays(prev.overlays);
    setSelectedClip(null);
    setSelectedOverlay(null);
    flash('Undone', 'success');
  };

  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack(s => [...s, { clips: [...clips], overlays: [...overlays] }]);
    setRedoStack(s => s.slice(0, -1));
    setClips(next.clips);
    setOverlays(next.overlays);
    setSelectedClip(null);
    setSelectedOverlay(null);
    flash('Redone', 'success');
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClip && !(e.target instanceof HTMLInputElement)) { deleteClip(selectedClip.id); }
        if (selectedOverlay && !(e.target instanceof HTMLInputElement)) { deleteOverlay(selectedOverlay.id); }
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
    } catch { flash('Failed to load project'); }
  };

  // Upload + auto-add to timeline
  const upload = async (file: File) => {
    if (!project) return;
    try {
      setUploadPct(0);
      const res = await assetsApi.upload(project.id, file, pct => setUploadPct(pct));
      const asset = res.data;
      setAssets(a => [...a, asset]);
      setUploadPct(-1);

      // Auto-add to timeline
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

  // Duplicate clip
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
      flash('Clip duplicated', 'success');
    } catch { flash('Failed to duplicate'); }
  };

  // Split at playhead
  const splitClip = async () => {
    if (!selectedClip) return;
    if (time <= selectedClip.startTime || time >= selectedClip.endTime) {
      flash('Playhead must be inside the selected clip to split'); return;
    }
    try {
      pushUndo();
      const res = await clipsApi.split(selectedClip.id, time);
      const { left, right } = res.data;
      setClips(c => c.map(x => x.id === selectedClip.id ? left : x).concat(right));
      setSelectedClip(left);
      flash('Clip split', 'success');
    } catch { flash('Failed to split clip'); }
  };

  // Overlay CRUD
  const addOverlaySubmit = async () => {
    if (!project || !overlayText.trim()) return;
    try {
      pushUndo();
      // Store animation in content as "text|||animation"
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
      flash('Text overlay added', 'success');
    } catch { flash('Failed to add overlay'); }
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
    const content = overlayAnimation !== 'none' ? `${overlayText.trim()}|||${overlayAnimation}` : overlayText.trim();
    await updateOverlay(selectedOverlay.id, {
      content, fontSize: overlayFontSize, color: overlayColor, bgColor: overlayBgColor,
    });
    setShowEditOverlay(false);
  };

  const applySpeed = async () => {
    if (!selectedClip) return;
    pushUndo();
    await updateClip(selectedClip.id, { speedKeyframes: [{ time: 0, speed: speedValue }] });
    setShowSpeedEdit(false);
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
          if (s.status === 'COMPLETE') { clearInterval(iv); setExporting(false); window.open(exportsApi.download(eid), '_blank'); flash('Export complete!', 'success'); }
          else if (s.status === 'FAILED') { clearInterval(iv); setExporting(false); flash('Export failed: ' + (s.errorMessage || 'Unknown')); }
        } catch { clearInterval(iv); setExporting(false); flash('Export polling failed'); }
      }, 1000);
    } catch { setExporting(false); flash('Failed to start export'); }
  };

  const handleTimeChange = useCallback((t: number | ((prev: number) => number)) => {
    setTime(prev => typeof t === 'function' ? t(prev) : t);
  }, []);

  const canSplit = selectedClip && time > selectedClip.startTime && time < selectedClip.endTime;

  // Landing
  if (!project) {
    return (
      <div className="h-screen bg-black text-white flex flex-col items-center justify-center gap-6">
        <h1 className="text-4xl font-bold tracking-tight">Video Editor</h1>
        <p className="text-neutral-500 text-sm">Create or open a project to start editing</p>
        {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
        <button onClick={() => setShowNewProject(true)}
          className="flex items-center gap-2 px-6 py-2.5 bg-white text-black rounded-lg font-medium text-sm hover:bg-neutral-200 transition">
          <Plus size={16} /> New Project
        </button>
        {projects.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5 w-80">
            <p className="text-[10px] uppercase tracking-widest text-neutral-600 font-semibold mb-1">Recent Projects</p>
            {projects.map(p => (
              <button key={p.id} onClick={() => openProject(p.id)}
                className="flex items-center gap-2 text-left px-4 py-2.5 bg-neutral-900 border border-neutral-800 rounded-lg text-sm hover:border-neutral-600 hover:bg-neutral-800 transition">
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

  return (
    <div className="h-screen bg-black text-white flex flex-col overflow-hidden">
      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

      {/* Header toolbar */}
      <header className="flex items-center justify-between px-3 h-10 bg-neutral-950 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-tight text-red-500">VidEdit</span>
          <span className="text-[11px] text-neutral-600">/ {project.name}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Undo / Redo */}
          <button onClick={undo} disabled={!undoStack.length} title="Undo (⌘Z)"
            className="p-1.5 hover:bg-neutral-800 rounded-md transition disabled:opacity-20 disabled:cursor-not-allowed">
            <RotateCcw size={14} />
          </button>
          <button onClick={redo} disabled={!redoStack.length} title="Redo (⌘⇧Z)"
            className="p-1.5 hover:bg-neutral-800 rounded-md transition disabled:opacity-20 disabled:cursor-not-allowed">
            <RotateCw size={14} />
          </button>
          <div className="w-px h-5 bg-neutral-800 mx-1" />

          {/* Add text overlay */}
          <button onClick={() => { setOverlayText(''); setOverlayAnimation('none'); setOverlayFontSize(48); setOverlayColor('#ffffff'); setOverlayBgColor('#000000'); setShowOverlay(true); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-purple-700 hover:bg-purple-600 rounded-md transition">
            <Type size={12} /> Text
          </button>

          {/* Clip tools — only when clip selected */}
          {selectedClip && (
            <>
              <button onClick={() => { setSpeedValue(selectedClip.speedKeyframes[0]?.speed ?? 1); setShowSpeedEdit(true); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-amber-700 hover:bg-amber-600 rounded-md transition">
                <Gauge size={12} /> Speed
              </button>
              <button onClick={splitClip} disabled={!canSplit}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-cyan-700 hover:bg-cyan-600 rounded-md transition disabled:opacity-30 disabled:cursor-not-allowed">
                <Scissors size={12} /> Split
              </button>
              <button onClick={duplicateClip}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-blue-700 hover:bg-blue-600 rounded-md transition">
                <Copy size={12} /> Duplicate
              </button>
            </>
          )}

          {/* Overlay tools */}
          {selectedOverlay && (
            <button onClick={openEditOverlay}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-purple-700 hover:bg-purple-600 rounded-md transition">
              <Pencil size={12} /> Edit Text
            </button>
          )}

          <div className="w-px h-5 bg-neutral-800 mx-1" />

          {/* Export */}
          <button onClick={doExport} disabled={exporting || clips.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-red-700 hover:bg-red-600 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed">
            <Download size={12} /> {exporting ? `${exportPct}%` : 'Export'}
          </button>

          <div className="w-px h-5 bg-neutral-800 mx-1" />

          {/* Project switcher */}
          <select value={project.id} onChange={e => openProject(e.target.value)}
            className="text-[11px] bg-neutral-900 border border-neutral-800 rounded-md px-2 py-1 text-neutral-400 focus:outline-none" aria-label="Switch project">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={() => setShowNewProject(true)} className="p-1.5 hover:bg-neutral-800 rounded-md transition" title="New project">
            <Plus size={14} />
          </button>
        </div>
      </header>

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        <AssetPanel assets={assets} onUpload={upload} uploadPct={uploadPct} />
        <Preview clips={clips} overlays={overlays} assets={assets} currentTime={time} onTimeChange={handleTimeChange} />
      </div>

      {/* Selected item bar */}
      {selectedClip && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-neutral-900 border-t border-neutral-800 shrink-0 text-[11px]">
          <span className="text-neutral-500">Clip</span>
          <span className="text-blue-400 font-mono">{selectedClip.id.slice(0, 8)}</span>
          <span className="text-neutral-600">|</span>
          <span className="text-neutral-400">{selectedClip.startTime.toFixed(1)}s → {selectedClip.endTime.toFixed(1)}s</span>
          <span className="text-neutral-600">|</span>
          <span className="text-amber-400">{selectedClip.speedKeyframes[0]?.speed ?? 1}x</span>
          {canSplit && <span className="text-cyan-400">Split ready at {time.toFixed(1)}s</span>}
          <div className="ml-auto flex items-center gap-1">
            <button onClick={duplicateClip}
              className="flex items-center gap-1 px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded transition text-neutral-300">
              <Copy size={11} /> Duplicate
            </button>
            <button onClick={() => deleteClip(selectedClip.id)}
              className="flex items-center gap-1 px-2 py-1 bg-red-900 hover:bg-red-800 rounded transition text-red-300">
              <Trash2 size={11} /> Delete
            </button>
          </div>
        </div>
      )}
      {selectedOverlay && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-neutral-900 border-t border-neutral-800 shrink-0 text-[11px]">
          <span className="text-neutral-500">Text</span>
          <span className="text-purple-400">"{(selectedOverlay.content || '').split('|||')[0]}"</span>
          <span className="text-neutral-600">|</span>
          <span className="text-neutral-400">{selectedOverlay.startTime.toFixed(1)}s → {selectedOverlay.endTime.toFixed(1)}s</span>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={openEditOverlay}
              className="flex items-center gap-1 px-2 py-1 bg-neutral-800 hover:bg-neutral-700 rounded transition text-neutral-300">
              <Pencil size={11} /> Edit
            </button>
            <button onClick={() => deleteOverlay(selectedOverlay.id)}
              className="flex items-center gap-1 px-2 py-1 bg-red-900 hover:bg-red-800 rounded transition text-red-300">
              <Trash2 size={11} /> Delete
            </button>
          </div>
        </div>
      )}

      {/* Timeline */}
      <Timeline
        clips={clips} overlays={overlays} currentTime={time}
        onTimeChange={handleTimeChange}
        onClipUpdate={updateClip} onClipDelete={deleteClip}
        onSelectClip={setSelectedClip} onSelectOverlay={setSelectedOverlay}
        onOverlayDelete={deleteOverlay} onOverlayUpdate={updateOverlay}
        selectedClipId={selectedClip?.id ?? null}
        selectedOverlayId={selectedOverlay?.id ?? null}
      />

      {/* ---- Modals ---- */}

      {/* New Project */}
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

          {/* Animation picker */}
          <div>
            <span className="text-[10px] text-neutral-500 uppercase block mb-1.5">Animation</span>
            <div className="grid grid-cols-4 gap-1.5">
              {TEXT_ANIMATIONS.map(a => (
                <button key={a.value} onClick={() => setOverlayAnimation(a.value)}
                  className={`py-1.5 text-[10px] rounded-md border transition ${overlayAnimation === a.value
                    ? 'bg-purple-700 border-purple-500 text-white'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] text-neutral-500 uppercase">Size</span>
              <input type="number" value={overlayFontSize} onChange={e => setOverlayFontSize(+e.target.value)}
                className="px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-500 uppercase">Text</span>
              <input type="color" value={overlayColor} onChange={e => setOverlayColor(e.target.value)}
                className="w-10 h-9 bg-neutral-800 border border-neutral-700 rounded-lg cursor-pointer" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-500 uppercase">BG</span>
              <input type="color" value={overlayBgColor} onChange={e => setOverlayBgColor(e.target.value)}
                className="w-10 h-9 bg-neutral-800 border border-neutral-700 rounded-lg cursor-pointer" />
            </label>
          </div>

          {/* Preview */}
          <div className="bg-neutral-800 rounded-lg p-4 flex items-center justify-center min-h-[60px]">
            <span style={{ fontSize: Math.min(overlayFontSize, 32), color: overlayColor, backgroundColor: overlayBgColor, padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {overlayText || 'Preview'}
            </span>
          </div>

          <p className="text-[10px] text-neutral-600">Placed at {time.toFixed(1)}s for 5 seconds</p>
          <button onClick={addOverlaySubmit} disabled={!overlayText.trim()}
            className="w-full py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition disabled:opacity-40">Add Overlay</button>
        </div>
      </Modal>

      {/* Edit Overlay */}
      <Modal open={showEditOverlay} onClose={() => setShowEditOverlay(false)} title="Edit Text Overlay">
        <div className="flex flex-col gap-3">
          <input value={overlayText} onChange={e => setOverlayText(e.target.value)}
            placeholder="Text content" autoFocus onKeyDown={e => e.key === 'Enter' && saveEditOverlay()}
            className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500" />

          <div>
            <span className="text-[10px] text-neutral-500 uppercase block mb-1.5">Animation</span>
            <div className="grid grid-cols-4 gap-1.5">
              {TEXT_ANIMATIONS.map(a => (
                <button key={a.value} onClick={() => setOverlayAnimation(a.value)}
                  className={`py-1.5 text-[10px] rounded-md border transition ${overlayAnimation === a.value
                    ? 'bg-purple-700 border-purple-500 text-white'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <label className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] text-neutral-500 uppercase">Size</span>
              <input type="number" value={overlayFontSize} onChange={e => setOverlayFontSize(+e.target.value)}
                className="px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-500 uppercase">Text</span>
              <input type="color" value={overlayColor} onChange={e => setOverlayColor(e.target.value)}
                className="w-10 h-9 bg-neutral-800 border border-neutral-700 rounded-lg cursor-pointer" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-500 uppercase">BG</span>
              <input type="color" value={overlayBgColor} onChange={e => setOverlayBgColor(e.target.value)}
                className="w-10 h-9 bg-neutral-800 border border-neutral-700 rounded-lg cursor-pointer" />
            </label>
          </div>

          <div className="bg-neutral-800 rounded-lg p-4 flex items-center justify-center min-h-[60px]">
            <span style={{ fontSize: Math.min(overlayFontSize, 32), color: overlayColor, backgroundColor: overlayBgColor, padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {overlayText || 'Preview'}
            </span>
          </div>

          <button onClick={saveEditOverlay} className="w-full py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-500 transition">Save Changes</button>
        </div>
      </Modal>

      {/* Speed */}
      <Modal open={showSpeedEdit} onClose={() => setShowSpeedEdit(false)} title="Set Playback Speed">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <input type="range" min={0} max={8} step={0.25} value={speedValue}
              onChange={e => setSpeedValue(+e.target.value)} className="flex-1 accent-amber-500" />
            <span className="text-lg font-mono font-bold text-amber-400 w-14 text-right">{speedValue}x</span>
          </div>
          <div className="flex gap-1.5">
            {[0, 0.25, 0.5, 1, 1.5, 2, 4, 8].map(v => (
              <button key={v} onClick={() => setSpeedValue(v)}
                className={`flex-1 py-1.5 text-[10px] rounded-md border transition ${speedValue === v ? 'bg-amber-700 border-amber-500 text-white' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>
                {v === 0 ? 'Freeze' : `${v}x`}
              </button>
            ))}
          </div>
          <button onClick={applySpeed} className="w-full py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-500 transition">Apply Speed</button>
        </div>
      </Modal>
    </div>
  );
}
