/* ============================================================
   JEDAG STUDIO — core engine
   Plain HTML5 + CSS3 + JS. No frameworks, no build step.
   ============================================================ */
(function(){
"use strict";

/* ---------------- Utils ---------------- */
const $ = (sel,root)=> (root||document).querySelector(sel);
const $$ = (sel,root)=> Array.from((root||document).querySelectorAll(sel));
function uid(prefix){ return (prefix||'id')+'_'+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4); }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function lerp(a,b,t){ return a+(b-a)*t; }
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }
/* Fase 9 — moved here (from editor.js) so project-list-page code (which
   lives entirely in this file's closure) can use them too, e.g. for the
   Backup/.json download feature. */
function sanitizeFileName(name){ return (name||'project').replace(/[^a-z0-9\-_]+/gi,'_'); }
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}
function fmtTime(sec){
  sec = Math.max(0,sec||0);
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=Math.floor(sec%60);
  const cs=Math.floor((sec-Math.floor(sec))*100);
  if(h>0) return `${p2(h)}:${p2(m)}:${p2(s)}`;
  return `${p2(m)}:${p2(s)}:${p2(cs)}`;
}
function p2(n){ return String(Math.floor(n)).padStart(2,'0'); }
function fmtBytes(b){
  if(b<1024) return b+'b';
  if(b<1024*1024) return (b/1024).toFixed(1)+'KB';
  return (b/1024/1024).toFixed(1)+'MB';
}
let toastTimer=null;
function toast(msg){
  const el=$('#toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),2200);
}

/* Easing functions: t in [0,1] -> [0,1] */
const Easing = {
  linear: t=>t,
  easeIn: t=>t*t,
  easeOut: t=>1-(1-t)*(1-t),
  easeInOut: t=> t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2,
  cubic: t=> t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2,
  back: t=>{ const c1=1.70158,c3=c1+1; return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2); },
  elastic: t=>{ if(t===0||t===1) return t; const c4=(2*Math.PI)/3; return Math.pow(2,-10*t)*Math.sin((t*10-0.75)*c4)+1; },
  bounce: t=>{
    const n1=7.5625,d1=2.75;
    if(t<1/d1) return n1*t*t;
    if(t<2/d1) return n1*(t-=1.5/d1)*t+0.75;
    if(t<2.5/d1) return n1*(t-=2.25/d1)*t+0.9375;
    return n1*(t-=2.625/d1)*t+0.984375;
  },
  /* Fase 3 additions */
  smooth: t=> t*t*(3-2*t), // classic smoothstep
  hold: t=> 0, // step: value stays at the start keyframe for the whole segment
  expo: t=> t===0?0: t===1?1: Math.pow(2,10*t-10),
};
function ease(name,t,bezierPts){
  if(name==='bezier' && bezierPts){ return cubicBezierEase(bezierPts.x1,bezierPts.y1,bezierPts.x2,bezierPts.y2, clamp(t,0,1)); }
  const f=Easing[name]||Easing.linear; return f(clamp(t,0,1));
}
/* Standard CSS-style cubic-bezier(x1,y1,x2,y2) evaluator: given t (0..1
   along the segment), solves for the bezier's x-parameter that matches t,
   then returns the corresponding y — same math browsers use for
   `cubic-bezier()` timing functions, which is what the Graph Editor's
   draggable handles manipulate. */
function cubicBezierEase(x1,y1,x2,y2,t){
  const cx=3*x1, bx=3*(x2-x1)-cx, ax=1-cx-bx;
  const cy=3*y1, by=3*(y2-y1)-cy, ay=1-cy-by;
  const sampleX = u=> ((ax*u+bx)*u+cx)*u;
  const sampleY = u=> ((ay*u+by)*u+cy)*u;
  const sampleDX = u=> (3*ax*u+2*bx)*u+cx;
  let u=t;
  for(let i=0;i<8;i++){
    const x=sampleX(u)-t;
    if(Math.abs(x)<1e-4) break;
    const d=sampleDX(u);
    if(Math.abs(d)<1e-6) break;
    u -= x/d;
  }
  u = clamp(u,0,1);
  return sampleY(u);
}
/* Named curve presets offered in the Graph Editor, mapped onto the Easing
   set above (or a bezier shape for the ones with no built-in equivalent). */
const CURVE_PRESETS = {
  'Linear': {easing:'linear'},
  'Fast In': {easing:'easeIn'},
  'Fast Out': {easing:'easeOut'},
  'Slow In': {easing:'bezier', bezier:{x1:0.1,y1:0,x2:0.2,y2:1}},
  'Slow Out': {easing:'bezier', bezier:{x1:0.8,y1:0,x2:0.9,y2:1}},
  'Smooth': {easing:'smooth'},
  'Bounce': {easing:'bounce'},
  'Elastic': {easing:'elastic'},
  'Overshoot': {easing:'back'},
  'Back': {easing:'back'},
  'Expo': {easing:'expo'},
  'Hold': {easing:'hold'},
};

/* seeded pseudo-random for stable noise per clip/effect */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------------- Storage (IndexedDB for blobs, localStorage for metadata) ---------------- */
const DB_NAME='jedagStudioDB', DB_VERSION=1;
let dbPromise=null;
function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded = e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains('media')) db.createObjectStore('media',{keyPath:'id'});
    };
    req.onsuccess = e=> resolve(e.target.result);
    req.onerror = e=> reject(e);
  });
  return dbPromise;
}
async function idbPutMedia(rec){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('media','readwrite');
    tx.objectStore('media').put(rec);
    tx.oncomplete=()=>resolve(true);
    tx.onerror=e=>reject(e);
  });
}
async function idbGetMedia(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('media','readonly');
    const r=tx.objectStore('media').get(id);
    r.onsuccess=()=>resolve(r.result||null);
    r.onerror=e=>reject(e);
  });
}
async function idbDeleteMedia(id){
  const db=await openDB();
  return new Promise((resolve)=>{
    const tx=db.transaction('media','readwrite');
    tx.objectStore('media').delete(id);
    tx.oncomplete=()=>resolve(true);
  });
}

const LS_PROJECTS='jedag_projects_v1'; // {id,name,updatedAt,ratio,fps,duration,sizeBytes,thumbDataUrl,data}
const LS_FAV_EFFECTS='jedag_fav_effects_v1'; // Fase 7 — array of effect type strings, global across projects
function getFavoriteEffects(){ try{ return JSON.parse(localStorage.getItem(LS_FAV_EFFECTS)||'[]'); }catch(e){ return []; } }
function toggleFavoriteEffect(type){
  const favs = getFavoriteEffects();
  const idx = favs.indexOf(type);
  if(idx>=0) favs.splice(idx,1); else favs.push(type);
  try{ localStorage.setItem(LS_FAV_EFFECTS, JSON.stringify(favs)); }catch(e){}
  return favs;
}

/* Fase 9 — Preset System: user-saved presets (Effect/Color/Text/
   Transition), global across projects, browsable and re-applicable —
   the OLD "Save as Preset" button only ever pushed into a project-local
   array that no UI ever read back, so saved presets were unreachable
   forever. This replaces that with real storage + retrieval. */
const LS_USER_PRESETS='jedag_user_presets_v1'; // {effect:[{id,name,data}], adjust:[...], text:[...], transition:[...]}
function getUserPresets(kind){
  try{ const all = JSON.parse(localStorage.getItem(LS_USER_PRESETS)||'{}'); return all[kind]||[]; }catch(e){ return []; }
}
function addUserPreset(kind, name, data){
  let all={}; try{ all = JSON.parse(localStorage.getItem(LS_USER_PRESETS)||'{}'); }catch(e){}
  all[kind] = all[kind]||[];
  all[kind].push({id:uid('upreset'), name, data});
  try{ localStorage.setItem(LS_USER_PRESETS, JSON.stringify(all)); }catch(e){ toast('Penyimpanan penuh'); }
  return all[kind];
}
function deleteUserPreset(kind, id){
  let all={}; try{ all = JSON.parse(localStorage.getItem(LS_USER_PRESETS)||'{}'); }catch(e){}
  all[kind] = (all[kind]||[]).filter(p=>p.id!==id);
  try{ localStorage.setItem(LS_USER_PRESETS, JSON.stringify(all)); }catch(e){}
  return all[kind];
}
function lsGetProjects(){
  try{ return JSON.parse(localStorage.getItem(LS_PROJECTS)||'[]'); }catch(e){ return []; }
}
function lsSaveProjects(list){
  try{ localStorage.setItem(LS_PROJECTS, JSON.stringify(list)); }catch(e){ console.warn('save failed',e); toast('Penyimpanan penuh'); }
}
function lsUpsertProject(rec){
  const list=lsGetProjects();
  const i=list.findIndex(p=>p.id===rec.id);
  if(i>=0) list[i]=rec; else list.unshift(rec);
  lsSaveProjects(list);
}
function lsDeleteProject(id){
  lsSaveProjects(lsGetProjects().filter(p=>p.id!==id));
}

/* ---------------- App / Project State ---------------- */
const App = {
  page:'home',
  project:null,      // current editor project object
  mediaCache:{},      // mediaId -> {blob,url,type,el(<video>/<img>),duration,width,height}
  selectedClipId:null,
  playing:false,
  playStartClock:0,   // performance.now() at play start
  playStartTime:0,    // project time at play start
  zoomPxPerSec:70,
  undoStack:[],
  redoStack:[],
  activeAddSheetTarget:null,
  audioCtx:null,
  panelTab:null,
  exportRecorder:null,
  // Fase 4 — Timeline Pro
  multiSelectMode:false,
  multiSelectedClipIds:[],
  rippleMode:false,
  // Fase 5 — Pre-compose: stack of {tracks, clipId, name} for "entered"
  // compositions, innermost last. Empty = editing the root project.
  compositionStack:[],
};
window.App = App; // debug access

/* Fase 5 — the standard 4-kind track layout, reused both for brand-new
   projects and for a freshly created composition's own nested tracks. */
function makeStandardTracks(){
  return [
    { id: uid('trk'), kind:'video', clips: [] },
    { id: uid('trk'), kind:'overlay', clips: [] },
    { id: uid('trk'), kind:'text', clips: [] },
    { id: uid('trk'), kind:'audio', clips: [] },
  ];
}
function newProjectData(name,ratio){
  return {
    id: uid('proj'),
    name: name||'New Project',
    ratio: ratio||'9:16',
    fps: 60,
    bpm: 0,
    duration: 0,
    beatMarkers: [], // seconds
    markers: [], // Fase 4 — generic named markers: {id, time, label, color}
    camera: {x:0,y:0,zoom:1,rotation:0,shake:0,keyframes:[]}, // Fase 8 — virtual camera
    mediaLibrary: [], // {id, kind, name, duration, width, height}
    tracks: makeStandardTracks(),
    presets: [], // saved effect combos
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function ratioWH(ratio){
  const map = {'9:16':[1080,1920], '16:9':[1920,1080], '1:1':[1080,1080], '4:5':[1080,1350]};
  return map[ratio]||map['9:16'];
}

/* ---------------- Router ---------------- */
function showPage(name){
  App.page=name;
  $$('.page').forEach(p=>p.classList.remove('active'));
  $('#page-'+name).classList.add('active');
  $('#bottomNav').classList.toggle('hidden', name==='editor');
  $$('.nav-item[data-page]').forEach(b=> b.classList.toggle('active', b.dataset.page===name));
  if(name==='home') renderProjectList($('#projectList'), 6);
  if(name==='projects') renderProjectList($('#projectListFull'));
  if(name==='templates') renderTemplateList();
  if(window.Editor && Editor.pause) Editor.pause();
}

/* ---------------- Home: project list ---------------- */
function renderProjectList(container, limit){
  let list = lsGetProjects().sort((a,b)=>b.updatedAt-a.updatedAt);
  if(limit) list=list.slice(0,limit);
  container.innerHTML='';
  const empty = container.id==='projectList' ? $('#emptyProjects') : null;
  if(empty) empty.classList.toggle('hidden', list.length>0);
  list.forEach(rec=>{
    const card=document.createElement('div');
    card.className='project-card';
    const dur=fmtTime(rec.duration||0);
    card.innerHTML = `
      <div class="project-thumb" style="background-image:url('${rec.thumbDataUrl||''}')">
        <span class="dur-badge">${dur}</span>
      </div>
      <div class="project-info">
        <h3>${escapeHtml(rec.name)}</h3>
        <div class="project-meta">
          <span>${rec.ratio||'9:16'}</span>
          <span>${(rec.data&&rec.data.exportRes)||'1080p'}</span>
          <span>${fmtBytes(rec.sizeBytes||0)}</span>
          <span>${rec.fps||60} FPS</span>
        </div>
      </div>
      <button class="project-card-menu" data-menu="${rec.id}">⋮</button>`;
    card.addEventListener('click', (e)=>{
      if(e.target.closest('[data-menu]')){
        e.stopPropagation();
        openProjectCardMenu(rec, e.target.closest('[data-menu]'), container, limit);
        return;
      }
      openProject(rec.id);
    });
    container.appendChild(card);
  });
}
/* Fase 9 — project card menu: was a bare "⋮" that only ever triggered
   delete (no actual menu). Now Rename / Duplicate / Backup (.json
   download) / Delete, matching the project-management options from the
   original spec. Self-contained here (rather than reusing editor.js's
   openLayerContextMenu) since studio-script.js and editor.js are each
   wrapped in their own IIFE and can't see each other's local functions —
   only whatever's explicitly exported through JS_CORE. */
function openProjectCardMenu(rec, anchorEl, container, limit){
  $$('.layer-ctx-menu,.layer-ctx-backdrop').forEach(el=>el.remove());
  const backdrop=document.createElement('div'); backdrop.className='layer-ctx-backdrop';
  const menu=document.createElement('div'); menu.className='layer-ctx-menu';
  const close=()=>{ backdrop.remove(); menu.remove(); };
  const items=[
    ['✏️ Rename', ()=>{
      const name=prompt('Nama project baru', rec.name);
      if(name){ rec.name=name; rec.updatedAt=Date.now(); lsUpsertProject(rec); renderProjectList(container, limit); if(container.id!=='projectList') renderProjectList($('#projectList'),6); }
    }],
    ['📄 Duplicate', ()=>{
      const copy = deepClone(rec);
      copy.id = uid('proj'); copy.name = rec.name+' copy'; copy.updatedAt=Date.now();
      copy.data = deepClone(rec.data); copy.data.id = copy.id; copy.data.name = copy.name;
      lsUpsertProject(copy);
      renderProjectList(container, limit); if(container.id!=='projectList') renderProjectList($('#projectList'),6);
      toast('Project diduplikat');
    }],
    ['💾 Backup (.json)', ()=>{
      const blob = new Blob([JSON.stringify(rec)], {type:'application/json'});
      downloadBlob(blob, sanitizeFileName(rec.name)+'.jedagbackup.json');
    }],
    ['🗑 Delete', ()=>{
      if(confirm(`Hapus project "${rec.name}"?`)){
        lsDeleteProject(rec.id);
        renderProjectList(container, limit);
        if(container.id!=='projectList') renderProjectList($('#projectList'),6);
      }
    }, true],
  ];
  items.forEach(([label,fn,danger])=>{
    const b=document.createElement('button'); if(danger) b.className='danger'; b.textContent=label;
    b.addEventListener('click', ()=>{ close(); fn(); });
    menu.appendChild(b);
  });
  document.body.appendChild(backdrop); document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  requestAnimationFrame(()=>{
    const mr=menu.getBoundingClientRect();
    let mx=Math.min(r.left, window.innerWidth-mr.width-10), my=Math.min(r.bottom+4, window.innerHeight-mr.height-10);
    menu.style.left=Math.max(10,mx)+'px'; menu.style.top=Math.max(10,my)+'px';
  });
  backdrop.addEventListener('pointerdown', close);
}
/* Fase 9 — Restore Project: recreate a project from a .json backup file
   saved by the Backup action above. */
async function restoreProjectFromFile(file){
  try{
    const text = await file.text();
    const rec = JSON.parse(text);
    if(!rec || !rec.data || !rec.data.tracks){ toast('File backup tidak valid'); return; }
    rec.id = uid('proj'); rec.data.id = rec.id; rec.updatedAt = Date.now();
    lsUpsertProject(rec);
    if($('#projectListFull')) renderProjectList($('#projectListFull'));
    renderProjectList($('#projectList'),6);
    toast('Project dipulihkan dari backup');
  }catch(e){ toast('Gagal membaca file backup'); }
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderTemplateList(){
  const list = lsGetProjects().filter(p=>p.isTemplate);
  const grid = $('#templateList');
  grid.innerHTML='';
  if(!list.length){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>Belum ada template.</p><p class="muted">Simpan project sebagai template dari menu Settings di editor.</p></div>`;
    return;
  }
  list.forEach(rec=>{
    const card=document.createElement('div');
    card.className='template-card';
    card.innerHTML=`
      <div class="t-thumb" style="background-image:url('${rec.thumbDataUrl||''}')"></div>
      <div class="t-body">
        <h4>${escapeHtml(rec.name)}</h4>
        <div class="t-meta">${rec.ratio} · ${rec.fps}FPS · ${fmtTime(rec.duration||0)}</div>
        <button class="t-use" data-use="${rec.id}">Use Template</button>
      </div>`;
    card.querySelector('[data-use]').addEventListener('click', ()=> openProject(rec.id));
    grid.appendChild(card);
  });
}

async function openProject(id){
  const rec = lsGetProjects().find(p=>p.id===id);
  if(!rec){ toast('Project tidak ditemukan'); return; }
  App.project = deepClone(rec.data);
  await hydrateMediaCache(App.project);
  showPage('editor');
  Editor.load();
}

function persistCurrentProject(){
  if(!App.project) return;
  App.project.updatedAt = Date.now();
  computeProjectDuration();
  const existing = lsGetProjects().find(p=>p.id===App.project.id);
  captureThumb().then(thumb=>{
    const sizeBytes = JSON.stringify(App.project).length + Object.values(App.mediaCache).reduce((s,m)=>s+(m.blob?m.blob.size:0),0);
    lsUpsertProject({
      id: App.project.id, name: App.project.name, updatedAt: App.project.updatedAt,
      ratio: App.project.ratio, fps: App.project.fps, duration: App.project.duration,
      sizeBytes, thumbDataUrl: thumb || (existing?existing.thumbDataUrl:''), data: App.project,
      isTemplate: existing? !!existing.isTemplate : false,
    });
  });
}
function captureThumb(){
  return new Promise(resolve=>{
    try{
      const cv = $('#previewCanvas');
      if(cv && cv.width) resolve(cv.toDataURL('image/jpeg',0.55));
      else resolve('');
    }catch(e){ resolve(''); }
  });
}
function computeProjectDuration(){
  let max=0;
  App.project.tracks.forEach(tr=> tr.clips.forEach(c=>{ max=Math.max(max, c.start + c.duration); }));
  App.project.duration = max;
}

async function hydrateMediaCache(project){
  App.mediaCache = {};
  for(const m of project.mediaLibrary){
    const rec = await idbGetMedia(m.id);
    if(!rec) continue;
    const url = URL.createObjectURL(rec.blob);
    const entry = { blob:rec.blob, url, kind:m.kind, width:m.width, height:m.height, duration:m.duration };
    if(m.kind==='video'){
      const v=document.createElement('video');
      v.src=url; v.muted=true; v.playsInline=true; v.preload='auto';
      entry.el=v;
      v.addEventListener('loadeddata', ()=>{
        try{
          const c=document.createElement('canvas'); c.width=80; c.height=142;
          const cctx=c.getContext('2d');
          const mr=v.videoWidth/v.videoHeight, br=80/142;
          let rw,rh; if(mr>br){ rh=142; rw=rh*mr; } else { rw=80; rh=rw/mr; }
          cctx.drawImage(v,(80-rw)/2,(142-rh)/2,rw,rh);
          entry.thumb = c.toDataURL('image/jpeg',0.6);
        }catch(e){}
      }, {once:true});
    } else if(m.kind==='image'){
      const im=new Image(); im.src=url; entry.el=im;
    } else if(m.kind==='audio'){
      entry.el=document.createElement('audio'); entry.el.src=url; entry.el.preload='auto';
      try{
        if(!App.audioCtx){ const AC=window.AudioContext||window.webkitAudioContext; App.audioCtx=new AC(); }
        const arr = await rec.blob.arrayBuffer();
        const buf = await App.audioCtx.decodeAudioData(arr.slice(0));
        entry.buffer = buf;
        entry.duration = buf.duration;
        const resolution=400, data=buf.getChannelData(0), step=Math.ceil(data.length/resolution), peaks=[];
        for(let i=0;i<resolution;i++){ let max=0; const s=i*step,e=Math.min(data.length,s+step); for(let j=s;j<e;j++){ const v=Math.abs(data[j]); if(v>max) max=v; } peaks.push(max); }
        entry.peaks = peaks;
      }catch(e){ console.warn('audio decode on hydrate failed', e); }
    }
    App.mediaCache[m.id]=entry;
  }
}

/* =========================================================
   EFFECTS ENGINE
   Each effect is a function(params, ctx) mutating ctx.tf (transform patch).
   ========================================================= */
const FX = {};

function nearestBeatDelta(timeSec, beatMarkers){
  if(!beatMarkers || !beatMarkers.length) return null;
  let best=Infinity, bt=null;
  for(const b of beatMarkers){
    const d=timeSec-b;
    if(d>=-0.02 && Math.abs(d)<Math.abs(best)){ best=d; bt=b; }
  }
  if(bt===null){
    for(const b of beatMarkers){ const d=Math.abs(timeSec-b); if(d<Math.abs(best)){ best=timeSec-b; bt=b; } }
  }
  return bt===null? null : {delta:best, beatTime:bt};
}
function pulseEnvelope(delta, decay){
  if(delta===null || delta===undefined) return 0;
  if(delta<0) return 0;
  return Math.exp(-delta/(decay||0.18));
}
function baseTransform(){ return {dx:0,dy:0,scale:1,rotation:0,alpha:1,blurPx:0,brightness:0,contrast:0,saturate:0,rgbSplit:0,flash:null,vignette:0,grain:0,waveAmp:0,waveFreq:3,waveRadial:false,twist:0,lens:0,skew:0,glow:0,lightLeak:0,lensFlare:0,bokeh:0,trail:null,scanline:0,glitch:null,dirBlur:null,radialBlur:0,spinBlur:0,focusBlur:0,hue:0,temperature:0,tint:0,highlights:0,shadows:0,sharpen:0,spark:false,displace:0,pixelate:0,posterize:0,neon:0,levels:null}; }

FX.beatZoom = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta, p.decay||0.16); ctx.tf.scale *= 1 + e*(p.amount||0.22)*(p.dir==='out'?-1:1); };
FX.bassZoom = FX.beatZoom;
FX.beatPulse = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta, 0.12); ctx.tf.scale *= 1 + e*(p.amount||0.14); };
FX.beatBounce = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.28); const b=ease('bounce', 1-e); ctx.tf.scale *= 1+ (1-b)*(p.amount||0.2); };
FX.beatFlash = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.10); ctx.tf.flash = {color:p.color||'#ffffff', alpha:e*(p.amount||0.7)}; };
FX.beatRotation = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.2); ctx.tf.rotation += e*(p.amount||8)*(ctx.rnd()>0.5?1:-1); };
FX.beatScale = FX.beatZoom;
FX.beatBlur = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.15); ctx.tf.blurPx += e*(p.amount||10); };
FX.beatRGB = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.12); ctx.tf.rgbSplit += e*(p.amount||14); };
FX.beatDistortion = (p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.15); ctx.tf.waveAmp += e*(p.amount||10); };
FX.bassShake = (p,ctx)=> FX.xyShake(p,ctx);

function shakeCommon(p,ctx,axis){
  const t=ctx.clipTime, f=p.freq||18, amp=p.amp||10;
  let env=1;
  if(p.onBeat){ env = pulseEnvelope(ctx.beatDelta, p.decay!==undefined?p.decay:0.15); }
  const n1=Math.sin(t*f*6.283+ctx.seed)*amp*env;
  const n2=Math.cos(t*f*7.9+ctx.seed*1.7)*amp*env;
  if(axis==='x'||axis==='xy') ctx.tf.dx += n1;
  if(axis==='y'||axis==='xy') ctx.tf.dy += n2;
  if(axis==='rot') ctx.tf.rotation += n1*0.15;
}
FX.xShake=(p,ctx)=>shakeCommon(p,ctx,'x');
FX.yShake=(p,ctx)=>shakeCommon(p,ctx,'y');
FX.xyShake=(p,ctx)=>shakeCommon(p,ctx,'xy');
FX.rotationShake=(p,ctx)=>shakeCommon(p,ctx,'rot');
FX.cameraShake=(p,ctx)=>{ shakeCommon(Object.assign({},p,{amp:(p.amp||8)}),ctx,'xy'); shakeCommon(Object.assign({},p,{amp:(p.amp||3)}),ctx,'rot'); };
FX.randomShake=(p,ctx)=>{ const r=ctx.rnd; ctx.tf.dx += (r()-0.5)*(p.amp||14); ctx.tf.dy += (r()-0.5)*(p.amp||14); };
FX.smoothShake=(p,ctx)=>shakeCommon(Object.assign({freq:4},p),ctx,'xy');
FX.hardShake=(p,ctx)=>shakeCommon(Object.assign({freq:28},p),ctx,'xy');
FX.microShake=(p,ctx)=>shakeCommon(Object.assign({amp:(p.amp||3)},p),ctx,'xy');
FX.impactShake=(p,ctx)=>shakeCommon(Object.assign({onBeat:true,amp:(p.amp||22),decay:0.1},p),ctx,'xy');
FX.beatShake=(p,ctx)=>shakeCommon(Object.assign({onBeat:true},p),ctx,'xy');

function zoomCommon(p,ctx,curveFn){
  const t=clamp(ctx.clipTime/(ctx.clipDur||1),0,1);
  const v=curveFn(t);
  const dir = p.dir==='out'? -1:1;
  ctx.tf.scale *= 1 + dir*(p.amount!==undefined?p.amount:0.35)*v;
}
FX.zoomIn=(p,ctx)=>zoomCommon(Object.assign({dir:'in'},p),ctx,t=>ease('linear',t));
FX.zoomOut=(p,ctx)=>zoomCommon(Object.assign({dir:'out'},p),ctx,t=>ease('linear',t));
FX.smoothZoom=(p,ctx)=>zoomCommon(p,ctx,t=>ease('easeInOut',t));
FX.snapZoom=(p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.08); ctx.tf.scale *= 1+e*(p.amount||0.3); };
FX.punchZoom=(p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.06); ctx.tf.scale *= 1+e*(p.amount||0.45); };
FX.elasticZoom=(p,ctx)=>zoomCommon(p,ctx,t=>ease('elastic',t));
FX.dynamicZoom=(p,ctx)=>zoomCommon(p,ctx,t=>ease('back',t));
FX.centerZoom=(p,ctx)=>zoomCommon(p,ctx,t=>ease('easeOut',t));
FX.customZoom=(p,ctx)=>zoomCommon(p,ctx,t=>ease(p.easing||'easeInOut',t));

FX.motionBlur=(p,ctx)=>{ ctx.tf.blurPx += Math.min(24,(p.amount||8)); };
FX.directionalBlur=(p,ctx)=>{ ctx.tf.dirBlur = {angle:p.angle||0, amount:p.amount||10}; };
FX.radialBlur=(p,ctx)=>{ ctx.tf.radialBlur = p.amount||8; };
FX.spinBlur=(p,ctx)=>{ ctx.tf.spinBlur = p.amount||6; };
FX.motionTrail=(p,ctx)=>{ ctx.tf.trail={n:p.count||4, offset:p.offset||6, alpha:p.alpha||0.35}; };
FX.echo=(p,ctx)=>{ ctx.tf.trail={n:p.count||3, offset:p.offset||10, alpha:0.3}; };
FX.ghost=(p,ctx)=>{ ctx.tf.trail={n:2, offset:14, alpha:0.25}; };
FX.afterImage=(p,ctx)=>{ ctx.tf.trail={n:5, offset:4, alpha:0.18}; };

FX.gaussianBlur=(p,ctx)=>{ ctx.tf.blurPx += p.amount!==undefined?p.amount:6; };
FX.softBlur=(p,ctx)=>{ ctx.tf.blurPx += p.amount!==undefined?p.amount:3; };
FX.focusBlur=(p,ctx)=>{ ctx.tf.focusBlur = p.amount!==undefined?p.amount:8; };
FX.zoomBlurFx=(p,ctx)=>{ ctx.tf.radialBlur = p.amount||10; };

FX.digitalGlitch=(p,ctx)=>{ ctx.tf.glitch = {amount:p.amount||0.5, seed:ctx.seed}; };
FX.rgbSplitFx=(p,ctx)=>{ ctx.tf.rgbSplit += p.amount||8; };
FX.chromaticAberration=(p,ctx)=>{ ctx.tf.rgbSplit += p.amount||5; };
FX.scanline=(p,ctx)=>{ ctx.tf.scanline = p.amount||0.25; };
FX.vhs=(p,ctx)=>{ ctx.tf.scanline=0.2; ctx.tf.rgbSplit += 3; ctx.tf.grain += 0.15; };
FX.noiseFx=(p,ctx)=>{ ctx.tf.grain += p.amount!==undefined?p.amount:0.25; };
FX.pixelSort=(p,ctx)=>{ ctx.tf.glitch = {amount:(p.amount||0.6), seed:ctx.seed, sort:true}; };
FX.datamosh=(p,ctx)=>{ ctx.tf.glitch = {amount:(p.amount||0.7), seed:ctx.seed, mosh:true}; };
FX.signalDistortion=(p,ctx)=>{ ctx.tf.waveAmp += (p.amount||6); };
FX.tvDistortion=(p,ctx)=>{ ctx.tf.waveAmp += (p.amount||8); ctx.tf.scanline=0.15; };
FX.displacement=(p,ctx)=>{ ctx.tf.displace += (p.amount||14); };

function manualOrBeatEnvelope(p,ctx){ return pulseEnvelope(ctx.beatDelta, p.decay||0.09); }
FX.whiteFlash=(p,ctx)=>{ const e=manualOrBeatEnvelope(p,ctx); ctx.tf.flash={color:'#fff',alpha:e*(p.amount||0.85)}; };
FX.blackFlash=(p,ctx)=>{ const e=manualOrBeatEnvelope(p,ctx); ctx.tf.flash={color:'#000',alpha:e*(p.amount||0.85)}; };
FX.rgbFlash=(p,ctx)=>{ const e=manualOrBeatEnvelope(p,ctx); ctx.tf.flash={color:['#ff2d55','#16e8a6','#3d7bff'][Math.floor(ctx.clipTime*4)%3],alpha:e*0.6}; };
FX.cameraFlash=(p,ctx)=>{ const e=pulseEnvelope(ctx.beatDelta,0.05); ctx.tf.flash={color:'#fff',alpha:e*0.9}; };
FX.softFlash=(p,ctx)=>{ const e=manualOrBeatEnvelope(p,ctx); ctx.tf.flash={color:'#fff',alpha:e*0.35}; };
FX.strobe=(p,ctx)=>{ const on = Math.floor(ctx.clipTime*(p.rate||10))%2===0; ctx.tf.flash = on? {color:'#fff',alpha:p.amount||0.5}: null; };
FX.exposureFlash=(p,ctx)=>{ const e=manualOrBeatEnvelope(p,ctx); ctx.tf.brightness += e*(p.amount||0.6); };

FX.wave=(p,ctx)=>{ ctx.tf.waveAmp += (p.amount||10); ctx.tf.waveFreq=p.freq||3; };
FX.ripple=(p,ctx)=>{ ctx.tf.waveAmp += (p.amount||8); ctx.tf.waveFreq=p.freq||6; ctx.tf.waveRadial=true; };
FX.twist=(p,ctx)=>{ ctx.tf.twist += (p.amount||20); };
FX.swirl=(p,ctx)=>{ ctx.tf.twist += (p.amount||35); };
FX.lensFx=(p,ctx)=>{ ctx.tf.lens += (p.amount||0.3); };
FX.bulge=(p,ctx)=>{ ctx.tf.lens += (p.amount||0.35); };
FX.pinch=(p,ctx)=>{ ctx.tf.lens -= (p.amount||0.3); };
FX.fisheye=(p,ctx)=>{ ctx.tf.lens += (p.amount||0.5); };
FX.perspectiveDistortion=(p,ctx)=>{ ctx.tf.skew += (p.amount||0.15); };

FX.brightness=(p,ctx)=>{ ctx.tf.brightness += (p.amount||0)/100; };
FX.contrast=(p,ctx)=>{ ctx.tf.contrast += (p.amount||0)/100; };
FX.saturationFx=(p,ctx)=>{ ctx.tf.saturate += (p.amount||0)/100; };
FX.exposureFx=(p,ctx)=>{ ctx.tf.brightness += (p.amount||0)/100; };
FX.temperature=(p,ctx)=>{ ctx.tf.temperature += (p.amount||0); };
FX.tint=(p,ctx)=>{ ctx.tf.tint += (p.amount||0); };
FX.hueFx=(p,ctx)=>{ ctx.tf.hue += (p.amount||0); };
FX.highlights=(p,ctx)=>{ ctx.tf.highlights += (p.amount||0); };
FX.shadows=(p,ctx)=>{ ctx.tf.shadows += (p.amount||0); };
FX.fadeFx=(p,ctx)=>{ ctx.tf.alpha *= 1-clamp((p.amount||0)/100,0,1); };
FX.vignetteFx=(p,ctx)=>{ ctx.tf.vignette += (p.amount!==undefined?p.amount:40)/100; };
FX.sharpenFx=(p,ctx)=>{ ctx.tf.sharpen += (p.amount||0); };
FX.grainFx=(p,ctx)=>{ ctx.tf.grain += (p.amount!==undefined?p.amount:20)/100; };
/* Fase 7 — Stylize category */
FX.pixelateFx=(p,ctx)=>{ ctx.tf.pixelate = Math.max(ctx.tf.pixelate||0, p.amount||16); };
FX.posterizeFx=(p,ctx)=>{ ctx.tf.posterize = Math.max(ctx.tf.posterize||0, p.amount||4); };
FX.neon=(p,ctx)=>{ ctx.tf.neon = {amount:(p.amount!==undefined?p.amount:0.6), color:p.color||'#00FF6A'}; };
FX.levelsFx=(p,ctx)=>{ ctx.tf.levels = {black:p.black||0, white:p.white!==undefined?p.white:100, gamma:p.gamma||1}; };

FX.lightLeak=(p,ctx)=>{ ctx.tf.lightLeak += (p.amount!==undefined?p.amount:0.5); };
FX.lensFlare=(p,ctx)=>{ ctx.tf.lensFlare += (p.amount!==undefined?p.amount:0.6); };
FX.glow=(p,ctx)=>{ ctx.tf.glow += (p.amount!==undefined?p.amount:0.4); };
FX.bloom=(p,ctx)=>{ ctx.tf.glow += (p.amount!==undefined?p.amount:0.6); };
FX.bokeh=(p,ctx)=>{ ctx.tf.bokeh += (p.amount!==undefined?p.amount:0.5); };
FX.spark=(p,ctx)=>{ ctx.tf.spark=true; };
FX.flashLight=(p,ctx)=>{ ctx.tf.lightLeak += (p.amount||0.7); };
FX.softLight=(p,ctx)=>{ ctx.tf.glow += (p.amount||0.25); };

const EFFECT_CATEGORIES = {
  'Beat': [['Beat Zoom','beatZoom'],['Beat Shake','beatShake'],['Beat Pulse','beatPulse'],['Beat Flash','beatFlash'],['Beat Bounce','beatBounce'],['Beat Rotation','beatRotation'],['Beat Scale','beatScale'],['Beat Blur','beatBlur'],['Beat RGB','beatRGB'],['Beat Distortion','beatDistortion'],['Bass Zoom','bassZoom'],['Bass Shake','bassShake']],
  'Shake': [['X Shake','xShake'],['Y Shake','yShake'],['XY Shake','xyShake'],['Rotation Shake','rotationShake'],['Camera Shake','cameraShake'],['Random Shake','randomShake'],['Smooth Shake','smoothShake'],['Hard Shake','hardShake'],['Micro Shake','microShake'],['Impact Shake','impactShake'],['Beat Shake','beatShake']],
  'Zoom': [['Zoom In','zoomIn'],['Zoom Out','zoomOut'],['Smooth Zoom','smoothZoom'],['Snap Zoom','snapZoom'],['Punch Zoom','punchZoom'],['Beat Zoom','beatZoom'],['Elastic Zoom','elasticZoom'],['Dynamic Zoom','dynamicZoom'],['Center Zoom','centerZoom'],['Custom Zoom','customZoom']],
  'Motion': [['Motion Blur','motionBlur'],['Directional Blur','directionalBlur'],['Radial Blur','radialBlur'],['Spin Blur','spinBlur'],['Motion Trail','motionTrail'],['Echo','echo'],['Ghost','ghost'],['After Image','afterImage']],
  'Blur': [['Gaussian Blur','gaussianBlur'],['Motion Blur','motionBlur'],['Radial Blur','radialBlur'],['Zoom Blur','zoomBlurFx'],['Directional Blur','directionalBlur'],['Soft Blur','softBlur'],['Focus Blur','focusBlur']],
  'Glitch': [['Digital Glitch','digitalGlitch'],['RGB Split','rgbSplitFx'],['Chromatic Aberration','chromaticAberration'],['Scanline','scanline'],['VHS','vhs'],['Noise','noiseFx'],['Pixel Sort','pixelSort'],['Datamosh-style','datamosh'],['Signal Distortion','signalDistortion'],['TV Distortion','tvDistortion']],
  'Flash': [['White Flash','whiteFlash'],['Black Flash','blackFlash'],['RGB Flash','rgbFlash'],['Beat Flash','beatFlash'],['Camera Flash','cameraFlash'],['Soft Flash','softFlash'],['Strobe','strobe'],['Exposure Flash','exposureFlash']],
  'Distortion': [['Wave','wave'],['Ripple','ripple'],['Twist','twist'],['Swirl','swirl'],['Lens','lensFx'],['Bulge','bulge'],['Pinch','pinch'],['Fisheye','fisheye'],['Perspective','perspectiveDistortion'],['Displacement','displacement']],
  'Color': [['Brightness','brightness'],['Contrast','contrast'],['Saturation','saturationFx'],['Exposure','exposureFx'],['Temperature','temperature'],['Tint','tint'],['Hue','hueFx'],['Highlights','highlights'],['Shadows','shadows'],['Fade','fadeFx'],['Vignette','vignetteFx'],['Sharpen','sharpenFx'],['Grain','grainFx'],['Levels','levelsFx']],
  'Light': [['Light Leak','lightLeak'],['Lens Flare','lensFlare'],['Glow','glow'],['Bloom','bloom'],['Neon','neon'],['Bokeh','bokeh'],['Spark','spark'],['Flash Light','flashLight'],['Soft Light','softLight']],
  'Stylize': [['Pixelate','pixelateFx'],['Posterize','posterizeFx'],['Sharpen','sharpenFx'],['Grain','grainFx'],['Vignette','vignetteFx']],
};
const TRANSITIONS = ['Cut','Fade','Dissolve','Zoom','Zoom Blur','Swipe Left','Swipe Right','Swipe Up','Swipe Down','Spin','Rotate','Push','Pull','Wipe','Flash','Glitch','RGB','Shake','Elastic','Bounce','Blur','Directional Blur','Camera Transition'];
const OVERLAY_TYPES = ['Film Grain','Dust','Particles','Rain','Snow','Smoke','Light Leak','Bokeh','VHS Overlay','Film Overlay'];

/* ============================================================
   Fase 5 — Parent / Null Object / Pre-compose
   ============================================================ */
/* Minimal 2D affine matrix helpers (a,b,c,d,e,f — same convention as
   CanvasRenderingContext2D.transform/setTransform) used to compose a
   chain of parent transforms into one final world transform. */
function matIdentity(){ return {a:1,b:0,c:0,d:1,e:0,f:0}; }
function matFromTransform(tf){
  const rad=(tf.rotation||0)*Math.PI/180, cos=Math.cos(rad), sin=Math.sin(rad);
  const sx=tf.scaleX!==undefined?tf.scaleX:(tf.scale!==undefined?tf.scale:1);
  const sy=tf.scaleY!==undefined?tf.scaleY:(tf.scale!==undefined?tf.scale:1);
  return { a:cos*sx, b:sin*sx, c:-sin*sy, d:cos*sy, e:tf.x||0, f:tf.y||0 };
}
/* result(p) = m1(m2(p)) — i.e. m2 (child, local) applied first, then m1 (parent, world) */
function matMultiply(m1,m2){
  return {
    a: m1.a*m2.a + m1.c*m2.b, b: m1.b*m2.a + m1.d*m2.b,
    c: m1.a*m2.c + m1.c*m2.d, d: m1.b*m2.c + m1.d*m2.d,
    e: m1.a*m2.e + m1.c*m2.f + m1.e, f: m1.b*m2.e + m1.d*m2.f + m1.f,
  };
}
/* Walks a clip's parentId chain (all clips must come from the SAME
   flat list — parenting never crosses a composition boundary) and
   composes their position/rotation/scale into one effective world
   transform. Anchor and skew stay intrinsic to each clip and are left
   for the normal per-clip draw code to apply on top of this result —
   only position/rotation/scale are inherited down a parent chain,
   matching how anchor/skew already work everywhere else in the app.
   `localTimeFn(clip)` supplies the local seconds to evaluate each
   ancestor's own keyframes at (its OWN timeline position may differ
   from the child's). Guards against accidental parent cycles. */
function resolveWorldTransform(clip, siblingClips, localTimeFn){
  const byId = {}; siblingClips.forEach(c=> byId[c.id]=c);
  const chain=[]; const visited=new Set();
  let cur=clip;
  while(cur){
    if(visited.has(cur.id)) break;
    visited.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId[cur.parentId] : null;
  }
  let m = matIdentity();
  chain.forEach(c=>{
    const bt = getClipTransformAtTimeShared(c, localTimeFn(c));
    m = matMultiply(m, matFromTransform(bt));
  });
  const rotation = Math.atan2(m.b,m.a)*180/Math.PI;
  const scaleX = Math.hypot(m.a,m.b);
  const det = m.a*m.d - m.b*m.c;
  const scaleY = (det<0?-1:1)*Math.hypot(m.c,m.d);
  const own = getClipTransformAtTimeShared(clip, localTimeFn(clip));
  return Object.assign({}, own, {x:m.e, y:m.f, rotation, scaleX, scaleY, scale:(scaleX+scaleY)/2});
}
/* Small standalone copy of the KF_DEFAULT/baseTransform merge (editor.js's
   getClipTransformAtTime does the same thing but also needs the DOM-side
   Editor.curTime context) — kept side-effect-free here so both the core
   engine and editor.js can resolve an ancestor's transform identically. */
function getClipTransformAtTimeShared(clip, localTime){
  const base = Object.assign({}, KF_DEFAULT, clip.baseTransform||{});
  if(clip.keyframes && clip.keyframes.length){
    return Object.assign(base, interpKeyframes(clip, localTime));
  }
  return base;
}
const MASK_SHAPES = ['Rectangle','Circle','Ellipse','Rounded Rectangle','Linear','Radial','Polygon','Custom Path'];
const MASK_BLEND_MODES = [['Add','add'],['Subtract','subtract'],['Intersect','intersect'],['Difference','difference']];
/* Fase 8 — Shape & Vector engine's full shape list (was Rectangle/Circle/
   Triangle only). */
const SHAPE_TYPES = ['Rectangle','Rounded Rectangle','Circle','Ellipse','Triangle','Polygon','Star','Line','Arrow'];
const TEXT_ANIMS = ['None','Fade','Pop','Bounce','Shake','Typewriter','Slide','Zoom','Glitch','RGB','Wave','Tracking'];
const TEXT_ANIM_MODES = ['Whole','Character','Word','Line'];

/* =========================================================
   LAYER MODEL — profesional layer system (Fase 1)
   Setiap clip di track adalah sebuah "layer". Fungsi di bawah
   menambahkan field layer (visible/locked/solo/blendMode/zIndex/
   parentId/children/name/colorLabel) TANPA mengubah/menghapus
   field lama (baseTransform, keyframes, effects, dst), supaya
   fitur existing tidak rusak dan tidak ada sistem paralel.
   ========================================================= */
const LAYER_BLEND_MODES = [
  ['Normal','normal'],['Multiply','multiply'],['Screen','screen'],['Overlay','overlay'],
  ['Soft Light','soft-light'],['Hard Light','hard-light'],['Darken','darken'],['Lighten','lighten'],
  ['Color Dodge','color-dodge'],['Color Burn','color-burn'],['Difference','difference'],
  ['Exclusion','exclusion'],['Add','lighter'],
];
const LAYER_COLOR_LABELS = ['','#ff5a5f','#ffb020','#f4e04d','#16E8A6','#3d7bff','#a463f2','#ff5ac8'];

function defaultLayerName(clip){
  if(clip.name) return clip.name;
  if(clip.type==='text') return (clip.text&&clip.text.text||'Text').slice(0,24);
  if(clip.type==='subtitle') return 'Subtitle';
  if(clip.type==='shape') return clip.shapeType||'Shape';
  if(clip.type==='sticker') return 'Sticker '+(clip.sticker||'');
  if(clip.type==='overlay') return clip.overlayType||'Overlay';
  return clip.type ? (clip.type.charAt(0).toUpperCase()+clip.type.slice(1)) : 'Layer';
}

/* Fills in any missing layer AND transform fields on a single clip. Never
   overwrites a field that's already present, so re-running is always safe. */
function ensureLayerFields(clip, zIndex){
  if(clip.name===undefined) clip.name = defaultLayerName(clip);
  if(clip.visible===undefined) clip.visible = true;
  if(clip.locked===undefined) clip.locked = false;
  if(clip.solo===undefined) clip.solo = false;
  if(clip.blendMode===undefined) clip.blendMode = 'normal';
  if(clip.colorLabel===undefined) clip.colorLabel = '';
  if(clip.parentId===undefined) clip.parentId = null;
  if(!Array.isArray(clip.children)) clip.children = [];
  if(clip.zIndex===undefined) clip.zIndex = zIndex!==undefined? zIndex : 0;
  if(!clip.effects) clip.effects=[];
  if(!clip.keyframes) clip.keyframes=[];
  if(!clip.adjust) clip.adjust={};
  // Fase 6 — Mask Engine: migrate the old single clip.mask into the new
  // clip.masks array (multiple masks with combine modes). Old projects/
  // templates keep working exactly as before — a single mask is just a
  // one-item "add" stack now.
  if(!Array.isArray(clip.masks)){
    clip.masks = clip.mask? [Object.assign({id:uid('mask'), mode:'add', rotation:0, expansion:0, invert:false}, clip.mask)] : [];
  }
  delete clip.mask;
  // Fase 2 — full transform engine fields (additive on top of the existing
  // x/y/scale/rotation/opacity/width/height baseTransform, nothing removed).
  if(!clip.baseTransform) clip.baseTransform = {x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100};
  const bt = clip.baseTransform;
  if(bt.scaleX===undefined) bt.scaleX = bt.scale!==undefined? bt.scale : 1;
  if(bt.scaleY===undefined) bt.scaleY = bt.scale!==undefined? bt.scale : 1;
  if(bt.anchorX===undefined) bt.anchorX = 0;
  if(bt.anchorY===undefined) bt.anchorY = 0;
  if(bt.skewX===undefined) bt.skewX = 0;
  if(bt.skewY===undefined) bt.skewY = 0;
  return clip;
}

/* Backfill layer fields across an entire project (old saves / imported
   templates). Render order today is fixed as video -> overlay -> text/
   audio tracks in array order, so zIndex is assigned to mirror that,
   giving every layer a stable, editable stacking value going forward. */
function migrateProjectLayers(project){
  if(!project || !project.tracks) return project;
  if(!Array.isArray(project.markers)) project.markers=[]; // Fase 4 — backfill old projects
  if(!project.camera) project.camera = {x:0,y:0,zoom:1,rotation:0,shake:0,keyframes:[]}; // Fase 8 — backfill
  const order = {video:0, overlay:1, text:2, audio:3};
  function migrateTracks(tracks){
    let z=0;
    tracks.slice().sort((a,b)=> (order[a.kind]!==undefined?order[a.kind]:9) - (order[b.kind]!==undefined?order[b.kind]:9))
      .forEach(track=>{ track.clips.forEach(clip=>{
        ensureLayerFields(clip, z++);
        // Fase 5 — recurse into composition clips' own nested tracks too.
        if(clip.type==='composition' && Array.isArray(clip.tracks)) migrateTracks(clip.tracks);
      }); });
  }
  migrateTracks(project.tracks);
  return project;
}

/* Layer visibility/lock/solo/blend helpers — pure data ops, UI wires these
   up to buttons and calls its own undo/redo + re-render. */
function isLayerEffectivelyVisible(clip, siblingClips){
  if(clip.visible===false) return false;
  const anySolo = siblingClips.some(c=>c.solo && c.visible!==false);
  if(anySolo) return !!clip.solo;
  return true;
}

/* =========================================================
   RENDER ENGINE — canvas pipeline, keyframes, transitions, text
   ========================================================= */
const KF_PROPS = ['x','y','scale','rotation','opacity','width','height','blur','brightness','saturation'];
const KF_DEFAULT = {x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100,blur:0,brightness:0,saturation:0};
/* Fase 3 — value ranges per animatable prop, used to scale the Graph
   Editor's vertical axis and to size new-keyframe value sliders. */
const KF_PROP_RANGES = {
  x:[-800,800], y:[-800,800], scale:[0.1,3], rotation:[-180,180], opacity:[0,1],
  width:[10,300], height:[10,300], blur:[0,40], brightness:[-1,1], saturation:[-1,1],
};

function seedFromString(str){ let h=0; for(let i=0;i<str.length;i++){ h=(h*31+str.charCodeAt(i))|0; } return h; }
function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex||'#00FF6A');
  return m? {r:parseInt(m[1],16), g:parseInt(m[2],16), b:parseInt(m[3],16)} : {r:0,g:255,b:106};
}

function interpKeyframes(clip, localTime){
  const out = Object.assign({}, KF_DEFAULT);
  if(!clip.keyframes || !clip.keyframes.length) return out;
  KF_PROPS.forEach(prop=>{
    const pts = clip.keyframes.filter(k=>k.prop===prop).sort((a,b)=>a.time-b.time);
    if(!pts.length) return;
    if(localTime<=pts[0].time){ out[prop]=pts[0].value; return; }
    if(localTime>=pts[pts.length-1].time){ out[prop]=pts[pts.length-1].value; return; }
    for(let i=0;i<pts.length-1;i++){
      const a=pts[i], b=pts[i+1];
      if(localTime>=a.time && localTime<=b.time){
        const span=(b.time-a.time)||0.0001;
        const t=ease(b.easing||'linear',(localTime-a.time)/span, b.bezier);
        out[prop]=lerp(a.value,b.value,t);
        return;
      }
    }
  });
  return out;
}

function getFitRect(mediaW,mediaH,boxW,boxH,mode){
  mediaW=mediaW||boxW; mediaH=mediaH||boxH;
  const mr=mediaW/mediaH, br=boxW/boxH;
  let w,h;
  if(mode==='fit'){
    if(mr>br){ w=boxW; h=w/mr; } else { h=boxH; w=h*mr; }
  } else { // fill / crop (cover)
    if(mr>br){ h=boxH; w=h*mr; } else { w=boxW; h=w/mr; }
  }
  return {w,h};
}

function buildCssFilter(tf){
  const parts=[];
  const brightness = 1 + clamp(tf.brightness,-1,1);
  parts.push(`brightness(${clamp(brightness,0,3).toFixed(3)})`);
  parts.push(`contrast(${clamp(1+tf.contrast,0,3).toFixed(3)})`);
  parts.push(`saturate(${clamp(1+tf.saturate,0,4).toFixed(3)})`);
  if(tf.hue) parts.push(`hue-rotate(${tf.hue}deg)`);
  if(tf.temperature) parts.push(`sepia(${clamp(Math.abs(tf.temperature)/150,0,0.6).toFixed(3)})`);
  if(tf.blurPx>0.05) parts.push(`blur(${clamp(tf.blurPx,0,40).toFixed(2)}px)`);
  // Fase 7 — Levels: black/white/gamma approximated via brightness+contrast
  // (a true per-channel LUT remap would need its own getImageData pass on
  // top of everything else already stacked here, too costly for smooth
  // preview) — gamma is intentionally not applied in this approximation.
  if(tf.levels){
    const black=clamp(tf.levels.black||0,0,99), white=clamp(tf.levels.white!==undefined?tf.levels.white:100,black+1,100);
    const range=Math.max(0.05,(white-black)/100);
    parts.push(`contrast(${clamp(1/range,0.2,5).toFixed(3)})`);
    parts.push(`brightness(${clamp((1/range)*(1-black/100),0.1,4).toFixed(3)})`);
  }
  return parts.join(' ');
}
/* Fase 7 — Effect Engine: real rendering for FX flags that used to be set
   by their FX.* function but were never actually drawn anywhere (Directional/
   Radial/Spin/Focus Blur, Tint, Highlights, Shadows, Sharpen, Spark). Called
   right after the main content draw, before the scanline/grain/vignette/
   glow overlay pass, so it composites correctly under those. Every effect
   here is a no-op unless its own tf flag is actually set, so clips that
   never use these effects render byte-identical to before Fase 7. */
function drawExtraFXPasses(ctx2d, srcEl, w, h, cx, cy, tf, seed, t){
  const alpha = tf.alpha!==undefined?tf.alpha:1;
  // Directional Blur — several offset ghost copies along one angle,
  // fading out, approximating a real anisotropic blur cheaply.
  if(tf.dirBlur && tf.dirBlur.amount>0.3){
    const rad=(tf.dirBlur.angle||0)*Math.PI/180, n=6, amt=Math.min(30,tf.dirBlur.amount);
    ctx2d.save(); ctx2d.globalCompositeOperation='source-over';
    for(let i=1;i<=n;i++){
      const d=(i/n)*amt;
      ctx2d.globalAlpha = alpha*(1-i/(n+1))*0.35;
      try{ ctx2d.drawImage(srcEl, cx-w/2+Math.cos(rad)*d, cy-h/2+Math.sin(rad)*d, w, h); }catch(e){}
    }
    ctx2d.restore();
  }
  // Radial / Zoom Blur — ghost copies at slightly larger scale, fading out.
  if(tf.radialBlur>0.3){
    const n=6, amt=Math.min(0.5,tf.radialBlur/40);
    ctx2d.save(); ctx2d.globalCompositeOperation='source-over';
    for(let i=1;i<=n;i++){
      const s=1+ (i/n)*amt;
      ctx2d.globalAlpha = alpha*(1-i/(n+1))*0.3;
      try{ ctx2d.drawImage(srcEl, cx-w*s/2, cy-h*s/2, w*s, h*s); }catch(e){}
    }
    ctx2d.restore();
  }
  // Spin Blur — ghost copies rotated slightly around center, fading out.
  if(tf.spinBlur>0.3){
    const n=6, amt=Math.min(12,tf.spinBlur)*Math.PI/180;
    ctx2d.save(); ctx2d.globalCompositeOperation='source-over';
    for(let i=1;i<=n;i++){
      ctx2d.save();
      ctx2d.globalAlpha = alpha*(1-i/(n+1))*0.3;
      ctx2d.translate(cx,cy); ctx2d.rotate((i/n)*amt); ctx2d.translate(-cx,-cy);
      try{ ctx2d.drawImage(srcEl, cx-w/2, cy-h/2, w, h); }catch(e){}
      ctx2d.restore();
    }
    ctx2d.restore();
  }
  // Focus Blur (tilt-shift) — blurred full frame underneath, sharp band
  // through the center on top, so focus falls off toward the edges.
  if(tf.focusBlur>0.3){
    ctx2d.save();
    ctx2d.filter = `blur(${clamp(tf.focusBlur,0,30).toFixed(1)}px)`;
    ctx2d.globalAlpha = alpha;
    try{ ctx2d.drawImage(srcEl, cx-w/2, cy-h/2, w, h); }catch(e){}
    ctx2d.restore();
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.rect(cx-w/2, cy-h*0.18, w, h*0.36); ctx2d.clip();
    ctx2d.globalAlpha = alpha;
    try{ ctx2d.drawImage(srcEl, cx-w/2, cy-h/2, w, h); }catch(e){}
    ctx2d.restore();
  }
  // Tint — a solid color wash using the 'color' blend mode, which keeps
  // luminance and replaces hue/saturation (a real color tint, not just a
  // sepia approximation).
  if(tf.tint){
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.rect(cx-w/2,cy-h/2,w,h); ctx2d.clip();
    ctx2d.globalCompositeOperation='color';
    ctx2d.globalAlpha = clamp(Math.abs(tf.tint)/100,0,0.85);
    ctx2d.fillStyle = tf.tint>0 ? '#ff8a4c' : '#4c8aff';
    ctx2d.fillRect(cx-w/2,cy-h/2,w,h);
    ctx2d.restore();
  }
  // Highlights / Shadows — soft-light gradient washes that brighten only
  // the light areas or darken only the dark areas, a standard cheap
  // approximation used by realtime canvas/WebGL editors (a true tonal
  // remap would need a per-pixel pass, too costly for smooth preview).
  if(tf.highlights){
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.rect(cx-w/2,cy-h/2,w,h); ctx2d.clip();
    ctx2d.globalCompositeOperation = tf.highlights>0? 'soft-light':'multiply';
    ctx2d.globalAlpha = clamp(Math.abs(tf.highlights)/100,0,0.7);
    ctx2d.fillStyle = '#ffffff';
    ctx2d.fillRect(cx-w/2,cy-h/2,w,h);
    ctx2d.restore();
  }
  if(tf.shadows){
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.rect(cx-w/2,cy-h/2,w,h); ctx2d.clip();
    ctx2d.globalCompositeOperation = tf.shadows>0? 'screen':'multiply';
    ctx2d.globalAlpha = clamp(Math.abs(tf.shadows)/100,0,0.6);
    ctx2d.fillStyle = tf.shadows>0? '#3a3a3a' : '#000000';
    ctx2d.fillRect(cx-w/2,cy-h/2,w,h);
    ctx2d.restore();
  }
  // Sharpen — a cheap perceptual approximation (slightly upscaled +
  // contrast-boosted overlay) instead of a real convolution kernel,
  // which would need a per-pixel pass every frame and is too heavy for
  // smooth mobile preview (see rule: preview rendering must stay light).
  if(tf.sharpen>0.3){
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.rect(cx-w/2,cy-h/2,w,h); ctx2d.clip();
    ctx2d.globalCompositeOperation='overlay';
    ctx2d.globalAlpha = clamp(tf.sharpen/100,0,0.5);
    ctx2d.filter = 'contrast(1.4)';
    try{ ctx2d.drawImage(srcEl, cx-w/2, cy-h/2, w, h); }catch(e){}
    ctx2d.restore();
  }
  // Spark — a handful of small seeded bright sparkles drifting over time.
  if(tf.spark){
    ctx2d.save();
    ctx2d.beginPath(); ctx2d.rect(cx-w/2,cy-h/2,w,h); ctx2d.clip();
    ctx2d.globalCompositeOperation='screen';
    const rnd=mulberry32(seed);
    for(let i=0;i<10;i++){
      const bx=cx-w/2+rnd()*w, by=cy-h/2+rnd()*h;
      const tw = 0.5+0.5*Math.sin(t*6+i*7);
      const r=2+rnd()*3;
      const g=ctx2d.createRadialGradient(bx,by,0,bx,by,r*4);
      g.addColorStop(0,`rgba(255,255,255,${0.8*tw})`); g.addColorStop(1,'rgba(255,255,255,0)');
      ctx2d.fillStyle=g; ctx2d.beginPath(); ctx2d.arc(bx,by,r*4,0,7); ctx2d.fill();
    }
    ctx2d.restore();
  }
}

/* Fase 7 — Stylize preprocessing: Pixelate and Posterize transform the
   SOURCE pixels themselves (not just an overlay on top), so they're
   applied once here into an offscreen canvas which then stands in for
   the original video/image element through the rest of the normal
   pipeline (rotation, blur, tint, etc. all still apply naturally on
   top). Returns the original element unchanged when neither is active —
   zero extra cost for every clip that doesn't use them. */
let pixelateScratch=null, posterizeScratch=null;
function preprocessStylizeSource(srcEl, srcW, srcH, tf){
  if(!(tf.pixelate>1) && !(tf.posterize>1)) return srcEl;
  let source = srcEl, sw=srcW, sh=srcH;
  if(tf.pixelate>1){
    const factor = clamp(tf.pixelate,2,64);
    const smallW = Math.max(1,Math.round(srcW/factor)), smallH = Math.max(1,Math.round(srcH/factor));
    if(!pixelateScratch) pixelateScratch=document.createElement('canvas');
    pixelateScratch.width=smallW; pixelateScratch.height=smallH;
    const sctx=pixelateScratch.getContext('2d');
    sctx.imageSmoothingEnabled=true;
    try{ sctx.drawImage(source,0,0,smallW,smallH); }catch(e){ return srcEl; }
    const big=document.createElement('canvas'); big.width=srcW; big.height=srcH;
    const bctx=big.getContext('2d'); bctx.imageSmoothingEnabled=false;
    bctx.drawImage(pixelateScratch,0,0,srcW,srcH);
    source=big; sw=srcW; sh=srcH;
  }
  if(tf.posterize>1){
    // Downscaled working resolution for the pixel-manipulation pass —
    // posterize is a stylize effect, not a detail-critical one, so this
    // keeps getImageData/putImageData cheap enough for smooth preview.
    const PW=320, PH=Math.round(PW*sh/sw)||1;
    if(!posterizeScratch) posterizeScratch=document.createElement('canvas');
    posterizeScratch.width=PW; posterizeScratch.height=PH;
    const pctx=posterizeScratch.getContext('2d');
    try{ pctx.drawImage(source,0,0,PW,PH); }catch(e){ return source; }
    const img=pctx.getImageData(0,0,PW,PH);
    const levels=clamp(Math.round(tf.posterize),2,16);
    const step=255/(levels-1);
    for(let i=0;i<img.data.length;i+=4){
      img.data[i]=Math.round(Math.round(img.data[i]/step)*step);
      img.data[i+1]=Math.round(Math.round(img.data[i+1]/step)*step);
      img.data[i+2]=Math.round(Math.round(img.data[i+2]/step)*step);
    }
    pctx.putImageData(img,0,0);
    const big=document.createElement('canvas'); big.width=sw; big.height=sh;
    const bctx=big.getContext('2d');
    bctx.drawImage(posterizeScratch,0,0,sw,sh);
    source=big;
  }
  return source;
}
/* draw a media element (video/image) into ctx honoring tf transform + effects */
function drawMediaWithFX(ctx2d, srcEl, srcW, srcH, boxCX, boxCY, boxW, boxH, fit, tf, seed, t){
  srcEl = preprocessStylizeSource(srcEl, srcW, srcH, tf);
  const rect = getFitRect(srcW,srcH,boxW,boxH, fit||'fill');
  // Fase 2 — non-uniform scale: factor out whatever FX (beat-zoom, punch-zoom,
  // etc) multiplied the old single tf.scale by, then re-apply that same
  // multiplier on top of scaleX/scaleY independently. When scaleX===scaleY===
  // scaleBase (legacy clips / uniform scale, the default) fxRatio*scaleX
  // reduces to exactly tf.scale, so old projects render pixel-identical.
  const fxRatio = (tf.scale||1) / (tf.scaleBase||1);
  const finalScaleX = (tf.scaleX!==undefined? tf.scaleX : (tf.scale||1)) * fxRatio;
  const finalScaleY = (tf.scaleY!==undefined? tf.scaleY : (tf.scale||1)) * fxRatio;
  const w = rect.w*finalScaleX*((tf.kfWidth||100)/100);
  const h = rect.h*finalScaleY*((tf.kfHeight||100)/100);
  const cx = boxCX + (tf.dx||0) + (tf.kfX||0);
  const cy = boxCY + (tf.dy||0) + (tf.kfY||0);
  // Anchor point as a fraction of the layer's own size (-0.5..0.5, 0=center,
  // matching the old center-anchored behavior exactly when unset).
  const ax = (tf.anchorX||0)*w, ay = (tf.anchorY||0)*h;

  ctx2d.save();
  // motion trail / echo / ghost / after-image: draw faded offset copies first
  if(tf.trail){
    const n=tf.trail.n, off=tf.trail.offset, a=tf.trail.alpha;
    for(let i=n;i>=1;i--){
      ctx2d.save();
      ctx2d.globalAlpha = a*(1-i/(n+1))*(tf.alpha||1);
      ctx2d.translate(cx - i*off - ax, cy - ay);
      ctx2d.rotate((tf.rotation||0)*Math.PI/180);
      try{ ctx2d.drawImage(srcEl, -w/2, -h/2, w, h); }catch(e){}
      ctx2d.restore();
    }
  }

  ctx2d.globalAlpha = clamp(tf.alpha!==undefined?tf.alpha:1,0,1);
  ctx2d.filter = buildCssFilter(tf);

  const strips = 1 + (tf.glitch? 14:0) + (tf.waveAmp>0.5? 22:0) + (tf.displace>0.3? 20:0);
  if(strips<=1 && !tf.twist && !tf.lens && !tf.skew){
    ctx2d.translate(cx,cy);
    ctx2d.rotate((tf.rotation||0)*Math.PI/180);
    if(tf.skew) ctx2d.transform(1,0,tf.skew,1,0,0);
    if(tf.skewX || tf.skewY) ctx2d.transform(1, Math.tan((tf.skewY||0)*Math.PI/180), Math.tan((tf.skewX||0)*Math.PI/180), 1, 0, 0);
    if(ax||ay) ctx2d.translate(-ax,-ay);
    drawRGBSplitLayer(ctx2d, srcEl, w, h, tf);
  } else {
    // strip-based rendering for wave / glitch / twist / lens distortions.
    // Anchor/independent-axis-scale aren't combined with these advanced
    // distortions yet — they keep using the classic uniform transform.
    ctx2d.translate(cx,cy); ctx2d.rotate((tf.rotation||0)*Math.PI/180);
    const rnd = mulberry32(seed + Math.floor(t*30));
    const stripCount = tf.glitch ? 18 : (tf.waveAmp>0.5? 26: (tf.displace>0.3? 22 : 1));
    const sh = h/stripCount;
    // Fase 7 — Displacement: smooth continuous seeded noise offset per
    // strip (distinct from Glitch's fully-random jitter and Wave's clean
    // sine), giving a warping/heat-haze style distortion.
    const dispSeeds = tf.displace>0.3 ? Array.from({length:4},(_,k)=> (Math.sin(seed*13.7+k*3.1)+1)/2) : null;
    for(let i=0;i<stripCount;i++){
      const sy = -h/2 + i*sh;
      let ox=0, sourceShiftY=0;
      if(tf.waveAmp>0.5){
        if(tf.waveRadial){
          // Fase 7 — Ripple: radial wave emanating from center (distance-
          // based phase) instead of Wave's simple per-row horizontal phase,
          // so the two effects finally look visually distinct.
          const distFromCenter = Math.abs(i/stripCount - 0.5)*2;
          const phase = distFromCenter*Math.PI*2*(tf.waveFreq||3) - t*6;
          ox = Math.sin(phase)*tf.waveAmp*(1-distFromCenter*0.3);
        } else {
          const phase = (i/stripCount)*Math.PI*2*(tf.waveFreq||3) + t*6;
          ox = Math.sin(phase)*tf.waveAmp;
        }
      }
      if(tf.twist){
        const distFromCenter = (i/stripCount - 0.5);
        ox += distFromCenter*tf.twist*Math.sin(t*2+distFromCenter*3);
      }
      if(tf.lens){
        const distFromCenter = (i/stripCount - 0.5);
        const scaleAdj = 1 + tf.lens*(1-Math.abs(distFromCenter)*2)*0.4;
        ox += 0; sourceShiftY = sh*(1-scaleAdj)*0.5;
      }
      if(tf.glitch && rnd()<tf.glitch.amount*0.5){
        ox += (rnd()-0.5)*w*0.25*tf.glitch.amount;
      }
      if(tf.displace>0.3 && dispSeeds){
        const u=i/stripCount;
        const n = dispSeeds.reduce((acc,s,k)=> acc + Math.sin(u*(k+2)*6.28 + s*6.28 + t*(1.5+k*0.4)), 0)/dispSeeds.length;
        ox += n*Math.min(30,tf.displace);
      }
      try{
        ctx2d.drawImage(srcEl, 0, (i/stripCount)*srcH, srcW, srcH/stripCount, -w/2+ox, sy, w, sh+0.5);
      }catch(e){}
    }
  }
  ctx2d.restore();

  // Fase 7 — extra FX passes (directional/radial/spin/focus blur, tint,
  // highlights, shadows, sharpen, spark) drawn in the SAME unrotated
  // (cx,cy)-centered space the overlay pass below already uses.
  drawExtraFXPasses(ctx2d, srcEl, w, h, cx, cy, tf, seed, t);

  // overlays drawn on top, unaffected by filter
  ctx2d.save();
  ctx2d.globalAlpha = clamp(tf.alpha!==undefined?tf.alpha:1,0,1);
  if(tf.scanline>0){
    ctx2d.globalCompositeOperation='multiply';
    ctx2d.fillStyle=`rgba(0,0,0,${clamp(tf.scanline,0,1)})`;
    for(let y=cy-h/2; y<cy+h/2; y+=3){ ctx2d.fillRect(cx-w/2,y,w,1); }
    ctx2d.globalCompositeOperation='source-over';
  }
  if(tf.grain>0){ drawGrain(ctx2d, cx-w/2, cy-h/2, w, h, tf.grain, seed+Math.floor(t*60)); }
  if(tf.vignette>0){ drawVignette(ctx2d, cx-w/2, cy-h/2, w, h, tf.vignette); }
  if(tf.glow>0 || tf.bokeh>0 || tf.lightLeak>0 || tf.lensFlare>0 || tf.neon){
    ctx2d.globalCompositeOperation='screen';
    if(tf.glow>0){ const g=ctx2d.createRadialGradient(cx,cy,0,cx,cy,Math.max(w,h)*0.6); g.addColorStop(0,`rgba(255,255,255,${0.25*tf.glow})`); g.addColorStop(1,'rgba(255,255,255,0)'); ctx2d.fillStyle=g; ctx2d.fillRect(cx-w/2,cy-h/2,w,h); }
    if(tf.neon){
      // Fase 7 — Neon: a colored glow hugging the layer's edges, distinct
      // from plain white Glow.
      const rgb = hexToRgb(tf.neon.color||'#00FF6A');
      ctx2d.save();
      ctx2d.filter = `blur(${(6+10*tf.neon.amount).toFixed(1)}px)`;
      ctx2d.globalAlpha = clamp(0.5*tf.neon.amount,0,0.9);
      ctx2d.strokeStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
      ctx2d.lineWidth = 6+8*tf.neon.amount;
      ctx2d.strokeRect(cx-w/2,cy-h/2,w,h);
      ctx2d.restore();
    }
    if(tf.lightLeak>0){ const g=ctx2d.createRadialGradient(cx-w/3+Math.sin(t)*w*0.1,cy-h/3,0,cx-w/3,cy-h/3,w*0.7); g.addColorStop(0,`rgba(255,180,90,${0.35*tf.lightLeak})`); g.addColorStop(1,'rgba(255,180,90,0)'); ctx2d.fillStyle=g; ctx2d.fillRect(cx-w/2,cy-h/2,w,h); }
    if(tf.bokeh>0){ const rnd2=mulberry32(seed); for(let i=0;i<8;i++){ const bx=cx-w/2+rnd2()*w, by=cy-h/2+rnd2()*h, br=8+rnd2()*22; const g=ctx2d.createRadialGradient(bx,by,0,bx,by,br); g.addColorStop(0,`rgba(255,255,255,${0.18*tf.bokeh})`); g.addColorStop(1,'rgba(255,255,255,0)'); ctx2d.fillStyle=g; ctx2d.beginPath(); ctx2d.arc(bx,by,br,0,7); ctx2d.fill(); } }
    if(tf.lensFlare>0){ const g=ctx2d.createRadialGradient(cx+w*0.3,cy-h*0.3,0,cx+w*0.3,cy-h*0.3,w*0.25); g.addColorStop(0,`rgba(255,255,255,${0.5*tf.lensFlare})`); g.addColorStop(1,'rgba(255,255,255,0)'); ctx2d.fillStyle=g; ctx2d.fillRect(cx-w/2,cy-h/2,w,h); }
    ctx2d.globalCompositeOperation='source-over';
  }
  ctx2d.restore();

  if(tf.flash){
    ctx2d.save();
    ctx2d.globalAlpha = clamp(tf.flash.alpha,0,1);
    ctx2d.fillStyle = tf.flash.color;
    ctx2d.fillRect(0,0, ctx2d.canvas.width, ctx2d.canvas.height);
    ctx2d.restore();
  }
}

function drawRGBSplitLayer(ctx2d, srcEl, w, h, tf){
  if(tf.rgbSplit>0.3){
    const o=Math.min(24,tf.rgbSplit);
    ctx2d.save(); ctx2d.globalCompositeOperation='screen';
    ctx2d.globalAlpha=(tf.alpha!==undefined?tf.alpha:1)*0.75;
    try{
      ctx2d.filter='sepia(1) saturate(6) hue-rotate(-50deg) brightness(1.1)';
      ctx2d.drawImage(srcEl,-w/2-o,-h/2,w,h);
      ctx2d.filter='sepia(1) saturate(6) hue-rotate(140deg) brightness(1.1)';
      ctx2d.drawImage(srcEl,-w/2+o,-h/2,w,h);
    }catch(e){}
    ctx2d.restore();
    ctx2d.save(); ctx2d.globalAlpha=(tf.alpha!==undefined?tf.alpha:1); ctx2d.filter=buildCssFilter(Object.assign({},tf,{blurPx:tf.blurPx*0.4}));
    try{ ctx2d.drawImage(srcEl,-w/2,-h/2,w,h); }catch(e){}
    ctx2d.restore();
    return;
  }
  try{ ctx2d.drawImage(srcEl,-w/2,-h/2,w,h); }catch(e){}
}

let grainPatternCache={};
function drawGrain(ctx2d,x,y,w,h,amount,seed){
  const key=seed%40;
  let tile=grainPatternCache[key];
  if(!tile){
    const c=document.createElement('canvas'); c.width=64; c.height=64;
    const g=c.getContext('2d'); const rnd=mulberry32(seed);
    const id=g.createImageData(64,64);
    for(let i=0;i<id.data.length;i+=4){ const v=rnd()*255; id.data[i]=v; id.data[i+1]=v; id.data[i+2]=v; id.data[i+3]=255; }
    g.putImageData(id,0,0);
    tile=c; grainPatternCache[key]=tile;
    if(Object.keys(grainPatternCache).length>40) grainPatternCache={};
  }
  ctx2d.save();
  ctx2d.globalAlpha=clamp(amount,0,1)*0.35;
  ctx2d.globalCompositeOperation='overlay';
  const pat=ctx2d.createPattern(tile,'repeat');
  ctx2d.fillStyle=pat;
  ctx2d.translate(x,y);
  ctx2d.fillRect(0,0,w,h);
  ctx2d.restore();
}
function drawVignette(ctx2d,x,y,w,h,amount){
  ctx2d.save();
  const cx=x+w/2, cy=y+h/2;
  const g=ctx2d.createRadialGradient(cx,cy,Math.max(w,h)*0.25,cx,cy,Math.max(w,h)*0.72);
  g.addColorStop(0,'rgba(0,0,0,0)');
  g.addColorStop(1,`rgba(0,0,0,${clamp(amount,0,1)})`);
  ctx2d.fillStyle=g;
  ctx2d.fillRect(x,y,w,h);
  ctx2d.restore();
}

/* mask clipping */
function applyMaskClip(ctx2d, mask, boxCX, boxCY, boxW, boxH){
  if(!mask) return false;
  const mw = boxW*(mask.scale||1)*((mask.width||70)/100);
  const mh = boxH*(mask.scale||1)*((mask.height||70)/100);
  const mx = boxCX + (mask.x||0);
  const my = boxCY + (mask.y||0);
  ctx2d.save();
  ctx2d.beginPath();
  if(mask.shape==='Circle'){
    ctx2d.arc(mx,my,Math.min(mw,mh)/2,0,Math.PI*2);
  } else if(mask.shape==='Rounded Rectangle'){
    roundRectPath(ctx2d, mx-mw/2, my-mh/2, mw, mh, Math.min(mw,mh)*0.15);
  } else if(mask.shape==='Linear'){
    ctx2d.rect(mx-mw/2, my-mh*(mask.pos||0.5), mw, mh*(mask.pos||0.5));
  } else if(mask.shape==='Radial'){
    ctx2d.arc(mx,my,Math.max(mw,mh)/2,0,Math.PI*2);
  } else {
    ctx2d.rect(mx-mw/2,my-mh/2,mw,mh);
  }
  ctx2d.closePath();
  ctx2d.clip();
  return true;
}
function roundRectPath(ctx2d,x,y,w,h,r){
  ctx2d.moveTo(x+r,y);
  ctx2d.arcTo(x+w,y,x+w,y+h,r);
  ctx2d.arcTo(x+w,y+h,x,y+h,r);
  ctx2d.arcTo(x,y+h,x,y,r);
  ctx2d.arcTo(x,y,x+w,y,r);
}

/* text rendering */
/* Fase 8 — Text Engine: extracted so the SAME animation curve math can be
   evaluated once for "Whole text" (as before) or per-segment for the new
   Character/Word/Line stagger modes below. */
function computeTextAnimTransform(anim, localTime, dur, canvasW){
  let alpha=1, dx=0, dy=0, scale=1;
  const animIn=0.4, animOut=0.4;
  const p0=clamp(localTime/animIn,0,1), p1=clamp((dur-localTime)/animOut,0,1);
  const inOut=Math.min(p0,p1);
  switch(anim){
    case 'Fade': alpha = ease('easeOut',inOut); break;
    case 'Pop': scale = 0.5+0.5*ease('back',inOut); alpha=ease('linear',Math.min(1,p0*3)); break;
    case 'Bounce': scale = 0.6+0.4*ease('bounce',inOut); break;
    case 'Shake': dx = Math.sin(localTime*40)*(1-inOut)*8; break;
    case 'Slide': dx = (1-ease('easeOut',p0))* -canvasW*0.4 + (1-ease('easeOut',p1))*canvasW*0.4; break;
    case 'Zoom': scale = 0.3+0.7*ease('easeOut',inOut); break;
    case 'Glitch': dx = (Math.random()-0.5)*(1-inOut)*10; break;
    case 'Tracking': alpha = ease('easeOut',p0)*p1; break; // spacing handled by the caller; this still fades in/out
    case 'RGB': case 'Wave': case 'Typewriter': default: break;
  }
  if(anim==='Wave') dy = Math.sin(localTime*6)*4;
  return {alpha,dx,dy,scale,p0};
}
function drawTextLayer(ctx2d, layer, canvasW, canvasH, localTime, dur){
  const s = layer.style;
  const mode = layer.animMode||'Whole';
  const staggerDelay = layer.staggerDelay!==undefined? layer.staggerDelay : 0.045;

  ctx2d.save();
  const cx = canvasW*(0.5+(s.x||0)/canvasW), cy = canvasH*(0.5+(s.y||0)/canvasH);
  let weight = s.bold? '700':'500';
  let style = s.italic? 'italic':'normal';
  const size = s.size||48;
  ctx2d.font = `${style} ${weight} ${size}px ${s.font||"'Inter',sans-serif"}`;
  ctx2d.textAlign = s.align||'center';
  ctx2d.textBaseline='middle';
  let text = layer.text||'';
  if(layer.anim==='Typewriter'){
    const chars = Math.floor(clamp(localTime/Math.max(0.3,dur*0.6),0,1)*text.length);
    text = text.slice(0,chars);
  }
  const lines = text.split('\n');
  const lh = (s.lineHeight||1.2)*size;
  const totalH = lh*(lines.length-1);
  const letterSpacing = layer.anim==='Tracking'
    ? (s.letterSpacing||6) * ease('easeOut', clamp(localTime/0.6,0,1))
    : (s.letterSpacing||0);

  if(mode==='Whole'){
    const tr = computeTextAnimTransform(layer.anim, localTime, dur, canvasW);
    ctx2d.globalAlpha=clamp((s.opacity!==undefined?s.opacity:1)*tr.alpha,0,1);
    ctx2d.translate(cx+tr.dx, cy+tr.dy);
    ctx2d.rotate((s.rotation||0)*Math.PI/180);
    ctx2d.scale(tr.scale,tr.scale);
    lines.forEach((line,i)=>{
      const ly = -totalH/2 + i*lh;
      drawTextLineFill(ctx2d, layer, s, line, ly, letterSpacing, localTime);
    });
  } else if(mode==='Line'){
    ctx2d.translate(cx, cy);
    ctx2d.rotate((s.rotation||0)*Math.PI/180);
    lines.forEach((line,i)=>{
      const ly = -totalH/2 + i*lh;
      const segLocal = clamp(localTime - i*staggerDelay, 0, dur);
      const tr = computeTextAnimTransform(layer.anim, segLocal, dur, canvasW);
      ctx2d.save();
      ctx2d.globalAlpha=clamp((s.opacity!==undefined?s.opacity:1)*tr.alpha,0,1);
      ctx2d.translate(tr.dx, ly+tr.dy);
      ctx2d.scale(tr.scale,tr.scale);
      drawTextLineFill(ctx2d, layer, s, line, 0, letterSpacing, localTime);
      ctx2d.restore();
    });
  } else {
    // Character / Word stagger — lay each segment out left-to-right
    // (honoring the line's own alignment), then animate each with an
    // increasing time delay so the text builds itself in piece by piece.
    ctx2d.translate(cx, cy);
    ctx2d.rotate((s.rotation||0)*Math.PI/180);
    let globalIndex=0;
    lines.forEach((line,li)=>{
      const ly = -totalH/2 + li*lh;
      const segments = mode==='Character' ? [...line].map(c=>({text:c})) : line.split(/(\s+)/).filter(p=>p.length).map(p=>({text:p}));
      const gap = mode==='Character' ? letterSpacing : 0;
      const widths = segments.map(seg=> ctx2d.measureText(seg.text).width);
      const total = widths.reduce((a,b)=>a+b,0) + gap*Math.max(0,segments.length-1);
      let startX = s.align==='right' ? -total : (s.align==='left' ? 0 : -total/2);
      const prevAlign=ctx2d.textAlign; ctx2d.textAlign='left';
      let x=startX;
      segments.forEach((seg,si)=>{
        const segLocal = clamp(localTime - globalIndex*staggerDelay, 0, dur);
        const tr = computeTextAnimTransform(layer.anim, segLocal, dur, canvasW);
        const segCenterX = x + widths[si]/2;
        ctx2d.save();
        ctx2d.textAlign='center';
        ctx2d.globalAlpha=clamp((s.opacity!==undefined?s.opacity:1)*tr.alpha,0,1);
        ctx2d.translate(segCenterX+tr.dx, ly+tr.dy);
        ctx2d.scale(tr.scale,tr.scale);
        drawTextLineFill(ctx2d, layer, s, seg.text, 0, 0, localTime);
        ctx2d.restore();
        x += widths[si]+gap;
        globalIndex++;
      });
      ctx2d.textAlign=prevAlign;
    });
  }
  ctx2d.restore();
}
/* Fills+strokes+glow/shadow ONE line/segment of text at (0,y) in the
   current (already translated/rotated/scaled) context — shared by every
   stagger mode above so the actual paint logic only lives in one place. */
function drawTextLineFill(ctx2d, layer, s, line, ly, letterSpacing, localTime){
  if(s.glow){
    ctx2d.save(); ctx2d.shadowColor=s.color||'#fff'; ctx2d.shadowBlur=20; ctx2d.fillStyle=s.color||'#fff';
    drawSpacedText(ctx2d,line,0,ly,letterSpacing,ctx2d.textAlign);
    ctx2d.restore();
  }
  if(s.shadow){ ctx2d.save(); ctx2d.shadowColor='rgba(0,0,0,0.6)'; ctx2d.shadowBlur=6; ctx2d.shadowOffsetX=2; ctx2d.shadowOffsetY=3; }
  if(s.gradient){
    const g=ctx2d.createLinearGradient(-(s.size||48)*3,0,(s.size||48)*3,0);
    g.addColorStop(0,s.color||'#fff'); g.addColorStop(1,s.color2||'#16E8A6');
    ctx2d.fillStyle=g;
  } else {
    ctx2d.fillStyle = layer.anim==='RGB'? ['#ff2d55','#16e8a6','#3d7bff'][Math.floor(localTime*4)%3] : (s.color||'#ffffff');
  }
  drawSpacedText(ctx2d,line,0,ly,letterSpacing,ctx2d.textAlign);
  if(s.shadow) ctx2d.restore();
  if(s.stroke){
    ctx2d.strokeStyle=s.strokeColor||'#000'; ctx2d.lineWidth=s.strokeWidth||3;
    ctx2d.strokeText(line,0,ly);
  }
}
function drawSpacedText(ctx2d,text,x,y,spacing,align){
  if(!spacing){ ctx2d.fillText(text,x,y); return; }
  const widths=[...text].map(c=>ctx2d.measureText(c).width+spacing);
  const total=widths.reduce((a,b)=>a+b,0)-spacing;
  let startX = x - (align==='center'? total/2 : (align==='right'? total : 0));
  const prevAlign=ctx2d.textAlign; ctx2d.textAlign='left';
  let cx=startX;
  [...text].forEach((c,i)=>{ ctx2d.fillText(c,cx,y); cx+=widths[i]; });
  ctx2d.textAlign=prevAlign;
}

/* procedural overlays (grain/dust/particles/rain/snow/smoke/lightleak/bokeh/vhs/film) */
function drawOverlayFx(ctx2d, type, canvasW, canvasH, t, seed, intensity){
  const rnd=mulberry32(seed);
  ctx2d.save();
  intensity = intensity!==undefined? intensity: 0.6;
  switch(type){
    case 'Film Grain': drawGrain(ctx2d,0,0,canvasW,canvasH,intensity,seed+Math.floor(t*60)); break;
    case 'Dust': {
      ctx2d.globalAlpha=0.5*intensity; ctx2d.fillStyle='#fff';
      for(let i=0;i<40;i++){ const x=(rnd()*canvasW+t*20*rnd())%canvasW, y=(rnd()*canvasH+t*10)%canvasH; ctx2d.beginPath(); ctx2d.arc(x,y,rnd()*1.5+0.3,0,7); ctx2d.fill(); }
      break; }
    case 'Particles': {
      ctx2d.globalAlpha=0.7*intensity; ctx2d.fillStyle='#16E8A6';
      for(let i=0;i<26;i++){ const x=(rnd()*canvasW+Math.sin(t+i)*30)%canvasW, y=((rnd()*canvasH)-(t*60+i*40)%canvasH+canvasH)%canvasH; ctx2d.beginPath(); ctx2d.arc(x,y,rnd()*2+1,0,7); ctx2d.fill(); }
      break; }
    case 'Rain': {
      ctx2d.globalAlpha=0.5*intensity; ctx2d.strokeStyle='rgba(200,220,255,0.8)'; ctx2d.lineWidth=1.5;
      for(let i=0;i<60;i++){ const x=(rnd()*canvasW*1.2 - canvasH*0.2 + t*180)%(canvasW+canvasH*0.2); const y=(rnd()*canvasH+t*900+i*30)%canvasH; ctx2d.beginPath(); ctx2d.moveTo(x,y); ctx2d.lineTo(x-8,y+22); ctx2d.stroke(); }
      break; }
    case 'Snow': {
      ctx2d.globalAlpha=0.8*intensity; ctx2d.fillStyle='#fff';
      for(let i=0;i<50;i++){ const x=(rnd()*canvasW+Math.sin(t+i)*20)%canvasW; const y=(rnd()*canvasH+t*40+i*17)%canvasH; ctx2d.beginPath(); ctx2d.arc(x,y,rnd()*2+1,0,7); ctx2d.fill(); }
      break; }
    case 'Smoke': {
      ctx2d.globalCompositeOperation='screen';
      for(let i=0;i<5;i++){
        const x=canvasW*(0.2+0.6*rnd())+Math.sin(t*0.5+i)*40, y=canvasH*(0.3+0.5*rnd())+Math.cos(t*0.3+i)*30;
        const g=ctx2d.createRadialGradient(x,y,0,x,y,canvasW*0.25);
        g.addColorStop(0,`rgba(255,255,255,${0.08*intensity})`); g.addColorStop(1,'rgba(255,255,255,0)');
        ctx2d.fillStyle=g; ctx2d.fillRect(0,0,canvasW,canvasH);
      }
      break; }
    case 'Light Leak': drawVignette(ctx2d,0,0,canvasW,canvasH,-0.001); {
      ctx2d.globalCompositeOperation='screen';
      const g=ctx2d.createRadialGradient(canvasW*0.15,canvasH*0.1,0,canvasW*0.15,canvasH*0.1,canvasW*0.8);
      g.addColorStop(0,`rgba(255,170,80,${0.4*intensity})`); g.addColorStop(1,'rgba(255,170,80,0)');
      ctx2d.fillStyle=g; ctx2d.fillRect(0,0,canvasW,canvasH);
      break; }
    case 'Bokeh': {
      ctx2d.globalCompositeOperation='screen';
      for(let i=0;i<10;i++){ const x=rnd()*canvasW,y=rnd()*canvasH,r=10+rnd()*30; const g=ctx2d.createRadialGradient(x,y,0,x,y,r); g.addColorStop(0,`rgba(255,255,255,${0.2*intensity})`); g.addColorStop(1,'rgba(255,255,255,0)'); ctx2d.fillStyle=g; ctx2d.beginPath(); ctx2d.arc(x,y,r,0,7); ctx2d.fill(); }
      break; }
    case 'VHS Overlay': {
      ctx2d.globalAlpha=0.18*intensity; ctx2d.fillStyle='#000';
      for(let y=0;y<canvasH;y+=3) ctx2d.fillRect(0,y,canvasW,1);
      drawGrain(ctx2d,0,0,canvasW,canvasH,0.3*intensity,seed+Math.floor(t*60));
      break; }
    case 'Film Overlay': {
      drawGrain(ctx2d,0,0,canvasW,canvasH,0.3*intensity,seed+Math.floor(t*40));
      drawVignette(ctx2d,0,0,canvasW,canvasH,0.35*intensity);
      if(rnd()<0.04){ ctx2d.globalAlpha=0.5; ctx2d.strokeStyle='rgba(255,255,255,0.5)'; ctx2d.beginPath(); const x=rnd()*canvasW; ctx2d.moveTo(x,0); ctx2d.lineTo(x+rnd()*10-5,canvasH); ctx2d.stroke(); }
      break; }
  }
  ctx2d.restore();
}

/* expose to other modules */
window.JS_CORE = {
  $, $$, uid, clamp, lerp, deepClone, fmtTime, fmtBytes, toast, ease, mulberry32,
  App, newProjectData, ratioWH, showPage, openProject, persistCurrentProject,
  computeProjectDuration, hydrateMediaCache, idbPutMedia, idbGetMedia, idbDeleteMedia,
  getFavoriteEffects, toggleFavoriteEffect,
  getUserPresets, addUserPreset, deleteUserPreset,
  lsGetProjects, lsUpsertProject, lsDeleteProject, escapeHtml,
  FX, nearestBeatDelta, pulseEnvelope, baseTransform,
  EFFECT_CATEGORIES, TRANSITIONS, OVERLAY_TYPES, MASK_SHAPES, MASK_BLEND_MODES, TEXT_ANIMS, TEXT_ANIM_MODES, SHAPE_TYPES,
  KF_PROPS, KF_DEFAULT, seedFromString, interpKeyframes, getFitRect, buildCssFilter,
  drawMediaWithFX, applyMaskClip, drawTextLayer, drawOverlayFx, drawVignette, drawGrain,
  LAYER_BLEND_MODES, LAYER_COLOR_LABELS, ensureLayerFields, migrateProjectLayers,
  isLayerEffectivelyVisible, defaultLayerName,
  KF_PROP_RANGES, CURVE_PRESETS, cubicBezierEase,
  matIdentity, matFromTransform, matMultiply, resolveWorldTransform, getClipTransformAtTimeShared,
  makeStandardTracks,
  sanitizeFileName, downloadBlob,
  restoreProjectFromFile,
};

})();
