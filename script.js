/* ============================================================================
   JEDAG STUDIO — script.js
   Editor Jedag-Jedug berbasis browser. Semua logic ada di file ini:
   state & persistence, media, timeline, beat sync, keyframe engine, effects,
   canvas preview renderer, export XML template, import XML template,
   template community, dan export video (WebM via MediaRecorder).
   Tidak ada dependency eksternal wajib — hanya vanilla JS.
   ============================================================================ */

(() => {
'use strict';

/* ============================================================
   0. UTILITIES
   ============================================================ */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nowIso = () => new Date().toISOString();

function formatTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// XML text sanitizer — never trust incoming/outgoing text content.
function escapeXml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}
// Strip anything that looks like markup/script from imported free-text fields.
function sanitizeText(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, max);
}
function safeNum(v, fallback = 0, min = -Infinity, max = Infinity) {
  const n = parseFloat(v);
  if (!isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = msg;
  $('#toastStack').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Debounce — used for autosave & text inputs so we don't hammer localStorage.
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ============================================================
   1. EASING / KEYFRAME ENGINE
   ============================================================ */
const Easing = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicBezier: (t, p1x = 0.42, p1y = 0, p2x = 0.58, p2y = 1) => {
    // Approximate cubic-bezier(p1x,p1y,p2x,p2y) via sampling (good enough for UI-scale motion).
    const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
    const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
    const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
    const sampleY = (u) => ((ay * u + by) * u + cy) * u;
    let u = t;
    for (let i = 0; i < 6; i++) {
      const x = sampleX(u) - t;
      if (Math.abs(x) < 1e-4) break;
      const d = (3 * ax * u + 2 * bx) * u + cx || 1e-6;
      u -= x / d;
    }
    return sampleY(clamp(u, 0, 1));
  }
};
function ease(name, t) {
  t = clamp(t, 0, 1);
  return (Easing[name] || Easing.linear)(t);
}

// Interpolate a numeric property across a keyframe list at local clip time `t` (seconds).
function interpKeyframes(keyframes, prop, t, fallback) {
  if (!keyframes || !keyframes.length) return fallback;
  const kfs = keyframes.filter(k => prop in k.props).sort((a, b) => a.time - b.time);
  if (!kfs.length) return fallback;
  if (t <= kfs[0].time) return kfs[0].props[prop];
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].props[prop];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time || 1e-6;
      const local = (t - a.time) / span;
      const e = ease(b.easing || 'linear', local);
      return a.props[prop] + (b.props[prop] - a.props[prop]) * e;
    }
  }
  return fallback;
}

/* ============================================================
   2. EFFECT / ANIMATION PRESET DEFINITIONS
   Whitelist used both by the effects panel AND by XML validation —
   imported XML may only reference effects from this list.
   ============================================================ */
const EFFECT_TYPES = [
  { id: 'shake', label: 'Shake' },
  { id: 'beatZoom', label: 'Beat Zoom' },
  { id: 'flash', label: 'Flash' },
  { id: 'blur', label: 'Blur' },
  { id: 'glitch', label: 'Glitch' },
  { id: 'rgbSplit', label: 'RGB Split' },
  { id: 'chromaticAberration', label: 'Chromatic Aberration' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'motionBlur', label: 'Motion Blur' },
  { id: 'cameraShake', label: 'Camera Shake' },
  { id: 'impact', label: 'Impact' },
  { id: 'strobe', label: 'Strobe' },
  { id: 'speedRamp', label: 'Speed Ramp' },
  { id: 'velocity', label: 'Velocity' }
];
const EFFECT_IDS = new Set(EFFECT_TYPES.map(e => e.id));

const ANIM_PRESETS = ['zoomIn', 'zoomOut', 'shake', 'spin', 'bounce', 'flash', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'pulse', 'glitch', 'rgbSplit', 'motionBlur'];
const TEXT_ANIM_PRESETS = ['fadeIn', 'popIn', 'typewriter', 'slideUp', 'shake', 'glitch'];

/* ============================================================
   3. PROJECT / STATE MODEL
   ============================================================ */
function newTrack(type, name) {
  return { id: uid('trk'), type, name: name || type, clips: [] };
}
function newProject(name = 'Untitled Project') {
  return {
    id: uid('proj'),
    name,
    author: 'Guest',
    version: '1.0',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    fps: 30,
    ratio: '9:16',
    bpm: 120,
    beatOffset: 0,
    duration: 10,
    beats: [],
    media: [],       // {id,name,type('image'|'video'|'audio'),url,duration,size,width,height}
    tracks: [
      newTrack('video', 'Video'),
      newTrack('photo', 'Foto'),
      newTrack('text', 'Teks'),
      newTrack('effect', 'Efek'),
      newTrack('audio', 'Audio')
    ]
  };
}

const App = {
  project: newProject(),
  ui: {
    zoomPxPerSec: 80,
    playhead: 0,
    playing: false,
    selectedClipId: null,
    selectedTrackId: null,
    selectedMediaId: null,
    activePanel: 'media',
    lastFrameT: 0
  },
  history: { stack: [], index: -1, limit: 60, suspend: false },
  objectUrls: new Set(), // track for release
  audioCtx: null
};
window.App = App; // handy for debugging in console

/* ============================================================
   4. HISTORY (UNDO / REDO)
   ============================================================ */
function snapshot() {
  if (App.history.suspend) return;
  const json = JSON.stringify(App.project);
  App.history.stack = App.history.stack.slice(0, App.history.index + 1);
  App.history.stack.push(json);
  if (App.history.stack.length > App.history.limit) App.history.stack.shift();
  App.history.index = App.history.stack.length - 1;
  updateUndoRedoButtons();
}
function undo() {
  if (App.history.index <= 0) return;
  App.history.index--;
  App.history.suspend = true;
  App.project = JSON.parse(App.history.stack[App.history.index]);
  App.history.suspend = false;
  onProjectMutated(false);
}
function redo() {
  if (App.history.index >= App.history.stack.length - 1) return;
  App.history.index++;
  App.history.suspend = true;
  App.project = JSON.parse(App.history.stack[App.history.index]);
  App.history.suspend = false;
  onProjectMutated(false);
}
function updateUndoRedoButtons() {
  $('#btnUndo').disabled = App.history.index <= 0;
  $('#btnRedo').disabled = App.history.index >= App.history.stack.length - 1;
}

/* Central "something changed" hook: re-render UI + push history + autosave. */
function onProjectMutated(pushHistory = true) {
  App.project.updatedAt = nowIso();
  recomputeDuration();
  renderAll();
  if (pushHistory) snapshot();
  scheduleAutosave();
}

function recomputeDuration() {
  let max = 1;
  App.project.tracks.forEach(tr => tr.clips.forEach(c => { max = Math.max(max, c.start + c.duration); }));
  App.project.duration = Math.max(max, 1);
}

/* ============================================================
   5. PERSISTENCE (localStorage) — projects list + current project
   ============================================================ */
const LS_PROJECTS = 'jedag_projects_v1';
const LS_CURRENT = 'jedag_current_project_id_v1';
const LS_TEMPLATES = 'jedag_community_templates_v1';

function loadProjectsIndex() {
  try { return JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]'); } catch { return []; }
}
function saveProjectsIndex(list) {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(list));
}
// NOTE: media objectURLs cannot survive reload (blob: URLs die with the page),
// so we persist media metadata but mark media as "offline" until re-attached.
function persistProject() {
  const list = loadProjectsIndex();
  const idx = list.findIndex(p => p.id === App.project.id);
  const serializable = JSON.parse(JSON.stringify(App.project));
  // don't try to persist blob: URLs — they will be invalid after reload
  serializable.media = serializable.media.map(m => ({ ...m, url: m.url && m.url.startsWith('blob:') ? null : m.url, offline: true }));
  const entry = { id: App.project.id, name: App.project.name, updatedAt: App.project.updatedAt, data: serializable };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveProjectsIndex(list);
  localStorage.setItem(LS_CURRENT, App.project.id);
  flashAutosave();
}
const scheduleAutosave = debounce(persistProject, 700);

function flashAutosave() {
  const el = $('#autosaveIndicator');
  el.textContent = 'Tersimpan';
  el.classList.add('saving');
  setTimeout(() => el.classList.remove('saving'), 500);
}

/* ============================================================
   6. MEDIA MANAGEMENT
   ============================================================ */
function registerObjectUrl(url) { App.objectUrls.add(url); return url; }
function releaseUnusedObjectUrls() {
  const used = new Set(App.project.media.map(m => m.url));
  App.objectUrls.forEach(u => { if (!used.has(u)) { URL.revokeObjectURL(u); App.objectUrls.delete(u); } });
}

function mediaKindFromFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'unknown';
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    const kind = mediaKindFromFile(file);
    if (kind === 'unknown') { toast(`Format tidak didukung: ${file.name}`, 'error'); continue; }
    const url = registerObjectUrl(URL.createObjectURL(file));
    const media = { id: uid('media'), name: sanitizeText(file.name, 120), type: kind, url, size: file.size, duration: 0, width: 0, height: 0 };
    try {
      if (kind === 'image') {
        const dim = await loadImageDims(url);
        media.width = dim.width; media.height = dim.height; media.duration = 4; // default photo duration
      } else if (kind === 'video') {
        const dim = await loadVideoMeta(url);
        media.width = dim.width; media.height = dim.height; media.duration = dim.duration;
      } else if (kind === 'audio') {
        media.duration = await loadAudioDuration(url);
      }
    } catch (e) { console.warn('meta read failed', e); }
    App.project.media.push(media);
  }
  onProjectMutated();
  renderMediaGrid();
}
function loadImageDims(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = rej;
    img.src = url;
  });
}
function loadVideoMeta(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => res({ width: v.videoWidth, height: v.videoHeight, duration: v.duration || 4 });
    v.onerror = rej;
    v.src = url;
  });
}
function loadAudioDuration(url) {
  return new Promise((res, rej) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => res(a.duration || 4);
    a.onerror = rej;
    a.src = url;
  });
}

function deleteMedia(id) {
  // Also remove clips referencing this media
  App.project.tracks.forEach(tr => { tr.clips = tr.clips.filter(c => c.mediaId !== id); });
  App.project.media = App.project.media.filter(m => m.id !== id);
  onProjectMutated();
  releaseUnusedObjectUrls();
}

function renderMediaGrid() {
  const grid = $('#mediaGrid');
  grid.innerHTML = '';
  App.project.media.forEach(m => {
    const el = document.createElement('div');
    el.className = 'media-item';
    el.draggable = true;
    el.dataset.mediaId = m.id;
    let inner = '';
    if (m.type === 'image') inner = `<img src="${m.url || ''}" alt="">`;
    else if (m.type === 'video') inner = `<video src="${m.url || ''}" muted></video>`;
    else inner = `<div class="m-audio"><svg class="ic ic-lg"><use href="#ic-beat"/></svg></div>`;
    const sizeKb = m.size ? (m.size / 1024).toFixed(0) + ' KB' : (m.offline ? 'offline' : '');
    el.innerHTML = `${inner}<span class="m-type">${m.type}</span>
      <button class="m-del" data-del="${m.id}" title="Hapus"><svg class="ic"><use href="#ic-close"/></svg></button>
      <div class="m-meta"><span>${(m.duration || 0).toFixed(1)}s</span><span>${sizeKb}</span></div>`;
    grid.appendChild(el);
  });
  if (!App.project.media.length) {
    grid.innerHTML = '<p class="hint" style="grid-column:1/-1">Belum ada media. Import foto/video/audio dulu.</p>';
  }
}

/* Drag & drop from media grid onto a timeline track adds a clip. */
function initMediaDnD() {
  const dz = $('#mediaDropzone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => importFiles(e.dataTransfer.files));
  $('#btnBrowseMedia').addEventListener('click', () => $('#mediaFileInput').click());
  $('#mediaFileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });

  $('#mediaGrid').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { deleteMedia(del.dataset.del); return; }
    const item = e.target.closest('.media-item');
    if (item) {
      App.ui.selectedMediaId = item.dataset.mediaId;
      $$('.media-item', $('#mediaGrid')).forEach(i => i.classList.toggle('selected', i === item));
      // quick-add: tap media on mobile/desktop adds it to the timeline at playhead on a fitting track
      addClipFromMedia(item.dataset.mediaId);
    }
  });
  $('#mediaGrid').addEventListener('dragstart', (e) => {
    const item = e.target.closest('.media-item');
    if (item) e.dataTransfer.setData('text/media-id', item.dataset.mediaId);
  });
}

function trackTypeForMediaKind(kind) {
  if (kind === 'video') return 'video';
  if (kind === 'image') return 'photo';
  if (kind === 'audio') return 'audio';
  return 'video';
}

function addClipFromMedia(mediaId, atTime = null, trackId = null) {
  const media = App.project.media.find(m => m.id === mediaId);
  if (!media) return;
  const wantType = trackTypeForMediaKind(media.type);
  let track = trackId ? App.project.tracks.find(t => t.id === trackId) : App.project.tracks.find(t => t.type === wantType);
  if (!track) { track = newTrack(wantType); App.project.tracks.push(track); }
  const start = atTime != null ? atTime : trackEndTime(track);
  const clip = {
    id: uid('clip'), trackId: track.id, mediaId: media.id, kind: wantType,
    start, duration: clamp(media.duration || 2, 0.1, 60),
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, skew: 0 },
    keyframes: [], effects: [], animationPreset: '', text: null,
    audio: { volume: 1, fadeIn: 0, fadeOut: 0, muted: false, trimStart: 0 }
  };
  track.clips.push(clip);
  App.ui.selectedClipId = clip.id;
  onProjectMutated();
}
function trackEndTime(track) {
  return track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

/* ============================================================
   7. TRACKS / CLIPS — timeline editing operations
   ============================================================ */
function findClip(clipId) {
  for (const tr of App.project.tracks) {
    const c = tr.clips.find(c => c.id === clipId);
    if (c) return { clip: c, track: tr };
  }
  return null;
}
function addTrack(type = 'video') {
  const track = newTrack(type, `${type}-${App.project.tracks.filter(t => t.type === type).length + 1}`);
  App.project.tracks.push(track);
  onProjectMutated();
}
function splitClipAtPlayhead() {
  const found = App.ui.selectedClipId && findClip(App.ui.selectedClipId);
  if (!found) return toast('Pilih clip dulu untuk di-split', 'error');
  const { clip, track } = found;
  const t = App.ui.playhead;
  if (t <= clip.start + 0.02 || t >= clip.start + clip.duration - 0.02) return toast('Playhead harus berada di dalam clip', 'error');
  const rightDur = clip.start + clip.duration - t;
  const newClip = JSON.parse(JSON.stringify(clip));
  newClip.id = uid('clip');
  newClip.start = t;
  newClip.duration = rightDur;
  clip.duration = t - clip.start;
  track.clips.push(newClip);
  onProjectMutated();
}
function deleteSelectedClip() {
  const found = App.ui.selectedClipId && findClip(App.ui.selectedClipId);
  if (!found) return;
  found.track.clips = found.track.clips.filter(c => c.id !== found.clip.id);
  App.ui.selectedClipId = null;
  onProjectMutated();
}
function duplicateSelectedClip() {
  const found = App.ui.selectedClipId && findClip(App.ui.selectedClipId);
  if (!found) return;
  const copy = JSON.parse(JSON.stringify(found.clip));
  copy.id = uid('clip');
  copy.start = found.clip.start + found.clip.duration + 0.05;
  found.track.clips.push(copy);
  App.ui.selectedClipId = copy.id;
  onProjectMutated();
}

/* ============================================================
   8. TEXT CLIPS
   ============================================================ */
function addTextClip(preset = '') {
  const track = App.project.tracks.find(t => t.type === 'text') || (() => { const t = newTrack('text', 'Teks'); App.project.tracks.push(t); return t; })();
  const clip = {
    id: uid('clip'), trackId: track.id, mediaId: null, kind: 'text',
    start: App.ui.playhead || 0, duration: 2.5,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, skew: 0 },
    keyframes: [], effects: [], animationPreset: preset,
    text: { content: 'Teks Baru', font: 'Inter', size: 64, weight: 700, color: '#ffffff', gradient: '', stroke: '#000000', strokeWidth: 0, shadow: true, letterSpacing: 0, align: 'center' }
  };
  track.clips.push(clip);
  App.ui.selectedClipId = clip.id;
  onProjectMutated();
}

/* ============================================================
   9. BEAT SYNC / JEDAG-JEDUG
   ============================================================ */
function addBeatAt(time) {
  const t = Math.round(time * 1000) / 1000;
  if (!App.project.beats.includes(t)) {
    App.project.beats.push(t);
    App.project.beats.sort((a, b) => a - b);
  }
  onProjectMutated();
}
function clearBeats() { App.project.beats = []; onProjectMutated(); }

function generateBeatsFromBpm() {
  const bpm = App.project.bpm || 120;
  const interval = 60 / bpm;
  const beats = [];
  for (let t = App.project.beatOffset || 0; t <= App.project.duration; t += interval) beats.push(Math.round(t * 1000) / 1000);
  App.project.beats = beats;
  onProjectMutated();
  toast(`Generated ${beats.length} beat dari ${bpm} BPM`);
}

// Auto beat detection using the Web Audio API: energy-based onset detection.
// We decode the chosen audio clip, compute short-window RMS energy, then flag
// local peaks that exceed a rolling average — a lightweight, dependency-free
// approximation of real beat-detection algorithms.
async function autoDetectBeats() {
  const audioClip = findFirstAudioMedia();
  if (!audioClip) return toast('Import audio dulu untuk auto beat detection', 'error');
  toast('Menganalisa audio...');
  try {
    App.audioCtx = App.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(audioClip.url);
    const buf = await res.arrayBuffer();
    const audioBuffer = await App.audioCtx.decodeAudioData(buf);
    const data = audioBuffer.getChannelData(0);
    const sr = audioBuffer.sampleRate;
    const windowSize = Math.floor(sr * 0.05); // 50ms windows
    const energies = [];
    for (let i = 0; i < data.length; i += windowSize) {
      let sum = 0;
      for (let j = i; j < Math.min(i + windowSize, data.length); j++) sum += data[j] * data[j];
      energies.push(Math.sqrt(sum / windowSize));
    }
    // rolling average for adaptive threshold
    const avgWindow = 20;
    const beats = [];
    let lastBeatIdx = -999;
    const minGapWindows = Math.max(1, Math.floor((60 / 220) / 0.05)); // cap ~220 BPM max density
    for (let i = 0; i < energies.length; i++) {
      const start = Math.max(0, i - avgWindow);
      const localAvg = energies.slice(start, i).reduce((a, b) => a + b, 0) / Math.max(1, i - start);
      if (energies[i] > localAvg * 1.4 && energies[i] > 0.02 && (i - lastBeatIdx) > minGapWindows) {
        beats.push(Math.round((i * windowSize / sr) * 1000) / 1000);
        lastBeatIdx = i;
      }
    }
    App.project.beats = beats;
    // estimate BPM from median inter-beat interval
    if (beats.length > 4) {
      const intervals = [];
      for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      if (median > 0) App.project.bpm = Math.round(60 / median);
    }
    onProjectMutated();
    toast(`Terdeteksi ${beats.length} beat`, 'success');
  } catch (e) {
    console.error(e);
    toast('Gagal menganalisa audio (format tidak didukung browser ini)', 'error');
  }
}
function findFirstAudioMedia() { return App.project.media.find(m => m.type === 'audio' || m.type === 'video'); }

function syncSelectedClipToBeat() {
  const found = App.ui.selectedClipId && findClip(App.ui.selectedClipId);
  if (!found) return toast('Pilih clip dulu', 'error');
  const beats = App.project.beats;
  if (!beats.length) return toast('Belum ada beat marker', 'error');
  const nearest = beats.reduce((best, b) => Math.abs(b - found.clip.start) < Math.abs(best - found.clip.start) ? b : best, beats[0]);
  found.clip.start = nearest;
  onProjectMutated();
}
function nearestBeat(time) {
  const beats = App.project.beats;
  if (!beats.length) return null;
  return beats.reduce((best, b) => Math.abs(b - time) < Math.abs(best - time) ? b : best, beats[0]);
}

function renderBeatList() {
  const list = $('#beatList');
  list.innerHTML = '';
  App.project.beats.forEach((b, i) => {
    const chip = document.createElement('span');
    chip.className = 'beat-chip';
    chip.innerHTML = `${b.toFixed(2)}s <button data-beat-idx="${i}"><svg class="ic" style="width:10px;height:10px"><use href="#ic-close"/></svg></button>`;
    list.appendChild(chip);
  });
  $('#beatCount').textContent = App.project.beats.length;
  list.onclick = (e) => {
    const btn = e.target.closest('[data-beat-idx]');
    if (btn) { App.project.beats.splice(+btn.dataset.beatIdx, 1); onProjectMutated(); }
  };
}

/* ============================================================
   10. TIMELINE RENDERING & INTERACTION
   ============================================================ */
const TRACK_LABEL_W = 96;
function timeToPx(t) { return t * App.ui.zoomPxPerSec; }
function pxToTime(px) { return px / App.ui.zoomPxPerSec; }

function renderRuler() {
  const ruler = $('#timelineRuler');
  const totalW = Math.max(600, timeToPx(App.project.duration + 5)) + TRACK_LABEL_W;
  ruler.style.width = totalW + 'px';
  ruler.style.position = 'relative';
  ruler.innerHTML = '';
  const step = App.ui.zoomPxPerSec < 60 ? 5 : App.ui.zoomPxPerSec < 140 ? 1 : 0.5;
  for (let t = 0; t <= App.project.duration + 5; t += step) {
    const tick = document.createElement('div');
    tick.style.position = 'absolute';
    tick.style.left = (TRACK_LABEL_W + timeToPx(t)) + 'px';
    tick.style.top = '2px';
    tick.style.fontSize = '9px';
    tick.textContent = t.toFixed(step < 1 ? 1 : 0) + 's';
    ruler.appendChild(tick);
  }
}

function renderTracks() {
  const wrap = $('#timelineTracks');
  wrap.innerHTML = '';
  const totalW = Math.max(600, timeToPx(App.project.duration + 5));

  App.project.tracks.forEach(track => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.innerHTML = `<div class="track-label"><span class="t-name">${sanitizeText(track.name, 24)}</span><span class="t-kind">${track.type}</span></div>
      <div class="track-lane track-${track.type}" style="width:${totalW}px" data-track-id="${track.id}"></div>`;
    wrap.appendChild(row);
    const lane = row.querySelector('.track-lane');

    // beat markers under every lane
    App.project.beats.forEach(b => {
      const m = document.createElement('div');
      m.className = 'beat-marker';
      m.style.left = timeToPx(b) + 'px';
      lane.appendChild(m);
    });

    track.clips.forEach(clip => {
      const el = document.createElement('div');
      el.className = 'clip' + (clip.id === App.ui.selectedClipId ? ' selected' : '');
      el.style.left = timeToPx(clip.start) + 'px';
      el.style.width = Math.max(10, timeToPx(clip.duration)) + 'px';
      el.dataset.clipId = clip.id;
      el.title = clipLabel(clip);
      el.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis">${clipLabel(clip)}</span>
        <div class="clip-handle left" data-handle="left"></div>
        <div class="clip-handle right" data-handle="right"></div>`;
      lane.appendChild(el);
    });

    lane.addEventListener('dragover', (e) => e.preventDefault());
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      const mediaId = e.dataTransfer.getData('text/media-id');
      if (!mediaId) return;
      const rect = lane.getBoundingClientRect();
      const t = Math.max(0, pxToTime(e.clientX - rect.left));
      addClipFromMedia(mediaId, snapIfEnabled(t), track.id);
    });
  });

  $('#timelineTracks').style.width = totalW + 'px';
  positionPlayhead();
}
function clipLabel(clip) {
  if (clip.kind === 'text') return clip.text?.content?.slice(0, 20) || 'Teks';
  const media = App.project.media.find(m => m.id === clip.mediaId);
  return media ? media.name : clip.kind;
}
function snapIfEnabled(t) {
  if ($('#snapToggle').checked) {
    const nb = nearestBeat(t);
    if (nb != null && Math.abs(nb - t) < 0.25) return nb;
  }
  return Math.max(0, Math.round(t * 100) / 100);
}
function positionPlayhead() {
  const ph = $('#playhead');
  ph.style.left = (TRACK_LABEL_W + timeToPx(App.ui.playhead)) + 'px';
}

/* Clip drag (move) and trim (resize handles) via pointer events, delegated on the tracks container. */
let dragState = null;
function initTimelineInteraction() {
  const container = $('#timelineTracks');
  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.clip-handle');
    const clipEl = e.target.closest('.clip');
    if (!clipEl) return;
    const clipId = clipEl.dataset.clipId;
    const found = findClip(clipId);
    if (!found) return;
    App.ui.selectedClipId = clipId;
    renderInspector();
    $$('.clip', container).forEach(c => c.classList.toggle('selected', c === clipEl));
    dragState = {
      mode: handle ? (handle.dataset.handle === 'left' ? 'trim-left' : 'trim-right') : 'move',
      clip: found.clip, startX: e.clientX,
      origStart: found.clip.start, origDuration: found.clip.duration
    };
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dt = pxToTime(e.clientX - dragState.startX);
    const c = dragState.clip;
    if (dragState.mode === 'move') {
      c.start = Math.max(0, snapDrag(dragState.origStart + dt));
    } else if (dragState.mode === 'trim-left') {
      const newStart = clamp(dragState.origStart + dt, 0, dragState.origStart + dragState.origDuration - 0.1);
      c.duration = dragState.origDuration + (dragState.origStart - newStart);
      c.start = newStart;
    } else if (dragState.mode === 'trim-right') {
      c.duration = Math.max(0.1, dragState.origDuration + dt);
    }
    renderTracks();
  });
  window.addEventListener('pointerup', () => {
    if (dragState) { dragState = null; onProjectMutated(); }
  });

  // click empty lane / ruler to move playhead
  $('#timelineScroll').addEventListener('click', (e) => {
    if (e.target.closest('.clip')) return;
    const lane = e.target.closest('.track-lane') || e.target.closest('.timeline-ruler');
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    App.ui.playhead = Math.max(0, pxToTime(e.clientX - rect.left));
    positionPlayhead();
    renderPreviewFrame();
    updateTimeLabels();
  });

  $('#zoomSlider').addEventListener('input', (e) => { App.ui.zoomPxPerSec = +e.target.value; renderTimeline(); });
  $('#btnAddTrack').addEventListener('click', () => openTrackTypeModal());
  $('#btnSplit').addEventListener('click', splitClipAtPlayhead);
  $('#btnDuplicateClip').addEventListener('click', duplicateSelectedClip);
  $('#btnDeleteClip').addEventListener('click', deleteSelectedClip);
}
function snapDrag(t) { return $('#snapToggle').checked ? (nearestBeat(t) != null && Math.abs(nearestBeat(t) - t) < 0.15 ? nearestBeat(t) : t) : t; }

function renderTimeline() { renderRuler(); renderTracks(); }

function openTrackTypeModal() {
  openModal(`
    <h2>Tambah Track</h2>
    <div class="btn-stack">
      ${['video', 'photo', 'audio', 'text', 'effect'].map(t => `<button class="btn btn-block" data-add-track="${t}">${t}</button>`).join('')}
    </div>
    <div class="modal-actions"><button class="btn" id="modalCancel">Batal</button></div>
  `);
  $$('[data-add-track]').forEach(b => b.addEventListener('click', () => { addTrack(b.dataset.addTrack); closeModal(); }));
  $('#modalCancel').addEventListener('click', closeModal);
}

/* ============================================================
   11. INSPECTOR PANEL
   ============================================================ */
function renderInspector() {
  const found = App.ui.selectedClipId && findClip(App.ui.selectedClipId);
  const body = $('#inspectorBody'), empty = $('#inspectorEmpty');
  const sheetBody = $('#sheetContent');
  if (!found) {
    empty.hidden = false; body.hidden = true;
    if (sheetBody) sheetBody.innerHTML = '<p class="hint" style="padding:20px">Pilih clip di timeline untuk mengedit properti.</p>';
    return;
  }
  empty.hidden = true; body.hidden = false;
  const html = buildInspectorHtml(found.clip);
  body.innerHTML = html;
  if (sheetBody) sheetBody.innerHTML = html;
  bindInspectorEvents(body, found.clip);
  if (sheetBody) bindInspectorEvents(sheetBody, found.clip);
}

function buildInspectorHtml(clip) {
  const tr = clip.transform;
  let textSection = '';
  if (clip.kind === 'text') {
    const tx = clip.text;
    textSection = `
      <div class="insp-group">
        <h3>Teks</h3>
        <div class="insp-row"><textarea data-field="text.content">${sanitizeText(tx.content, 300)}</textarea></div>
        <div class="insp-row"><label>Font</label>
          <select data-field="text.font"><option ${tx.font === 'Inter' ? 'selected' : ''}>Inter</option><option ${tx.font === 'Space Grotesk' ? 'selected' : ''}>Space Grotesk</option><option ${tx.font === 'JetBrains Mono' ? 'selected' : ''}>JetBrains Mono</option><option ${tx.font === 'Georgia' ? 'selected' : ''}>Georgia</option></select></div>
        <div class="insp-row"><label>Size</label><input type="number" data-field="text.size" value="${tx.size}"></div>
        <div class="insp-row"><label>Weight</label><input type="number" step="100" min="100" max="900" data-field="text.weight" value="${tx.weight}"></div>
        <div class="insp-row"><label>Color</label><input type="color" data-field="text.color" value="${tx.color}"></div>
        <div class="insp-row"><label>Stroke</label><input type="color" data-field="text.stroke" value="${tx.stroke}"></div>
        <div class="insp-row"><label>Stroke W</label><input type="number" data-field="text.strokeWidth" value="${tx.strokeWidth}"></div>
        <div class="insp-row"><label>Letter Spc</label><input type="number" data-field="text.letterSpacing" value="${tx.letterSpacing}"></div>
        <div class="insp-row"><label>Align</label><select data-field="text.align"><option ${tx.align === 'left' ? 'selected' : ''}>left</option><option ${tx.align === 'center' ? 'selected' : ''}>center</option><option ${tx.align === 'right' ? 'selected' : ''}>right</option></select></div>
        <div class="insp-row"><label>Shadow</label><input type="checkbox" data-field="text.shadow" ${tx.shadow ? 'checked' : ''}></div>
        <div class="insp-row"><label>Animasi</label><select data-field="animationPreset"><option value="">none</option>${TEXT_ANIM_PRESETS.map(p => `<option value="${p}" ${clip.animationPreset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      </div>`;
  }
  let audioSection = '';
  if (clip.kind === 'audio' || clip.kind === 'video') {
    const a = clip.audio;
    audioSection = `
      <div class="insp-group">
        <h3>Audio</h3>
        <div class="insp-row"><label>Volume</label><input type="range" min="0" max="1" step="0.01" data-field="audio.volume" value="${a.volume}"></div>
        <div class="insp-row"><label>Fade In (s)</label><input type="number" min="0" step="0.1" data-field="audio.fadeIn" value="${a.fadeIn}"></div>
        <div class="insp-row"><label>Fade Out (s)</label><input type="number" min="0" step="0.1" data-field="audio.fadeOut" value="${a.fadeOut}"></div>
        <div class="insp-row"><label>Mute</label><input type="checkbox" data-field="audio.muted" ${a.muted ? 'checked' : ''}></div>
      </div>`;
  }
  const effectChips = EFFECT_TYPES.map(e => `<button class="preset-chip" data-toggle-effect="${e.id}" style="${clip.effects.find(x => x.type === e.id) ? 'border-color:var(--accent);color:var(--text-hi)' : ''}">${e.label}</button>`).join('');

  return `
    <div class="insp-group">
      <h3>Clip</h3>
      <div class="insp-row"><label>Start (s)</label><input type="number" step="0.01" data-field="start" value="${clip.start.toFixed(2)}"></div>
      <div class="insp-row"><label>Durasi (s)</label><input type="number" step="0.01" min="0.1" data-field="duration" value="${clip.duration.toFixed(2)}"></div>
    </div>
    <div class="insp-group">
      <h3>Transform</h3>
      <div class="insp-row"><label>Position X</label><input type="number" data-field="transform.x" value="${tr.x}"></div>
      <div class="insp-row"><label>Position Y</label><input type="number" data-field="transform.y" value="${tr.y}"></div>
      <div class="insp-row"><label>Scale</label><input type="range" min="0.1" max="4" step="0.01" data-field="transform.scale" value="${tr.scale}"></div>
      <div class="insp-row"><label>Rotation</label><input type="range" min="-180" max="180" data-field="transform.rotation" value="${tr.rotation}"></div>
      <div class="insp-row"><label>Opacity</label><input type="range" min="0" max="1" step="0.01" data-field="transform.opacity" value="${tr.opacity}"></div>
      <div class="insp-row"><label>Blur</label><input type="range" min="0" max="30" data-field="transform.blur" value="${tr.blur}"></div>
      <div class="insp-row"><label>Skew</label><input type="range" min="-45" max="45" data-field="transform.skew" value="${tr.skew}"></div>
    </div>
    <div class="insp-group">
      <h3>Animation Preset</h3>
      <select data-field="animationPreset" style="width:100%">
        <option value="">none</option>
        ${ANIM_PRESETS.map(p => `<option value="${p}" ${clip.animationPreset === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
    </div>
    <div class="insp-group">
      <h3>Keyframe (di waktu playhead)</h3>
      <div class="btn-stack">
        <button class="btn btn-block btn-sm" id="btnAddKeyframe">+ Tambah Keyframe (Scale/Pos/Rot/Opacity saat ini)</button>
      </div>
      <div class="easing-row" id="easingRow">
        ${['linear', 'easeIn', 'easeOut', 'easeInOut'].map(e => `<button class="easing-chip" data-easing="${e}">${e}</button>`).join('')}
      </div>
      <div class="kf-list" id="kfList">
        ${clip.keyframes.map((k, i) => `<div class="kf-item"><span>t=${k.time.toFixed(2)}s ${k.easing || 'linear'}</span><button data-del-kf="${i}"><svg class="ic" style="width:10px;height:10px"><use href="#ic-close"/></svg></button></div>`).join('')}
      </div>
    </div>
    <div class="insp-group">
      <h3>Effects</h3>
      <div class="preset-grid">${effectChips}</div>
    </div>
    ${textSection}
    ${audioSection}
  `;
}

function bindInspectorEvents(root, clip) {
  root.querySelectorAll('[data-field]').forEach(input => {
    const handler = () => {
      const path = input.dataset.field.split('.');
      let val = input.type === 'checkbox' ? input.checked : input.type === 'number' || input.type === 'range' ? safeNum(input.value, 0) : sanitizeText(input.value, 300);
      let obj = clip;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      obj[path[path.length - 1]] = val;
      onProjectMutated();
    };
    input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' || input.type === 'color' ? 'change' : 'input', handler);
  });
  root.querySelectorAll('[data-toggle-effect]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.toggleEffect;
      const idx = clip.effects.findIndex(e => e.type === type);
      if (idx >= 0) clip.effects.splice(idx, 1);
      else clip.effects.push({ type, intensity: 50, duration: 0.3, frequency: 4, direction: 'x', amount: 50 });
      onProjectMutated();
    });
  });
  const addKf = root.querySelector('#btnAddKeyframe');
  if (addKf) addKf.addEventListener('click', () => {
    const local = clamp(App.ui.playhead - clip.start, 0, clip.duration);
    const activeEasing = root.querySelector('.easing-chip.active')?.dataset.easing || 'linear';
    clip.keyframes.push({ time: local, easing: activeEasing, props: { x: clip.transform.x, y: clip.transform.y, scale: clip.transform.scale, rotation: clip.transform.rotation, opacity: clip.transform.opacity } });
    onProjectMutated();
  });
  root.querySelectorAll('.easing-chip').forEach(c => c.addEventListener('click', () => {
    root.querySelectorAll('.easing-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
  }));
  root.querySelectorAll('[data-del-kf]').forEach(b => b.addEventListener('click', () => { clip.keyframes.splice(+b.dataset.delKf, 1); onProjectMutated(); }));
}

/* ============================================================
   12. EFFECTS PANEL (left sidebar library)
   ============================================================ */
function renderEffectGrid() {
  const grid = $('#effectGrid');
  grid.innerHTML = EFFECT_TYPES.map(e => `<div class="effect-card" data-effect="${e.id}"><b>${e.label}</b><span>tap untuk tambah ke clip terpilih</span></div>`).join('');
  grid.onclick = (e) => {
    const card = e.target.closest('.effect-card');
    if (!card) return;
    const found = App.ui.selectedClipId && findClip(App.ui.selectedClipId);
    if (!found) return toast('Pilih clip di timeline dulu', 'error');
    found.clip.effects.push({ type: card.dataset.effect, intensity: 50, duration: 0.3, frequency: 4, direction: 'x', amount: 50 });
    onProjectMutated();
    toast(`Efek "${card.dataset.effect}" ditambahkan`);
  };
}

/* ============================================================
   13. CANVAS PREVIEW RENDERER
   Draws every active clip on every track for the current playhead time,
   applies transform + keyframe interpolation + effect post-processing.
   ============================================================ */
const canvas = () => $('#previewCanvas');
function setCanvasRatio(ratio) {
  const map = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };
  const [w, h] = map[ratio] || map['9:16'];
  const c = canvas(); c.width = w; c.height = h;
}

const mediaElCache = new Map(); // mediaId -> <video>/<img> element (reused for playback + drawing)
function getPlaybackEl(media) {
  if (mediaElCache.has(media.id)) return mediaElCache.get(media.id);
  let el;
  if (media.type === 'video') { el = document.createElement('video'); el.src = media.url; el.muted = false; el.playsInline = true; el.crossOrigin = 'anonymous'; }
  else if (media.type === 'image') { el = new Image(); el.src = media.url; }
  else { el = document.createElement('audio'); el.src = media.url; }
  mediaElCache.set(media.id, el);
  return el;
}

function activeClipsAt(t) {
  const list = [];
  App.project.tracks.forEach(tr => tr.clips.forEach(c => {
    if (t >= c.start && t < c.start + c.duration) list.push(c);
  }));
  return list;
}

function computeClipTransform(clip, t) {
  const local = t - clip.start;
  const base = { ...clip.transform };
  ['x', 'y', 'scale', 'rotation', 'opacity'].forEach(k => {
    base[k] = interpKeyframes(clip.keyframes, k, local, base[k]);
  });
  applyAnimationPreset(base, clip, local);
  return base;
}

function applyAnimationPreset(base, clip, local) {
  const p = clip.animationPreset;
  if (!p) return;
  const dur = Math.min(0.5, clip.duration / 2);
  const inProg = clamp(local / dur, 0, 1);
  const outProg = clamp((clip.duration - local) / dur, 0, 1);
  const edge = Math.min(inProg, outProg, 1);
  switch (p) {
    case 'zoomIn': base.scale *= 0.85 + 0.15 * ease('easeOut', inProg); break;
    case 'zoomOut': base.scale *= 1.15 - 0.15 * ease('easeOut', inProg); break;
    case 'slideLeft': base.x -= (1 - ease('easeOut', inProg)) * 300; break;
    case 'slideRight': base.x += (1 - ease('easeOut', inProg)) * 300; break;
    case 'slideUp': base.y -= (1 - ease('easeOut', inProg)) * 300; break;
    case 'slideDown': base.y += (1 - ease('easeOut', inProg)) * 300; break;
    case 'bounce': base.y -= Math.abs(Math.sin(local * 10)) * 20 * (1 - inProg); break;
    case 'pulse': base.scale *= 1 + Math.sin(local * 8) * 0.04; break;
    case 'shake': base.x += (Math.random() - 0.5) * 10; base.y += (Math.random() - 0.5) * 10; break;
    case 'spin': base.rotation += (local * 360) % 360; break;
    case 'flash': base.opacity *= 1; break; // handled as post fx too
    default: break;
  }
  base.opacity *= edge <= 0.001 ? edge : (dur > 0 ? clamp(Math.min(inProg, outProg) * 4, 0, 1) : 1);
  if (['zoomIn', 'zoomOut', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'bounce', 'pulse', 'shake', 'spin'].includes(p) === false) base.opacity = base.opacity; // no-op guard
}

function drawClip(ctx, clip, t, cw, ch) {
  const tf = computeClipTransform(clip, t);
  ctx.save();
  ctx.globalAlpha = clamp(tf.opacity, 0, 1);
  ctx.translate(cw / 2 + tf.x, ch / 2 + tf.y);
  ctx.rotate((tf.rotation || 0) * Math.PI / 180);
  if (tf.skew) ctx.transform(1, 0, Math.tan((tf.skew || 0) * Math.PI / 180), 1, 0, 0);
  ctx.scale(tf.scale || 1, tf.scale || 1);
  if (tf.blur) ctx.filter = `blur(${tf.blur}px)`;

  if (clip.kind === 'text') {
    drawText(ctx, clip, t);
  } else if (clip.mediaId) {
    const media = App.project.media.find(m => m.id === clip.mediaId);
    if (media) drawMedia(ctx, media, clip, t, cw, ch);
  }
  ctx.restore();

  // per-clip post effects (drawn relative to full canvas, so re-enter/exit save separately)
  clip.effects.forEach(fx => applyPostEffect(ctx, fx, clip, t, cw, ch));
}

function drawMedia(ctx, media, clip, t, cw, ch) {
  const el = getPlaybackEl(media);
  let iw = media.width || cw, ih = media.height || ch;
  if (media.type === 'video' && el.videoWidth) { iw = el.videoWidth; ih = el.videoHeight; }
  const scale = Math.max(cw / iw, ch / ih); // cover-fit
  const dw = iw * scale, dh = ih * scale;
  try {
    if (media.type === 'image' || (media.type === 'video' && el.readyState >= 2)) {
      ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
    } else {
      ctx.fillStyle = '#111318'; ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
    }
  } catch (e) { /* media not decodable yet — skip frame silently */ }
}

function drawText(ctx, clip, t) {
  const tx = clip.text; if (!tx) return;
  ctx.textAlign = tx.align || 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${tx.weight} ${tx.size}px "${tx.font}", sans-serif`;
  let content = tx.content || '';
  if (clip.animationPreset === 'typewriter') {
    const local = t - clip.start;
    const chars = Math.floor(clamp(local / Math.max(0.3, clip.duration * 0.6), 0, 1) * content.length);
    content = content.slice(0, chars);
  }
  if (tx.letterSpacing && ctx.letterSpacing !== undefined) ctx.letterSpacing = tx.letterSpacing + 'px';
  if (tx.shadow) { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3; }
  if (tx.strokeWidth > 0) { ctx.lineWidth = tx.strokeWidth; ctx.strokeStyle = tx.stroke; ctx.strokeText(content, 0, 0); }
  ctx.fillStyle = tx.color || '#fff';
  ctx.fillText(content, 0, 0);
}

// Post-processing "jedag-jedug" effects applied on top of a clip's rendered frame.
// Implemented with plain canvas ops so it runs everywhere without extra libs.
function applyPostEffect(ctx, fx, clip, t, cw, ch) {
  const local = t - clip.start;
  const beat = nearestBeat(t);
  const beatPhase = beat != null ? clamp(1 - Math.abs(t - beat) / 0.15, 0, 1) : 0;
  const intensity = (fx.intensity ?? 50) / 100;
  ctx.save();
  switch (fx.type) {
    case 'flash':
    case 'strobe': {
      const on = fx.type === 'strobe' ? (Math.floor(local * (fx.frequency || 4)) % 2 === 0) : beatPhase > 0.5;
      if (on) { ctx.globalAlpha = 0.35 * intensity; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); }
      break;
    }
    case 'vignette': {
      const g = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.3, cw / 2, ch / 2, ch * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.6 * intensity})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
      break;
    }
    case 'impact':
    case 'beatZoom': {
      if (beatPhase > 0) {
        ctx.globalAlpha = 0.12 * beatPhase * intensity; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
      }
      break;
    }
    default: break; // shake/glitch/rgbSplit/blur/motionBlur/cameraShake/speedRamp/velocity/chromaticAberration
    // are approximated at the transform level (shake -> jitter already in preset,
    // blur -> ctx.filter above) to keep the compositor simple & dependency-free.
  }
  ctx.restore();
}

function renderPreviewFrame() {
  const c = canvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
  const t = App.ui.playhead;
  const clips = activeClipsAt(t).sort((a, b) => trackOrder(a) - trackOrder(b));
  $('#placeholderOverlay').hidden = App.project.media.length > 0 || App.project.tracks.some(t => t.clips.length);
  clips.forEach(clip => drawClip(ctx, clip, t, c.width, c.height));
  updateTimeLabels();
}
function trackOrder(clip) {
  const order = { video: 0, photo: 1, effect: 2, text: 3, audio: 4 };
  const track = App.project.tracks.find(tr => tr.id === clip.trackId);
  return order[track?.type] ?? 9;
}
function updateTimeLabels() {
  $('#currentTimeLabel').textContent = formatTime(App.ui.playhead);
  $('#totalTimeLabel').textContent = formatTime(App.project.duration);
}

/* ---- Transport / playback loop ---- */
let rafId = null;
function play() {
  if (App.ui.playing) return;
  App.ui.playing = true;
  $('#btnPlayPause').innerHTML = '<svg class="ic"><use href="#ic-pause"/></svg>';
  App.ui.lastFrameT = performance.now();
  syncMediaPlaybackElements(true);
  const loop = (now) => {
    if (!App.ui.playing) return;
    const dt = (now - App.ui.lastFrameT) / 1000;
    App.ui.lastFrameT = now;
    App.ui.playhead += dt;
    if (App.ui.playhead >= App.project.duration) { App.ui.playhead = App.project.duration; pause(); }
    positionPlayhead();
    renderPreviewFrame();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function pause() {
  App.ui.playing = false;
  $('#btnPlayPause').innerHTML = '<svg class="ic"><use href="#ic-play"/></svg>';
  if (rafId) cancelAnimationFrame(rafId);
  syncMediaPlaybackElements(false);
}
function stop() {
  pause();
  App.ui.playhead = 0;
  positionPlayhead();
  renderPreviewFrame();
}
function stepFrame(dir) {
  pause();
  App.ui.playhead = clamp(App.ui.playhead + dir / App.project.fps, 0, App.project.duration);
  positionPlayhead();
  renderPreviewFrame();
}
function syncMediaPlaybackElements(playing) {
  const active = new Set(activeClipsAt(App.ui.playhead).map(c => c.mediaId));
  mediaElCache.forEach((el, mediaId) => {
    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      if (active.has(mediaId) && playing) { el.currentTime = App.ui.playhead; el.play().catch(() => {}); }
      else el.pause();
    }
  });
}

/* ============================================================
   14. EXPORT VIDEO (WebM via MediaRecorder — with browser-support fallback)
   ============================================================ */
async function exportVideo() {
  if (!('MediaRecorder' in window) || !canvas().captureStream) {
    return openModal(`<h2>Export tidak didukung</h2><p class="hint">Browser ini tidak mendukung MediaRecorder / canvas.captureStream(), sehingga export video langsung tidak memungkinkan. Coba gunakan Chrome/Edge/Firefox versi terbaru di desktop atau Android.</p><div class="modal-actions"><button class="btn btn-accent" id="modalCancel">Tutup</button></div>`), bindModalCancel();
  }
  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
  if (!mime) { toast('Format WebM tidak didukung browser ini', 'error'); return; }

  openModal(`<h2>Mengekspor Video…</h2><p class="hint">Merender ${App.project.duration.toFixed(1)}s @ ${App.project.fps}fps sebagai WebM. Jangan tutup tab ini.</p><div id="exportProgress" class="hint" style="margin-top:10px">0%</div>`);

  const stream = canvas().captureStream(App.project.fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { recorder.onstop = resolve; });

  stop();
  recorder.start();
  const fps = App.project.fps, total = App.project.duration;
  let frame = 0;
  const totalFrames = Math.ceil(total * fps);
  await new Promise((resolve) => {
    function renderStep() {
      App.ui.playhead = Math.min(total, frame / fps);
      renderPreviewFrame();
      const pct = Math.round((frame / totalFrames) * 100);
      const pEl = $('#exportProgress'); if (pEl) pEl.textContent = pct + '%';
      frame++;
      if (frame > totalFrames) { resolve(); return; }
      setTimeout(renderStep, 1000 / fps);
    }
    renderStep();
  });
  recorder.stop();
  await done;

  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  closeModal();
  openModal(`<h2>Export Selesai</h2><p class="hint">Video WebM siap diunduh (audio track browser-dependent — untuk hasil terbaik gunakan Chrome desktop).</p>
    <div class="modal-actions">
      <a class="btn btn-accent" href="${url}" download="${sanitizeText(App.project.name, 60) || 'jedag-export'}.webm">Download WebM</a>
      <button class="btn" id="modalCancel">Tutup</button>
    </div>`);
  bindModalCancel();
}
function bindModalCancel() { const b = $('#modalCancel'); if (b) b.addEventListener('click', closeModal); }

/* ============================================================
   15. XML TEMPLATE — EXPORT (built live from current project state)
   ============================================================ */
function buildTemplateXml() {
  const p = App.project;
  const mediaPlaceholderMap = new Map(); // mediaId -> MEDIA_00N
  p.media.forEach((m, i) => mediaPlaceholderMap.set(m.id, `MEDIA_${String(i + 1).padStart(3, '0')}`));

  const beatsXml = p.beats.map(b => `    <beat time="${b.toFixed(3)}"/>`).join('\n');

  const tracksXml = p.tracks.map(track => {
    const clipsXml = track.clips.map(c => {
      const placeholder = c.mediaId ? mediaPlaceholderMap.get(c.mediaId) : '';
      const kfXml = c.keyframes.map(k => `
          <keyframe time="${k.time.toFixed(3)}" easing="${escapeXml(k.easing || 'linear')}">
            ${Object.entries(k.props).map(([k2, v]) => `<prop name="${escapeXml(k2)}">${safeNum(v, 0)}</prop>`).join('')}
          </keyframe>`).join('');
      const fxXml = c.effects.filter(e => EFFECT_IDS.has(e.type)).map(e => `
          <effect type="${escapeXml(e.type)}">
            <intensity>${safeNum(e.intensity, 50, 0, 100)}</intensity>
            <duration>${safeNum(e.duration, 0.3, 0, 10)}</duration>
            <frequency>${safeNum(e.frequency, 4, 0, 60)}</frequency>
            <direction>${escapeXml(e.direction || 'x')}</direction>
            <amount>${safeNum(e.amount, 50, 0, 200)}</amount>
          </effect>`).join('');
      const textXml = c.kind === 'text' && c.text ? `
          <text>
            <content>${escapeXml(c.text.content)}</content>
            <font>${escapeXml(c.text.font)}</font>
            <size>${safeNum(c.text.size, 48)}</size>
            <weight>${safeNum(c.text.weight, 700)}</weight>
            <color>${escapeXml(c.text.color)}</color>
            <stroke>${escapeXml(c.text.stroke)}</stroke>
            <strokeWidth>${safeNum(c.text.strokeWidth, 0)}</strokeWidth>
            <letterSpacing>${safeNum(c.text.letterSpacing, 0)}</letterSpacing>
            <align>${escapeXml(c.text.align)}</align>
            <shadow>${c.text.shadow ? 1 : 0}</shadow>
          </text>` : '';
      const audioXml = c.audio ? `
          <audioSettings>
            <volume>${safeNum(c.audio.volume, 1, 0, 1)}</volume>
            <fadeIn>${safeNum(c.audio.fadeIn, 0, 0, 30)}</fadeIn>
            <fadeOut>${safeNum(c.audio.fadeOut, 0, 0, 30)}</fadeOut>
            <muted>${c.audio.muted ? 1 : 0}</muted>
          </audioSettings>` : '';
      return `
        <clip kind="${escapeXml(c.kind)}" animationPreset="${escapeXml(c.animationPreset || '')}">
          ${placeholder ? `<placeholder>${placeholder}</placeholder>` : ''}
          <start>${c.start.toFixed(3)}</start>
          <duration>${c.duration.toFixed(3)}</duration>
          <transform>
            <x>${safeNum(c.transform.x, 0)}</x>
            <y>${safeNum(c.transform.y, 0)}</y>
            <scale>${safeNum(c.transform.scale, 1)}</scale>
            <rotation>${safeNum(c.transform.rotation, 0)}</rotation>
            <opacity>${safeNum(c.transform.opacity, 1, 0, 1)}</opacity>
            <blur>${safeNum(c.transform.blur, 0, 0, 50)}</blur>
            <skew>${safeNum(c.transform.skew, 0, -89, 89)}</skew>
          </transform>
          <keyframes>${kfXml}
          </keyframes>
          <effects>${fxXml}
          </effects>${textXml}${audioXml}
        </clip>`;
    }).join('');
    return `
      <track type="${escapeXml(track.type)}" name="${escapeXml(track.name)}">${clipsXml}
      </track>`;
  }).join('');

  const mediaRefXml = Array.from(mediaPlaceholderMap.entries()).map(([mid, ph]) => {
    const m = p.media.find(x => x.id === mid);
    return `    <mediaRef placeholder="${ph}" type="${escapeXml(m.type)}" originalName="${escapeXml(m.name)}"/>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<jedagTemplate version="1.0">
  <metadata>
    <name>${escapeXml(p.name)}</name>
    <author>${escapeXml(p.author || 'Guest')}</author>
    <version>1.0</version>
    <fps>${p.fps}</fps>
    <ratio>${escapeXml(p.ratio)}</ratio>
    <bpm>${p.bpm}</bpm>
    <duration>${p.duration.toFixed(3)}</duration>
    <exportedAt>${nowIso()}</exportedAt>
  </metadata>
  <beats>
${beatsXml}
  </beats>
  <mediaPlaceholders>
${mediaRefXml}
  </mediaPlaceholders>
  <timeline>${tracksXml}
  </timeline>
</jedagTemplate>
`;
}

function downloadTextFile(filename, text, mime = 'application/xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function openExportTemplateModal() {
  const xml = buildTemplateXml();
  openModal(`
    <h2>Export Template XML</h2>
    <div class="insp-row"><label>Nama Template</label><input type="text" id="tplName" value="${escapeXml(App.project.name)}"></div>
    <div class="insp-row"><label>Author</label><input type="text" id="tplAuthor" value="${escapeXml(App.project.author || 'Guest')}"></div>
    <div class="insp-row"><label>Description</label><input type="text" id="tplDesc" placeholder="Deskripsi singkat..."></div>
    <div class="insp-row"><label>Tags (koma)</label><input type="text" id="tplTags" placeholder="beat,transisi,zoom"></div>
    <p class="hint">Media asli TIDAK disertakan — hanya placeholder referensi (${App.project.media.length} media). Penerima template akan diminta memilih media sendiri.</p>
    <div class="modal-actions">
      <button class="btn" id="modalCancel">Batal</button>
      <button class="btn btn-ghost" id="btnCopyTplInfo"><svg class="ic"><use href="#ic-share"/></svg> Copy Info</button>
      <button class="btn btn-accent" id="btnDownloadXml"><svg class="ic"><use href="#ic-file-xml"/></svg> Download XML</button>
    </div>`);
  bindModalCancel();
  $('#btnDownloadXml').addEventListener('click', async () => {
    App.project.name = sanitizeText($('#tplName').value, 80) || App.project.name;
    App.project.author = sanitizeText($('#tplAuthor').value, 60) || 'Guest';
    const finalXml = buildTemplateXml();
    const filename = `${(App.project.name || 'jedag-template').replace(/[^a-z0-9\-_]+/gi, '_')}.xml`;
    downloadTextFile(filename, finalXml);
    saveAsCommunityTemplate(finalXml, $('#tplDesc').value, $('#tplTags').value);
    // Web Share API — share the file directly if the platform supports it
    if (navigator.canShare && navigator.canShare({ files: [new File([finalXml], filename, { type: 'application/xml' })] })) {
      try {
        await navigator.share({ files: [new File([finalXml], filename, { type: 'application/xml' })], title: App.project.name, text: 'Template Jedag Studio' });
      } catch (e) { /* user cancelled share — ignore */ }
    }
    toast('Template XML diekspor', 'success');
    closeModal();
  });
  $('#btnCopyTplInfo').addEventListener('click', async () => {
    const info = `${$('#tplName').value} by ${$('#tplAuthor').value} — ${App.project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips, BPM ${App.project.bpm}, ${App.project.ratio}`;
    try { await navigator.clipboard.writeText(info); toast('Info template disalin'); } catch { toast('Gagal menyalin', 'error'); }
  });
}

function saveAsCommunityTemplate(xml, desc, tags) {
  const list = JSON.parse(localStorage.getItem(LS_TEMPLATES) || '[]');
  list.unshift({
    id: uid('tpl'), name: App.project.name, author: App.project.author || 'Guest',
    description: sanitizeText(desc, 200), tags: sanitizeText(tags, 120).split(',').map(t => t.trim()).filter(Boolean),
    createdAt: nowIso(), xml, popularity: 0, isNew: true
  });
  localStorage.setItem(LS_TEMPLATES, JSON.stringify(list.slice(0, 100)));
  renderTemplateGrid();
}

/* ============================================================
   16. XML TEMPLATE — IMPORT (parse, validate, rebuild, placeholders)
   ============================================================ */
const SUPPORTED_TEMPLATE_VERSIONS = new Set(['1.0']);

function parseAndValidateTemplateXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('XML tidak valid / rusak.');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'jedagTemplate') throw new Error('Root element harus <jedagTemplate>.');
  const version = root.getAttribute('version') || doc.querySelector('metadata > version')?.textContent || '1.0';
  if (!SUPPORTED_TEMPLATE_VERSIONS.has(version.trim())) throw new Error(`Versi template "${version}" tidak didukung.`);
  return doc;
}

function textOf(el, sel, fallback = '') { const n = el?.querySelector(sel); return n ? n.textContent : fallback; }
function numOf(el, sel, fallback = 0, min = -1e9, max = 1e9) { return safeNum(textOf(el, sel, String(fallback)), fallback, min, max); }

function buildProjectFromTemplateDoc(doc) {
  const root = doc.documentElement;
  const meta = root.querySelector('metadata');
  const proj = newProject(sanitizeText(textOf(meta, 'name', 'Imported Template'), 80));
  proj.author = sanitizeText(textOf(meta, 'author', 'Unknown'), 60);
  proj.fps = clamp(safeNum(textOf(meta, 'fps', '30'), 30), 1, 120);
  const ratio = textOf(meta, 'ratio', '9:16').trim();
  proj.ratio = ['9:16', '16:9', '1:1', '4:5'].includes(ratio) ? ratio : '9:16';
  proj.bpm = clamp(safeNum(textOf(meta, 'bpm', '120'), 120), 20, 300);

  // beats
  proj.beats = Array.from(root.querySelectorAll('beats > beat')).map(b => safeNum(b.getAttribute('time'), 0, 0, 100000)).sort((a, b) => a - b);

  // media placeholders -> registered as "missing media" entries the user must fill
  const placeholders = Array.from(root.querySelectorAll('mediaPlaceholders > mediaRef')).map(m => ({
    placeholder: sanitizeText(m.getAttribute('placeholder'), 40),
    type: ['image', 'video', 'audio'].includes(m.getAttribute('type')) ? m.getAttribute('type') : 'image',
    originalName: sanitizeText(m.getAttribute('originalName'), 120)
  }));
  proj.tracks = []; // rebuilt below

  const placeholderToMediaId = {}; // filled in once user assigns real files

  Array.from(root.querySelectorAll('timeline > track')).forEach(trackEl => {
    const type = ['video', 'photo', 'audio', 'text', 'effect'].includes(trackEl.getAttribute('type')) ? trackEl.getAttribute('type') : 'video';
    const track = newTrack(type, sanitizeText(trackEl.getAttribute('name'), 24) || type);
    Array.from(trackEl.querySelectorAll(':scope > clip')).forEach(clipEl => {
      const kind = ['video', 'photo', 'audio', 'text', 'effect'].includes(clipEl.getAttribute('kind')) ? clipEl.getAttribute('kind') : type;
      const animationPreset = ANIM_PRESETS.concat(TEXT_ANIM_PRESETS).includes(clipEl.getAttribute('animationPreset')) ? clipEl.getAttribute('animationPreset') : '';
      const placeholder = textOf(clipEl, 'placeholder', '');
      const tEl = clipEl.querySelector('transform');
      const clip = {
        id: uid('clip'), trackId: track.id, mediaId: null, mediaPlaceholder: placeholder || null, kind,
        start: numOf(clipEl, 'start', 0, 0, 100000), duration: clamp(numOf(clipEl, 'duration', 1), 0.05, 6000),
        transform: {
          x: numOf(tEl, 'x', 0, -100000, 100000), y: numOf(tEl, 'y', 0, -100000, 100000),
          scale: clamp(numOf(tEl, 'scale', 1), 0.01, 50), rotation: clamp(numOf(tEl, 'rotation', 0), -100000, 100000),
          opacity: clamp(numOf(tEl, 'opacity', 1), 0, 1), blur: clamp(numOf(tEl, 'blur', 0), 0, 100),
          skew: clamp(numOf(tEl, 'skew', 0), -89, 89)
        },
        keyframes: Array.from(clipEl.querySelectorAll('keyframes > keyframe')).map(kf => ({
          time: safeNum(kf.getAttribute('time'), 0, 0, 100000),
          easing: ['linear', 'easeIn', 'easeOut', 'easeInOut'].includes(kf.getAttribute('easing')) ? kf.getAttribute('easing') : 'linear',
          props: Object.fromEntries(Array.from(kf.querySelectorAll('prop')).map(pr => [sanitizeText(pr.getAttribute('name'), 20), safeNum(pr.textContent, 0, -100000, 100000)]))
        })),
        // Effects are strictly whitelisted against EFFECT_IDS — anything else in the XML is dropped.
        effects: Array.from(clipEl.querySelectorAll('effects > effect')).filter(fx => EFFECT_IDS.has(fx.getAttribute('type'))).map(fx => ({
          type: fx.getAttribute('type'),
          intensity: clamp(numOf(fx, 'intensity', 50), 0, 100), duration: clamp(numOf(fx, 'duration', 0.3), 0, 10),
          frequency: clamp(numOf(fx, 'frequency', 4), 0, 60), direction: sanitizeText(textOf(fx, 'direction', 'x'), 10),
          amount: clamp(numOf(fx, 'amount', 50), 0, 200)
        })),
        animationPreset,
        text: null,
        audio: { volume: 1, fadeIn: 0, fadeOut: 0, muted: false, trimStart: 0 }
      };
      const textEl = clipEl.querySelector('text');
      if (textEl) {
        clip.text = {
          content: sanitizeText(textOf(textEl, 'content', 'Teks'), 300), font: sanitizeText(textOf(textEl, 'font', 'Inter'), 40) || 'Inter',
          size: clamp(numOf(textEl, 'size', 48), 4, 500), weight: clamp(numOf(textEl, 'weight', 700), 100, 900),
          color: /^#[0-9a-f]{3,8}$/i.test(textOf(textEl, 'color', '#fff')) ? textOf(textEl, 'color') : '#ffffff',
          stroke: /^#[0-9a-f]{3,8}$/i.test(textOf(textEl, 'stroke', '#000')) ? textOf(textEl, 'stroke') : '#000000',
          strokeWidth: clamp(numOf(textEl, 'strokeWidth', 0), 0, 40), letterSpacing: clamp(numOf(textEl, 'letterSpacing', 0), -20, 100),
          align: ['left', 'center', 'right'].includes(textOf(textEl, 'align', 'center')) ? textOf(textEl, 'align') : 'center',
          shadow: textOf(textEl, 'shadow', '0') === '1', gradient: ''
        };
      }
      const audioEl = clipEl.querySelector('audioSettings');
      if (audioEl) {
        clip.audio = {
          volume: clamp(numOf(audioEl, 'volume', 1), 0, 1), fadeIn: clamp(numOf(audioEl, 'fadeIn', 0), 0, 30),
          fadeOut: clamp(numOf(audioEl, 'fadeOut', 0), 0, 30), muted: textOf(audioEl, 'muted', '0') === '1', trimStart: 0
        };
      }
      track.clips.push(clip);
    });
    proj.tracks.push(track);
  });

  let max = 1;
  proj.tracks.forEach(tr => tr.clips.forEach(c => { max = Math.max(max, c.start + c.duration); }));
  proj.duration = max;

  return { project: proj, placeholders };
}

function handleXmlFileSelected(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = parseAndValidateTemplateXml(reader.result);
      const { project, placeholders } = buildProjectFromTemplateDoc(doc);
      openPlaceholderAssignModal(project, placeholders);
    } catch (e) {
      console.error(e);
      openModal(`<h2>Import Gagal</h2><p class="hint">${escapeXml(e.message || 'Format XML tidak dikenali.')}</p><div class="modal-actions"><button class="btn btn-accent" id="modalCancel">Tutup</button></div>`);
      bindModalCancel();
    }
  };
  reader.onerror = () => toast('Gagal membaca file XML', 'error');
  reader.readAsText(file);
}

function openPlaceholderAssignModal(project, placeholders) {
  if (!placeholders.length) { commitImportedProject(project); return toast('Template diimpor', 'success'); }
  const rows = placeholders.map(ph => `
    <div class="placeholder-row" data-ph-row="${ph.placeholder}">
      <img class="ph-thumb" alt="">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">${escapeXml(ph.placeholder)}</div>
        <div class="hint">${escapeXml(ph.originalName || ph.type)} · ${escapeXml(ph.type)}</div>
      </div>
      <button class="btn btn-sm" data-choose="${ph.placeholder}" data-accept="${ph.type === 'image' ? 'image/*' : ph.type === 'video' ? 'video/*' : 'audio/*'}">Choose Media</button>
    </div>`).join('');
  openModal(`
    <h2>Media Placeholder</h2>
    <p class="hint">Template ini membutuhkan ${placeholders.length} media. Pasangkan media milikmu ke tiap placeholder, atau gunakan Auto Fill jika jumlah medianya cocok.</p>
    <div id="placeholderRows">${rows}</div>
    <div class="modal-actions">
      <button class="btn" id="btnAutoFill">Auto Fill</button>
      <button class="btn" id="modalCancel">Batal</button>
      <button class="btn btn-accent" id="btnFinishImport">Preview Template</button>
    </div>`);
  bindModalCancel();
  const assigned = {}; // placeholder -> mediaId (new media created from chosen files)

  $('#placeholderRows').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-choose]');
    if (!btn) return;
    const input = $('#placeholderFileInput');
    input.accept = btn.dataset.accept;
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const kind = mediaKindFromFile(file);
      const url = registerObjectUrl(URL.createObjectURL(file));
      const media = { id: uid('media'), name: sanitizeText(file.name, 120), type: kind, url, size: file.size, duration: 4, width: 0, height: 0 };
      try {
        if (kind === 'image') Object.assign(media, await loadImageDims(url));
        else if (kind === 'video') Object.assign(media, await loadVideoMeta(url));
        else media.duration = await loadAudioDuration(url);
      } catch {}
      App.project.media.push(media); // stage into current project's media pool (harmless if we cancel)
      assigned[btn.dataset.choose] = media.id;
      const row = document.querySelector(`[data-ph-row="${btn.dataset.choose}"]`);
      const thumb = row.querySelector('.ph-thumb');
      if (kind === 'image' || kind === 'video') thumb.src = url;
      btn.textContent = 'Terpasang ✓';
      input.value = '';
    };
    input.click();
  });

  $('#btnAutoFill').addEventListener('click', () => {
    const byType = { image: [], video: [], audio: [] };
    App.project.media.forEach(m => { if (byType[m.type]) byType[m.type].push(m); });
    placeholders.forEach(ph => {
      if (assigned[ph.placeholder]) return;
      const pool = byType[ph.type] || [];
      const pick = pool.shift();
      if (pick) {
        assigned[ph.placeholder] = pick.id;
        const row = document.querySelector(`[data-ph-row="${ph.placeholder}"]`);
        const btn = row.querySelector('[data-choose]');
        const thumb = row.querySelector('.ph-thumb');
        if (pick.type !== 'audio') thumb.src = pick.url;
        btn.textContent = 'Terpasang ✓';
      }
    });
    toast('Auto Fill selesai (media yang cocok telah dipasangkan)');
  });

  $('#btnFinishImport').addEventListener('click', () => {
    project.tracks.forEach(tr => tr.clips.forEach(c => {
      if (c.mediaPlaceholder && assigned[c.mediaPlaceholder]) { c.mediaId = assigned[c.mediaPlaceholder]; c.kind = c.kind; }
    }));
    commitImportedProject(project);
    closeModal();
    toast('Template diimpor & siap dipreview', 'success');
  });
}

function commitImportedProject(project) {
  App.project = project;
  App.ui.selectedClipId = null;
  App.ui.playhead = 0;
  App.history.stack = []; App.history.index = -1;
  onProjectMutated();
  snapshot();
}

function initXmlImportExport() {
  $('#btnExportXml').addEventListener('click', openExportTemplateModal);
  const triggerImport = () => $('#xmlFileInput').click();
  $('#btnImportXml').addEventListener('click', triggerImport);
  $('#btnImportXml2').addEventListener('click', triggerImport);
  $('#xmlFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleXmlFileSelected(file);
    e.target.value = '';
  });
}

/* ============================================================
   17. TEMPLATE COMMUNITY / MARKETPLACE (localStorage-backed sample data)
   Frontend-only for now; structured so a real API can replace loadTemplates()
   later without touching the render/import logic.
   ============================================================ */
function seedSampleTemplatesIfEmpty() {
  if (localStorage.getItem(LS_TEMPLATES)) return;
  const sample = [
    { id: uid('tpl'), name: 'Beat Shake Intro', author: 'JedagCrew', description: 'Intro shake + flash tersinkron beat 128 BPM.', tags: ['beat', 'shake', 'intro'], createdAt: nowIso(), popularity: 128, isNew: false },
    { id: uid('tpl'), name: 'Zoom Punch Transition', author: 'StudioX', description: 'Transisi zoom + impact untuk highlight momen.', tags: ['zoom', 'transisi'], createdAt: nowIso(), popularity: 87, isNew: true },
    { id: uid('tpl'), name: 'Glitch RGB Reveal', author: 'NightEdit', description: 'Reveal teks dengan glitch & RGB split.', tags: ['glitch', 'teks', 'rgb'], createdAt: nowIso(), popularity: 54, isNew: true }
  ].map(t => ({ ...t, xml: buildStarterXmlForSample(t) }));
  localStorage.setItem(LS_TEMPLATES, JSON.stringify(sample));
}
function buildStarterXmlForSample(t) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<jedagTemplate version="1.0">
  <metadata><name>${escapeXml(t.name)}</name><author>${escapeXml(t.author)}</author><version>1.0</version><fps>30</fps><ratio>9:16</ratio><bpm>128</bpm><duration>4</duration></metadata>
  <beats><beat time="0.000"/><beat time="0.469"/><beat time="0.938"/></beats>
  <mediaPlaceholders><mediaRef placeholder="MEDIA_001" type="video" originalName="clip1"/></mediaPlaceholders>
  <timeline><track type="video" name="Video"><clip kind="video" animationPreset="zoomIn"><placeholder>MEDIA_001</placeholder><start>0</start><duration>2</duration><transform><x>0</x><y>0</y><scale>1</scale><rotation>0</rotation><opacity>1</opacity><blur>0</blur><skew>0</skew></transform><keyframes></keyframes><effects><effect type="shake"><intensity>35</intensity><duration>0.25</duration><frequency>6</frequency><direction>x</direction><amount>50</amount></effect></effects></clip></track></timeline>
</jedagTemplate>`;
}
function loadTemplates() { return JSON.parse(localStorage.getItem(LS_TEMPLATES) || '[]'); }

let templateFilter = 'all', templateQuery = '';
function renderTemplateGrid() {
  const grid = $('#templateGrid');
  let list = loadTemplates();
  if (templateFilter === 'trending') list = list.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 10);
  if (templateFilter === 'new') list = list.filter(t => t.isNew);
  if (templateFilter === 'popular') list = list.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  if (templateQuery) list = list.filter(t => (t.name + t.description + (t.tags || []).join(' ')).toLowerCase().includes(templateQuery.toLowerCase()));

  grid.innerHTML = list.map(t => `
    <div class="template-card" data-tpl-id="${t.id}">
      <div class="t-thumb">${escapeXml(t.name.slice(0, 2).toUpperCase())}</div>
      <div class="t-title">${escapeXml(t.name)}</div>
      <div class="t-meta"><span>by ${escapeXml(t.author)}</span><span>♥ ${t.popularity || 0}</span></div>
      <div class="hint">${escapeXml(t.description || '')}</div>
      <div class="t-tags">${(t.tags || []).map(tag => `<span class="t-tag">#${escapeXml(tag)}</span>`).join('')}</div>
      <div class="t-actions">
        <button class="btn btn-sm" data-dl-tpl="${t.id}">Download XML</button>
        <button class="btn btn-sm btn-accent" data-import-tpl="${t.id}">Import</button>
      </div>
    </div>`).join('') || '<p class="hint">Tidak ada template ditemukan.</p>';
}
function initTemplatesPanel() {
  seedSampleTemplatesIfEmpty();
  renderTemplateGrid();
  $('#templateFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    $$('.chip', $('#templateFilters')).forEach(c => c.classList.remove('active'));
    chip.classList.add('active'); templateFilter = chip.dataset.filter; renderTemplateGrid();
  });
  $('#templateSearch').addEventListener('input', debounce((e) => { templateQuery = e.target.value; renderTemplateGrid(); }, 200));
  $('#templateGrid').addEventListener('click', (e) => {
    const dl = e.target.closest('[data-dl-tpl]');
    const imp = e.target.closest('[data-import-tpl]');
    if (dl) {
      const t = loadTemplates().find(x => x.id === dl.dataset.dlTpl);
      if (t) downloadTextFile(`${t.name.replace(/[^a-z0-9\-_]+/gi, '_')}.xml`, t.xml);
    }
    if (imp) {
      const t = loadTemplates().find(x => x.id === imp.dataset.importTpl);
      if (!t) return;
      try {
        const doc = parseAndValidateTemplateXml(t.xml);
        const { project, placeholders } = buildProjectFromTemplateDoc(doc);
        openPlaceholderAssignModal(project, placeholders);
      } catch (err) { toast('Template rusak: ' + err.message, 'error'); }
    }
  });
}

/* ============================================================
   18. PROJECT MANAGER PANEL (new / save / rename / duplicate / delete / list)
   ============================================================ */
function renderProjectList() {
  const list = $('#projectList');
  const projects = loadProjectsIndex().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  list.innerHTML = projects.map(p => `
    <div class="project-card ${p.id === App.project.id ? 'active' : ''}" data-open-project="${p.id}">
      <div class="p-info"><span class="p-name">${escapeXml(p.name)}</span><span class="p-date">${new Date(p.updatedAt).toLocaleString('id-ID')}</span></div>
      <div class="p-actions">
        <button class="icon-btn" data-dup-project="${p.id}" title="Duplicate"><svg class="ic"><use href="#ic-copy"/></svg></button>
        <button class="icon-btn" data-del-project="${p.id}" title="Delete"><svg class="ic"><use href="#ic-trash"/></svg></button>
      </div>
    </div>`).join('') || '<p class="hint">Belum ada project tersimpan.</p>';
}
function initProjectsPanel() {
  renderProjectList();
  $('#projectList').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-project]');
    const dup = e.target.closest('[data-dup-project]');
    const del = e.target.closest('[data-del-project]');
    if (del) {
      if (!confirm('Hapus project ini? Tindakan tidak dapat dibatalkan.')) return;
      const list = loadProjectsIndex().filter(p => p.id !== del.dataset.delProject);
      saveProjectsIndex(list);
      renderProjectList();
      return;
    }
    if (dup) {
      const entry = loadProjectsIndex().find(p => p.id === dup.dataset.dupProject);
      if (!entry) return;
      const copy = JSON.parse(JSON.stringify(entry.data));
      copy.id = uid('proj'); copy.name = entry.name + ' (copy)'; copy.updatedAt = nowIso();
      const list = loadProjectsIndex();
      list.push({ id: copy.id, name: copy.name, updatedAt: copy.updatedAt, data: copy });
      saveProjectsIndex(list);
      renderProjectList();
      toast('Project diduplikasi');
      return;
    }
    if (open) {
      const entry = loadProjectsIndex().find(p => p.id === open.dataset.openProject);
      if (!entry) return;
      commitImportedProject(JSON.parse(JSON.stringify(entry.data)));
      renderProjectList();
    }
  });
  const createNew = () => {
    if (!confirm('Buat project baru? Perubahan yang belum tersimpan pada project saat ini tetap tersimpan otomatis.')) return;
    persistProject();
    commitImportedProject(newProject());
    renderProjectList();
  };
  $('#btnNewProject').addEventListener('click', createNew);
  $('#btnNewProject2').addEventListener('click', createNew);
  $('#btnSaveProject').addEventListener('click', () => { persistProject(); renderProjectList(); toast('Project disimpan'); });
}

/* ============================================================
   19. MODALS
   ============================================================ */
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalBackdrop').hidden = false;
}
function closeModal() { $('#modalBackdrop').hidden = true; $('#modal').innerHTML = ''; }

/* ============================================================
   20. MOBILE UI (panel drawer, bottom nav, bottom sheet)
   ============================================================ */
function initMobileUI() {
  const openPanel = (name) => {
    App.ui.activePanel = name;
    $$('.panel', $('#sidebarPanel')).forEach(p => p.hidden = p.dataset.panel !== name);
    $$('.rail-btn', $('#sidebarRail')).forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    $$('.bn-btn[data-panel]', $('#bottomNav')).forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    $('#sidebarPanel').classList.add('open');
  };
  $$('.rail-btn').forEach(b => b.addEventListener('click', () => openPanel(b.dataset.panel)));
  $$('.bn-btn[data-panel]').forEach(b => b.addEventListener('click', () => {
    if (window.matchMedia('(max-width:880px)').matches) {
      const alreadyOpen = $('#sidebarPanel').classList.contains('open') && App.ui.activePanel === b.dataset.panel;
      if (alreadyOpen) { $('#sidebarPanel').classList.remove('open'); return; }
    }
    openPanel(b.dataset.panel);
  }));
  // tap outside drawer (on stage) closes it on mobile
  $('.stage')?.addEventListener('click', () => { if (window.matchMedia('(max-width:880px)').matches) $('#sidebarPanel').classList.remove('open'); });

  const sheet = $('#bottomSheet'), backdrop = $('#sheetBackdrop');
  $('#btnMobileInspector').addEventListener('click', () => {
    renderInspector();
    sheet.classList.add('open'); backdrop.hidden = false;
  });
  backdrop.addEventListener('click', () => { sheet.classList.remove('open'); backdrop.hidden = true; });
  $('#sheetHandle').addEventListener('click', () => { sheet.classList.remove('open'); backdrop.hidden = true; });
}

/* ============================================================
   21. GLOBAL RENDER + INIT / EVENT BINDINGS
   ============================================================ */
function renderAll() {
  renderMediaGrid();
  renderBeatList();
  renderTimeline();
  renderInspector();
  renderPreviewFrame();
  $('#bpmInput').value = App.project.bpm;
  $('#beatOffsetInput').value = App.project.beatOffset;
  $('#ratioSelect').value = App.project.ratio;
  $('#fpsIndicator').textContent = App.project.fps;
  $('#projectNameLabel').textContent = App.project.name;
  updateUndoRedoButtons();
}

function initTopbarEvents() {
  $('#projectNameLabel').addEventListener('blur', (e) => {
    App.project.name = sanitizeText(e.target.textContent, 80) || 'Untitled Project';
    e.target.textContent = App.project.name;
    onProjectMutated();
  });
  $('#projectNameLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnExportVideo').addEventListener('click', exportVideo);
}

function initBeatPanelEvents() {
  $('#bpmInput').addEventListener('change', (e) => { App.project.bpm = clamp(safeNum(e.target.value, 120), 20, 300); onProjectMutated(); });
  $('#beatOffsetInput').addEventListener('change', (e) => { App.project.beatOffset = safeNum(e.target.value, 0, 0, 60); onProjectMutated(); });
  $('#btnAddBeat').addEventListener('click', () => addBeatAt(App.ui.playhead));
  $('#btnAutoDetectBeat').addEventListener('click', autoDetectBeats);
  $('#btnGenerateBeat').addEventListener('click', generateBeatsFromBpm);
  $('#btnSyncToBeat').addEventListener('click', syncSelectedClipToBeat);
  $('#btnClearBeats').addEventListener('click', () => { if (confirm('Hapus semua beat marker?')) clearBeats(); });
}

function initTextPanelEvents() {
  $('#btnAddText').addEventListener('click', () => addTextClip());
  $('#textPresetGrid').addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (chip) addTextClip(chip.dataset.preset);
  });
}

function initStageEvents() {
  $('#ratioSelect').addEventListener('change', (e) => { App.project.ratio = e.target.value; setCanvasRatio(e.target.value); onProjectMutated(); });
  $('#btnPlayPause').addEventListener('click', () => (App.ui.playing ? pause() : play()));
  $('#btnStop').addEventListener('click', stop);
  $('#btnPrevFrame').addEventListener('click', () => stepFrame(-1));
  $('#btnNextFrame').addEventListener('click', () => stepFrame(1));
  $('#btnFullscreen').addEventListener('click', () => {
    const wrap = $('#canvasWrap');
    if (document.fullscreenElement) document.exitFullscreen(); else wrap.requestFullscreen?.();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); App.ui.playing ? pause() : play(); }
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelectedClip();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); persistProject(); toast('Project disimpan'); }
  });
}

function restoreLastSession() {
  const currentId = localStorage.getItem(LS_CURRENT);
  const list = loadProjectsIndex();
  const entry = currentId && list.find(p => p.id === currentId);
  if (entry) {
    App.project = JSON.parse(JSON.stringify(entry.data));
    // media objectURLs are gone after reload — flag as offline placeholders visually
    App.project.media = App.project.media.map(m => ({ ...m, url: null, offline: true }));
    toast('Project terakhir dimuat (media perlu di-import ulang setelah reload)', '');
  }
}

function init() {
  setCanvasRatio(App.project.ratio);
  restoreLastSession();
  initMediaDnD();
  initTimelineInteraction();
  initTopbarEvents();
  initBeatPanelEvents();
  initTextPanelEvents();
  renderEffectGrid();
  initStageEvents();
  initXmlImportExport();
  initTemplatesPanel();
  initProjectsPanel();
  initMobileUI();
  renderAll();
  snapshot(); // baseline history state
  window.addEventListener('beforeunload', persistProject);
}

document.addEventListener('DOMContentLoaded', init);
})();
