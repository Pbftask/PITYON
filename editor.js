/* ============================================================
   JEDAG STUDIO — editor controller, timeline UI, panels, export
   ============================================================ */
(function(){
"use strict";
const C = window.JS_CORE;
const {$,$$,uid,clamp,lerp,deepClone,fmtTime,fmtBytes,toast,ease,mulberry32,App,
  newProjectData,ratioWH,showPage,openProject,persistCurrentProject,computeProjectDuration,
  hydrateMediaCache,idbPutMedia,idbGetMedia,idbDeleteMedia,lsGetProjects,lsUpsertProject,
  lsDeleteProject,escapeHtml,FX,nearestBeatDelta,pulseEnvelope,baseTransform,
  EFFECT_CATEGORIES,TRANSITIONS,OVERLAY_TYPES,MASK_SHAPES,TEXT_ANIMS,
  KF_PROPS,KF_DEFAULT,seedFromString,interpKeyframes,getFitRect,buildCssFilter,
  drawMediaWithFX,applyMaskClip,drawTextLayer,drawOverlayFx,drawVignette,drawGrain,
  LAYER_BLEND_MODES,LAYER_COLOR_LABELS,ensureLayerFields,migrateProjectLayers,
  isLayerEffectivelyVisible,defaultLayerName} = C;

const ADJUST_KEYS = [['Brightness','brightness'],['Contrast','contrast'],['Saturation','saturationFx'],['Exposure','exposureFx'],
  ['Temperature','temperature'],['Tint','tint'],['Hue','hueFx'],['Highlights','highlights'],['Shadows','shadows'],
  ['Sharpen','sharpenFx'],['Fade','fadeFx'],['Vignette','vignetteFx'],['Grain','grainFx']];

const Editor = {
  curTime: 0,
  loaded:false,
  audioSources: [],
  exportAudioDest: null,
  exportMode:false,
};
window.Editor = Editor;

/* ---------------- Load / init editor for current project ---------------- */
Editor.load = function(){
  migrateProjectLayers(App.project);
  App.selectedClipId = null;
  Editor.curTime = 0;
  $('#projectNameInput').value = App.project.name;
  $('#ratioChip').textContent = App.project.ratio;
  resizeCanvas();
  Editor.renderTimeline();
  Editor.renderFrame(0);
  Editor.updateTransport();
  hideClipTabs();
  App.undoStack = [App.project ? deepClone(App.project) : null];
  App.redoStack = [];
  updateUndoRedoButtons();
};

function resizeCanvas(){
  const [w,h] = ratioWH(App.project.ratio);
  const cv = $('#previewCanvas');
  cv.width = w; cv.height = h;
  const frame = $('#previewFrame');
  const wrap = $('#previewWrap');
  const wrapW = wrap.clientWidth - 20, wrapH = wrap.clientHeight - 8;
  const ar = w/h;
  let fw = wrapW, fh = fw/ar;
  if(fh > wrapH){ fh = wrapH; fw = fh*ar; }
  frame.style.width = Math.max(60,fw)+'px';
  frame.style.height = Math.max(60,fh)+'px';
}
window.addEventListener('resize', ()=>{ if(App.page==='editor'){ resizeCanvas(); updateGizmo(); } });

/* ============================================================
   Fase 2 — Transform Engine: interactive preview gizmo
   ============================================================ */
/* Types the gizmo currently supports. Text/subtitle render through their
   own x/y/rotation style system (see buildTextStylePanel) rather than
   clip.baseTransform, so they aren't wired into the gizmo yet. */
const GIZMO_SUPPORTED_TYPES = ['video','image','shape','sticker'];

function getClipScreenBox(clip){
  const canvas = $('#previewCanvas');
  if(!canvas) return null;
  const W = canvas.width, H = canvas.height;
  const localTime = clamp(Editor.curTime - clip.start, 0, clip.duration);
  const bt = getClipTransformAtTime(clip, localTime);
  let w, h;
  if(clip.type==='video' || clip.type==='image'){
    const media = App.mediaCache[clip.mediaId];
    const mw = (media && media.width) || W, mh = (media && media.height) || H;
    const rect = getFitRect(mw, mh, W, H, clip.fit||'fill');
    w = rect.w * (bt.scaleX!==undefined?bt.scaleX:bt.scale) * ((bt.width||100)/100);
    h = rect.h * (bt.scaleY!==undefined?bt.scaleY:bt.scale) * ((bt.height||100)/100);
  } else if(clip.type==='shape'){
    w = W*0.4 * (bt.scaleX!==undefined?bt.scaleX:bt.scale) * ((bt.width||100)/100);
    h = H*0.2 * (bt.scaleY!==undefined?bt.scaleY:bt.scale) * ((bt.height||100)/100);
  } else if(clip.type==='sticker'){
    const fontSize = W*0.18;
    w = fontSize*(bt.scaleX!==undefined?bt.scaleX:bt.scale);
    h = fontSize*(bt.scaleY!==undefined?bt.scaleY:bt.scale);
  } else {
    return null;
  }
  return { cx: W/2+(bt.x||0), cy: H/2+(bt.y||0), w, h, rotation: bt.rotation||0, anchorX: bt.anchorX||0, anchorY: bt.anchorY||0 };
}

function updateGizmo(){
  const host = $('#transformGizmo');
  if(!host) return;
  host.innerHTML='';
  const clip = getSelectedClip();
  if(!clip || clip.locked || GIZMO_SUPPORTED_TYPES.indexOf(clip.type)===-1) return;
  const box = getClipScreenBox(clip);
  if(!box) return;
  const canvas = $('#previewCanvas'), frame = $('#previewFrame');
  if(!canvas.width || !frame.clientWidth) return;
  const ratio = frame.clientWidth / canvas.width;

  const cssCx = box.cx*ratio, cssCy = box.cy*ratio, cssW = box.w*ratio, cssH = box.h*ratio;
  const axCss = box.anchorX*cssW, ayCss = box.anchorY*cssH;

  // Center guide lines (used by snapping while dragging).
  const guideV=document.createElement('div'); guideV.className='gizmo-guide v'; guideV.style.left=(frame.clientWidth/2)+'px'; guideV.id='gizmoGuideV';
  const guideH=document.createElement('div'); guideH.className='gizmo-guide h'; guideH.style.top=(frame.clientHeight/2)+'px'; guideH.id='gizmoGuideH';
  host.appendChild(guideV); host.appendChild(guideH);

  const boxEl=document.createElement('div'); boxEl.className='gizmo-box';
  boxEl.style.left=(cssCx-axCss-cssW/2)+'px';
  boxEl.style.top=(cssCy-ayCss-cssH/2)+'px';
  boxEl.style.width=Math.max(4,cssW)+'px';
  boxEl.style.height=Math.max(4,cssH)+'px';
  boxEl.style.transformOrigin = (cssW/2+axCss)+'px '+(cssH/2+ayCss)+'px';
  boxEl.style.transform = `rotate(${box.rotation}deg)`;

  ['tl','tr','bl','br'].forEach(pos=>{
    const h=document.createElement('div'); h.className='gizmo-corner '+pos; h.dataset.corner=pos;
    boxEl.appendChild(h);
  });
  const rotHandle=document.createElement('div'); rotHandle.className='gizmo-rotate-handle'; rotHandle.textContent='↻';
  boxEl.appendChild(rotHandle);

  host.appendChild(boxEl);

  const anchorDot=document.createElement('div'); anchorDot.className='gizmo-anchor-dot';
  anchorDot.style.left=cssCx+'px'; anchorDot.style.top=cssCy+'px';
  host.appendChild(anchorDot);

  attachGizmoDrag(boxEl, clip, box, ratio, frame);
}

function attachGizmoDrag(boxEl, clip, box, ratio, frame){
  const bt = clip.baseTransform;
  let mode=null, startClientX=0, startClientY=0;
  let startBtX=0, startBtY=0, startScaleX=1, startScaleY=1, startRotation=0, startDist=1, startAngle=0;
  const pivotCssX = frame.clientWidth/2 + (bt.x||0)*ratio;
  const pivotCssY = frame.clientHeight/2 + (bt.y||0)*ratio;

  function showGuides(snapX, snapY){
    $('#gizmoGuideV')?.classList.toggle('show', !!snapX);
    $('#gizmoGuideH')?.classList.toggle('show', !!snapY);
  }

  function onDown(e, m){
    e.preventDefault(); e.stopPropagation();
    mode=m;
    startClientX=e.clientX; startClientY=e.clientY;
    startBtX=bt.x||0; startBtY=bt.y||0;
    startScaleX = bt.scaleX!==undefined?bt.scaleX:bt.scale;
    startScaleY = bt.scaleY!==undefined?bt.scaleY:bt.scale;
    startRotation = bt.rotation||0;
    startDist = Math.max(1, Math.hypot(startClientX-pivotCssX, startClientY-pivotCssY));
    startAngle = Math.atan2(startClientY-pivotCssY, startClientX-pivotCssX)*180/Math.PI;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function onMove(e){
    if(!mode) return;
    if(mode==='move'){
      let nx = startBtX + (e.clientX-startClientX)/ratio;
      let ny = startBtY + (e.clientY-startClientY)/ratio;
      const canvas=$('#previewCanvas');
      const snapPx = 10/ratio;
      let snapX=false, snapY=false;
      if(App.snapEnabled!==false){
        if(Math.abs(nx)<snapPx){ nx=0; snapX=true; }
        if(Math.abs(ny)<snapPx){ ny=0; snapY=true; }
      }
      bt.x=nx; bt.y=ny;
      showGuides(snapX, snapY);
      Editor.renderFrame(Editor.curTime);
    } else if(mode==='rotate'){
      const angle = Math.atan2(e.clientY-pivotCssY, e.clientX-pivotCssX)*180/Math.PI;
      let rot = startRotation + (angle-startAngle);
      if(App.snapEnabled!==false){
        const nearest15 = Math.round(rot/15)*15;
        if(Math.abs(rot-nearest15)<4) rot=nearest15;
      }
      bt.rotation = rot;
      Editor.renderFrame(Editor.curTime);
    } else if(mode==='scale'){
      const dist = Math.max(1, Math.hypot(e.clientX-pivotCssX, e.clientY-pivotCssY));
      const factor = dist/startDist;
      bt.scaleX = Math.max(0.05, startScaleX*factor);
      bt.scaleY = Math.max(0.05, startScaleY*factor);
      Editor.renderFrame(Editor.curTime);
    }
  }
  function onUp(){
    if(!mode) return;
    mode=null;
    showGuides(false,false);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    Editor.renderTimeline();
    pushUndoSnapshot();
  }

  boxEl.addEventListener('pointerdown', e=>{
    if(e.target.classList.contains('gizmo-corner')){ onDown(e,'scale'); }
    else if(e.target.classList.contains('gizmo-rotate-handle')){ onDown(e,'rotate'); }
    else { onDown(e,'move'); }
  });
}

/* Fase 2 — preview toolbar: Snap / Grid / Safe Area toggles */
function initPreviewTools(){
  const bSnap=$('#btnToggleSnap'), bGrid=$('#btnToggleGrid'), bSafe=$('#btnToggleSafeArea');
  if(App.snapEnabled===undefined) App.snapEnabled=true;
  bSnap.classList.toggle('active', App.snapEnabled);
  bSnap.addEventListener('click', ()=>{ App.snapEnabled=!App.snapEnabled; bSnap.classList.toggle('active', App.snapEnabled); });
  bGrid.addEventListener('click', ()=>{ $('#previewGridOverlay').classList.toggle('hidden'); bGrid.classList.toggle('active'); });
  bSafe.addEventListener('click', ()=>{ $('#previewSafeArea').classList.toggle('hidden'); bSafe.classList.toggle('active'); });
}

/* ---------------- Undo / Redo ---------------- */
function pushUndoSnapshot(){
  if(!App.project) return;
  App.undoStack.push(deepClone(App.project));
  if(App.undoStack.length>60) App.undoStack.shift();
  App.redoStack = [];
  updateUndoRedoButtons();
  persistCurrentProject();
}
function updateUndoRedoButtons(){
  $('#btnUndo').disabled = App.undoStack.length<=1;
  $('#btnRedo').disabled = App.redoStack.length===0;
}
function doUndo(){
  if(App.undoStack.length<=1) return;
  App.redoStack.push(App.undoStack.pop());
  App.project = deepClone(App.undoStack[App.undoStack.length-1]);
  afterHistoryRestore();
}
function doRedo(){
  if(!App.redoStack.length) return;
  const state = App.redoStack.pop();
  App.undoStack.push(state);
  App.project = deepClone(state);
  afterHistoryRestore();
}
function afterHistoryRestore(){
  updateUndoRedoButtons();
  Editor.renderTimeline();
  Editor.renderFrame(Editor.curTime);
  hideClipTabs();
  App.selectedClipId=null;
  persistCurrentProject();
}

/* ---------------- Timeline rendering ---------------- */
const TRACK_LABEL = {video:'Media', overlay:'Overlay', text:'Text/Shape', audio:'Audio'};

Editor.renderTimeline = function(){
  computeProjectDuration();
  const pxPerSec = App.zoomPxPerSec;
  const totalW = Math.max(400, (App.project.duration+6)*pxPerSec);
  const tracksEl = $('#timelineTracks');
  tracksEl.style.width = totalW+'px';
  tracksEl.innerHTML='';

  App.project.tracks.forEach(track=>{
    const row=document.createElement('div');
    row.className='track-row'+(track.kind==='audio'?' audio-track':'');
    row.style.width = totalW+'px';
    row.dataset.trackId = track.id;
    track.clips.forEach(clip=>{
      const el = buildClipEl(clip, track);
      row.appendChild(el);
    });
    tracksEl.appendChild(row);
  });

  // beat markers overlay (span all tracks)
  if(App.project.beatMarkers && App.project.beatMarkers.length){
    const totalH = tracksEl.scrollHeight || (App.project.tracks.length*58);
    App.project.beatMarkers.forEach(bt=>{
      const m=document.createElement('div');
      m.className='beat-marker';
      m.style.left=(bt*pxPerSec)+'px';
      m.style.height=totalH+'px';
      tracksEl.appendChild(m);
    });
  }

  $('#timelineEmptyHint').classList.toggle('hidden', App.project.tracks.some(t=>t.clips.length>0));
  renderRuler(pxPerSec, totalW);
  positionPlayheadUI();
};

function renderRuler(pxPerSec, totalW){
  const ruler = $('#timelineRuler');
  ruler.innerHTML='';
  ruler.style.width = totalW+'px';
  let step = 5;
  if(pxPerSec>140) step=1; else if(pxPerSec>70) step=2; else if(pxPerSec>35) step=5; else step=10;
  const dur = App.project.duration+6;
  for(let s=0; s<=dur; s+=step){
    const tick=document.createElement('div');
    tick.style.position='absolute'; tick.style.left=(s*pxPerSec)+'px'; tick.style.top='0'; tick.style.fontSize='9px';
    tick.style.color='#6b7180'; tick.textContent=fmtTime(s).slice(0,5);
    ruler.appendChild(tick);
  }
  ruler.style.position='relative';
}

function clipThumbStyle(clip){
  const media = clip.mediaId ? App.mediaCache[clip.mediaId] : null;
  if(clip.type==='image' && media) return `background-image:url('${media.url}')`;
  if(clip.type==='video' && media && media.thumb) return `background-image:url('${media.thumb}')`;
  if(clip.type==='shape') return `background:${clip.color||'#16E8A6'}`;
  if(clip.type==='text'||clip.type==='subtitle') return `background:linear-gradient(135deg,#232833,#161a22)`;
  if(clip.type==='sticker') return `background:#232833`;
  return '';
}

function buildClipEl(clip, track){
  const pxPerSec = App.zoomPxPerSec;
  const el=document.createElement('div');
  el.className='clip'+(clip.type==='audio'?' audio-clip':'')+(App.selectedClipId===clip.id?' selected':'')
    +(clip.visible===false?' clip-hidden':'')+(clip.locked?' clip-locked':'')+(clip.solo?' clip-solo':'');
  el.dataset.clipId = clip.id;
  positionClipEl(el, clip);
  const label = (clip.locked?'🔒 ':'')+(clip.visible===false?'🚫 ':'')+(clip.type==='text'? (clip.text&&clip.text.text||'Text').slice(0,18)
    : clip.type==='subtitle'? 'Subtitle'
    : clip.type==='shape'? (clip.shapeType||'Shape')
    : clip.type==='sticker'? clip.sticker
    : (clip.name||clip.type));
  if(clip.type==='audio'){
    el.innerHTML = `<canvas class="wave"></canvas><div class="clip-label">${escapeHtml(label)}</div>
      <div class="trim-handle left"></div><div class="trim-handle right"></div>`;
    requestAnimationFrame(()=> drawWaveform(el.querySelector('canvas.wave'), clip));
  } else {
    el.innerHTML = `<div class="clip-thumbs" style="${clipThumbStyle(clip)}"></div><div class="clip-label">${escapeHtml(label)}</div>
      <div class="trim-handle left"></div><div class="trim-handle right"></div>`;
  }
  attachClipHandlers(el, clip, track);
  return el;
}
function positionClipEl(el, clip){
  el.style.left = (clip.start*App.zoomPxPerSec)+'px';
  el.style.width = Math.max(6,clip.duration*App.zoomPxPerSec)+'px';
}

function drawWaveform(canvas, clip){
  if(!canvas) return;
  const media = App.mediaCache[clip.mediaId];
  canvas.width = Math.max(6,clip.duration*App.zoomPxPerSec);
  canvas.height = 40;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#16E8A6';
  if(!media || !media.peaks){ ctx.fillStyle='#2a3540'; ctx.fillRect(0,18,canvas.width,4); return; }
  const peaks=media.peaks;
  const srcDur=media.duration||1;
  const trimStart=clip.trimStart||0, trimEnd=clip.trimEnd!==undefined?clip.trimEnd:srcDur;
  const n=canvas.width;
  for(let x=0;x<n;x++){
    const tt = trimStart + (x/n)*(trimEnd-trimStart);
    const idx = Math.floor((tt/srcDur)*peaks.length);
    const v = clamp(peaks[idx]||0,0,1);
    const h = Math.max(2, v*canvas.height*0.9);
    ctx.fillRect(x, (canvas.height-h)/2, 1, h);
  }
}

/* ---------------- Track compatibility for drag-to-reorder ---------------- */
// Visual layers (video/overlay/text tracks) can be freely reordered between
// each other — this lets the user restack images, videos, text, shapes, etc.
// Audio clips may only ever live on an audio track.
const VISUAL_TRACK_KINDS = ['video','overlay','text'];
function trackCompatible(clip, track){
  if(!clip || !track) return false;
  if(clip.type==='audio') return track.kind==='audio';
  if(track.kind==='audio') return false;
  return VISUAL_TRACK_KINDS.includes(track.kind);
}
function rowAtClientY(y){
  const rows = $$('.track-row');
  let best=null, bestDist=Infinity;
  rows.forEach(row=>{
    const r = row.getBoundingClientRect();
    if(y>=r.top && y<=r.bottom){ best=row; bestDist=0; }
    else {
      const d = y<r.top ? r.top-y : y-r.bottom;
      if(d<bestDist){ bestDist=d; best=row; }
    }
  });
  return best;
}

/* ---------------- Clip interactions (move / trim / reorder between tracks) ---------------- */
function attachClipHandlers(el, clip, track){
  let mode=null, startX=0, startY=0, origStart=0, origDur=0, origTrimStart=0, origTrimEnd=0;
  let originTrack=null, originRow=null, hoverRow=null;
  let longPressTimer=null, longPressFired=false;
  el.addEventListener('pointerdown', e=>{
    e.stopPropagation();
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    startX=e.clientX; startY=e.clientY; origStart=clip.start; origDur=clip.duration;
    origTrimStart=clip.trimStart||0; origTrimEnd = clip.trimEnd!==undefined?clip.trimEnd:origDur*(clip.speed||1)+origTrimStart;
    const t=e.target;
    longPressFired=false;
    if(clip.locked){ mode=null; selectClip(clip.id); return; }
    mode = t.classList && t.classList.contains('trim-handle') ? (t.classList.contains('left')?'trimL':'trimR') : 'move';
    if(mode==='move'){
      originTrack = track;
      originRow = el.parentElement;
      hoverRow = null;
      // Take over vertical touch gestures too, so dragging a clip up/down
      // to another track works instead of the page scrolling.
      el.style.touchAction='none';
      el.classList.add('dragging');
      // Long press (hold without moving) opens the layer context menu instead of dragging.
      const lpX=e.clientX, lpY=e.clientY;
      longPressTimer=setTimeout(()=>{
        longPressFired=true; mode=null;
        el.classList.remove('dragging'); el.style.touchAction='';
        openLayerContextMenu(clip, lpX, lpY);
      }, 480);
    }
    selectClip(clip.id);
  });
  el.addEventListener('pointermove', e=>{
    if(longPressTimer && (Math.abs(e.clientX-startX)>8 || Math.abs(e.clientY-startY)>8)){
      clearTimeout(longPressTimer); longPressTimer=null;
    }
    if(!mode) return;
    const dx=(e.clientX-startX)/App.zoomPxPerSec;
    const minDur=0.15;
    if(mode==='move'){
      clip.start = Math.max(0, origStart+dx);
      const dy = e.clientY-startY;
      if(Math.abs(dy)>10){
        const targetRow = rowAtClientY(e.clientY);
        if(targetRow && targetRow!==hoverRow){
          const targetTrack = App.project.tracks.find(t=>t.id===targetRow.dataset.trackId);
          $$('.track-row').forEach(r=>r.classList.remove('drop-target','drop-target-invalid'));
          if(targetTrack && trackCompatible(clip, targetTrack)){
            targetRow.classList.add('drop-target');
            hoverRow = targetRow;
            if(el.parentElement!==targetRow) targetRow.appendChild(el);
          } else {
            targetRow.classList.add('drop-target-invalid');
            hoverRow = null;
            if(el.parentElement!==originRow) originRow.appendChild(el);
          }
        }
      }
    } else if(mode==='trimR'){
      clip.duration = Math.max(minDur, origDur+dx);
      if(clip.trimEnd!==undefined) clip.trimEnd = origTrimEnd + dx*(clip.speed||1);
    } else if(mode==='trimL'){
      let newStart = Math.max(0, origStart+dx);
      let delta = newStart-origStart;
      let newDur = origDur-delta;
      if(newDur<minDur){ newDur=minDur; delta = origDur-minDur; newStart=origStart+delta; }
      clip.start=newStart; clip.duration=newDur;
      if(clip.trimStart!==undefined) clip.trimStart = Math.max(0, origTrimStart + delta*(clip.speed||1));
    }
    positionClipEl(el, clip);
    Editor.renderFrame(Editor.curTime);
  });
  function finish(){
    if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer=null; }
    if(longPressFired){ longPressFired=false; return; }
    if(!mode) return;
    if(mode==='move'){
      el.style.touchAction='';
      el.classList.remove('dragging');
      $$('.track-row').forEach(r=>r.classList.remove('drop-target','drop-target-invalid'));
      if(hoverRow){
        const targetTrack = App.project.tracks.find(t=>t.id===hoverRow.dataset.trackId);
        if(targetTrack && targetTrack!==originTrack && trackCompatible(clip, targetTrack)){
          originTrack.clips = originTrack.clips.filter(c=>c.id!==clip.id);
          targetTrack.clips.push(clip);
          toast(`Dipindah ke track ${TRACK_LABEL[targetTrack.kind]||targetTrack.kind}`);
        }
      }
    }
    mode=null;
    Editor.renderTimeline();
    pushUndoSnapshot();
  }
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

/* ---- Fase 1: long-press layer context menu ---- */
function closeLayerContextMenu(){
  $$('.layer-ctx-menu').forEach(m=>m.remove());
  $$('.layer-ctx-backdrop').forEach(b=>b.remove());
}
function openLayerContextMenu(clip, x, y){
  closeLayerContextMenu();
  selectClip(clip.id);
  const backdrop=document.createElement('div'); backdrop.className='layer-ctx-backdrop';
  const menu=document.createElement('div'); menu.className='layer-ctx-menu';
  const items=[
    ['✏️ Rename', ()=>{
      const name = prompt('Nama layer', clip.name||defaultLayerName(clip));
      if(name!==null){ clip.name = name.trim() || defaultLayerName(clip); Editor.renderTimeline(); pushUndoSnapshot(); }
    }],
    ['📄 Duplicate', ()=> duplicateSelectedClip()],
    [clip.visible===false? '👁 Show' : '🚫 Hide', ()=>{
      clip.visible = clip.visible===false;
      Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    }],
    [clip.locked? '🔓 Unlock' : '🔒 Lock', ()=>{
      clip.locked = !clip.locked;
      Editor.renderTimeline(); pushUndoSnapshot();
    }],
  ];
  if(clip.type==='video'||clip.type==='image'){
    items.push(['🔁 Replace', ()=>{
      if(clip.type==='video') $('#fileInputVideo').click(); else $('#fileInputPhoto').click();
    }]);
  }
  items.push(['🗑 Delete', ()=> deleteSelectedClip(), true]);

  items.forEach(([label,fn,danger])=>{
    const b=document.createElement('button'); if(danger) b.className='danger'; b.textContent=label;
    b.addEventListener('click', ()=>{ closeLayerContextMenu(); fn(); });
    menu.appendChild(b);
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
  // Position, then clamp inside the viewport so it never renders off-screen.
  const vw=window.innerWidth, vh=window.innerHeight;
  requestAnimationFrame(()=>{
    const r=menu.getBoundingClientRect();
    let mx=Math.min(x, vw-r.width-10), my=Math.min(y, vh-r.height-10);
    mx=Math.max(10,mx); my=Math.max(10,my);
    menu.style.left=mx+'px'; menu.style.top=my+'px';
  });
  backdrop.addEventListener('pointerdown', closeLayerContextMenu);
}

/* ---------------- Timeline scrub (tap/drag on ruler or empty area) ---------------- */
(function initScrub(){
  const scroll = $('#timelineScroll');
  let dragging=false;
  function timeFromEvent(e){
    const rect = scroll.getBoundingClientRect();
    const x = e.clientX - rect.left + scroll.scrollLeft;
    return Math.max(0, x/App.zoomPxPerSec);
  }
  function start(e){
    if(e.target.closest('.clip')) return;
    dragging=true;
    Editor.seek(timeFromEvent(e));
  }
  function move(e){ if(dragging) Editor.seek(timeFromEvent(e)); }
  function end(){ dragging=false; }
  scroll.addEventListener('pointerdown', start);
  scroll.addEventListener('pointermove', move);
  scroll.addEventListener('pointerup', end);
  scroll.addEventListener('pointercancel', end);
  $('#timelineRuler').addEventListener('pointerdown', e=>{ dragging=true; Editor.seek(timeFromEvent(e)); });
  $('#timelineRuler').addEventListener('pointermove', move);
  $('#timelineRuler').addEventListener('pointerup', end);
})();

function selectClip(id){
  App.selectedClipId = id;
  $$('.clip').forEach(el=> el.classList.toggle('selected', el.dataset.clipId===id));
  showClipTabs();
  updateGizmo();
}
function getSelectedClip(){
  if(!App.selectedClipId) return null;
  for(const tr of App.project.tracks){ const c=tr.clips.find(c=>c.id===App.selectedClipId); if(c) return c; }
  return null;
}
function getClipTrack(clipId){
  for(const tr of App.project.tracks){ if(tr.clips.some(c=>c.id===clipId)) return tr; }
  return null;
}

function showClipTabs(){
  $('#clipTabsBar').classList.remove('hidden');
}
function hideClipTabs(){
  $('#clipTabsBar').classList.add('hidden');
  updateGizmo();
}

/* ---------------- Playback / render loop ---------------- */
Editor.seek = function(t){
  t = clamp(t, 0, App.project.duration||0.001);
  Editor.curTime = t;
  Editor.renderFrame(t);
  Editor.updateTransport();
  positionPlayheadUI();
};

Editor.updateTransport = function(){
  $('#timecode').textContent = `${fmtTime(Editor.curTime)} / ${fmtTime(App.project.duration)}`;
};
function positionPlayheadUI(){
  $('#playhead').style.left = (Editor.curTime*App.zoomPxPerSec)+'px';
}

Editor.togglePlay = function(){ App.playing ? Editor.pause() : Editor.play(); };

Editor.play = function(){
  if(!App.project.duration) { toast('Timeline kosong'); return; }
  if(Editor.curTime>=App.project.duration-0.01) Editor.curTime=0;
  ensureAudioCtx();
  App.playing = true;
  App.playStartClock = performance.now();
  App.playStartTime = Editor.curTime;
  $('#playIcon').innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  scheduleAudioPlayback(Editor.curTime, null);
  requestAnimationFrame(loopTick);
};
Editor.pause = function(){
  App.playing = false;
  $('#playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
  stopAudioPlayback();
  pauseAllVideos();
};
function loopTick(now){
  if(!App.playing) return;
  Editor.curTime = App.playStartTime + (now-App.playStartClock)/1000;
  if(Editor.curTime >= App.project.duration){
    Editor.curTime = App.project.duration;
    Editor.renderFrame(Editor.curTime);
    Editor.pause();
    Editor.updateTransport(); positionPlayheadUI();
    return;
  }
  Editor.renderFrame(Editor.curTime);
  Editor.updateTransport();
  positionPlayheadUI();
  requestAnimationFrame(loopTick);
}
function pauseAllVideos(){
  Object.values(App.mediaCache).forEach(m=>{ if(m.kind==='video' && m.el && !m.el.paused) m.el.pause(); });
}

/* ---------------- Audio scheduling (Web Audio) ---------------- */
function ensureAudioCtx(){
  if(!App.audioCtx){
    const AC = window.AudioContext||window.webkitAudioContext;
    App.audioCtx = new AC();
  }
  if(App.audioCtx.state==='suspended') App.audioCtx.resume();
}
function scheduleAudioPlayback(fromTime, extraDestStream){
  stopAudioPlayback();
  const audioTrack = App.project.tracks.find(t=>t.kind==='audio');
  if(!audioTrack) return;
  audioTrack.clips.forEach(clip=>{
    const media = App.mediaCache[clip.mediaId];
    if(!media || !media.buffer) return;
    const clipEnd = clip.start+clip.duration;
    if(fromTime>=clipEnd) return;
    const src = App.audioCtx.createBufferSource();
    src.buffer = media.buffer;
    src.playbackRate.value = clip.speed||1;
    const gain = App.audioCtx.createGain();
    gain.gain.value = clip.muted? 0 : (clip.volume!==undefined?clip.volume:1);
    src.connect(gain);
    gain.connect(App.audioCtx.destination);
    if(extraDestStream) gain.connect(extraDestStream);
    let when, offsetInClipSec, playDurSec;
    if(fromTime <= clip.start){
      when = App.audioCtx.currentTime + (clip.start-fromTime);
      offsetInClipSec = 0;
    } else {
      when = App.audioCtx.currentTime;
      offsetInClipSec = fromTime-clip.start;
    }
    const sourceOffset = (clip.trimStart||0) + offsetInClipSec*(clip.speed||1);
    playDurSec = (clip.duration - offsetInClipSec);
    try{ src.start(when, sourceOffset, Math.max(0.02,playDurSec*(clip.speed||1))); }catch(e){}
    Editor.audioSources.push(src);
  });
}
function stopAudioPlayback(){
  Editor.audioSources.forEach(s=>{ try{ s.stop(); }catch(e){} });
  Editor.audioSources=[];
}

/* ---------------- Frame render pipeline ---------------- */
function drawSingleClip(ctx2d, clip, atLocalTimeOverride, canvasW, canvasH){
  const localTime = atLocalTimeOverride!==undefined? atLocalTimeOverride : clamp(Editor.curTime - clip.start, 0, clip.duration);
  const tfBase = getClipTransformAtTime(clip, localTime);
  const tf = baseTransform();
  tf.dx = tfBase.x; tf.dy = tfBase.y; tf.scale = tfBase.scale; tf.rotation = tfBase.rotation; tf.alpha = tfBase.opacity;
  tf.kfWidth = tfBase.width; tf.kfHeight = tfBase.height; tf.kfX=tfBase.x; tf.kfY=tfBase.y;
  // Fase 2 — full transform engine: independent scale X/Y, anchor point, skew.
  // scaleBase is stashed so drawMediaWithFX can factor out whatever beat/zoom
  // FX multiplied tf.scale by, then re-apply that same multiplier on top of
  // the (possibly non-uniform) scaleX/scaleY — see drawMediaWithFX for the math.
  tf.scaleBase = tfBase.scale!==undefined? tfBase.scale : 1;
  tf.scaleX = tfBase.scaleX!==undefined? tfBase.scaleX : tf.scaleBase;
  tf.scaleY = tfBase.scaleY!==undefined? tfBase.scaleY : tf.scaleBase;
  tf.anchorX = tfBase.anchorX||0; tf.anchorY = tfBase.anchorY||0;
  tf.skewX = tfBase.skewX||0; tf.skewY = tfBase.skewY||0;

  const seed = seedFromString(clip.id);
  const beatInfo = nearestBeatDelta(Editor.curTime, App.project.beatMarkers);
  const fxCtx = { tf, beatDelta: beatInfo? beatInfo.delta : null, clipTime: localTime, clipDur: clip.duration, seed, rnd: mulberry32(seed+Math.floor(Editor.curTime*10)) };

  (clip.effects||[]).forEach(fx=>{ const fn=FX[fx.type]; if(fn){ try{ fn(fx.params||{}, fxCtx); }catch(e){} } });
  if(clip.adjust){ ADJUST_KEYS.forEach(([label,key])=>{ const v=clip.adjust[key]; if(v){ FX[key]({amount:v}, fxCtx); } }); }

  const cx = canvasW/2, cy = canvasH/2;

  const renderContent = (targetCtx)=>{
    if(clip.type==='video'||clip.type==='image'){
      const media = App.mediaCache[clip.mediaId];
      if(!media || !media.el) return;
      if(clip.type==='video'){ syncVideoElement(media.el, clip, localTime); }
      drawMediaWithFX(targetCtx, media.el, media.width||canvasW, media.height||canvasH, cx, cy, canvasW, canvasH, clip.fit||'fill', tf, seed, Editor.curTime);
    } else if(clip.type==='shape'){
      drawShapeClip(targetCtx, clip, tf, cx, cy, canvasW, canvasH);
    } else if(clip.type==='sticker'){
      drawStickerClip(targetCtx, clip, tf, cx, cy, canvasW, canvasH);
    } else if(clip.type==='text'||clip.type==='subtitle'){
      targetCtx.save();
      targetCtx.filter = buildCssFilter(tf);
      drawTextLayer(targetCtx, clip.text, canvasW, canvasH, localTime, clip.duration);
      targetCtx.restore();
    }
  };

  if(clip.mask){
    const off=document.createElement('canvas'); off.width=canvasW; off.height=canvasH;
    const octx=off.getContext('2d');
    renderContent(octx);
    const maskCv=document.createElement('canvas'); maskCv.width=canvasW; maskCv.height=canvasH;
    const mctx=maskCv.getContext('2d');
    mctx.filter = clip.mask.feather? `blur(${clip.mask.feather}px)`:'none';
    mctx.fillStyle='#fff';
    mctx.beginPath();
    buildMaskPath(mctx, clip.mask, cx, cy, canvasW, canvasH);
    mctx.fill();
    octx.globalCompositeOperation='destination-in';
    octx.drawImage(maskCv,0,0);
    ctx2d.save();
    ctx2d.globalAlpha = clip.mask.opacity!==undefined?clip.mask.opacity:1;
    ctx2d.drawImage(off,0,0);
    ctx2d.restore();
  } else {
    renderContent(ctx2d);
  }
}
function buildMaskPath(ctx2d, mask, cx, cy, canvasW, canvasH){
  const mw = canvasW*((mask.width||70)/100)*(mask.scale||1);
  const mh = canvasH*((mask.height||70)/100)*(mask.scale||1);
  const mx = cx+(mask.x||0), my = cy+(mask.y||0);
  if(mask.shape==='Circle'||mask.shape==='Radial'){ ctx2d.arc(mx,my,Math.min(mw,mh)/2,0,Math.PI*2); }
  else if(mask.shape==='Rounded Rectangle'){ roundRectP(ctx2d,mx-mw/2,my-mh/2,mw,mh,Math.min(mw,mh)*0.15); }
  else if(mask.shape==='Linear'){ ctx2d.rect(mx-mw/2, my-mh/2, mw, mh*(mask.pos!==undefined?mask.pos:0.5)); }
  else { ctx2d.rect(mx-mw/2,my-mh/2,mw,mh); }
}
function roundRectP(ctx2d,x,y,w,h,r){
  ctx2d.moveTo(x+r,y); ctx2d.arcTo(x+w,y,x+w,y+h,r); ctx2d.arcTo(x+w,y+h,x,y+h,r); ctx2d.arcTo(x,y+h,x,y,r); ctx2d.arcTo(x,y,x+w,y,r);
}
function drawShapeClip(ctx2d, clip, tf, cx, cy, canvasW, canvasH){
  const fxRatio = (tf.scale||1) / (tf.scaleBase||1);
  const sx = (tf.scaleX!==undefined? tf.scaleX : (tf.scale||1)) * fxRatio;
  const sy = (tf.scaleY!==undefined? tf.scaleY : (tf.scale||1)) * fxRatio;
  const w=canvasW*0.4*sx*((tf.kfWidth||100)/100), h=canvasH*0.2*sy*((tf.kfHeight||100)/100);
  const ax=(tf.anchorX||0)*w, ay=(tf.anchorY||0)*h;
  ctx2d.save();
  ctx2d.globalAlpha=clamp(tf.alpha,0,1);
  ctx2d.filter = buildCssFilter(tf);
  ctx2d.translate(cx+(tf.dx||0), cy+(tf.dy||0));
  ctx2d.rotate((tf.rotation||0)*Math.PI/180);
  if(tf.skewX || tf.skewY) ctx2d.transform(1, Math.tan((tf.skewY||0)*Math.PI/180), Math.tan((tf.skewX||0)*Math.PI/180), 1, 0, 0);
  if(ax||ay) ctx2d.translate(-ax,-ay);
  ctx2d.fillStyle = clip.color||'#16E8A6';
  ctx2d.beginPath();
  if(clip.shapeType==='Circle'){ ctx2d.arc(0,0,Math.min(w,h)/2,0,Math.PI*2); }
  else if(clip.shapeType==='Triangle'){ ctx2d.moveTo(0,-h/2); ctx2d.lineTo(w/2,h/2); ctx2d.lineTo(-w/2,h/2); ctx2d.closePath(); }
  else { ctx2d.rect(-w/2,-h/2,w,h); }
  ctx2d.fill();
  ctx2d.restore();
}
function drawStickerClip(ctx2d, clip, tf, cx, cy, canvasW, canvasH){
  const fxRatio = (tf.scale||1) / (tf.scaleBase||1);
  const sx = (tf.scaleX!==undefined? tf.scaleX : (tf.scale||1)) * fxRatio;
  const sy = (tf.scaleY!==undefined? tf.scaleY : (tf.scale||1)) * fxRatio;
  const fontSize = canvasW*0.18;
  const ax=(tf.anchorX||0)*fontSize*sx, ay=(tf.anchorY||0)*fontSize*sy;
  ctx2d.save();
  ctx2d.globalAlpha=clamp(tf.alpha,0,1);
  ctx2d.translate(cx+(tf.dx||0), cy+(tf.dy||0));
  ctx2d.rotate((tf.rotation||0)*Math.PI/180);
  if(tf.skewX || tf.skewY) ctx2d.transform(1, Math.tan((tf.skewY||0)*Math.PI/180), Math.tan((tf.skewX||0)*Math.PI/180), 1, 0, 0);
  ctx2d.scale(sx, sy);
  if(ax||ay) ctx2d.translate(-ax/sx,-ay/sy);
  ctx2d.font = `${Math.round(fontSize)}px sans-serif`;
  ctx2d.textAlign='center'; ctx2d.textBaseline='middle';
  ctx2d.fillText(clip.sticker||'✨',0,0);
  ctx2d.restore();
}

function getClipTransformAtTime(clip, localTime){
  // Always start from the full baseTransform (which now includes scaleX/scaleY/
  // anchorX/anchorY/skewX/skewY) so those Fase-2 fields survive even on clips
  // that have keyframes on the older props (x/y/scale/rotation/opacity/...).
  const base = Object.assign({}, KF_DEFAULT, clip.baseTransform||{});
  if(clip.keyframes && clip.keyframes.length){ return Object.assign(base, interpKeyframes(clip, localTime)); }
  return base;
}

function syncVideoElement(videoEl, clip, localTime){
  const desired = (clip.trimStart||0) + localTime*(clip.speed||1);
  if(videoEl.readyState<1) return;
  if(App.playing){
    videoEl.playbackRate = clamp(clip.speed||1, 0.0625, 16);
    if(videoEl.paused){ videoEl.play().catch(()=>{}); }
    if(Math.abs(videoEl.currentTime-desired)>0.25){ try{ videoEl.currentTime=desired; }catch(e){} }
  } else {
    if(!videoEl.paused) videoEl.pause();
    try{ videoEl.currentTime = desired; }catch(e){}
  }
}

/* transitions */
function findTransitionAt(track, t){
  const clips = track.clips.slice().sort((a,b)=>a.start-b.start);
  for(let i=0;i<clips.length-1;i++){
    const A=clips[i], B=clips[i+1];
    const gap = B.start-(A.start+A.duration);
    if(Math.abs(gap)<0.08 && A.transitionOut && A.transitionOut.type && A.transitionOut.type!=='Cut'){
      const D = Math.max(0.05, Math.min(A.transitionOut.duration||0.5, A.duration, B.duration));
      if(t>=B.start && t<=B.start+D) return {A,B,D,p: clamp((t-B.start)/D,0,1)};
    }
  }
  return null;
}
function renderTransitionPair(mainCtx, pair, canvasW, canvasH){
  const {A,B,D,p} = pair;
  const trType = A.transitionOut.type;
  const easingName = A.transitionOut.easing||'easeInOut';
  const pe = ease(easingName, p);
  const oa = document.createElement('canvas'); oa.width=canvasW; oa.height=canvasH;
  const ob = document.createElement('canvas'); ob.width=canvasW; ob.height=canvasH;
  drawSingleClip(oa.getContext('2d'), A, Math.max(0,A.duration-0.001), canvasW, canvasH);
  drawSingleClip(ob.getContext('2d'), B, clamp(Editor.curTime-B.start,0,B.duration), canvasW, canvasH);

  mainCtx.save();
  switch(trType){
    case 'Fade': case 'Dissolve':
      mainCtx.globalAlpha=1-pe; mainCtx.drawImage(oa,0,0);
      mainCtx.globalAlpha=pe; mainCtx.drawImage(ob,0,0);
      break;
    case 'Zoom': case 'Zoom Blur': {
      mainCtx.globalAlpha=1-pe; mainCtx.save(); mainCtx.translate(canvasW/2,canvasH/2); mainCtx.scale(1+pe*0.5,1+pe*0.5); mainCtx.filter= trType==='Zoom Blur'? `blur(${pe*8}px)`:'none'; mainCtx.drawImage(oa,-canvasW/2,-canvasH/2); mainCtx.restore();
      mainCtx.globalAlpha=pe; mainCtx.save(); mainCtx.translate(canvasW/2,canvasH/2); mainCtx.scale(0.6+pe*0.4,0.6+pe*0.4); mainCtx.drawImage(ob,-canvasW/2,-canvasH/2); mainCtx.restore();
      break; }
    case 'Swipe Left': mainCtx.globalAlpha=1; mainCtx.drawImage(oa,-pe*canvasW,0); mainCtx.drawImage(ob,canvasW-pe*canvasW,0); break;
    case 'Swipe Right': mainCtx.drawImage(oa,pe*canvasW,0); mainCtx.drawImage(ob,-canvasW+pe*canvasW,0); break;
    case 'Swipe Up': mainCtx.drawImage(oa,0,-pe*canvasH); mainCtx.drawImage(ob,0,canvasH-pe*canvasH); break;
    case 'Swipe Down': mainCtx.drawImage(oa,0,pe*canvasH); mainCtx.drawImage(ob,0,-canvasH+pe*canvasH); break;
    case 'Push': mainCtx.drawImage(oa,-pe*canvasW,0); mainCtx.drawImage(ob,canvasW-pe*canvasW,0); break;
    case 'Pull': mainCtx.globalAlpha=1-pe*0.3; mainCtx.drawImage(oa,0,0); mainCtx.globalAlpha=pe; mainCtx.drawImage(ob,(1-pe)*canvasW*0.3,0); break;
    case 'Wipe': mainCtx.drawImage(oa,0,0); mainCtx.save(); mainCtx.beginPath(); mainCtx.rect(0,0,canvasW*pe,canvasH); mainCtx.clip(); mainCtx.drawImage(ob,0,0); mainCtx.restore(); break;
    case 'Spin': case 'Rotate': case 'Camera Transition':
      mainCtx.globalAlpha=1-pe; mainCtx.drawImage(oa,0,0);
      mainCtx.globalAlpha=pe; mainCtx.save(); mainCtx.translate(canvasW/2,canvasH/2); mainCtx.rotate((1-pe)*(trType==='Spin'?Math.PI:0.6)); mainCtx.scale(0.7+pe*0.3,0.7+pe*0.3); mainCtx.drawImage(ob,-canvasW/2,-canvasH/2); mainCtx.restore();
      break;
    case 'Flash':
      mainCtx.globalAlpha=1; mainCtx.drawImage(p<0.5?oa:ob,0,0);
      mainCtx.globalAlpha = 1-Math.abs(p-0.5)*2; mainCtx.fillStyle='#fff'; mainCtx.fillRect(0,0,canvasW,canvasH);
      break;
    case 'Glitch': case 'RGB': case 'Shake': {
      const rnd=mulberry32(Math.floor(Editor.curTime*1000));
      mainCtx.globalAlpha=1-pe; mainCtx.drawImage(oa,(rnd()-0.5)*20*(1-pe),0);
      mainCtx.globalAlpha=pe; mainCtx.drawImage(ob,(rnd()-0.5)*20*pe,0);
      break; }
    case 'Elastic': { const pel=ease('elastic',p); mainCtx.drawImage(oa,-pel*canvasW,0); mainCtx.drawImage(ob,canvasW-pel*canvasW,0); break; }
    case 'Bounce': { const pel=ease('bounce',p); mainCtx.drawImage(oa,-pel*canvasW,0); mainCtx.drawImage(ob,canvasW-pel*canvasW,0); break; }
    case 'Blur': case 'Directional Blur': {
      const blurAmt = (1-Math.abs(p-0.5)*2)*14;
      mainCtx.filter=`blur(${blurAmt}px)`;
      mainCtx.globalAlpha=1-pe; mainCtx.drawImage(oa,0,0);
      mainCtx.globalAlpha=pe; mainCtx.drawImage(ob,0,0);
      mainCtx.filter='none';
      break; }
    default:
      mainCtx.globalAlpha=1-pe; mainCtx.drawImage(oa,0,0); mainCtx.globalAlpha=pe; mainCtx.drawImage(ob,0,0);
  }
  mainCtx.restore();
}

Editor.renderFrame = function(t){
  if(t===undefined) t=Editor.curTime;
  const cv = $('#previewCanvas');
  if(!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const W=cv.width, H=cv.height;
  ctx.save();
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);

  // Solo: if ANY layer anywhere in the project is soloed, only soloed
  // (and still-visible) layers are drawn this frame.
  const allClips = [];
  App.project.tracks.forEach(tr=> tr.clips.forEach(c=> allClips.push(c)));
  const anySolo = allClips.some(c=> c.solo && c.visible!==false);

  const order = ['video','overlay','text'];
  order.forEach(kind=>{
    App.project.tracks.filter(tr=>tr.kind===kind).forEach(track=>{
      const trans = findTransitionAt(track, t);
      if(trans){
        renderTransitionPair(ctx, trans, W, H);
        track.clips.forEach(c=>{
          if(c.id===trans.A.id || c.id===trans.B.id) return;
          if(!layerVisibleNow(c, anySolo)) return;
          if(t>=c.start && t<c.start+c.duration) drawLayerWithBlend(ctx, c, ()=> drawSingleClip(ctx, c, undefined, W, H));
        });
      } else {
        track.clips.forEach(c=>{
          if(!layerVisibleNow(c, anySolo)) return;
          if(t>=c.start && t<c.start+c.duration){
            if(c.type==='overlay'){ drawLayerWithBlend(ctx, c, ()=> drawOverlayFx(ctx, c.overlayType, W, H, t, seedFromString(c.id), c.intensity!==undefined?c.intensity:0.6)); }
            else drawLayerWithBlend(ctx, c, ()=> drawSingleClip(ctx, c, undefined, W, H));
          }
        });
      }
    });
  });
  ctx.restore();
  updateGizmo();
};

/* Fase 1 — Layer visibility (hide/show + solo). */
function layerVisibleNow(clip, anySolo){
  if(clip.visible===false) return false;
  if(anySolo) return !!clip.solo;
  return true;
}
/* Fase 1 — Blend mode compositing. Wraps a draw call so the layer's
   blendMode actually changes how it composites onto everything drawn
   below it, instead of just being a label in a dropdown. */
function drawLayerWithBlend(ctx2d, clip, drawFn){
  const mode = clip.blendMode && clip.blendMode!=='normal' ? clip.blendMode : 'source-over';
  if(mode==='source-over'){ drawFn(); return; }
  ctx2d.save();
  ctx2d.globalCompositeOperation = mode;
  drawFn();
  ctx2d.restore();
}

/* ============================================================
   FAB / Bottom sheet: Add menu
   ============================================================ */
function openSheet(id){ $(id).classList.add('show'); $(id==='#sheetAdd'?'#sheetBackdropAdd':'#sheetBackdropPanel').classList.add('show'); }
function closeSheet(id){ $(id).classList.remove('show'); $(id==='#sheetAdd'?'#sheetBackdropAdd':'#sheetBackdropPanel').classList.remove('show'); }

$('#fabAdd').addEventListener('click', ()=>{
  $('#fabAdd').classList.toggle('spin');
  openSheet('#sheetAdd');
});
$('#sheetBackdropAdd').addEventListener('click', ()=>{ closeSheet('#sheetAdd'); $('#fabAdd').classList.remove('spin'); });
$('#sheetBackdropPanel').addEventListener('click', ()=> closeSheet('#sheetPanel'));

$$('.add-item').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    closeSheet('#sheetAdd'); $('#fabAdd').classList.remove('spin');
    handleAddAction(btn.dataset.add);
  });
});

function handleAddAction(kind){
  switch(kind){
    case 'media': case 'photo': $('#fileInputPhoto').click(); break;
    case 'video': $('#fileInputVideo').click(); break;
    case 'audio': $('#fileInputAudio').click(); break;
    case 'text': addTextClip('Text'); break;
    case 'subtitle': addTextClip('Subtitle', true); break;
    case 'shape': addShapeClip(); break;
    case 'sticker': openStickerPicker(); break;
    case 'effect': openEffectPanelForSelection(); break;
    case 'transition': openTransitionPanelForSelection(); break;
    case 'overlay': addOverlayClip(); break;
    case 'beat': openBeatPanel(); break;
    case 'adjustment': openAdjustPanelForSelection(); break;
  }
}

/* ---------------- Media import ---------------- */
$('#fileInputVideo').addEventListener('change', e=> importFiles(e.target.files,'video'));
$('#fileInputPhoto').addEventListener('change', e=> importFiles(e.target.files,'image'));
$('#fileInputAudio').addEventListener('change', e=> importFiles(e.target.files,'audio'));

async function importFiles(fileList, kind){
  const files = Array.from(fileList||[]);
  if(!files.length) return;
  let added=0, skipped=0;
  for(const file of files){
    const ok = await importSingleFile(file, kind);
    if(ok) added++; else skipped++;
  }
  if(added>0){
    Editor.renderTimeline();
    pushUndoSnapshot();
  }
  if(skipped>0 && added>0){
    toast(`${added} media ditambahkan, ${skipped} dilewati (tanpa suara)`);
  }
}

function loadMeta(url, kind){
  return new Promise(resolve=>{
    if(kind==='video'){
      const v=document.createElement('video'); v.preload='metadata'; v.src=url; v.muted=true;
      v.onloadedmetadata=()=> resolve({duration:v.duration||1, width:v.videoWidth||1080, height:v.videoHeight||1920});
      v.onerror=()=> resolve({duration:3,width:1080,height:1920});
    } else if(kind==='image'){
      const im=new Image(); im.src=url;
      im.onload=()=> resolve({duration:3, width:im.naturalWidth, height:im.naturalHeight});
      im.onerror=()=> resolve({duration:3,width:1080,height:1920});
    } else {
      resolve({duration:3,width:0,height:0});
    }
  });
}

/* ---------------- Audio-presence validation ----------------
   Video and audio uploads are required to actually contain sound.
   - For video files we probe the decoded media's audio track via
     captureStream() (works without needing playback to start).
   - For audio files we decode the real audio data and check that it
     isn't effectively silent. */
function detectVideoHasAudio(url){
  return new Promise(resolve=>{
    const v=document.createElement('video');
    v.src=url; v.muted=true; v.playsInline=true; v.preload='auto';
    let settled=false;
    function finish(res){ if(settled) return; settled=true; resolve(res); }
    v.addEventListener('loadeddata', ()=>{
      try{
        let stream=null;
        if(v.captureStream) stream=v.captureStream();
        else if(v.mozCaptureStream) stream=v.mozCaptureStream();
        if(stream){ finish(stream.getAudioTracks().length>0); return; }
      }catch(e){}
      // Can't verify in this browser — don't block a possibly-valid file.
      finish(null);
    }, {once:true});
    v.addEventListener('error', ()=> finish(null));
    setTimeout(()=> finish(null), 4000);
  });
}
async function tryDecodeAudioBuffer(file){
  try{
    ensureAudioCtx();
    const arr = await file.arrayBuffer();
    return await App.audioCtx.decodeAudioData(arr.slice(0));
  }catch(e){ console.warn('decode audio failed', e); return null; }
}
function isSilentBuffer(buffer, threshold){
  threshold = threshold===undefined ? 0.008 : threshold; // ~ -42dB noise floor
  for(let c=0;c<buffer.numberOfChannels;c++){
    const data = buffer.getChannelData(c);
    const step = Math.max(1, Math.floor(data.length/20000));
    for(let i=0;i<data.length;i+=step){
      if(Math.abs(data[i])>threshold) return false;
    }
  }
  return true;
}

async function importSingleFile(file, kind){
  const mediaId = uid('MED');
  const url = URL.createObjectURL(file);
  const meta = await loadMeta(url, kind);

  let audioBuffer = null;
  if(kind==='video'){
    const hasAudio = await detectVideoHasAudio(url);
    if(hasAudio===false){
      URL.revokeObjectURL(url);
      toast(`"${file.name}" dilewati: video tidak memiliki suara`);
      return false;
    }
  } else if(kind==='audio'){
    audioBuffer = await tryDecodeAudioBuffer(file);
    if(!audioBuffer){
      URL.revokeObjectURL(url);
      toast(`"${file.name}" dilewati: file audio tidak valid`);
      return false;
    }
    if(isSilentBuffer(audioBuffer)){
      URL.revokeObjectURL(url);
      toast(`"${file.name}" dilewati: audio tidak memiliki suara`);
      return false;
    }
  }

  await idbPutMedia({ id:mediaId, blob:file });
  const mediaDuration = kind==='audio' ? audioBuffer.duration : meta.duration;
  App.project.mediaLibrary.push({ id:mediaId, kind, name:file.name, duration:mediaDuration, width:meta.width, height:meta.height });

  const entry = { blob:file, url, kind, width:meta.width, height:meta.height, duration:mediaDuration };
  if(kind==='video'){
    const v=document.createElement('video'); v.src=url; v.muted=true; v.playsInline=true; v.preload='auto'; entry.el=v;
    generateVideoThumb(v, entry);
  } else if(kind==='image'){
    const im=new Image(); im.src=url; entry.el=im;
  } else if(kind==='audio'){
    entry.el=document.createElement('audio'); entry.el.src=url; entry.el.preload='auto';
    entry.buffer = audioBuffer;
    entry.peaks = computePeaks(audioBuffer, 400);
  }
  App.mediaCache[mediaId]=entry;

  const track = App.project.tracks.find(t=> kind==='audio'? t.kind==='audio' : t.kind==='video');
  const start = trackEndTime(track);
  const clip = {
    id: uid('clip'), type:kind, mediaId, name:file.name.replace(/\.[^.]+$/,''),
    start, duration: mediaDuration, trimStart:0, trimEnd: mediaDuration, speed:1, fit:'fill',
    effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
    baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100},
    volume: kind==='audio'?1:undefined,
  };
  ensureLayerFields(clip, nextZIndex());
  track.clips.push(clip);
  computeProjectDuration();
  toast(`${kind==='audio'?'Audio':kind==='video'?'Video':'Foto'} ditambahkan`);
  return true;
}
/* ---------------- Extract audio from a video clip ---------------- */
async function extractAudioFromClip(clip){
  const media = App.mediaCache[clip.mediaId];
  if(!media || !media.blob){ toast('Media video tidak ditemukan'); return; }
  toast('Mengekstrak audio...');
  try{
    ensureAudioCtx();
    const arr = await media.blob.arrayBuffer();
    const buffer = await App.audioCtx.decodeAudioData(arr.slice(0));
    if(isSilentBuffer(buffer)){ toast('Video ini tidak punya suara untuk diekstrak'); return; }

    const mediaId = uid('MED');
    const url = URL.createObjectURL(media.blob);
    await idbPutMedia({ id:mediaId, blob:media.blob });
    const name = (clip.name||'audio') + ' (audio)';
    App.project.mediaLibrary.push({ id:mediaId, kind:'audio', name, duration:buffer.duration, width:0, height:0 });

    const entry = { blob:media.blob, url, kind:'audio', width:0, height:0, duration:buffer.duration };
    entry.el = document.createElement('audio'); entry.el.src=url; entry.el.preload='auto';
    entry.buffer = buffer;
    entry.peaks = computePeaks(buffer, 400);
    App.mediaCache[mediaId] = entry;

    const audioTrack = App.project.tracks.find(t=>t.kind==='audio');
    const newClip = {
      id: uid('clip'), type:'audio', mediaId, name,
      start: clip.start, duration: Math.min(buffer.duration, clip.duration), trimStart:0, trimEnd: buffer.duration, speed:1,
      effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
      baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100},
      volume:1, muted:false,
    };
    ensureLayerFields(newClip, nextZIndex());
    audioTrack.clips.push(newClip);
    computeProjectDuration();
    Editor.renderTimeline();
    toast('Audio berhasil diekstrak ke track audio');
    pushUndoSnapshot();
  }catch(e){
    console.warn('extract audio failed', e);
    toast('Gagal mengekstrak audio dari video ini');
  }
}
function trackEndTime(track){
  let max=0; track.clips.forEach(c=> max=Math.max(max,c.start+c.duration)); return max;
}
/* Next free zIndex for a newly created layer, so it stacks above everything else by default. */
function nextZIndex(){
  let max=-1;
  App.project.tracks.forEach(tr=> tr.clips.forEach(c=>{ if(c.zIndex!==undefined && c.zIndex>max) max=c.zIndex; }));
  return max+1;
}
function generateVideoThumb(videoEl, entry){
  videoEl.addEventListener('loadeddata', ()=>{
    try{
      const c=document.createElement('canvas'); c.width=80; c.height=142;
      const ctx=c.getContext('2d');
      const rect=getFitRect(videoEl.videoWidth,videoEl.videoHeight,80,142,'fill');
      ctx.drawImage(videoEl,(80-rect.w)/2,(142-rect.h)/2,rect.w,rect.h);
      entry.thumb = c.toDataURL('image/jpeg',0.6);
      Editor.renderTimeline();
    }catch(e){}
  }, {once:true});
}
function computePeaks(buffer, resolution){
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length/resolution);
  const peaks=[];
  for(let i=0;i<resolution;i++){
    let max=0; const start=i*step, end=Math.min(data.length,start+step);
    for(let j=start;j<end;j++){ const v=Math.abs(data[j]); if(v>max) max=v; }
    peaks.push(max);
  }
  return peaks;
}

/* ---------------- Add text / shape / sticker / overlay ---------------- */
function addTextClip(kind, isSubtitle){
  const track = App.project.tracks.find(t=>t.kind==='text');
  const start = Editor.curTime||0;
  const clip = {
    id: uid('clip'), type: isSubtitle?'subtitle':'text', start, duration: 3,
    effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
    baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100},
    text: { text: isSubtitle? 'Subtitle text' : 'Jedag Jedug!', anim:'Pop',
      style:{ font:"'Space Grotesk',sans-serif", size: isSubtitle?36:56, bold:true, italic:false, align:'center',
        color:'#ffffff', gradient:false, color2:'#16E8A6', stroke:false, strokeColor:'#000000', strokeWidth:3,
        shadow:true, glow:false, letterSpacing:0, lineHeight:1.2, x:0, y:isSubtitle?700:0, rotation:0, opacity:1 } }
  };
  ensureLayerFields(clip, nextZIndex());
  track.clips.push(clip);
  computeProjectDuration(); Editor.renderTimeline(); selectClip(clip.id); openPanelTab('basic');
  pushUndoSnapshot();
}
function addShapeClip(){
  const track = App.project.tracks.find(t=>t.kind==='text');
  const clip = { id: uid('clip'), type:'shape', shapeType:'Rectangle', color:'#16E8A6',
    start: Editor.curTime||0, duration:3, effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
    baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100} };
  ensureLayerFields(clip, nextZIndex());
  track.clips.push(clip);
  computeProjectDuration(); Editor.renderTimeline(); selectClip(clip.id); openPanelTab('basic');
  pushUndoSnapshot();
}
const STICKERS = ['🔥','✨','💥','⚡','🎉','💫','⭐','❤️','😂','😎','👑','🚀','🎵','💯','🌟','⚠️'];
function openStickerPicker(){
  $('#panelTitle').textContent='Sticker';
  const body=$('#panelBody');
  body.innerHTML = `<div class="add-grid">${STICKERS.map(s=>`<button class="add-item" data-sticker="${s}"><span class="add-icon" style="font-size:26px">${s}</span></button>`).join('')}</div>`;
  $$('[data-sticker]',body).forEach(b=> b.addEventListener('click', ()=>{
    const track = App.project.tracks.find(t=>t.kind==='text');
    const clip={ id:uid('clip'), type:'sticker', sticker:b.dataset.sticker, start:Editor.curTime||0, duration:3,
      effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
      baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100} };
    ensureLayerFields(clip, nextZIndex());
    track.clips.push(clip); computeProjectDuration(); Editor.renderTimeline(); selectClip(clip.id);
    closeSheet('#sheetPanel'); pushUndoSnapshot();
  }));
  openSheet('#sheetPanel');
}
function addOverlayClip(){
  const track = App.project.tracks.find(t=>t.kind==='overlay');
  const clip = { id: uid('clip'), type:'overlay', overlayType:OVERLAY_TYPES[0], intensity:0.6,
    start: Editor.curTime||0, duration: Math.max(2, (App.project.duration||3)-(Editor.curTime||0)) };
  ensureLayerFields(clip, nextZIndex());
  track.clips.push(clip);
  computeProjectDuration(); Editor.renderTimeline(); selectClip(clip.id);
  openOverlayPanel(clip);
  pushUndoSnapshot();
}

/* ============================================================
   Clip tab bar -> panels
   ============================================================ */
$$('.clip-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    $$('.clip-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    openPanelTab(tab.dataset.tab);
  });
});
$('#btnCloseClipTabs').addEventListener('click', ()=>{ hideClipTabs(); App.selectedClipId=null; $$('.clip').forEach(el=>el.classList.remove('selected')); });

function openPanelTab(tab){
  const clip = getSelectedClip();
  if(!clip){ toast('Pilih clip dulu'); return; }
  App.panelTab = tab;
  if(clip.type==='overlay'){ openOverlayPanel(clip); return; }
  if(tab==='basic') renderBasicPanel(clip);
  else if(tab==='animation') renderAnimationPanel(clip);
  else if(tab==='effect') renderEffectPanel(clip);
  else if(tab==='adjust') renderAdjustPanel(clip);
  else if(tab==='speed') renderSpeedPanel(clip);
  else if(tab==='mask') renderMaskPanel(clip);
  else if(tab==='transition') renderTransitionPanel(clip);
  else if(tab==='blend') renderBlendPanel(clip);
  else if(tab==='layer') renderLayerPanel(clip);
  $$('.clip-tab').forEach(t=> t.classList.toggle('active', t.dataset.tab===tab));
  openSheet('#sheetPanel');
}
function tabStripEl(activeTab){
  const row=document.createElement('div'); row.className='panel-tabgroup'; row.style.marginBottom='16px';
  const tabs=[['basic','Basic'],['animation','Animation'],['effect','Effect'],['adjust','Adjust'],['speed','Speed'],['mask','Mask'],['transition','Transition'],['blend','Blend'],['layer','Layer']];
  tabs.forEach(([key,label])=>{
    const b=document.createElement('button'); b.textContent=label; if(key===activeTab) b.classList.add('active');
    b.addEventListener('click', ()=> openPanelTab(key));
    row.appendChild(b);
  });
  return row;
}
function openEffectPanelForSelection(){ const c=getSelectedClip(); if(!c){ toast('Pilih clip dulu, lalu ketuk Effect'); return; } renderEffectPanel(c); openSheet('#sheetPanel'); }
function openTransitionPanelForSelection(){ const c=getSelectedClip(); if(!c){ toast('Pilih clip dulu, lalu ketuk Transition'); return; } renderTransitionPanel(c); openSheet('#sheetPanel'); }
function openAdjustPanelForSelection(){ const c=getSelectedClip(); if(!c){ toast('Pilih clip dulu, lalu ketuk Adjustment'); return; } renderAdjustPanel(c); openSheet('#sheetPanel'); }

function sliderRow(label, value, min, max, step, onInput){
  const wrap=document.createElement('div'); wrap.className='slider-row';
  wrap.innerHTML = `<div class="slider-label"><span>${label}</span><b>${Number(value).toFixed(step<1?2:0)}</b></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
  const input=wrap.querySelector('input');
  const b=wrap.querySelector('b');
  input.addEventListener('input', ()=>{ b.textContent = Number(input.value).toFixed(step<1?2:0); onInput(parseFloat(input.value), false); });
  input.addEventListener('change', ()=>{ onInput(parseFloat(input.value), true); });
  return wrap;
}

/* ---- Basic tab ---- */
function renderBasicPanel(clip){
  $('#panelTitle').textContent='Basic';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('basic'));

  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML = `<button class="pill-btn ghost" id="bReplace">Ganti Media</button><button class="pill-btn ghost" id="bDup">Duplikat</button><button class="pill-btn ghost" id="bDel">Hapus</button>`;
  body.appendChild(actions);

  if(clip.type==='video'){
    const audioActions=document.createElement('div'); audioActions.className='action-row';
    audioActions.innerHTML = `<button class="pill-btn ghost" id="bExtractAudio">🎵 Extract Audio</button>`;
    body.appendChild(audioActions);
    $('#bExtractAudio').addEventListener('click', ()=> extractAudioFromClip(clip));
  }

  if(clip.type==='video'||clip.type==='image'){
    const fitRow=document.createElement('div'); fitRow.className='panel-tabgroup';
    ['fill','fit','crop'].forEach(f=>{
      const b=document.createElement('button'); b.textContent=f.toUpperCase(); if(clip.fit===f) b.classList.add('active');
      b.addEventListener('click', ()=>{ clip.fit=f; renderBasicPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
      fitRow.appendChild(b);
    });
    body.appendChild(fitRow);
  }

  const bt = clip.baseTransform || (clip.baseTransform={x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100});
  body.appendChild(sliderRow('Position X', bt.x, -800, 800, 1, (v,commit)=>{ bt.x=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Position Y', bt.y, -800, 800, 1, (v,commit)=>{ bt.y=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Scale', bt.scale, 0.1, 3, 0.01, (v,commit)=>{
    bt.scale=v;
    if(App.linkScaleXY!==false){ bt.scaleX=v; bt.scaleY=v; }
    Editor.renderFrame(Editor.curTime); if(commit){ Editor.renderTimeline(); pushUndoSnapshot(); }
  }));
  body.appendChild(sliderRow('Rotation', bt.rotation, -180, 180, 1, (v,commit)=>{ bt.rotation=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Opacity', bt.opacity, 0, 1, 0.01, (v,commit)=>{ bt.opacity=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));

  // Fase 2 — full transform engine: independent Scale X/Y, Anchor, Skew.
  // Not wired up for text/subtitle yet — those still render through their
  // own x/y/rotation style system (see the Text style panel below).
  if(clip.type!=='text' && clip.type!=='subtitle'){
    const linkRow=document.createElement('div'); linkRow.className='toggle-row';
    linkRow.innerHTML = `<span>Kunci Scale X = Scale Y</span><div class="switch ${App.linkScaleXY!==false?'on':''}"></div>`;
    linkRow.querySelector('.switch').addEventListener('click', function(){
      App.linkScaleXY = !this.classList.contains('on');
      this.classList.toggle('on', App.linkScaleXY);
    });
    body.appendChild(linkRow);
    body.appendChild(sliderRow('Scale X', bt.scaleX!==undefined?bt.scaleX:bt.scale, 0.1, 3, 0.01, (v,commit)=>{
      bt.scaleX=v; if(App.linkScaleXY!==false) bt.scaleY=v;
      Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot();
    }));
    body.appendChild(sliderRow('Scale Y', bt.scaleY!==undefined?bt.scaleY:bt.scale, 0.1, 3, 0.01, (v,commit)=>{
      bt.scaleY=v; if(App.linkScaleXY!==false) bt.scaleX=v;
      Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot();
    }));
    body.appendChild(sliderRow('Anchor X', bt.anchorX||0, -0.5, 0.5, 0.01, (v,commit)=>{ bt.anchorX=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
    body.appendChild(sliderRow('Anchor Y', bt.anchorY||0, -0.5, 0.5, 0.01, (v,commit)=>{ bt.anchorY=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
    body.appendChild(sliderRow('Skew X', bt.skewX||0, -60, 60, 1, (v,commit)=>{ bt.skewX=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
    body.appendChild(sliderRow('Skew Y', bt.skewY||0, -60, 60, 1, (v,commit)=>{ bt.skewY=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
  }

  if(clip.type==='text'||clip.type==='subtitle'){
    const ta=document.createElement('textarea'); ta.className='text-input-area'; ta.value=clip.text.text;
    ta.addEventListener('input', ()=>{ clip.text.text=ta.value; Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); });
    ta.addEventListener('change', ()=> pushUndoSnapshot());
    body.insertBefore(ta, body.firstChild);
    body.appendChild(buildTextStylePanel(clip));
  }
  if(clip.type==='shape'){
    const row=document.createElement('div'); row.className='panel-tabgroup';
    ['Rectangle','Circle','Triangle'].forEach(s=>{ const b=document.createElement('button'); b.textContent=s; if(clip.shapeType===s) b.classList.add('active');
      b.addEventListener('click',()=>{ clip.shapeType=s; renderBasicPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); row.appendChild(b); });
    body.appendChild(row);
    body.appendChild(colorRow(clip.color, c=>{ clip.color=c; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
  }

  $('#bDel').addEventListener('click', ()=>{ deleteSelectedClip(); });
  $('#bDup').addEventListener('click', ()=>{ duplicateSelectedClip(); });
  $('#bReplace').addEventListener('click', ()=>{
    if(clip.type==='video') $('#fileInputVideo').click();
    else if(clip.type==='image') $('#fileInputPhoto').click();
    else toast('Tidak berlaku untuk tipe ini');
  });
}
function colorRow(current, onPick){
  const colors=['#ffffff','#16E8A6','#FF4D6D','#3D7BFF','#FFB020','#B44DFF','#000000'];
  const row=document.createElement('div'); row.className='color-row';
  colors.forEach(c=>{
    const sw=document.createElement('button'); sw.className='color-swatch'+(current===c?' active':''); sw.style.background=c;
    sw.addEventListener('click', ()=>{ onPick(c); $$('.color-swatch',row).forEach(s=>s.classList.remove('active')); sw.classList.add('active'); });
    row.appendChild(sw);
  });
  return row;
}
function deleteSelectedClip(){
  const clip=getSelectedClip(); if(!clip) return;
  const track = getClipTrack(clip.id);
  track.clips = track.clips.filter(c=>c.id!==clip.id);
  App.selectedClipId=null; hideClipTabs(); closeSheet('#sheetPanel');
  computeProjectDuration(); Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
  pushUndoSnapshot();
}
function duplicateSelectedClip(){
  const clip=getSelectedClip(); if(!clip) return;
  const track = getClipTrack(clip.id);
  const copy = deepClone(clip); copy.id = uid('clip'); copy.start = clip.start+clip.duration+0.05;
  copy.name = (clip.name||defaultLayerName(clip))+' copy';
  copy.zIndex = nextZIndex(); copy.solo = false;
  track.clips.push(copy);
  computeProjectDuration(); Editor.renderTimeline(); selectClip(copy.id);
  pushUndoSnapshot();
}

/* ---- Fase 1: Blend tab ---- */
function renderBlendPanel(clip){
  $('#panelTitle').textContent='Blend';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('blend'));

  const bt = clip.baseTransform || (clip.baseTransform={x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100});
  body.appendChild(sliderRow('Opacity', bt.opacity!==undefined?bt.opacity:1, 0, 1, 0.01, (v,commit)=>{
    bt.opacity=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot();
  }));

  const label=document.createElement('div'); label.className='muted'; label.style.margin='6px 2px'; label.textContent='Blend Mode';
  body.appendChild(label);
  const grid=document.createElement('div'); grid.className='blend-mode-grid';
  LAYER_BLEND_MODES.forEach(([name,mode])=>{
    const b=document.createElement('button'); b.textContent=name;
    if((clip.blendMode||'normal')===mode) b.classList.add('active');
    b.addEventListener('click', ()=>{
      clip.blendMode = mode;
      $$('.blend-mode-grid button', grid).forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      Editor.renderFrame(Editor.curTime);
      pushUndoSnapshot();
    });
    grid.appendChild(b);
  });
  body.appendChild(grid);
}

/* ---- Fase 1: Layer tab (identity, visibility, lock, solo, stacking) ---- */
function toggleRowEl(label, value, onToggle){
  const row=document.createElement('div'); row.className='toggle-row';
  row.innerHTML=`<span>${escapeHtml(label)}</span><div class="switch ${value?'on':''}"></div>`;
  row.querySelector('.switch').addEventListener('click', function(){
    const next = !this.classList.contains('on');
    this.classList.toggle('on', next);
    onToggle(next);
  });
  return row;
}
function renderLayerPanel(clip){
  $('#panelTitle').textContent='Layer';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('layer'));

  const nameInput=document.createElement('input'); nameInput.type='text'; nameInput.className='layer-name-input';
  nameInput.value = clip.name || defaultLayerName(clip);
  nameInput.addEventListener('change', ()=>{
    clip.name = nameInput.value.trim() || defaultLayerName(clip);
    Editor.renderTimeline(); pushUndoSnapshot();
  });
  body.appendChild(nameInput);

  body.appendChild(toggleRowEl('Visible', clip.visible!==false, v=>{
    clip.visible=v; Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  }));
  body.appendChild(toggleRowEl('Lock', !!clip.locked, v=>{
    clip.locked=v; Editor.renderTimeline(); pushUndoSnapshot();
  }));
  body.appendChild(toggleRowEl('Solo', !!clip.solo, v=>{
    clip.solo=v; Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  }));

  const colorLabel=document.createElement('div'); colorLabel.className='muted'; colorLabel.style.margin='6px 2px'; colorLabel.textContent='Label Warna';
  body.appendChild(colorLabel);
  const colorRow2=document.createElement('div'); colorRow2.className='layer-color-row';
  LAYER_COLOR_LABELS.forEach(c=>{
    const sw=document.createElement('button'); sw.className='layer-color-swatch'+(c===''?' none':'');
    if(c) sw.style.background=c;
    if((clip.colorLabel||'')===c) sw.classList.add('active');
    sw.addEventListener('click', ()=>{
      clip.colorLabel=c;
      $$('.layer-color-swatch', colorRow2).forEach(x=>x.classList.remove('active'));
      sw.classList.add('active');
      Editor.renderTimeline(); pushUndoSnapshot();
    });
    colorRow2.appendChild(sw);
  });
  body.appendChild(colorRow2);

  const stackLabel=document.createElement('div'); stackLabel.className='muted'; stackLabel.style.margin='10px 2px 6px'; stackLabel.textContent='Urutan Tumpukan (dalam track ini)';
  body.appendChild(stackLabel);
  const stackRow=document.createElement('div'); stackRow.className='action-row';
  stackRow.innerHTML = `<button class="pill-btn ghost" id="bBringFwd">⬆ Ke Depan</button><button class="pill-btn ghost" id="bSendBack">⬇ Ke Belakang</button>`;
  body.appendChild(stackRow);
  stackRow.querySelector('#bBringFwd').addEventListener('click', ()=>{ reorderLayerInTrack(clip, 1); });
  stackRow.querySelector('#bSendBack').addEventListener('click', ()=>{ reorderLayerInTrack(clip, -1); });

  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML = `<button class="pill-btn ghost" id="bLayerDup">Duplikat</button><button class="pill-btn ghost" id="bLayerDel">Hapus</button>`;
  body.appendChild(actions);
  actions.querySelector('#bLayerDup').addEventListener('click', ()=> duplicateSelectedClip());
  actions.querySelector('#bLayerDel').addEventListener('click', ()=> deleteSelectedClip());
}
/* Moves a clip earlier/later within its own track's stacking order (and
   bumps its zIndex so cross-track blend ordering follows in a later phase). */
function reorderLayerInTrack(clip, dir){
  const track = getClipTrack(clip.id); if(!track) return;
  const idx = track.clips.findIndex(c=>c.id===clip.id);
  const swapIdx = idx+dir;
  if(swapIdx<0 || swapIdx>=track.clips.length) return;
  const other = track.clips[swapIdx];
  track.clips[idx]=other; track.clips[swapIdx]=clip;
  const z1=clip.zIndex, z2=other.zIndex; clip.zIndex=z2; other.zIndex=z1;
  Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
}

/* ---- Text style sub-panel ---- */
function buildTextStylePanel(clip){
  const s = clip.text.style;
  const wrap=document.createElement('div');
  const animRow=document.createElement('div'); animRow.className='panel-tabgroup';
  TEXT_ANIMS.forEach(a=>{ const b=document.createElement('button'); b.textContent=a; if(clip.text.anim===a) b.classList.add('active');
    b.addEventListener('click', ()=>{ clip.text.anim=a; $$('.panel-tabgroup button',animRow).forEach(x=>x.classList.remove('active')); b.classList.add('active'); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); animRow.appendChild(b); });
  wrap.appendChild(animRow);

  wrap.appendChild(sliderRow('Ukuran', s.size, 12, 140, 1, (v,c)=>{ s.size=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  wrap.appendChild(sliderRow('Letter spacing', s.letterSpacing, 0, 20, 1, (v,c)=>{ s.letterSpacing=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  wrap.appendChild(sliderRow('Line height', s.lineHeight, 0.8, 2.4, 0.05, (v,c)=>{ s.lineHeight=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));

  const toggles=[['Bold','bold'],['Italic','italic'],['Stroke','stroke'],['Shadow','shadow'],['Glow','glow'],['Gradient','gradient']];
  toggles.forEach(([label,key])=>{
    const row=document.createElement('div'); row.className='toggle-row';
    row.innerHTML=`<span>${label}</span><div class="switch ${s[key]?'on':''}"></div>`;
    row.querySelector('.switch').addEventListener('click', function(){ s[key]=!s[key]; this.classList.toggle('on'); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
    wrap.appendChild(row);
  });

  const alignRow=document.createElement('div'); alignRow.className='panel-tabgroup';
  ['left','center','right'].forEach(a=>{ const b=document.createElement('button'); b.textContent=a; if(s.align===a) b.classList.add('active');
    b.addEventListener('click', ()=>{ s.align=a; $$('.panel-tabgroup button',alignRow).forEach(x=>x.classList.remove('active')); b.classList.add('active'); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); alignRow.appendChild(b); });
  wrap.appendChild(alignRow);

  wrap.appendChild(colorRow(s.color, c=>{ s.color=c; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
  return wrap;
}

/* ---- Animation tab (keyframes) ---- */
function renderAnimationPanel(clip){
  $('#panelTitle').textContent='Animation';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('animation'));
  const propRow=document.createElement('div'); propRow.className='panel-tabgroup';
  let curProp = body._curProp || 'scale';
  KF_PROPS.forEach(p=>{ const b=document.createElement('button'); b.textContent=p; if(p===curProp) b.classList.add('active');
    b.addEventListener('click', ()=>{ body._curProp=p; renderAnimationPanel(clip); }); propRow.appendChild(b); });
  body.appendChild(propRow);

  const track=document.createElement('div'); track.className='keyframe-track';
  const dur=clip.duration||1;
  (clip.keyframes||[]).filter(k=>k.prop===curProp).forEach(k=>{
    const dot=document.createElement('div'); dot.className='keyframe-dot';
    dot.style.left = clamp((k.time/dur)*100,0,100)+'%';
    dot.addEventListener('click', ()=>{
      clip.keyframes = clip.keyframes.filter(x=>x!==k);
      renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    track.appendChild(dot);
  });
  const playheadMark=document.createElement('div'); playheadMark.style.cssText='position:absolute;top:-4px;bottom:-4px;width:2px;background:#fff;';
  playheadMark.style.left = clamp(((Editor.curTime-clip.start)/dur)*100,0,100)+'%';
  track.appendChild(playheadMark);
  body.appendChild(track);
  body.appendChild(mkHint('Ketuk keyframe untuk menghapus. Gunakan "Add Keyframe" untuk menambah di posisi playhead saat ini.'));

  const easeRow=document.createElement('div'); easeRow.className='panel-tabgroup';
  ['linear','easeIn','easeOut','easeInOut','cubic','back','elastic','bounce'].forEach(e=>{
    const b=document.createElement('button'); b.textContent=e;
    b.addEventListener('click', ()=>{ body._curEasing=e; $$('.panel-tabgroup button',easeRow).forEach(x=>x.classList.remove('active')); b.classList.add('active'); });
    if((body._curEasing||'linear')===e) b.classList.add('active');
    easeRow.appendChild(b);
  });
  body.appendChild(easeRow);

  const curVal = interpKeyframes(clip, clamp(Editor.curTime-clip.start,0,dur))[curProp];
  body.appendChild(sliderRow('Nilai di posisi ini', curVal, curProp==='rotation'?-180:(curProp==='opacity'?0:(curProp==='scale'?0.1:-500)), curProp==='rotation'?180:(curProp==='opacity'?1:(curProp==='scale'?3:500)), 0.01, ()=>{}));

  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML = `<button class="pill-btn accent" id="bAddKf">+ Add Keyframe</button>`;
  body.appendChild(actions);
  $('#bAddKf').addEventListener('click', ()=>{
    const localTime = clamp(Editor.curTime-clip.start,0,dur);
    const currentVal = interpKeyframes(clip, localTime)[curProp];
    clip.keyframes = clip.keyframes||[];
    clip.keyframes = clip.keyframes.filter(k=>!(k.prop===curProp && Math.abs(k.time-localTime)<0.05));
    clip.keyframes.push({prop:curProp, time:localTime, value: currentVal, easing: body._curEasing||'linear'});
    renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });
}
function mkHint(text){ const d=document.createElement('div'); d.className='muted small'; d.style.margin='6px 0 14px'; d.textContent=text; return d; }

/* ---- Effect tab ---- */
function renderEffectPanel(clip){
  $('#panelTitle').textContent='Effect';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('effect'));
  const catRow=document.createElement('div'); catRow.className='panel-tabgroup';
  const cats=Object.keys(EFFECT_CATEGORIES);
  let curCat = body._curCat || cats[0];
  cats.forEach(c=>{ const b=document.createElement('button'); b.textContent=c; if(c===curCat) b.classList.add('active');
    b.addEventListener('click', ()=>{ body._curCat=c; renderEffectPanel(clip); }); catRow.appendChild(b); });
  body.appendChild(catRow);

  const grid=document.createElement('div'); grid.className='preset-grid';
  EFFECT_CATEGORIES[curCat].forEach(([label,type])=>{
    const active = (clip.effects||[]).some(e=>e.type===type);
    const item=document.createElement('button'); item.className='preset-item'+(active?' active':''); item.textContent=label;
    item.addEventListener('click', ()=>{
      clip.effects = clip.effects||[];
      const idx = clip.effects.findIndex(e=>e.type===type);
      if(idx>=0){ clip.effects.splice(idx,1); } else { clip.effects.push({id:uid('fx'), category:curCat, type, label, params:{amount: defaultAmountFor(curCat)}}); }
      renderEffectPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    grid.appendChild(item);
  });
  body.appendChild(grid);

  const active = clip.effects||[];
  if(active.length){
    body.appendChild(mkHint('Effect aktif — atur intensitas:'));
    active.forEach(fx=>{
      const range = intensityRangeFor(fx.category);
      body.appendChild(sliderRow(fx.label+' intensity', fx.params.amount, range.min, range.max, range.step, (v,commit)=>{
        fx.params.amount=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot();
      }));
    });
    const actions=document.createElement('div'); actions.className='action-row';
    actions.innerHTML = `<button class="pill-btn ghost" id="bSavePreset">Save as Preset</button>`;
    body.appendChild(actions);
    $('#bSavePreset').addEventListener('click', saveCurrentPreset);
  }
}
function defaultAmountFor(cat){
  if(cat==='Beat'||cat==='Zoom') return 0.3;
  if(cat==='Shake') return 12;
  if(cat==='Motion'||cat==='Blur') return 8;
  if(cat==='Glitch') return 0.5;
  if(cat==='Flash') return 0.7;
  if(cat==='Distortion') return 20;
  if(cat==='Color') return 20;
  if(cat==='Light') return 0.5;
  if(cat==='Color Grade') return 30;
  if(cat==='Blur FX') return 30;
  if(cat==='Warp & Distort') return 30;
  if(cat==='Procedural') return 40;
  if(cat==='Transform') return 20;
  if(cat==='Key & Matte') return 40;
  return 1;
}
function intensityRangeFor(cat){
  if(cat==='Beat'||cat==='Zoom') return {min:0,max:1,step:0.01};
  if(cat==='Shake') return {min:0,max:40,step:1};
  if(cat==='Motion'||cat==='Blur') return {min:0,max:30,step:1};
  if(cat==='Glitch') return {min:0,max:1,step:0.01};
  if(cat==='Flash') return {min:0,max:1,step:0.01};
  if(cat==='Distortion') return {min:0,max:60,step:1};
  if(cat==='Color') return {min:-100,max:100,step:1};
  if(cat==='Light') return {min:0,max:1,step:0.01};
  if(cat==='Color Grade') return {min:-100,max:100,step:1};
  if(cat==='Blur FX') return {min:0,max:100,step:1};
  if(cat==='Warp & Distort') return {min:0,max:100,step:1};
  if(cat==='Procedural') return {min:0,max:100,step:1};
  if(cat==='Transform') return {min:0,max:100,step:1};
  if(cat==='Key & Matte') return {min:0,max:100,step:1};
  return {min:0,max:100,step:1};
}
function saveCurrentPreset(){
  const clip=getSelectedClip(); if(!clip) return;
  const name = prompt('Nama preset:', 'My Preset');
  if(!name) return;
  App.project.presets.push({ id:uid('preset'), name, effects: deepClone(clip.effects) });
  toast('Preset disimpan'); pushUndoSnapshot();
}

/* ---- Adjust tab ---- */
function renderAdjustPanel(clip){
  $('#panelTitle').textContent='Adjustment';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('adjust'));
  clip.adjust = clip.adjust||{};
  const labels = {brightness:'Brightness',contrast:'Contrast',saturationFx:'Saturation',exposureFx:'Exposure',temperature:'Temperature',tint:'Tint',hueFx:'Hue',highlights:'Highlights',shadows:'Shadows',sharpenFx:'Sharpen',fadeFx:'Fade',vignetteFx:'Vignette',grainFx:'Grain'};
  ADJUST_KEYS.forEach(([label,key])=>{
    const v = clip.adjust[key]||0;
    body.appendChild(sliderRow(label, v, -100, 100, 1, (val,commit)=>{ clip.adjust[key]=val; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot(); }));
  });
  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML=`<button class="pill-btn ghost" id="bResetAdjust">Reset</button>`;
  body.appendChild(actions);
  $('#bResetAdjust').addEventListener('click', ()=>{ clip.adjust={}; renderAdjustPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
}

/* ---- Speed tab ---- */
function renderSpeedPanel(clip){
  $('#panelTitle').textContent='Speed';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('speed'));
  const speeds=[0.25,0.5,0.75,1,1.5,2,3,4];
  const grid=document.createElement('div'); grid.className='speed-grid';
  speeds.forEach(sp=>{
    const b=document.createElement('button'); b.className='speed-opt'+(clip.speed===sp?' active':''); b.textContent=sp+'x';
    b.addEventListener('click', ()=>{ applySpeed(clip, sp); renderSpeedPanel(clip); pushUndoSnapshot(); });
    grid.appendChild(b);
  });
  body.appendChild(grid);
  body.appendChild(sliderRow('Custom speed', clip.speed||1, 0.1, 4, 0.05, (v,commit)=>{ if(commit){ applySpeed(clip,v); pushUndoSnapshot(); } }));

  const presetRow=document.createElement('div'); presetRow.className='preset-grid';
  [['Normal',1],['Fast',2],['Slow',0.5],['Fast-Slow','ramp-fs'],['Slow-Fast','ramp-sf'],['Beat Velocity','beat'],['Impact Velocity','impact']].forEach(([label,val])=>{
    const b=document.createElement('button'); b.className='preset-item'; b.textContent=label;
    b.addEventListener('click', ()=>{
      if(typeof val==='number'){ clip.speedRamp=null; applySpeed(clip,val); }
      else if(val==='ramp-fs'){ clip.speedRamp={from:2,to:0.5}; }
      else if(val==='ramp-sf'){ clip.speedRamp={from:0.5,to:2}; }
      else { clip.speedRamp={from:1,to:1}; toast(label+' aktif (mengikuti beat marker)'); clip.velocityBeatSync=true; }
      renderSpeedPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    presetRow.appendChild(b);
  });
  body.appendChild(mkHint('Preset ramp mengubah kecepatan secara bertahap sepanjang clip.'));
  body.appendChild(presetRow);
}
function applySpeed(clip, newSpeed){
  const span = (clip.trimEnd!==undefined? clip.trimEnd-clip.trimStart : clip.duration*(clip.speed||1));
  clip.speed = newSpeed;
  if(clip.type==='video'||clip.type==='audio'){ clip.duration = Math.max(0.1, span/newSpeed); }
  computeProjectDuration(); Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
}

/* ---- Mask tab ---- */
function renderMaskPanel(clip){
  $('#panelTitle').textContent='Mask';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('mask'));
  const toggle=document.createElement('div'); toggle.className='toggle-row';
  toggle.innerHTML=`<span>Aktifkan Mask</span><div class="switch ${clip.mask?'on':''}"></div>`;
  toggle.querySelector('.switch').addEventListener('click', function(){
    if(clip.mask){ clip.mask=null; } else { clip.mask={shape:'Circle',x:0,y:0,scale:1,width:70,height:70,feather:12,opacity:1,pos:0.5}; }
    this.classList.toggle('on'); renderMaskPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });
  body.appendChild(toggle);
  if(!clip.mask) return;
  const shapeRow=document.createElement('div'); shapeRow.className='panel-tabgroup';
  MASK_SHAPES.forEach(s=>{ const b=document.createElement('button'); b.textContent=s; if(clip.mask.shape===s) b.classList.add('active');
    b.addEventListener('click', ()=>{ clip.mask.shape=s; $$('.panel-tabgroup button',shapeRow).forEach(x=>x.classList.remove('active')); b.classList.add('active'); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); shapeRow.appendChild(b); });
  body.appendChild(shapeRow);
  body.appendChild(sliderRow('Feather', clip.mask.feather, 0, 60, 1, (v,c)=>{ clip.mask.feather=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Opacity', clip.mask.opacity, 0, 1, 0.01, (v,c)=>{ clip.mask.opacity=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Position X', clip.mask.x, -600, 600, 1, (v,c)=>{ clip.mask.x=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Position Y', clip.mask.y, -600, 600, 1, (v,c)=>{ clip.mask.y=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Scale', clip.mask.scale, 0.1, 2.5, 0.01, (v,c)=>{ clip.mask.scale=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Width %', clip.mask.width, 5, 100, 1, (v,c)=>{ clip.mask.width=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Height %', clip.mask.height, 5, 100, 1, (v,c)=>{ clip.mask.height=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
}

/* ---- Transition tab ---- */
function renderTransitionPanel(clip){
  $('#panelTitle').textContent='Transition (setelah clip ini)';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('transition'));
  clip.transitionOut = clip.transitionOut || {type:'Cut', duration:0.4, intensity:1, direction:'left', easing:'easeInOut'};
  const grid=document.createElement('div'); grid.className='preset-grid';
  TRANSITIONS.forEach(t=>{
    const b=document.createElement('button'); b.className='preset-item'+(clip.transitionOut.type===t?' active':''); b.textContent=t;
    b.addEventListener('click', ()=>{ clip.transitionOut.type=t; renderTransitionPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
    grid.appendChild(b);
  });
  body.appendChild(grid);
  body.appendChild(sliderRow('Duration (s)', clip.transitionOut.duration, 0.1, 2, 0.05, (v,c)=>{ clip.transitionOut.duration=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Intensity', clip.transitionOut.intensity, 0, 2, 0.05, (v,c)=>{ clip.transitionOut.intensity=v; if(c) pushUndoSnapshot(); }));
  const easeRow=document.createElement('div'); easeRow.className='panel-tabgroup';
  ['linear','easeIn','easeOut','easeInOut','back','elastic','bounce'].forEach(e=>{
    const b=document.createElement('button'); b.textContent=e; if(clip.transitionOut.easing===e) b.classList.add('active');
    b.addEventListener('click', ()=>{ clip.transitionOut.easing=e; $$('.panel-tabgroup button',easeRow).forEach(x=>x.classList.remove('active')); b.classList.add('active'); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
    easeRow.appendChild(b);
  });
  body.appendChild(easeRow);
}

/* ---- Overlay clip panel ---- */
function openOverlayPanel(clip){
  $('#panelTitle').textContent='Overlay';
  const body=$('#panelBody'); body.innerHTML='';
  const grid=document.createElement('div'); grid.className='preset-grid';
  OVERLAY_TYPES.forEach(t=>{
    const b=document.createElement('button'); b.className='preset-item'+(clip.overlayType===t?' active':''); b.textContent=t;
    b.addEventListener('click', ()=>{ clip.overlayType=t; $$('.preset-item',grid).forEach(x=>x.classList.remove('active')); b.classList.add('active'); Editor.renderFrame(Editor.curTime); Editor.renderTimeline(); pushUndoSnapshot(); });
    grid.appendChild(b);
  });
  body.appendChild(grid);
  body.appendChild(sliderRow('Intensity', clip.intensity!==undefined?clip.intensity:0.6, 0, 1, 0.01, (v,c)=>{ clip.intensity=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML=`<button class="pill-btn ghost" id="bDelOverlay">Hapus Overlay</button>`;
  body.appendChild(actions);
  $('#bDelOverlay').addEventListener('click', ()=>{ deleteSelectedClip(); });
  openSheet('#sheetPanel');
}

/* ============================================================
   Beat panel
   ============================================================ */
function openBeatPanel(){
  $('#panelTitle').textContent='Beat & Audio';
  const body=$('#panelBody'); body.innerHTML='';
  const audioTrack = App.project.tracks.find(t=>t.kind==='audio');
  if(!audioTrack.clips.length){
    body.appendChild(mkHint('Belum ada audio. Import audio dulu lewat menu + > Audio.'));
    openSheet('#sheetPanel'); return;
  }
  const bpmRow=document.createElement('div'); bpmRow.className='list-row';
  bpmRow.innerHTML = `<span>BPM Terdeteksi</span><span class="val">${App.project.bpm||'-'}</span>`;
  body.appendChild(bpmRow);
  const markerRow=document.createElement('div'); markerRow.className='list-row';
  markerRow.innerHTML = `<span>Jumlah Beat Marker</span><span class="val">${App.project.beatMarkers.length}</span>`;
  body.appendChild(markerRow);

  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML = `<button class="pill-btn accent" id="bAutoBeat">Auto Beat</button><button class="pill-btn ghost" id="bAddBeat">+ Marker di sini</button>`;
  body.appendChild(actions);
  const actions2=document.createElement('div'); actions2.className='action-row'; actions2.style.marginTop='8px';
  actions2.innerHTML = `<button class="pill-btn ghost" id="bClearBeat">Hapus Semua Marker</button>`;
  body.appendChild(actions2);

  $('#bAutoBeat').addEventListener('click', ()=> runAutoBeat(audioTrack));
  $('#bAddBeat').addEventListener('click', ()=>{ App.project.beatMarkers.push(Editor.curTime); App.project.beatMarkers.sort((a,b)=>a-b); Editor.renderTimeline(); openBeatPanel(); pushUndoSnapshot(); });
  $('#bClearBeat').addEventListener('click', ()=>{ App.project.beatMarkers=[]; Editor.renderTimeline(); openBeatPanel(); pushUndoSnapshot(); });

  openSheet('#sheetPanel');
}
async function runAutoBeat(audioTrack){
  const clip = audioTrack.clips[0];
  const media = App.mediaCache[clip.mediaId];
  if(!media || !media.buffer){ toast('Audio belum siap dianalisis'); return; }
  toast('Menganalisis beat...');
  await new Promise(r=>setTimeout(r,30));
  const {beats, bpm} = detectBeats(media.buffer);
  App.project.beatMarkers = beats.map(b=>b+clip.start).filter(t=>t<=App.project.duration+0.001);
  App.project.bpm = bpm;
  Editor.renderTimeline();
  openBeatPanel();
  toast(`Beat terdeteksi: ${App.project.beatMarkers.length} marker, ~${bpm} BPM`);
  pushUndoSnapshot();
}
function detectBeats(buffer){
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const hop = Math.floor(sr*0.02);
  const energies=[];
  for(let i=0;i<data.length;i+=hop){
    let sum=0; const end=Math.min(data.length,i+hop);
    for(let j=i;j<end;j++){ sum += data[j]*data[j]; }
    energies.push(sum/(end-i));
  }
  const beats=[]; const lookback=43; let lastIdx=-999;
  for(let i=0;i<energies.length;i++){
    const start=Math.max(0,i-lookback);
    let avg=0; for(let k=start;k<i;k++) avg+=energies[k];
    avg /= Math.max(1,i-start);
    const threshold = avg*1.35 + 0.00002;
    if(energies[i]>threshold && energies[i]>0.00006 && (i-lastIdx)>10){
      beats.push(i*hop/sr); lastIdx=i;
    }
  }
  let bpm=0;
  if(beats.length>2){
    const intervals=[]; for(let i=1;i<beats.length;i++) intervals.push(beats[i]-beats[i-1]);
    intervals.sort((a,b)=>a-b);
    let median = intervals[Math.floor(intervals.length/2)];
    if(median>0){ bpm=60/median; while(bpm<70) bpm*=2; while(bpm>185) bpm/=2; bpm=Math.round(bpm); }
  }
  return {beats,bpm};
}

/* ============================================================
   Split / transport controls
   ============================================================ */
$('#btnSplit').addEventListener('click', ()=>{
  const clip = getSelectedClip();
  if(!clip){ toast('Pilih clip yang ingin dipotong'); return; }
  const t = Editor.curTime;
  if(t<=clip.start+0.05 || t>=clip.start+clip.duration-0.05){ toast('Playhead harus berada di tengah clip'); return; }
  const track = getClipTrack(clip.id);
  const rightPart = deepClone(clip);
  rightPart.id = uid('clip');
  const splitLocal = t-clip.start;
  rightPart.start = t;
  rightPart.duration = clip.duration - splitLocal;
  if(clip.trimStart!==undefined) rightPart.trimStart = clip.trimStart + splitLocal*(clip.speed||1);
  clip.duration = splitLocal;
  if(clip.keyframes){ clip.keyframes = clip.keyframes.filter(k=>k.time<=splitLocal); rightPart.keyframes = rightPart.keyframes.filter(k=>k.time>=splitLocal).map(k=>({...k,time:k.time-splitLocal})); }
  track.clips.push(rightPart);
  Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
  toast('Clip dipotong');
  pushUndoSnapshot();
});
$('#btnPlayPause').addEventListener('click', ()=> Editor.togglePlay());
initPreviewTools();
$('#btnZoomIn').addEventListener('click', ()=>{ App.zoomPxPerSec=clamp(App.zoomPxPerSec*1.4,20,400); Editor.renderTimeline(); });
$('#btnZoomOut').addEventListener('click', ()=>{ App.zoomPxPerSec=clamp(App.zoomPxPerSec/1.4,20,400); Editor.renderTimeline(); });
$('#btnUndo').addEventListener('click', doUndo);
$('#btnRedo').addEventListener('click', doRedo);
$('#btnFullscreen').addEventListener('click', ()=>{
  const el = $('#previewWrap');
  if(!document.fullscreenElement){ el.requestFullscreen && el.requestFullscreen().catch(()=>{}); }
  else { document.exitFullscreen && document.exitFullscreen(); }
});
$('#projectNameInput').addEventListener('change', ()=>{ App.project.name = $('#projectNameInput').value||'New Project'; persistCurrentProject(); });
$('#btnEditorBack').addEventListener('click', ()=>{ Editor.pause(); persistCurrentProject(); showPage('home'); });

/* ============================================================
   Home / New project modal
   ============================================================ */
let chosenRatio='9:16';
$('#btnCreateProject').addEventListener('click', ()=> $('#modalNewProject').classList.add('show'));
$('#navCreate').addEventListener('click', ()=> $('#modalNewProject').classList.add('show'));
$('#btnCancelNewProject').addEventListener('click', ()=> $('#modalNewProject').classList.remove('show'));
$$('.ratio-opt').forEach(b=> b.addEventListener('click', ()=>{ $$('.ratio-opt').forEach(x=>x.classList.remove('active')); b.classList.add('active'); chosenRatio=b.dataset.ratio; }));
$('#btnConfirmNewProject').addEventListener('click', async ()=>{
  $('#modalNewProject').classList.remove('show');
  const data = newProjectData('New Project', chosenRatio);
  App.project = data;
  App.mediaCache = {};
  persistCurrentProject();
  showPage('editor');
  Editor.load();
});
$$('.nav-item[data-page]').forEach(b=> b.addEventListener('click', ()=> showPage(b.dataset.page)));
$('#btnViewAll').addEventListener('click', ()=> showPage('projects'));
$('#btnMenu').addEventListener('click', ()=> showPage('templates'));

/* Editor settings: rename / save as template / export template / import template */
$('#btnEditorSettings').addEventListener('click', ()=>{
  $('#panelTitle').textContent='Settings';
  const body=$('#panelBody'); body.innerHTML='';
  const rows = [
    ['Rename project', ()=>{ const n=prompt('Nama project baru', App.project.name); if(n){ App.project.name=n; $('#projectNameInput').value=n; persistCurrentProject(); } }],
    ['Simpan sebagai Template', ()=> saveAsTemplate()],
    ['Export Template (.jedag.xml)', ()=> exportTemplateXml()],
    ['Import Template (.jedag.xml)', ()=> $('#fileInputXml').click()],
    ['Hapus Project', ()=>{ if(confirm('Hapus project ini?')){ lsDeleteProject(App.project.id); closeSheet('#sheetPanel'); showPage('home'); } }],
  ];
  rows.forEach(([label,fn])=>{
    const r=document.createElement('button'); r.className='list-row'; r.style.width='100%'; r.style.textAlign='left';
    r.innerHTML=`<span>${label}</span><span>›</span>`;
    r.addEventListener('click', ()=>{ closeSheet('#sheetPanel'); fn(); });
    body.appendChild(r);
  });
  openSheet('#sheetPanel');
});
function saveAsTemplate(){
  const list = lsGetProjects();
  const rec = list.find(p=>p.id===App.project.id);
  if(rec){
    rec.isTemplate = true;
    rec.data = deepClone(App.project);
    rec.updatedAt = Date.now();
    lsUpsertProject(rec);
    toast('Disimpan sebagai template');
  } else {
    toast('Simpan project dulu sebelum dijadikan template');
  }
}

/* ============================================================
   XML export / import
   ============================================================ */
function xmlEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function attrs(obj){ return Object.entries(obj).map(([k,v])=> v===undefined||v===null? '' : ` ${k}="${xmlEsc(v)}"`).join(''); }

function buildProjectXml(project){
  const [w,h]=ratioWH(project.ratio);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<jedagProject version="1.0">\n`;
  xml += `  <meta name="${xmlEsc(project.name)}" createdAt="${project.createdAt}"/>\n`;
  xml += `  <canvas ratio="${project.ratio}" width="${w}" height="${h}" fps="${project.fps}"/>\n`;
  xml += `  <duration seconds="${project.duration.toFixed(3)}"/>\n`;
  xml += `  <audio bpm="${project.bpm||0}">\n    <beatMarkers>\n`;
  project.beatMarkers.forEach(b=> xml += `      <marker t="${b.toFixed(3)}"/>\n`);
  xml += `    </beatMarkers>\n  </audio>\n`;
  xml += `  <mediaLibrary>\n`;
  project.mediaLibrary.forEach(m=>{
    xml += `    <media${attrs({id:m.id, kind:m.kind, name:m.name, duration:(m.duration||0).toFixed(3), width:m.width||0, height:m.height||0})}/>\n`;
  });
  xml += `  </mediaLibrary>\n  <tracks>\n`;
  project.tracks.forEach(track=>{
    xml += `    <track${attrs({id:track.id, kind:track.kind})}>\n`;
    track.clips.forEach(clip=>{
      xml += `      <clip${attrs({id:clip.id, type:clip.type, mediaRef:clip.mediaId, start:clip.start.toFixed(3), duration:clip.duration.toFixed(3), trimStart:clip.trimStart, trimEnd:clip.trimEnd, speed:clip.speed, fit:clip.fit, overlayType:clip.overlayType, intensity:clip.intensity, shapeType:clip.shapeType, color:clip.color, sticker:clip.sticker})}>\n`;
      if(clip.baseTransform) xml += `        <baseTransform${attrs(clip.baseTransform)}/>\n`;
      if(clip.keyframes && clip.keyframes.length){
        xml += `        <keyframes>\n`;
        clip.keyframes.forEach(k=> xml += `          <kf${attrs({prop:k.prop, time:k.time.toFixed(3), value:k.value, easing:k.easing})}/>\n`);
        xml += `        </keyframes>\n`;
      }
      if(clip.effects && clip.effects.length){
        xml += `        <effects>\n`;
        clip.effects.forEach(e=> xml += `          <effect${attrs({type:e.type, category:e.category, label:e.label, amount:e.params?e.params.amount:undefined})}/>\n`);
        xml += `        </effects>\n`;
      }
      if(clip.adjust && Object.keys(clip.adjust).length) xml += `        <adjust${attrs(clip.adjust)}/>\n`;
      if(clip.mask) xml += `        <mask${attrs(clip.mask)}/>\n`;
      if(clip.transitionOut) xml += `        <transitionOut${attrs(clip.transitionOut)}/>\n`;
      if(clip.text) xml += `        <text${attrs(Object.assign({content:clip.text.text, anim:clip.text.anim}, clip.text.style))}/>\n`;
      xml += `      </clip>\n`;
    });
    xml += `    </track>\n`;
  });
  xml += `  </tracks>\n  <presets>\n`;
  (project.presets||[]).forEach(p=>{
    xml += `    <preset${attrs({id:p.id, name:p.name})}>\n`;
    (p.effects||[]).forEach(e=> xml += `      <effect${attrs({type:e.type, amount:e.params?e.params.amount:undefined})}/>\n`);
    xml += `    </preset>\n`;
  });
  xml += `  </presets>\n</jedagProject>\n`;
  return xml;
}
function exportTemplateXml(){
  computeProjectDuration();
  const xml = buildProjectXml(App.project);
  const blob = new Blob([xml], {type:'application/xml'});
  downloadBlob(blob, sanitizeFileName(App.project.name)+'.jedag.xml');
  toast('Template XML diexport');
}
function sanitizeFileName(name){ return (name||'project').replace(/[^a-z0-9\-_]+/gi,'_'); }
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}
$('#btnImportXmlHome').addEventListener('click', ()=> $('#fileInputXml').click());
$('#fileInputXml').addEventListener('change', async e=>{
  const file = e.target.files[0]; if(!file) return;
  const text = await file.text();
  try{ parseAndOpenXmlTemplate(text); }catch(err){ console.error(err); toast('XML tidak valid'); }
  e.target.value='';
});
let pendingImport = null;
function parseAndOpenXmlTemplate(xmlText){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const root = doc.querySelector('jedagProject');
  if(!root){ toast('File bukan template Jedag Studio yang valid'); return; }
  const version = root.getAttribute('version');
  if(!version){ toast('Versi XML tidak dikenali'); return; }
  const meta = doc.querySelector('meta');
  const canvasEl = doc.querySelector('canvas');
  const durEl = doc.querySelector('duration');
  const audioEl = doc.querySelector('audio');
  const project = newProjectData(meta?meta.getAttribute('name'):'Imported Project', canvasEl?canvasEl.getAttribute('ratio'):'9:16');
  project.fps = canvasEl? parseInt(canvasEl.getAttribute('fps'))||60 : 60;
  project.duration = durEl? parseFloat(durEl.getAttribute('seconds'))||0 : 0;
  project.bpm = audioEl? parseFloat(audioEl.getAttribute('bpm'))||0 : 0;
  project.beatMarkers = Array.from(doc.querySelectorAll('audio marker')).map(m=>parseFloat(m.getAttribute('t')));

  const mediaMap = {}; // placeholderId -> {kind,name,duration,width,height,file:null,newId:null}
  doc.querySelectorAll('mediaLibrary media').forEach(m=>{
    mediaMap[m.getAttribute('id')] = { kind:m.getAttribute('kind'), name:m.getAttribute('name'), duration:parseFloat(m.getAttribute('duration'))||3, width:parseInt(m.getAttribute('width'))||1080, height:parseInt(m.getAttribute('height'))||1920, file:null };
  });

  project.tracks = [];
  doc.querySelectorAll('tracks > track').forEach(trackEl=>{
    const track = { id: uid('trk'), kind: trackEl.getAttribute('kind'), clips: [] };
    trackEl.querySelectorAll('clip').forEach(clipEl=>{
      const clip = {
        id: uid('clip'), type: clipEl.getAttribute('type'), mediaId: clipEl.getAttribute('mediaRef')||null,
        start: parseFloat(clipEl.getAttribute('start'))||0, duration: parseFloat(clipEl.getAttribute('duration'))||1,
        trimStart: numAttr(clipEl,'trimStart'), trimEnd: numAttr(clipEl,'trimEnd'), speed: numAttr(clipEl,'speed',1),
        fit: clipEl.getAttribute('fit')||'fill', overlayType: clipEl.getAttribute('overlayType')||undefined,
        intensity: numAttr(clipEl,'intensity'), shapeType: clipEl.getAttribute('shapeType')||undefined,
        color: clipEl.getAttribute('color')||undefined, sticker: clipEl.getAttribute('sticker')||undefined,
        effects: [], keyframes: [], adjust:{}, mask:null, transitionOut:null,
      };
      const bt = clipEl.querySelector('baseTransform');
      if(bt) clip.baseTransform = { x:numAttr(bt,'x',0), y:numAttr(bt,'y',0), scale:numAttr(bt,'scale',1), rotation:numAttr(bt,'rotation',0), opacity:numAttr(bt,'opacity',1), width:numAttr(bt,'width',100), height:numAttr(bt,'height',100) };
      clipEl.querySelectorAll('keyframes kf').forEach(k=> clip.keyframes.push({prop:k.getAttribute('prop'), time:parseFloat(k.getAttribute('time'))||0, value:parseFloat(k.getAttribute('value'))||0, easing:k.getAttribute('easing')||'linear'}));
      clipEl.querySelectorAll('effects effect').forEach(e=> clip.effects.push({id:uid('fx'), category:e.getAttribute('category'), type:e.getAttribute('type'), label:e.getAttribute('label'), params:{amount:parseFloat(e.getAttribute('amount'))||0}}));
      const adjEl = clipEl.querySelector('adjust');
      if(adjEl) ADJUST_KEYS.forEach(([l,key])=>{ const v=adjEl.getAttribute(key); if(v!==null) clip.adjust[key]=parseFloat(v); });
      const maskEl = clipEl.querySelector('mask');
      if(maskEl) clip.mask = { shape:maskEl.getAttribute('shape'), x:numAttr(maskEl,'x',0), y:numAttr(maskEl,'y',0), scale:numAttr(maskEl,'scale',1), width:numAttr(maskEl,'width',70), height:numAttr(maskEl,'height',70), feather:numAttr(maskEl,'feather',10), opacity:numAttr(maskEl,'opacity',1), pos:numAttr(maskEl,'pos',0.5) };
      const trEl = clipEl.querySelector('transitionOut');
      if(trEl) clip.transitionOut = { type:trEl.getAttribute('type'), duration:numAttr(trEl,'duration',0.4), intensity:numAttr(trEl,'intensity',1), direction:trEl.getAttribute('direction'), easing:trEl.getAttribute('easing')||'easeInOut' };
      const textEl = clipEl.querySelector('text');
      if(textEl){
        clip.text = { text: textEl.getAttribute('content')||'', anim: textEl.getAttribute('anim')||'None', style: {
          font: textEl.getAttribute('font')||"'Inter',sans-serif", size:numAttr(textEl,'size',48), bold: textEl.getAttribute('bold')==='true', italic: textEl.getAttribute('italic')==='true',
          align: textEl.getAttribute('align')||'center', color: textEl.getAttribute('color')||'#fff', gradient: textEl.getAttribute('gradient')==='true', color2: textEl.getAttribute('color2')||'#16E8A6',
          stroke: textEl.getAttribute('stroke')==='true', strokeColor: textEl.getAttribute('strokeColor')||'#000', strokeWidth:numAttr(textEl,'strokeWidth',3),
          shadow: textEl.getAttribute('shadow')==='true', glow: textEl.getAttribute('glow')==='true', letterSpacing:numAttr(textEl,'letterSpacing',0), lineHeight:numAttr(textEl,'lineHeight',1.2),
          x:numAttr(textEl,'x',0), y:numAttr(textEl,'y',0), rotation:numAttr(textEl,'rotation',0), opacity:numAttr(textEl,'opacity',1),
        }};
      }
      track.clips.push(clip);
    });
    project.tracks.push(track);
  });
  doc.querySelectorAll('presets > preset').forEach(p=>{
    const preset={id:uid('preset'), name:p.getAttribute('name'), effects:[]};
    p.querySelectorAll('effect').forEach(e=> preset.effects.push({type:e.getAttribute('type'), params:{amount:parseFloat(e.getAttribute('amount'))||0}}));
    project.presets.push(preset);
  });

  pendingImport = { project, mediaMap };
  if(Object.keys(mediaMap).length===0){ finalizeImport(); return; }
  showMediaMapModal(mediaMap);
}
function numAttr(el,name,def){ const v=el.getAttribute(name); return v===null||v===''?def:parseFloat(v); }

function showMediaMapModal(mediaMap){
  const list=$('#mediaMapList'); list.innerHTML='';
  Object.entries(mediaMap).forEach(([id,m])=>{
    const row=document.createElement('div'); row.className='media-map-row'; row.dataset.mid=id;
    row.innerHTML = `<div class="mm-thumb"></div><div class="mm-info"><b>${id}</b><br><span class="muted">${escapeHtml(m.name||m.kind)} · ${m.kind}</span></div><button class="mm-choose">CHOOSE</button>`;
    row.querySelector('.mm-choose').addEventListener('click', ()=>{
      const input=document.createElement('input'); input.type='file';
      input.accept = m.kind==='video'?'video/*': m.kind==='image'?'image/*':'audio/*';
      input.onchange = ()=>{ if(input.files[0]){ m.file=input.files[0]; row.classList.add('filled'); row.querySelector('.mm-choose').textContent='✓ DIPILIH'; } };
      input.click();
    });
    list.appendChild(row);
  });
  $('#modalImportMap').classList.add('show');
}
$('#btnAutoFillMedia').addEventListener('click', ()=>{
  const input=document.createElement('input'); input.type='file'; input.multiple=true; input.accept='video/*,image/*,audio/*';
  input.onchange=()=>{
    const files=Array.from(input.files);
    const ids=Object.keys(pendingImport.mediaMap);
    ids.forEach((id,i)=>{ if(files[i]){ pendingImport.mediaMap[id].file=files[i]; } });
    showMediaMapModal(pendingImport.mediaMap);
  };
  input.click();
});
$('#btnConfirmImportMap').addEventListener('click', ()=> finalizeImport());
async function finalizeImport(){
  $('#modalImportMap').classList.remove('show');
  const {project, mediaMap} = pendingImport||{project:null,mediaMap:{}};
  if(!project) return;
  const idRemap = {};
  for(const [placeholderId, m] of Object.entries(mediaMap)){
    if(!m.file) continue;
    const newId = uid('MED');
    idRemap[placeholderId]=newId;
    const url = URL.createObjectURL(m.file);
    await idbPutMedia({id:newId, blob:m.file});
    project.mediaLibrary.push({id:newId, kind:m.kind, name:m.name, duration:m.duration, width:m.width, height:m.height});
  }
  project.tracks.forEach(tr=> tr.clips.forEach(c=>{ if(c.mediaId && idRemap[c.mediaId]) c.mediaId = idRemap[c.mediaId]; }));
  App.project = project;
  await hydrateMediaCache(App.project);
  persistCurrentProject();
  showPage('editor');
  Editor.load();
  toast('Project dibuat dari template');
  pendingImport=null;
}
$('#btnCancelImportMap').addEventListener('click', ()=>{ $('#modalImportMap').classList.remove('show'); pendingImport=null; });

/* ============================================================
   Export video
   ============================================================ */
$('#btnExport').addEventListener('click', ()=>{
  if(!App.project.duration){ toast('Timeline kosong'); return; }
  updateExportFormatNote();
  $('#modalExport').classList.add('show');
});
$('#btnCancelExport').addEventListener('click', ()=> $('#modalExport').classList.remove('show'));
$$('#segRes .seg-opt').forEach(b=> b.addEventListener('click', ()=>{ $$('#segRes .seg-opt').forEach(x=>x.classList.remove('active')); b.classList.add('active'); }));
$$('#segFps .seg-opt').forEach(b=> b.addEventListener('click', ()=>{ $$('#segFps .seg-opt').forEach(x=>x.classList.remove('active')); b.classList.add('active'); }));

function pickMimeType(){
  const candidates = ['video/mp4;codecs=avc1.42E01E','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  for(const c of candidates){ if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c; }
  return 'video/webm';
}
function updateExportFormatNote(){
  const mt = pickMimeType();
  $('#exportFormatNote').textContent = mt.includes('mp4') ? 'Format output: MP4' : 'Format output: WebM (MP4 tidak didukung browser ini)';
}
$('#btnStartExport').addEventListener('click', startExport);

async function startExport(){
  const res = parseInt($('#segRes .seg-opt.active').dataset.res);
  const fps = parseInt($('#segFps .seg-opt.active').dataset.fps);
  const [bw,bh] = ratioWH(App.project.ratio);
  const longEdge = res;
  const scale = longEdge/Math.max(bw,bh);
  let ew = Math.round(bw*scale/2)*2, eh = Math.round(bh*scale/2)*2;

  const mimeType = pickMimeType();
  const exportCanvas = document.createElement('canvas'); exportCanvas.width=ew; exportCanvas.height=eh;
  const exportCtx = exportCanvas.getContext('2d');

  ensureAudioCtx();
  const audioDest = App.audioCtx.createMediaStreamDestination();

  const canvasStream = exportCanvas.captureStream(fps);
  const combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]);
  let recorder;
  try{ recorder = new MediaRecorder(combined, {mimeType, videoBitsPerSecond: res>=1080?10_000_000:6_000_000}); }
  catch(e){ recorder = new MediaRecorder(combined); }
  const chunks=[];
  recorder.ondataavailable = e=>{ if(e.data && e.data.size) chunks.push(e.data); };

  $('#exportProgress').classList.remove('hidden');
  $('#btnStartExport').disabled = true;

  Editor.pause();
  Editor.exportMode = true;
  const duration = App.project.duration;
  const startT = performance.now();

  recorder.start(250);
  scheduleAudioPlayback(0, audioDest);

  function exportFrame(){
    const elapsed = (performance.now()-startT)/1000;
    const t = Math.min(duration, elapsed);
    renderFrameToCanvas(exportCtx, ew, eh, t);
    const pct = Math.min(100, Math.round((t/duration)*100));
    $('#exportProgressFill').style.width = pct+'%';
    $('#exportProgressLabel').textContent = `Merender... ${pct}%`;
    if(elapsed<duration){
      requestAnimationFrame(exportFrame);
    } else {
      setTimeout(()=>{
        recorder.stop();
      }, 200);
    }
  }
  recorder.onstop = ()=>{
    stopAudioPlayback();
    Editor.exportMode=false;
    const blob = new Blob(chunks, {type:mimeType});
    downloadBlob(blob, sanitizeFileName(App.project.name)+(mimeType.includes('mp4')?'.mp4':'.webm'));
    $('#exportProgress').classList.add('hidden');
    $('#btnStartExport').disabled=false;
    $('#modalExport').classList.remove('show');
    toast('Export selesai, file diunduh');
    Editor.renderFrame(Editor.curTime);
  };
  requestAnimationFrame(exportFrame);
}
function renderFrameToCanvas(ctx, W, H, t){
  ctx.save();
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
  const order=['video','overlay','text'];
  order.forEach(kind=>{
    App.project.tracks.filter(tr=>tr.kind===kind).forEach(track=>{
      track.clips.forEach(c=>{
        if(t>=c.start && t<c.start+c.duration){
          if(c.type==='video' && App.mediaCache[c.mediaId]) syncVideoElement(App.mediaCache[c.mediaId].el, c, t-c.start);
          if(c.type==='overlay') drawOverlayFx(ctx, c.overlayType, W, H, t, seedFromString(c.id), c.intensity!==undefined?c.intensity:0.6);
          else drawSingleClipAt(ctx, c, t-c.start, W, H, t);
        }
      });
    });
  });
  ctx.restore();
}
function drawSingleClipAt(ctx, clip, localTime, W, H, globalT){
  const saveCur = Editor.curTime; Editor.curTime = globalT;
  drawSingleClip(ctx, clip, localTime, W, H);
  Editor.curTime = saveCur;
}

/* ============================================================
   Bootstrap
   ============================================================ */
document.addEventListener('DOMContentLoaded', ()=>{
  showPage('home');
});
if(document.readyState!=='loading') showPage('home');

})();
