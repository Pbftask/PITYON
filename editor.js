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
  getFavoriteEffects,toggleFavoriteEffect,
  getUserPresets,addUserPreset,deleteUserPreset,
  EFFECT_CATEGORIES,TRANSITIONS,OVERLAY_TYPES,MASK_SHAPES,MASK_BLEND_MODES,TEXT_ANIMS,TEXT_ANIM_MODES,SHAPE_TYPES,
  KF_PROPS,KF_DEFAULT,seedFromString,interpKeyframes,getFitRect,buildCssFilter,
  drawMediaWithFX,applyMaskClip,drawTextLayer,drawOverlayFx,drawVignette,drawGrain,
  LAYER_BLEND_MODES,LAYER_COLOR_LABELS,ensureLayerFields,migrateProjectLayers,
  isLayerEffectivelyVisible,defaultLayerName,
  KF_PROP_RANGES,CURVE_PRESETS,cubicBezierEase,
  matIdentity,matFromTransform,matMultiply,resolveWorldTransform,getClipTransformAtTimeShared,
  makeStandardTracks,
  sanitizeFileName,downloadBlob,
  restoreProjectFromFile} = C;

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
  App.multiSelectMode=false; App.multiSelectedClipIds=[];
  $('#zoomSlider').value = App.zoomPxPerSec;
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
window.addEventListener('resize', ()=>{ if(App.page==='editor'){ resizeCanvas(); updateGizmo(); updateMotionPathOverlay(); } });

/* ============================================================
   Fase 2 — Transform Engine: interactive preview gizmo
   ============================================================ */
/* Types the gizmo currently supports. Text/subtitle render through their
   own x/y/rotation style system (see buildTextStylePanel) rather than
   clip.baseTransform, so they aren't wired into the gizmo yet. */
const GIZMO_SUPPORTED_TYPES = ['video','image','shape','sticker','composition'];

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
  } else if(clip.type==='composition'){
    // Fase 5 — a composition always renders at full canvas size before
    // its own clip transform is applied (see renderCompositionToCanvas).
    w = W * (bt.scaleX!==undefined?bt.scaleX:bt.scale) * ((bt.width||100)/100);
    h = H * (bt.scaleY!==undefined?bt.scaleY:bt.scale) * ((bt.height||100)/100);
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
  // Fase 5 — a parented clip's on-screen box is the composed result of
  // its whole parent chain; dragging it here would only edit its LOCAL
  // transform, so the box wouldn't track the drag correctly. Keep the
  // interactive gizmo for unparented clips and let parented ones be
  // adjusted precisely via the Position/Scale/Rotation sliders instead.
  if(!clip || clip.locked || clip.parentId || GIZMO_SUPPORTED_TYPES.indexOf(clip.type)===-1) return;
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

/* ============================================================
   Fase 6 — Pen Tool (Custom Path mask points, straight-line only)
   ============================================================ */
function updatePenToolOverlay(){
  const host = $('#penToolOverlay');
  if(!host) return;
  host.innerHTML='';
  if(!App._penEditing){ host.classList.add('hidden'); return; }
  const clip = getSelectedClip();
  const mask = clip && clip.masks && clip.masks[App._penEditMaskIndex];
  if(!clip || !mask){ host.classList.add('hidden'); return; }
  host.classList.remove('hidden');

  const canvas=$('#previewCanvas'), frame=$('#previewFrame');
  if(!canvas.width || !frame.clientWidth) return;
  const W=canvas.width, H=canvas.height, ratio=frame.clientWidth/W;
  const mw = W*((mask.width||70)/100)*(mask.scale||1);
  const mh = H*((mask.height||70)/100)*(mask.scale||1);
  const mx = W/2+(mask.x||0), my = H/2+(mask.y||0);
  const toScreen = p=> [ (mx+p.x*mw)*ratio, (my+p.y*mh)*ratio ];

  if(mask.points && mask.points.length>1){
    const svgNS='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(svgNS,'svg'); svg.setAttribute('class','pen-path-svg');
    svg.setAttribute('width', frame.clientWidth); svg.setAttribute('height', frame.clientHeight);
    const poly=document.createElementNS(svgNS,'polygon');
    poly.setAttribute('points', mask.points.map(p=>toScreen(p).join(',')).join(' '));
    poly.setAttribute('class','pen-path-poly');
    svg.appendChild(poly);
    host.appendChild(svg);
  }
  (mask.points||[]).forEach((p,i)=>{
    const [px,py] = toScreen(p);
    const dot=document.createElement('div'); dot.className='pen-point';
    dot.style.left=px+'px'; dot.style.top=py+'px';
    attachPenPointHandlers(dot, mask, i, mx,my,mw,mh,ratio);
    host.appendChild(dot);
  });

  // Tap empty space to add a new point at that position.
  host.onclick = e=>{
    if(e.target!==host) return; // ignore taps that landed on a point/svg
    const rect=frame.getBoundingClientRect();
    const sx=(e.clientX-rect.left)/ratio, sy=(e.clientY-rect.top)/ratio;
    mask.points = mask.points||[];
    mask.points.push({ x:(sx-mx)/mw, y:(sy-my)/mh });
    Editor.renderFrame(Editor.curTime); updatePenToolOverlay(); pushUndoSnapshot();
  };
}
function attachPenPointHandlers(dot, mask, index, mx,my,mw,mh,ratio){
  let longPressTimer=null, moved=false;
  dot.addEventListener('pointerdown', e=>{
    e.stopPropagation();
    moved=false;
    longPressTimer=setTimeout(()=>{
      mask.points.splice(index,1);
      Editor.renderFrame(Editor.curTime); updatePenToolOverlay(); pushUndoSnapshot();
    }, 480);
    const onMove=ev=>{
      if(longPressTimer && (Math.abs(ev.clientX-e.clientX)>6||Math.abs(ev.clientY-e.clientY)>6)){ clearTimeout(longPressTimer); longPressTimer=null; }
      moved=true;
      const frame=$('#previewFrame'); const rect=frame.getBoundingClientRect();
      const sx=(ev.clientX-rect.left)/ratio, sy=(ev.clientY-rect.top)/ratio;
      mask.points[index] = { x:(sx-mx)/mw, y:(sy-my)/mh };
      Editor.renderFrame(Editor.curTime); updatePenToolOverlay();
    };
    const onUp=()=>{
      if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer=null; }
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
      if(moved) pushUndoSnapshot();
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  });
}

/* ============================================================
   Fase 6 — Motion Path: visualizes x/y keyframes as a path directly on
   the preview, draggable, with optional auto-orientation + reverse.
   ============================================================ */
function updateMotionPathOverlay(){
  let host = $('#motionPathOverlay');
  const clip = getSelectedClip();
  const hasXY = clip && clip.keyframes && clip.keyframes.some(k=>k.prop==='x') && clip.keyframes.some(k=>k.prop==='y');
  if(!host){
    host=document.createElement('div'); host.id='motionPathOverlay'; host.style.cssText='position:absolute;inset:0;pointer-events:none;';
    $('#previewFrame').appendChild(host);
  }
  host.innerHTML='';
  if(!hasXY || App._penEditing) return;
  const canvas=$('#previewCanvas'), frame=$('#previewFrame');
  if(!canvas.width || !frame.clientWidth) return;
  const W=canvas.width, H=canvas.height, ratio=frame.clientWidth/W;
  const xs = clip.keyframes.filter(k=>k.prop==='x').sort((a,b)=>a.time-b.time);
  const ys = clip.keyframes.filter(k=>k.prop==='y').sort((a,b)=>a.time-b.time);
  const times = Array.from(new Set(xs.map(k=>k.time).concat(ys.map(k=>k.time)))).sort((a,b)=>a-b);

  const svgNS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(svgNS,'svg'); svg.setAttribute('class','motion-path-svg');
  svg.setAttribute('width', frame.clientWidth); svg.setAttribute('height', frame.clientHeight);
  const SAMPLES=40;
  let d='';
  for(let i=0;i<=SAMPLES;i++){
    const t = (clip.duration||1)*i/SAMPLES;
    const v = interpKeyframes(clip, t);
    const px=(W/2+v.x)*ratio, py=(H/2+v.y)*ratio;
    d += (i===0?'M':'L')+px.toFixed(1)+','+py.toFixed(1)+' ';
  }
  const path=document.createElementNS(svgNS,'path'); path.setAttribute('d',d); path.setAttribute('class','motion-path-line');
  svg.appendChild(path);
  host.appendChild(svg);

  times.forEach(t=>{
    const v = interpKeyframes(clip, t);
    const px=(W/2+v.x)*ratio, py=(H/2+v.y)*ratio;
    const dot=document.createElement('div'); dot.className='motion-path-point';
    dot.style.left=px+'px'; dot.style.top=py+'px';
    attachMotionPathPointDrag(dot, clip, t, ratio);
    host.appendChild(dot);
  });
}
function attachMotionPathPointDrag(dot, clip, time, ratio){
  let moved=false;
  dot.addEventListener('pointerdown', e=>{
    e.stopPropagation(); moved=false;
    const onMove=ev=>{
      moved=true;
      const rect=$('#previewFrame').getBoundingClientRect();
      const canvas=$('#previewCanvas');
      const nx=(ev.clientX-rect.left)/ratio - canvas.width/2, ny=(ev.clientY-rect.top)/ratio - canvas.height/2;
      let kx=clip.keyframes.find(k=>k.prop==='x'&&Math.abs(k.time-time)<0.001);
      let ky=clip.keyframes.find(k=>k.prop==='y'&&Math.abs(k.time-time)<0.001);
      if(kx) kx.value=nx; else clip.keyframes.push({prop:'x',time,value:nx,easing:'linear'});
      if(ky) ky.value=ny; else clip.keyframes.push({prop:'y',time,value:ny,easing:'linear'});
      Editor.renderFrame(Editor.curTime); updateMotionPathOverlay();
    };
    const onUp=()=>{
      window.removeEventListener('pointermove',onMove); window.removeEventListener('pointerup',onUp);
      if(moved) pushUndoSnapshot();
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  });
}
/* Reverses the ORDER of a clip's x/y keyframe values (times stay put),
   so the object retraces its path backwards. */
function reverseMotionPath(clip){
  ['x','y'].forEach(prop=>{
    const pts = clip.keyframes.filter(k=>k.prop===prop).sort((a,b)=>a.time-b.time);
    const values = pts.map(k=>k.value).reverse();
    pts.forEach((k,i)=> k.value=values[i]);
  });
  Editor.renderFrame(Editor.curTime); updateMotionPathOverlay(); pushUndoSnapshot();
}
/* Auto Orientation: rotates the clip each frame to face the direction
   it's currently moving along its x/y motion path. Computed from the
   path's tangent (a tiny lookahead sample), then ADDED on top of the
   clip's own authored rotation keyframes/value rather than replacing it. */
function applyAutoOrientation(clip, localTime){
  if(!clip.autoOrient || !clip.keyframes) return 0;
  const dt=0.05;
  const a = interpKeyframes(clip, clamp(localTime-dt,0,clip.duration));
  const b = interpKeyframes(clip, clamp(localTime+dt,0,clip.duration));
  const dx=b.x-a.x, dy=b.y-a.y;
  if(Math.abs(dx)<0.01 && Math.abs(dy)<0.01) return 0;
  return Math.atan2(dy,dx)*180/Math.PI;
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

  const activeTracks = getActiveTracks();
  activeTracks.forEach(track=>{
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
    const totalH = tracksEl.scrollHeight || (activeTracks.length*58);
    App.project.beatMarkers.forEach(bt=>{
      const m=document.createElement('div');
      m.className='beat-marker';
      m.style.left=(bt*pxPerSec)+'px';
      m.style.height=totalH+'px';
      tracksEl.appendChild(m);
    });
  }

  $('#timelineEmptyHint').classList.toggle('hidden', activeTracks.some(t=>t.clips.length>0));
  renderRuler(pxPerSec, totalW);
  renderMarkers(pxPerSec, totalW);
  updateMultiSelectBar();
  positionPlayheadUI();
  renderCompositionBreadcrumb();
};

/* Fase 4 — generic named markers on the ruler (separate from beat markers) */
function renderMarkers(pxPerSec, totalW){
  const ruler = $('#timelineRuler');
  (App.project.markers||[]).forEach(mk=>{
    const flag=document.createElement('div'); flag.className='timeline-marker';
    flag.style.left=(mk.time*pxPerSec-6)+'px'; flag.title=mk.label||'Marker';
    flag.addEventListener('click', e=>{ e.stopPropagation(); Editor.seek(mk.time); });
    let lpTimer=setTimeout(()=>{}, 0); clearTimeout(lpTimer);
    flag.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      lpTimer=setTimeout(()=>{
        if(confirm('Hapus marker ini?')){
          App.project.markers = App.project.markers.filter(m=>m!==mk);
          Editor.renderTimeline(); pushUndoSnapshot();
        }
      },480);
    });
    flag.addEventListener('pointerup', ()=> clearTimeout(lpTimer));
    flag.addEventListener('pointerleave', ()=> clearTimeout(lpTimer));
    ruler.appendChild(flag);
  });
};

function renderRuler(pxPerSec, totalW){
  const ruler = $('#timelineRuler');
  ruler.innerHTML='';
  ruler.style.width = totalW+'px';
  const dur = App.project.duration+6;
  const fps = App.project.fps||30;
  // Fase 4 — adaptive resolution: whole seconds when zoomed out, down to
  // individual frames when zoomed in far enough that frame ticks don't
  // overlap on screen.
  let step, showFrames=false;
  if(pxPerSec>500){ step=1/fps; showFrames=true; }
  else if(pxPerSec>140) step=1;
  else if(pxPerSec>70) step=2;
  else if(pxPerSec>35) step=5;
  else step=10;
  for(let s=0; s<=dur; s+=step){
    const tick=document.createElement('div');
    tick.style.position='absolute'; tick.style.left=(s*pxPerSec)+'px'; tick.style.top='0'; tick.style.fontSize='9px';
    tick.style.color='#6b7180';
    tick.textContent = showFrames ? fmtTimeFrames(s,fps) : fmtTime(s).slice(0,5);
    ruler.appendChild(tick);
  }
  ruler.style.position='relative';
}
function fmtTimeFrames(s, fps){
  const whole=Math.floor(s); const frame=Math.round((s-whole)*fps);
  return whole+':'+String(frame).padStart(2,'0');
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
    +(clip.visible===false?' clip-hidden':'')+(clip.locked?' clip-locked':'')+(clip.solo?' clip-solo':'')
    +(App.multiSelectedClipIds.includes(clip.id)?' multi-selected':'');
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

/* Fase 4 — Magnetic snapping while moving/trimming a clip on the main
   timeline. Snaps whichever edge is provided (start and/or end) to: the
   playhead, time 0, and the start/end of every OTHER clip in the same
   track. Draws a temporary guide line at the snapped position. */
function applyMagneticSnap(clip, track, proposedStart, proposedEnd){
  if(App.snapEnabled===false){ return proposedStart!==null? proposedStart : proposedEnd; }
  const pxPerSec = App.zoomPxPerSec;
  const thresholdSec = 8/pxPerSec;
  const targets = [0, Editor.curTime];
  track.clips.forEach(c=>{ if(c!==clip){ targets.push(c.start); targets.push(c.start+c.duration); } });

  function snapValue(v){
    let best=v, bestDist=thresholdSec;
    for(const t of targets){ const d=Math.abs(v-t); if(d<bestDist){ bestDist=d; best=t; } }
    if(best!==v) showSnapGuide(best);
    return best;
  }
  if(proposedStart!==null && proposedEnd===null) return snapValue(proposedStart);
  if(proposedEnd!==null && proposedStart===null) return snapValue(proposedEnd);
  return snapValue(proposedStart); // both provided (move): snap by the leading edge
}
function showSnapGuide(timeSec){
  let g = $('#activeSnapGuide');
  if(!g){ g=document.createElement('div'); g.id='activeSnapGuide'; g.className='timeline-snap-guide'; $('#timelineTracks').appendChild(g); }
  g.style.left=(timeSec*App.zoomPxPerSec)+'px';
  g.style.height = ($('#timelineTracks').scrollHeight||200)+'px';
}
function clearSnapGuides(){ const g=$('#activeSnapGuide'); if(g) g.remove(); }

/* ---------------- Clip interactions (move / trim / reorder between tracks) ---------------- */
function attachClipHandlers(el, clip, track){
  let mode=null, startX=0, startY=0, origStart=0, origDur=0, origTrimStart=0, origTrimEnd=0;
  let originTrack=null, originRow=null, hoverRow=null;
  let longPressTimer=null, longPressFired=false;
  let groupStarts=null; // Fase 4 — {clipId: origStart} for a multi-select group move
  let lastTapTime=0; // Fase 5 — double-tap to enter a composition
  el.addEventListener('pointerdown', e=>{
    e.stopPropagation();
    if(clip.type==='composition'){
      const now=performance.now();
      if(now-lastTapTime<350){ enterComposition(clip); lastTapTime=0; return; }
      lastTapTime=now;
    }
    // Fase 4 — multi-select mode: tap toggles this clip's membership in the
    // selection instead of opening its edit panel.
    if(App.multiSelectMode){
      const idx = App.multiSelectedClipIds.indexOf(clip.id);
      if(idx>=0) App.multiSelectedClipIds.splice(idx,1); else App.multiSelectedClipIds.push(clip.id);
      Editor.renderTimeline();
      return;
    }
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
      // If this clip is part of an active multi-selection, drag the whole
      // group together (horizontally only — no cross-track move for groups).
      groupStarts = null;
      if(App.multiSelectedClipIds.length>1 && App.multiSelectedClipIds.includes(clip.id)){
        groupStarts = {};
        App.multiSelectedClipIds.forEach(id=>{ const c=findClipById(id); if(c) groupStarts[id]=c.start; });
      }
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
      if(groupStarts){
        // Fase 4 — multi-select group move: same delta for every selected
        // clip, clamped so the earliest one never goes below 0.
        let delta=dx;
        const minStart = Math.min(...Object.values(groupStarts));
        if(minStart+delta<0) delta = -minStart;
        Object.keys(groupStarts).forEach(id=>{
          const c=findClipById(id); if(c) c.start = groupStarts[id]+delta;
        });
        Editor.renderTimeline();
      } else {
        let proposed = Math.max(0, origStart+dx);
        proposed = applyMagneticSnap(clip, track, proposed, proposed+origDur);
        clip.start = proposed;
        const dy = e.clientY-startY;
        if(Math.abs(dy)>10){
          const targetRow = rowAtClientY(e.clientY);
          if(targetRow && targetRow!==hoverRow){
            const targetTrack = getActiveTracks().find(t=>t.id===targetRow.dataset.trackId);
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
      }
    } else if(mode==='trimR'){
      let newDur = Math.max(minDur, origDur+dx);
      newDur = applyMagneticSnap(clip, track, null, origStart+newDur) - origStart;
      clip.duration = Math.max(minDur,newDur);
      if(clip.trimEnd!==undefined) clip.trimEnd = origTrimStart + clip.duration*(clip.speed||1);
    } else if(mode==='trimL'){
      let newStart = Math.max(0, origStart+dx);
      newStart = applyMagneticSnap(clip, track, newStart, null);
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
    clearSnapGuides();
    if(mode==='move'){
      el.style.touchAction='';
      el.classList.remove('dragging');
      $$('.track-row').forEach(r=>r.classList.remove('drop-target','drop-target-invalid'));
      if(hoverRow){
        const targetTrack = getActiveTracks().find(t=>t.id===hoverRow.dataset.trackId);
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
      App._replaceTargetClipId = clip.id;
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
  updateGizmo(); updateMotionPathOverlay();
}
function getSelectedClip(){
  if(!App.selectedClipId) return null;
  for(const tr of getActiveTracks()){ const c=tr.clips.find(c=>c.id===App.selectedClipId); if(c) return c; }
  return null;
}
function getClipTrack(clipId){
  for(const tr of getActiveTracks()){ if(tr.clips.some(c=>c.id===clipId)) return tr; }
  return null;
}
/* Fase 4 — helpers shared by Replace Media / Ripple Delete / multi-select */
function findClipById(clipId){
  for(const tr of getActiveTracks()){ const c=tr.clips.find(c=>c.id===clipId); if(c) return c; }
  return null;
}
function isMediaIdStillUsed(mediaId){
  // Deliberately checks the WHOLE project (root + every nested composition),
  // not just the currently-active level, so media still used inside a
  // composition you're not currently inside never gets released.
  const walk = tracks=> tracks.some(tr=> tr.clips.some(c=> c.mediaId===mediaId || (c.type==='composition' && walk(c.tracks||[]))));
  return walk(App.project.tracks);
}
async function releaseMediaIfUnused(mediaId){
  if(!mediaId || isMediaIdStillUsed(mediaId)) return;
  const entry = App.mediaCache[mediaId];
  if(entry && entry.url){ try{ URL.revokeObjectURL(entry.url); }catch(e){} }
  delete App.mediaCache[mediaId];
  App.project.mediaLibrary = App.project.mediaLibrary.filter(m=>m.id!==mediaId);
  try{ await idbDeleteMedia(mediaId); }catch(e){}
}

/* ============================================================
   Fase 5 — Parent / Null Object / Pre-compose
   ============================================================ */
/* The set of tracks currently being edited: the root project's tracks,
   or — if the user has "entered" a composition clip to edit its
   contents — that composition's own nested tracks. Almost everything in
   the editor (timeline rendering, clip lookup, "add new clip") reads
   tracks through this function so it transparently works one level
   deep or many levels deep. Saving/export always walk App.project.tracks
   directly (the true root), so autosave is unaffected by which level
   you're currently viewing. */
function getActiveTracks(){
  if(App.compositionStack.length) return App.compositionStack[App.compositionStack.length-1].tracks;
  return App.project.tracks;
}
function enterComposition(compClip){
  if(compClip.type!=='composition') return;
  if(!compClip.tracks) compClip.tracks = [];
  App.compositionStack.push({tracks:compClip.tracks, clipId:compClip.id, name:compClip.name||'Composition'});
  App.selectedClipId=null; App.multiSelectedClipIds=[];
  hideClipTabs(); closeSheet('#sheetPanel');
  Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
  renderCompositionBreadcrumb();
}
function exitComposition(toIndex){
  if(!App.compositionStack.length) return;
  App.compositionStack.length = toIndex!==undefined? Math.max(0,toIndex) : App.compositionStack.length-1;
  App.selectedClipId=null; App.multiSelectedClipIds=[];
  hideClipTabs(); closeSheet('#sheetPanel');
  Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
  renderCompositionBreadcrumb();
}
function renderCompositionBreadcrumb(){
  const bar=$('#compBreadcrumb');
  if(!bar) return;
  if(!App.compositionStack.length){ bar.classList.add('hidden'); bar.innerHTML=''; return; }
  bar.classList.remove('hidden'); bar.innerHTML='';
  const rootBtn=document.createElement('button'); rootBtn.textContent='Main Project';
  rootBtn.addEventListener('click', ()=> exitComposition(0));
  bar.appendChild(rootBtn);
  App.compositionStack.forEach((lvl,i)=>{
    const sep=document.createElement('span'); sep.textContent=' › '; bar.appendChild(sep);
    const b=document.createElement('button'); b.textContent=lvl.name;
    if(i===App.compositionStack.length-1) b.classList.add('current');
    b.addEventListener('click', ()=> exitComposition(i+1));
    bar.appendChild(b);
  });
}
/* Resolves a clip's final on-screen transform, walking its parent chain
   (Null objects or any other layer can be a parent) when it has one.
   Falls back to the plain per-clip transform otherwise — zero behavior
   change for clips that were never parented. */
function getEffectiveTransform(clip, localTime){
  if(!clip.parentId) return getClipTransformAtTime(clip, localTime);
  const siblings = getActiveTracks().reduce((acc,tr)=>acc.concat(tr.clips),[]);
  return resolveWorldTransform(clip, siblings, c=> clamp(Editor.curTime-c.start, 0, c.duration));
}
/* All OTHER clips at the current editing level eligible to be this
   clip's parent — excludes itself and anything already descending from
   it (which would create a cycle). */
function eligibleParents(clip){
  const siblings = getActiveTracks().reduce((acc,tr)=>acc.concat(tr.clips),[]);
  const isDescendant = (candidateId, ancestorId)=>{
    let cur = siblings.find(c=>c.id===candidateId);
    const visited=new Set();
    while(cur && cur.parentId){
      if(visited.has(cur.id)) return false;
      visited.add(cur.id);
      if(cur.parentId===ancestorId) return true;
      cur = siblings.find(c=>c.id===cur.parentId);
    }
    return false;
  };
  return siblings.filter(c=> c.id!==clip.id && !isDescendant(c.id, clip.id));
}

function showClipTabs(){
  $('#clipTabsBar').classList.remove('hidden');
}
function hideClipTabs(){
  $('#clipTabsBar').classList.add('hidden');
  App._penEditing=false; App._penEditMaskIndex=null;
  updateGizmo(); updateMotionPathOverlay(); updatePenToolOverlay();
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
  if(clip.type==='null') return; // Fase 5 — Null Objects are invisible; they only exist to be parented to.
  // Fase 5 — resolves the clip's parent chain (if any) into a final world
  // transform; unparented clips get exactly their own transform back, so
  // this is a no-op for every clip from before Fase 5.
  const tfBase = getEffectiveTransform(clip, localTime);
  const tf = baseTransform();
  tf.dx = tfBase.x; tf.dy = tfBase.y; tf.scale = tfBase.scale;
  // Fase 6 — Auto Orientation: rotate to face the motion path's tangent,
  // added on top of whatever rotation was already authored (keyframed or
  // static) rather than replacing it.
  tf.rotation = tfBase.rotation + applyAutoOrientation(clip, localTime);
  tf.alpha = tfBase.opacity;
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
  // Fase 8 — Audio-Reactive: modulates tf on top of everything else,
  // right before the FX effect stack runs (so Bass→Glow etc. composes
  // correctly with manually-added effects too).
  applyAudioReactive(clip, tf, Editor.curTime);

  const seed = seedFromString(clip.id);
  const beatInfo = nearestBeatDelta(Editor.curTime, App.project.beatMarkers);
  const fxCtx = { tf, beatDelta: beatInfo? beatInfo.delta : null, clipTime: localTime, clipDur: clip.duration, seed, rnd: mulberry32(seed+Math.floor(Editor.curTime*10)) };

  (clip.effects||[]).forEach(fx=>{ if(fx.enabled===false) return; const fn=FX[fx.type]; if(fn){ try{ fn(fx.params||{}, fxCtx); }catch(e){} } });
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
    } else if(clip.type==='composition'){
      const compCanvas = renderCompositionToCanvas(clip, localTime, canvasW, canvasH);
      drawMediaWithFX(targetCtx, compCanvas, canvasW, canvasH, cx, cy, canvasW, canvasH, 'fill', tf, seed, Editor.curTime);
    }
  };

  // Fase 6 — multiple masks with Add/Subtract/Intersect/Difference combine
  // modes, replacing the old single-mask-only clip.mask (still migrated
  // in automatically — see ensureLayerFields).
  const maskCv = renderMaskStack(clip.masks, cx, cy, canvasW, canvasH);
  if(maskCv){
    const off=document.createElement('canvas'); off.width=canvasW; off.height=canvasH;
    const octx=off.getContext('2d');
    renderContent(octx);
    octx.globalCompositeOperation='destination-in';
    octx.drawImage(maskCv,0,0);
    ctx2d.save();
    ctx2d.globalAlpha = 1;
    ctx2d.drawImage(off,0,0);
    ctx2d.restore();
  } else {
    renderContent(ctx2d);
  }
}
/* Fase 6 — Mask Engine: builds ONE mask shape's path, supporting rotation,
   expansion (grow/shrink), and the new Ellipse / Polygon / Custom Path
   shapes on top of the original set. */
function buildMaskPath(ctx2d, mask, cx, cy, canvasW, canvasH){
  const mw = canvasW*((mask.width||70)/100)*(mask.scale||1) + (mask.expansion||0)*2;
  const mh = canvasH*((mask.height||70)/100)*(mask.scale||1) + (mask.expansion||0)*2;
  const mx = cx+(mask.x||0), my = cy+(mask.y||0);
  const rot = (mask.rotation||0)*Math.PI/180;
  const useRotation = rot!==0 && mask.shape!=='Custom Path';
  if(useRotation){ ctx2d.save(); ctx2d.translate(mx,my); ctx2d.rotate(rot); ctx2d.translate(-mx,-my); }

  if(mask.shape==='Circle'||mask.shape==='Radial'){
    ctx2d.arc(mx,my,Math.min(mw,mh)/2,0,Math.PI*2);
  } else if(mask.shape==='Ellipse'){
    ctx2d.ellipse(mx,my,mw/2,mh/2,0,0,Math.PI*2);
  } else if(mask.shape==='Rounded Rectangle'){
    roundRectP(ctx2d,mx-mw/2,my-mh/2,mw,mh,Math.min(mw,mh)*0.15);
  } else if(mask.shape==='Linear'){
    ctx2d.rect(mx-mw/2, my-mh/2, mw, mh*(mask.pos!==undefined?mask.pos:0.5));
  } else if(mask.shape==='Polygon'){
    const sides = Math.max(3, mask.sides||6);
    const r = Math.min(mw,mh)/2;
    for(let i=0;i<sides;i++){
      const a = -Math.PI/2 + i*2*Math.PI/sides;
      const px=mx+r*Math.cos(a), py=my+r*Math.sin(a);
      if(i===0) ctx2d.moveTo(px,py); else ctx2d.lineTo(px,py);
    }
    ctx2d.closePath();
  } else if(mask.shape==='Custom Path'){
    // Fase 6 — Pen Tool: mask.points are straight-line vertices authored
    // in the preview, stored as fractions (-0.5..0.5) of the mask's own
    // box so they scale/move/rotate together with position/scale/rotation
    // like every other shape here. Curved (bezier) path segments aren't
    // supported yet — see the Pen Tool panel hint for that scope note.
    const pts = mask.points||[];
    if(pts.length>=2){
      pts.forEach((p,i)=>{
        const px = mx + p.x*mw, py = my + p.y*mh;
        if(i===0) ctx2d.moveTo(px,py); else ctx2d.lineTo(px,py);
      });
      ctx2d.closePath();
    } else {
      ctx2d.rect(mx-mw/2,my-mh/2,mw,mh); // not enough points yet — fall back so the mask isn't invisible
    }
  } else {
    ctx2d.rect(mx-mw/2,my-mh/2,mw,mh);
  }
  if(useRotation) ctx2d.restore();
}
/* Fase 6 — combines every mask in clip.masks into one alpha canvas
   (white = visible), honoring each mask's own feather, invert, and
   Add/Subtract/Intersect/Difference combine mode. Returns null when the
   clip has no masks, so the caller can skip masking entirely (identical
   render to before Fase 6 for every clip that never had a mask). */
function renderMaskStack(masks, cx, cy, canvasW, canvasH){
  if(!masks || !masks.length) return null;
  const acc=document.createElement('canvas'); acc.width=canvasW; acc.height=canvasH;
  const actx=acc.getContext('2d');
  masks.forEach((mask,i)=>{
    const layer=document.createElement('canvas'); layer.width=canvasW; layer.height=canvasH;
    const lctx=layer.getContext('2d');
    lctx.filter = mask.feather? `blur(${mask.feather}px)`:'none';
    lctx.fillStyle='#fff';
    lctx.beginPath();
    buildMaskPath(lctx, mask, cx, cy, canvasW, canvasH);
    lctx.fill();
    if(mask.invert){
      lctx.filter='none';
      lctx.globalCompositeOperation='source-out';
      lctx.fillRect(0,0,canvasW,canvasH);
      lctx.globalCompositeOperation='source-over';
    }
    // mask opacity = how strongly this mask reveals content (1 = full
    // cutout, lower = the masked region shows content only partially).
    const op = mask.opacity!==undefined? mask.opacity : 1;
    if(op<1){
      lctx.filter='none';
      lctx.globalCompositeOperation='destination-in';
      lctx.fillStyle=`rgba(255,255,255,${op})`;
      lctx.fillRect(0,0,canvasW,canvasH);
      lctx.globalCompositeOperation='source-over';
    }
    const mode = i===0? 'add' : (mask.mode||'add'); // the first mask always establishes the base region
    if(mode==='add'){ actx.globalCompositeOperation='source-over'; }
    else if(mode==='subtract'){ actx.globalCompositeOperation='destination-out'; }
    else if(mode==='intersect'){ actx.globalCompositeOperation='destination-in'; }
    else if(mode==='difference'){ actx.globalCompositeOperation='xor'; }
    actx.drawImage(layer,0,0);
  });
  actx.globalCompositeOperation='source-over';
  return acc;
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

  ctx2d.beginPath();
  buildShapePath(ctx2d, clip, w, h);

  // Fase 8 — Shape & Vector: real fill (solid or gradient) + stroke,
  // instead of the old always-on single solid fillStyle.
  const fillOn = clip.fillEnabled!==false;
  const strokeOn = !!clip.strokeEnabled;
  if(fillOn){
    if(clip.gradient){
      const g=ctx2d.createLinearGradient(-w/2,0,w/2,0);
      g.addColorStop(0, clip.color||'#16E8A6'); g.addColorStop(1, clip.color2||'#3d7bff');
      ctx2d.fillStyle=g;
    } else {
      ctx2d.fillStyle = clip.color||'#16E8A6';
    }
    ctx2d.fill();
  }
  if(strokeOn){
    ctx2d.lineWidth = clip.strokeWidth||4;
    ctx2d.strokeStyle = clip.strokeColor||'#ffffff';
    ctx2d.stroke();
  }
  ctx2d.restore();
}
/* Fase 8 — the actual path-building for every shape type, shared by the
   preview draw above and (later) anything else that needs the same
   outline (kept separate so adding a shape type only needs one edit). */
function buildShapePath(ctx2d, clip, w, h){
  const type = clip.shapeType||'Rectangle';
  if(type==='Circle'){
    ctx2d.arc(0,0,Math.min(w,h)/2,0,Math.PI*2);
  } else if(type==='Ellipse'){
    ctx2d.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);
  } else if(type==='Rounded Rectangle'){
    roundRectP(ctx2d,-w/2,-h/2,w,h, Math.min(w,h)*clamp((clip.cornerRadius!==undefined?clip.cornerRadius:15)/100,0,0.5));
  } else if(type==='Triangle'){
    ctx2d.moveTo(0,-h/2); ctx2d.lineTo(w/2,h/2); ctx2d.lineTo(-w/2,h/2); ctx2d.closePath();
  } else if(type==='Polygon'){
    const sides=Math.max(3, clip.sides||6), r=Math.min(w,h)/2;
    for(let i=0;i<sides;i++){ const a=-Math.PI/2+i*2*Math.PI/sides; const px=r*Math.cos(a), py=r*Math.sin(a); if(i===0) ctx2d.moveTo(px,py); else ctx2d.lineTo(px,py); }
    ctx2d.closePath();
  } else if(type==='Star'){
    const points=Math.max(3, clip.starPoints||5), outerR=Math.min(w,h)/2, innerR=outerR*clamp(clip.starInnerRatio!==undefined?clip.starInnerRatio:0.5,0.1,0.9);
    for(let i=0;i<points*2;i++){
      const a=-Math.PI/2+i*Math.PI/points, r=i%2===0?outerR:innerR;
      const px=r*Math.cos(a), py=r*Math.sin(a); if(i===0) ctx2d.moveTo(px,py); else ctx2d.lineTo(px,py);
    }
    ctx2d.closePath();
  } else if(type==='Line'){
    ctx2d.moveTo(-w/2,0); ctx2d.lineTo(w/2,0);
  } else if(type==='Arrow'){
    const headW=h*0.6, headL=Math.min(w*0.35,h*1.2);
    ctx2d.moveTo(-w/2, -h*0.15); ctx2d.lineTo(w/2-headL, -h*0.15); ctx2d.lineTo(w/2-headL,-headW/2);
    ctx2d.lineTo(w/2,0); ctx2d.lineTo(w/2-headL,headW/2); ctx2d.lineTo(w/2-headL,h*0.15);
    ctx2d.lineTo(-w/2,h*0.15); ctx2d.closePath();
  } else {
    ctx2d.rect(-w/2,-h/2,w,h);
  }
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
  const trimStart = clip.trimStart||0;
  const trimEnd = clip.trimEnd!==undefined? clip.trimEnd : trimStart + clip.duration*(clip.speed||1);
  const playedSpan = localTime*(clip.speed||1);
  if(videoEl.readyState<1) return;
  // Fase 4 — Reverse. <video> has no reliable native reverse playback, so
  // reversed clips are driven by repeatedly seeking backwards through the
  // source instead of relying on playbackRate. This means reversed
  // playback can look a bit less smooth than normal forward playback, and
  // scrubbing while paused works exactly as well as forward clips.
  if(clip.reversed){
    const desired = Math.max(trimStart, trimEnd - playedSpan);
    if(!videoEl.paused) videoEl.pause();
    if(Math.abs(videoEl.currentTime-desired)>0.03){ try{ videoEl.currentTime=desired; }catch(e){} }
    return;
  }
  const desired = trimStart + playedSpan;
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
  const perfStart = App.perfMonitorOn ? performance.now() : 0;
  ctx.save();
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
  renderTracksToContext(ctx, getActiveTracks(), t, W, H);
  // Fase 8 — Camera System: only applies at the ROOT level (a virtual
  // camera framing the whole project), not while editing inside a
  // composition — a composition's own contents render at their authored
  // scale/position so they still combine correctly with the rest of the
  // project once the camera is applied on the final composite.
  if(!App.compositionStack.length) applyCameraTransform(ctx, W, H, t);
  ctx.restore();
  updateGizmo(); updateMotionPathOverlay();
  if(App.perfMonitorOn) updatePerfMonitor(performance.now()-perfStart);
};

/* Fase 9 — Performance Monitor: FPS (via a rolling frame-time average,
   not just 1/renderTime, so it reflects real playback smoothness),
   render time for the last frame, active layer count, and active effect
   count for whatever's currently selected. Only does any work at all
   when explicitly turned on in Settings. */
let _perfFrameTimes=[];
function updatePerfMonitor(renderMs){
  const now = performance.now();
  _perfFrameTimes.push(now);
  _perfFrameTimes = _perfFrameTimes.filter(t2=> now-t2<1000);
  const fps = _perfFrameTimes.length;
  const activeTracks = getActiveTracks();
  const layerCount = activeTracks.reduce((n,tr)=>n+tr.clips.length,0);
  const sel = getSelectedClip();
  const fxCount = sel? (sel.effects||[]).filter(e=>e.enabled!==false).length : 0;
  let mem='';
  if(performance.memory) mem = `\nMemory: ${(performance.memory.usedJSHeapSize/1048576).toFixed(0)}MB`;
  $('#perfMonitor').textContent = `FPS: ${fps}\nRender: ${renderMs.toFixed(1)}ms\nLayers: ${layerCount}\nEffects (selected): ${fxCount}${mem}`;
}

/* Fase 5 — the actual per-track/per-clip draw loop, factored out of
   Editor.renderFrame so a composition clip can render its OWN nested
   tracks into an offscreen canvas using the exact same logic (solo,
   visibility, blend modes, transitions, everything). */
function renderTracksToContext(ctx, tracksArr, t, W, H){
  // Solo: if ANY layer anywhere in this set of tracks is soloed, only
  // soloed (and still-visible) layers are drawn this frame.
  const allClips = [];
  tracksArr.forEach(tr=> tr.clips.forEach(c=> allClips.push(c)));
  const anySolo = allClips.some(c=> c.solo && c.visible!==false);

  const order = ['video','overlay','text'];
  order.forEach(kind=>{
    tracksArr.filter(tr=>tr.kind===kind).forEach(track=>{
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
}

/* Renders a composition clip's own nested tracks into an offscreen
   canvas at `localTime` (0-based, within the composition's own
   duration) — reusing the exact same draw pipeline the main preview
   uses, including nested compositions inside this one. Editor.curTime
   and App.compositionStack are temporarily repointed at the
   composition's own context for the duration of this call (the same
   save/restore-global-clock trick the export renderer uses for
   scrubbing to an arbitrary frame), then restored —
   so this never disturbs the outer timeline's own playhead or view. */
function renderCompositionToCanvas(compClip, localTime, canvasW, canvasH){
  const off=document.createElement('canvas'); off.width=canvasW; off.height=canvasH;
  const octx=off.getContext('2d');
  octx.fillStyle='#000'; octx.fillRect(0,0,canvasW,canvasH);
  const savedCur=Editor.curTime, savedStack=App.compositionStack;
  Editor.curTime = clamp(localTime,0,compClip.duration);
  App.compositionStack = savedStack.concat([{tracks:compClip.tracks||[], clipId:compClip.id, name:compClip.name}]);
  try{ renderTracksToContext(octx, compClip.tracks||[], Editor.curTime, canvasW, canvasH); }
  finally{ Editor.curTime = savedCur; App.compositionStack = savedStack; }
  return off;
}

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
    case 'null': addNullObject(); break;
  }
}

/* ---------------- Media import ---------------- */
$('#fileInputVideo').addEventListener('change', e=> importFiles(e.target.files,'video'));
$('#fileInputPhoto').addEventListener('change', e=> importFiles(e.target.files,'image'));
$('#fileInputAudio').addEventListener('change', e=> importFiles(e.target.files,'audio'));

async function importFiles(fileList, kind){
  const files = Array.from(fileList||[]);
  if(!files.length) return;
  const wasReplace = !!App._replaceTargetClipId; // importSingleFile handles its own toast/undo/render for replace
  let added=0, skipped=0;
  for(const file of files){
    const ok = await importSingleFile(file, kind);
    if(ok) added++; else skipped++;
  }
  if(wasReplace) return;
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

  // Fase 4 — Replace Media: if this import was triggered by the "Replace"
  // action on an existing clip, swap that clip's footage in place instead
  // of adding a new clip. Position, transform, effects and keyframes all
  // stay untouched; only the source media changes.
  if(App._replaceTargetClipId){
    const targetId = App._replaceTargetClipId;
    App._replaceTargetClipId = null;
    const clip = findClipById(targetId);
    if(!clip){ toast('Clip pengganti tidak ditemukan'); return false; }
    const oldMediaId = clip.mediaId;
    clip.mediaId = mediaId;
    const playedSpan = clip.duration*(clip.speed||1); // how much source time the clip currently plays
    clip.trimStart = 0;
    clip.trimEnd = Math.min(mediaDuration, playedSpan);
    if(playedSpan > mediaDuration){ clip.duration = mediaDuration/(clip.speed||1); }
    await releaseMediaIfUnused(oldMediaId);
    computeProjectDuration();
    Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
    toast('Media berhasil diganti');
    pushUndoSnapshot();
    return true;
  }

  // Audio always imports to the ROOT project's audio track (compositions
  // don't have their own mixed-in audio playback yet — see scope note on
  // scheduleAudioPlayback), video/image import into whichever level
  // you're currently editing.
  const track = kind==='audio'
    ? App.project.tracks.find(t=>t.kind==='audio')
    : getActiveTracks().find(t=>t.kind==='video');
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
  getActiveTracks().forEach(tr=> tr.clips.forEach(c=>{ if(c.zIndex!==undefined && c.zIndex>max) max=c.zIndex; }));
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
  const track = getActiveTracks().find(t=>t.kind==='text');
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
  const track = getActiveTracks().find(t=>t.kind==='text');
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
    const track = getActiveTracks().find(t=>t.kind==='text');
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
  const track = getActiveTracks().find(t=>t.kind==='overlay');
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
    SHAPE_TYPES.forEach(s=>{ const b=document.createElement('button'); b.textContent=s; if((clip.shapeType||'Rectangle')===s) b.classList.add('active');
      b.addEventListener('click',()=>{ clip.shapeType=s; renderBasicPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); row.appendChild(b); });
    body.appendChild(row);

    if(clip.shapeType==='Rounded Rectangle') body.appendChild(sliderRow('Radius %', clip.cornerRadius!==undefined?clip.cornerRadius:15, 0, 50, 1, (v,c)=>{ clip.cornerRadius=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
    if(clip.shapeType==='Polygon') body.appendChild(sliderRow('Sisi', clip.sides||6, 3, 12, 1, (v,c)=>{ clip.sides=Math.round(v); Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
    if(clip.shapeType==='Star'){
      body.appendChild(sliderRow('Titik Bintang', clip.starPoints||5, 3, 12, 1, (v,c)=>{ clip.starPoints=Math.round(v); Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
      body.appendChild(sliderRow('Kedalaman', clip.starInnerRatio!==undefined?clip.starInnerRatio:0.5, 0.1, 0.9, 0.01, (v,c)=>{ clip.starInnerRatio=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
    }

    body.appendChild(toggleRowEl('Fill', clip.fillEnabled!==false, v=>{ clip.fillEnabled=v; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
    body.appendChild(colorRow(clip.color, c=>{ clip.color=c; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
    body.appendChild(toggleRowEl('Gradient', !!clip.gradient, v=>{ clip.gradient=v; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
    if(clip.gradient) body.appendChild(colorRow(clip.color2||'#3d7bff', c=>{ clip.color2=c; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));

    body.appendChild(toggleRowEl('Stroke', !!clip.strokeEnabled, v=>{ clip.strokeEnabled=v; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
    if(clip.strokeEnabled){
      body.appendChild(colorRow(clip.strokeColor||'#ffffff', c=>{ clip.strokeColor=c; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
      body.appendChild(sliderRow('Stroke Width', clip.strokeWidth||4, 1, 30, 1, (v,c)=>{ clip.strokeWidth=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
    }
  }

  $('#bDel').addEventListener('click', ()=>{ deleteSelectedClip(); });
  $('#bDup').addEventListener('click', ()=>{ duplicateSelectedClip(); });
  $('#bReplace').addEventListener('click', ()=>{
    if(clip.type==='video'){ App._replaceTargetClipId=clip.id; $('#fileInputVideo').click(); }
    else if(clip.type==='image'){ App._replaceTargetClipId=clip.id; $('#fileInputPhoto').click(); }
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
  const gapStart = clip.start, gapDur = clip.duration;
  track.clips = track.clips.filter(c=>c.id!==clip.id);
  // Fase 4 — Ripple Delete: close the gap by shifting every later clip
  // in the SAME track earlier by the deleted clip's duration.
  if(App.rippleMode){
    track.clips.forEach(c=>{ if(c.start>=gapStart-0.001) c.start=Math.max(0,c.start-gapDur); });
  }
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

  // Fase 5 — Parent / Unparent
  const parentLabel=document.createElement('div'); parentLabel.className='muted'; parentLabel.style.margin='6px 2px'; parentLabel.textContent='Parent';
  body.appendChild(parentLabel);
  const parentSelect=document.createElement('select'); parentSelect.className='layer-name-input';
  const noneOpt=document.createElement('option'); noneOpt.value=''; noneOpt.textContent='(Tidak ada — bebas)'; parentSelect.appendChild(noneOpt);
  eligibleParents(clip).forEach(c=>{
    const opt=document.createElement('option'); opt.value=c.id; opt.textContent=(c.name||defaultLayerName(c))+(c.type==='null'?' (Null)':'');
    if(clip.parentId===c.id) opt.selected=true;
    parentSelect.appendChild(opt);
  });
  parentSelect.addEventListener('change', ()=>{
    clip.parentId = parentSelect.value || null;
    renderLayerPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });
  body.appendChild(parentSelect);
  if(clip.parentId) body.appendChild(mkHint('Posisi/rotasi/skala layer ini sekarang mengikuti parent-nya. Slider Position/Scale/Rotation di tab Basic tetap mengatur nilai LOKAL relatif terhadap parent.'));

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

  // Fase 8 — animate the Whole text at once, or stagger it in per
  // Character/Word/Line.
  const modeLabel=document.createElement('div'); modeLabel.className='muted'; modeLabel.style.margin='6px 2px'; modeLabel.textContent='Mode Animasi';
  wrap.appendChild(modeLabel);
  const modeRow=document.createElement('div'); modeRow.className='panel-tabgroup';
  TEXT_ANIM_MODES.forEach(m=>{ const b=document.createElement('button'); b.textContent=m; if((clip.text.animMode||'Whole')===m) b.classList.add('active');
    b.addEventListener('click', ()=>{ clip.text.animMode=m; renderBasicPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); modeRow.appendChild(b); });
  wrap.appendChild(modeRow);
  if((clip.text.animMode||'Whole')!=='Whole'){
    wrap.appendChild(sliderRow('Jeda antar bagian (detik)', clip.text.staggerDelay!==undefined?clip.text.staggerDelay:0.045, 0, 0.3, 0.005, (v,c)=>{ clip.text.staggerDelay=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  }

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

  // Fase 9 — Text Preset: save/reuse the whole style + animation combo.
  const textPresetActions=document.createElement('div'); textPresetActions.className='action-row';
  textPresetActions.innerHTML = `<button class="pill-btn ghost" id="bSaveTextPreset">Save as Preset</button>`;
  wrap.appendChild(textPresetActions);
  textPresetActions.querySelector('#bSaveTextPreset').addEventListener('click', ()=>{
    const name=prompt('Nama preset teks:','My Text Style'); if(!name) return;
    addUserPreset('text', name, {style:deepClone(s), anim:clip.text.anim, animMode:clip.text.animMode, staggerDelay:clip.text.staggerDelay});
    toast('Preset teks disimpan');
  });
  renderUserPresetList(wrap, 'text', data=>{
    Object.assign(s, deepClone(data.style));
    clip.text.anim = data.anim; clip.text.animMode = data.animMode; clip.text.staggerDelay = data.staggerDelay;
    openPanelTab('basic'); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    toast('Preset teks diterapkan');
  });
  return wrap;
}

/* ---- Animation tab (Fase 3: keyframe engine + graph editor) ---- */
function renderAnimationPanel(clip){
  $('#panelTitle').textContent='Animation';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('animation'));

  const propRow=document.createElement('div'); propRow.className='panel-tabgroup';
  let curProp = body._curProp || App._kfCurProp || 'scale';
  KF_PROPS.forEach(p=>{ const b=document.createElement('button'); b.textContent=p; if(p===curProp) b.classList.add('active');
    b.addEventListener('click', ()=>{ App._kfCurProp=p; App._kfSelected=null; renderAnimationPanel(clip); }); propRow.appendChild(b); });
  body.appendChild(propRow);

  // Fase 6 — Motion Path controls: only meaningful once both x and y are
  // keyframed (otherwise there's no 2D path to preview/reverse/orient to).
  const hasXY = (clip.keyframes||[]).some(k=>k.prop==='x') && (clip.keyframes||[]).some(k=>k.prop==='y');
  if(hasXY){
    const mpLabel=document.createElement('div'); mpLabel.className='muted'; mpLabel.style.margin='6px 2px'; mpLabel.textContent='Motion Path';
    body.appendChild(mpLabel);
    body.appendChild(toggleRowEl('Auto Orientation (hadap arah gerak)', !!clip.autoOrient, v=>{
      clip.autoOrient=v; Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    }));
    const mpActions=document.createElement('div'); mpActions.className='action-row';
    mpActions.innerHTML = `<button class="pill-btn ghost" id="bReversePath">↔ Reverse Path</button>`;
    body.appendChild(mpActions);
    mpActions.querySelector('#bReversePath').addEventListener('click', ()=>{ reverseMotionPath(clip); renderAnimationPanel(clip); });
    body.appendChild(mkHint('Jalur gerak (garis putus-putus hijau) tampil langsung di preview — geser titiknya untuk mengubah posisi keyframe X/Y sekaligus. Kecepatan sepanjang jalur mengikuti jarak antar keyframe di timeline.'));
  }

  const dur=clip.duration||1;
  const pts = ()=> (clip.keyframes||[]).filter(k=>k.prop===curProp).sort((a,b)=>a.time-b.time);
  const selected = App._kfSelected; // {prop,time} identity of the tapped keyframe, since objects get re-sorted/cloned
  const findKf = (p,t)=> (clip.keyframes||[]).find(k=>k.prop===p && Math.abs(k.time-t)<0.001);

  // View toggle: simple timeline track vs full Graph Editor
  const viewRow=document.createElement('div'); viewRow.className='panel-tabgroup';
  ['track','graph'].forEach(v=>{
    const b=document.createElement('button'); b.textContent = v==='track'?'Timeline':'📈 Graph Editor';
    if((App._kfView||'track')===v) b.classList.add('active');
    b.addEventListener('click', ()=>{ App._kfView=v; renderAnimationPanel(clip); });
    viewRow.appendChild(b);
  });
  body.appendChild(viewRow);

  if((App._kfView||'track')==='track'){
    body.appendChild(buildKeyframeTrack(clip, curProp, dur, selected, findKf));
  } else {
    body.appendChild(buildGraphEditor(clip, curProp, dur, selected, findKf));
  }
  body.appendChild(mkHint('Ketuk keyframe untuk memilih, geser untuk memindah waktunya. Tahan (long-press) untuk multi-select. Di Graph Editor, geser titik untuk ubah waktu+nilai sekaligus, geser handle bulat untuk atur kurva bezier.'));

  // ---- Selected keyframe editor: easing/value/actions ----
  const selKf = selected? findKf(selected.prop, selected.time) : null;
  if(selKf){
    const easeLabel=document.createElement('div'); easeLabel.className='muted'; easeLabel.style.margin='10px 2px 6px'; easeLabel.textContent='Interpolation (kurva menuju keyframe ini)';
    body.appendChild(easeLabel);
    const easeRow=document.createElement('div'); easeRow.className='panel-tabgroup';
    ['linear','easeIn','easeOut','easeInOut','smooth','hold','cubic','back','elastic','bounce','expo','bezier'].forEach(e=>{
      const b=document.createElement('button'); b.textContent=e;
      if((selKf.easing||'linear')===e) b.classList.add('active');
      b.addEventListener('click', ()=>{
        selKf.easing=e;
        if(e==='bezier' && !selKf.bezier) selKf.bezier={x1:0.25,y1:0.1,x2:0.75,y2:0.9};
        renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
      });
      easeRow.appendChild(b);
    });
    body.appendChild(easeRow);

    const presetLabel=document.createElement('div'); presetLabel.className='muted'; presetLabel.style.margin='10px 2px 6px'; presetLabel.textContent='Preset Curve';
    body.appendChild(presetLabel);
    const presetRow=document.createElement('div'); presetRow.className='panel-tabgroup';
    Object.keys(CURVE_PRESETS).forEach(name=>{
      const b=document.createElement('button'); b.textContent=name;
      b.addEventListener('click', ()=>{
        const preset=CURVE_PRESETS[name];
        selKf.easing=preset.easing;
        if(preset.easing==='bezier') selKf.bezier=Object.assign({},preset.bezier);
        renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
      });
      presetRow.appendChild(b);
    });
    body.appendChild(presetRow);

    const [rmin,rmax]=KF_PROP_RANGES[curProp]||[-500,500];
    body.appendChild(sliderRow('Nilai keyframe ini', selKf.value, rmin, rmax, curProp==='rotation'?1:0.01, (v,commit)=>{
      selKf.value=v; Editor.renderFrame(Editor.curTime); if(commit){ renderAnimationPanel(clip); pushUndoSnapshot(); }
    }));

    const kfActions=document.createElement('div'); kfActions.className='action-row';
    kfActions.innerHTML = `<button class="pill-btn ghost" id="bKfDup">Duplikat</button><button class="pill-btn ghost" id="bKfCopy">Copy Curve</button><button class="pill-btn ghost" id="bKfPaste">Paste Curve</button><button class="pill-btn ghost" id="bKfReset">Reset Curve</button><button class="pill-btn ghost" id="bKfDel">Hapus</button>`;
    body.appendChild(kfActions);
    kfActions.querySelector('#bKfDup').addEventListener('click', ()=>{
      const copy=Object.assign({},selKf); copy.time = clamp(selKf.time+Math.max(0.1,dur*0.05),0,dur);
      clip.keyframes.push(copy); App._kfSelected={prop:curProp,time:copy.time};
      renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    kfActions.querySelector('#bKfCopy').addEventListener('click', ()=>{
      App._curveClipboard = {easing:selKf.easing, bezier: selKf.bezier?Object.assign({},selKf.bezier):null};
      toast('Kurva disalin');
    });
    kfActions.querySelector('#bKfPaste').addEventListener('click', ()=>{
      if(!App._curveClipboard){ toast('Belum ada kurva yang disalin'); return; }
      selKf.easing = App._curveClipboard.easing;
      selKf.bezier = App._curveClipboard.bezier? Object.assign({},App._curveClipboard.bezier) : undefined;
      renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    kfActions.querySelector('#bKfReset').addEventListener('click', ()=>{
      selKf.easing='linear'; delete selKf.bezier;
      renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    kfActions.querySelector('#bKfDel').addEventListener('click', ()=>{
      clip.keyframes = clip.keyframes.filter(k=>k!==selKf);
      App._kfSelected=null;
      renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
  }

  // ---- Multi-select bulk actions ----
  const multi = App._kfMultiSelect && App._kfMultiSelect.length>1 ? App._kfMultiSelect : null;
  if(multi){
    const multiHint=document.createElement('div'); multiHint.className='muted'; multiHint.style.margin='8px 2px';
    multiHint.textContent = multi.length+' keyframe dipilih. Geser salah satu titik untuk menggeser semuanya bersamaan.';
    body.appendChild(multiHint);
    const multiActions=document.createElement('div'); multiActions.className='action-row';
    multiActions.innerHTML = `<button class="pill-btn ghost" id="bMultiDel">Hapus Semua</button><button class="pill-btn ghost" id="bMultiClear">Batal Pilih</button>`;
    body.appendChild(multiActions);
    multiActions.querySelector('#bMultiDel').addEventListener('click', ()=>{
      clip.keyframes = clip.keyframes.filter(k=> !multi.some(m=>m.prop===k.prop && Math.abs(m.time-k.time)<0.001));
      App._kfMultiSelect=[]; App._kfSelected=null;
      renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    multiActions.querySelector('#bMultiClear').addEventListener('click', ()=>{ App._kfMultiSelect=[]; renderAnimationPanel(clip); });
  }

  const curVal = interpKeyframes(clip, clamp(Editor.curTime-clip.start,0,dur))[curProp];
  const addLabel=document.createElement('div'); addLabel.className='muted'; addLabel.style.margin='10px 2px 0'; addLabel.textContent='Nilai saat ini: '+Number(curVal).toFixed(2);
  body.appendChild(addLabel);
  const actions=document.createElement('div'); actions.className='action-row';
  actions.innerHTML = `<button class="pill-btn accent" id="bAddKf">+ Add Keyframe di Playhead</button>`;
  body.appendChild(actions);
  actions.querySelector('#bAddKf').addEventListener('click', ()=>{
    const localTime = clamp(Editor.curTime-clip.start,0,dur);
    const currentVal = interpKeyframes(clip, localTime)[curProp];
    clip.keyframes = clip.keyframes||[];
    clip.keyframes = clip.keyframes.filter(k=>!(k.prop===curProp && Math.abs(k.time-localTime)<0.05));
    clip.keyframes.push({prop:curProp, time:localTime, value: currentVal, easing:'linear'});
    App._kfSelected = {prop:curProp, time:localTime};
    renderAnimationPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });
}
function mkHint(text){ const d=document.createElement('div'); d.className='muted small'; d.style.margin='6px 0 14px'; d.textContent=text; return d; }

/* Simple horizontal timeline of diamonds for the selected prop — supports
   tap-to-select, drag-to-move (with snap to playhead/whole tenths/other
   keyframes), and long-press to toggle multi-select. */
function buildKeyframeTrack(clip, curProp, dur, selected, findKf){
  const track=document.createElement('div'); track.className='keyframe-track';
  (clip.keyframes||[]).filter(k=>k.prop===curProp).forEach(k=>{
    const dot=document.createElement('div'); dot.className='keyframe-dot';
    dot.style.left = clamp((k.time/dur)*100,0,100)+'%';
    const isSel = selected && selected.prop===curProp && Math.abs(selected.time-k.time)<0.001;
    const inMulti = (App._kfMultiSelect||[]).some(m=>m.prop===curProp && Math.abs(m.time-k.time)<0.001);
    if(isSel) dot.classList.add('selected');
    if(inMulti) dot.classList.add('multi-selected');

    let dragging=false, startX=0, startTime=k.time, longPressTimer=null, moved=false;
    dot.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      startX=e.clientX; startTime=k.time; moved=false;
      longPressTimer=setTimeout(()=>{
        App._kfMultiSelect = App._kfMultiSelect||[];
        const idx = App._kfMultiSelect.findIndex(m=>m.prop===curProp && Math.abs(m.time-k.time)<0.001);
        if(idx>=0) App._kfMultiSelect.splice(idx,1); else App._kfMultiSelect.push({prop:curProp,time:k.time});
        renderAnimationPanel(clip);
      }, 480);
      const onMove=ev=>{
        if(Math.abs(ev.clientX-startX)>4 && longPressTimer){ clearTimeout(longPressTimer); longPressTimer=null; }
        if(longPressTimer) return;
        dragging=true; moved=true;
        const trackRect = track.getBoundingClientRect();
        let nt = clamp(startTime + ((ev.clientX-startX)/trackRect.width)*dur, 0, dur);
        const snapTargets = [Editor.curTime-clip.start, 0, dur].concat((clip.keyframes||[]).filter(x=>x!==k).map(x=>x.time));
        const snapPx = 6/trackRect.width*dur;
        for(const s of snapTargets){ if(Math.abs(nt-s)<snapPx){ nt=s; break; } }
        const delta = nt-k.time;
        const group = (App._kfMultiSelect&&App._kfMultiSelect.some(m=>m.prop===curProp&&Math.abs(m.time-startTime)<0.001)) ? App._kfMultiSelect : [{prop:curProp,time:k.time}];
        group.forEach(g=>{ const gk=findKf(g.prop,g.time); if(gk) gk.time=clamp(gk.time+delta,0,dur); });
        if(group.length===1) k.time=nt;
        Editor.renderFrame(Editor.curTime);
        dot.style.left = clamp((k.time/dur)*100,0,100)+'%';
      };
      const onUp=()=>{
        if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer=null; }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if(moved){ renderAnimationPanel(clip); pushUndoSnapshot(); }
        else if(!dragging){ App._kfSelected={prop:curProp,time:k.time}; renderAnimationPanel(clip); }
        dragging=false;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    track.appendChild(dot);
  });
  const playheadMark=document.createElement('div'); playheadMark.className='keyframe-playhead';
  playheadMark.style.left = clamp(((Editor.curTime-clip.start)/dur)*100,0,100)+'%';
  track.appendChild(playheadMark);
  return track;
}

/* Fase 3 — Graph / Curve Editor: value-vs-time canvas for the selected
   prop, with draggable keyframe points and (for bezier segments)
   draggable handles. Auto-fits to the clip's duration and the prop's
   authored value range from KF_PROP_RANGES. */
function buildGraphEditor(clip, curProp, dur, selected, findKf){
  const wrap=document.createElement('div'); wrap.className='graph-editor-wrap';
  const canvas=document.createElement('canvas'); canvas.className='graph-editor-canvas';
  wrap.appendChild(canvas);

  const pts = ()=> (clip.keyframes||[]).filter(k=>k.prop===curProp).sort((a,b)=>a.time-b.time);
  const [rangeMin,rangeMax] = KF_PROP_RANGES[curProp]||[-500,500];
  let padL=34, padR=14, padT=14, padB=20;

  function toXY(t,v,w,h){
    const x = padL + (t/Math.max(dur,0.001))*(w-padL-padR);
    const y = padT + (1-(v-rangeMin)/(rangeMax-rangeMin))*(h-padT-padB);
    return [x,y];
  }
  function fromX(x,w){ return clamp(((x-padL)/(w-padL-padR))*dur, 0, dur); }
  function fromY(y,h){ return clamp(rangeMin + (1-(y-padT)/(h-padT-padB))*(rangeMax-rangeMin), rangeMin, rangeMax); }

  function draw(){
    const w = wrap.clientWidth||320, h=180;
    canvas.width=w*2; canvas.height=h*2; canvas.style.width=w+'px'; canvas.style.height=h+'px';
    const ctx=canvas.getContext('2d'); ctx.scale(2,2);
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1;
    for(let i=0;i<=4;i++){ const y=padT+i*(h-padT-padB)/4; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke(); }
    ctx.fillStyle='#6FA98A'; ctx.font='10px sans-serif'; ctx.textAlign='right';
    for(let i=0;i<=2;i++){ const v=rangeMax-i*(rangeMax-rangeMin)/2; const y=padT+i*(h-padT-padB)/2; ctx.fillText(v.toFixed(1), padL-6, y+3); }

    const list = pts();
    if(list.length){
      ctx.strokeStyle='#00FF6A'; ctx.lineWidth=2; ctx.beginPath();
      const SEG=24;
      for(let i=0;i<list.length-1;i++){
        const a=list[i], b=list[i+1];
        for(let s=0;s<=SEG;s++){
          const tt=s/SEG;
          const te=ease(b.easing||'linear', tt, b.bezier);
          const v=a.value+(b.value-a.value)*te;
          const t=a.time+(b.time-a.time)*tt;
          const [x,y]=toXY(t,v,w,h);
          if(s===0 && i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
      }
      // flat extension before first / after last keyframe
      const [fx,fy]=toXY(0, list[0].value, w,h); const [lx,ly]=toXY(dur, list[list.length-1].value, w,h);
      ctx.stroke();
      ctx.setLineDash([3,3]); ctx.strokeStyle='rgba(0,255,106,.35)';
      ctx.beginPath(); const [x0,y0]=toXY(list[0].time,list[0].value,w,h); ctx.moveTo(fx,fy); ctx.lineTo(x0,y0); ctx.stroke();
      const last=list[list.length-1]; const [xE,yE]=toXY(last.time,last.value,w,h);
      ctx.beginPath(); ctx.moveTo(xE,yE); ctx.lineTo(lx,ly); ctx.stroke();
      ctx.setLineDash([]);

      // playhead
      const [px]=toXY(clamp(Editor.curTime-clip.start,0,dur),0,w,h);
      ctx.strokeStyle='#fff'; ctx.beginPath(); ctx.moveTo(px,padT); ctx.lineTo(px,h-padB); ctx.stroke();

      // bezier handles for the segment ending at the selected keyframe
      if(selected){
        const selK = findKf(selected.prop, selected.time);
        const idx = list.indexOf(selK);
        if(selK && selK.easing==='bezier' && selK.bezier && idx>0){
          const a=list[idx-1], b=selK;
          const [ax,ay]=toXY(a.time,a.value,w,h), [bx,by]=toXY(b.time,b.value,w,h);
          const h1x = ax+(bx-ax)*selK.bezier.x1, h1y = ay-(ay-by)*selK.bezier.y1;
          const h2x = ax+(bx-ax)*selK.bezier.x2, h2y = ay-(ay-by)*selK.bezier.y2;
          ctx.strokeStyle='#FF2E7A'; ctx.setLineDash([2,2]);
          ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(h1x,h1y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(h2x,h2y); ctx.stroke();
          ctx.setLineDash([]);
          [[h1x,h1y],[h2x,h2y]].forEach(([hx,hy])=>{ ctx.fillStyle='#FF2E7A'; ctx.beginPath(); ctx.arc(hx,hy,4,0,7); ctx.fill(); });
        }
      }

      // keyframe points
      list.forEach(k=>{
        const [x,y]=toXY(k.time,k.value,w,h);
        const isSel = selected && selected.prop===curProp && Math.abs(selected.time-k.time)<0.001;
        ctx.fillStyle = isSel? '#fff' : '#00FF6A';
        ctx.strokeStyle='#02150B'; ctx.lineWidth=1.5;
        ctx.save(); ctx.translate(x,y); ctx.rotate(Math.PI/4); ctx.fillRect(-5,-5,10,10); ctx.strokeRect(-5,-5,10,10); ctx.restore();
      });
    } else {
      ctx.fillStyle='#6FA98A'; ctx.font='12px sans-serif'; ctx.textAlign='center';
      ctx.fillText('Belum ada keyframe untuk properti ini', w/2, h/2);
    }
  }
  requestAnimationFrame(draw);
  window.addEventListener('resize', draw);

  canvas.addEventListener('pointerdown', e=>{
    const rect=canvas.getBoundingClientRect();
    const w=rect.width, h=rect.height;
    const mx=e.clientX-rect.left, my=e.clientY-rect.top;
    const list=pts();

    // hit-test bezier handles first (only visible for the selected segment)
    if(selected){
      const selK=findKf(selected.prop,selected.time);
      const idx=list.indexOf(selK);
      if(selK && selK.easing==='bezier' && selK.bezier && idx>0){
        const a=list[idx-1], b=selK;
        const [ax,ay]=toXY(a.time,a.value,w,h), [bx,by]=toXY(b.time,b.value,w,h);
        const handles = [
          ['x1','y1', ax+(bx-ax)*selK.bezier.x1, ay-(ay-by)*selK.bezier.y1],
          ['x2','y2', ax+(bx-ax)*selK.bezier.x2, ay-(ay-by)*selK.bezier.y2],
        ];
        for(const [kx,ky,hx,hy] of handles){
          if(Math.hypot(mx-hx,my-hy)<14){
            const onMove=ev=>{
              const mx2=ev.clientX-rect.left, my2=ev.clientY-rect.top;
              const nx = clamp((mx2-ax)/(bx-ax||1),0,1);
              const ny = clamp((ay-my2)/(ay-by||1),0,1);
              selK.bezier[kx]=nx; selK.bezier[ky]=ny;
              Editor.renderFrame(Editor.curTime); draw();
            };
            const onUp=()=>{ window.removeEventListener('pointermove',onMove); window.removeEventListener('pointerup',onUp); pushUndoSnapshot(); };
            window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
            return;
          }
        }
      }
    }
    // hit-test keyframe points → select, or drag to move time+value together
    for(const k of list){
      const [x,y]=toXY(k.time,k.value,w,h);
      if(Math.hypot(mx-x,my-y)<14){
        let moved=false;
        const onMove=ev=>{
          moved=true;
          const mx2=ev.clientX-rect.left, my2=ev.clientY-rect.top;
          k.time = fromX(mx2,w); k.value = fromY(my2,h);
          Editor.renderFrame(Editor.curTime); draw();
        };
        const onUp=()=>{
          window.removeEventListener('pointermove',onMove); window.removeEventListener('pointerup',onUp);
          App._kfSelected={prop:curProp,time:k.time};
          renderAnimationPanel(clip);
          if(moved) pushUndoSnapshot();
        };
        window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
        return;
      }
    }
  });

  return wrap;
}

/* ---- Effect tab ---- */
function renderEffectPanel(clip){
  $('#panelTitle').textContent='Effect';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('effect'));

  // Fase 7 — Effect Search: type-to-filter across every category/effect,
  // not just the currently selected category tab.
  const searchInput=document.createElement('input'); searchInput.type='text'; searchInput.placeholder='Cari effect… (mis. "shake")';
  searchInput.className='layer-name-input'; searchInput.value = App._fxSearch||'';
  searchInput.addEventListener('input', ()=>{ App._fxSearch=searchInput.value; renderEffectPanel(clip); });
  body.appendChild(searchInput);

  const cats=Object.keys(EFFECT_CATEGORIES);
  const query = (App._fxSearch||'').trim().toLowerCase();
  const favs = getFavoriteEffects();

  if(query){
    const results=[];
    cats.forEach(c=> EFFECT_CATEGORIES[c].forEach(([label,type])=>{ if(label.toLowerCase().includes(query)) results.push([c,label,type]); }));
    body.appendChild(mkHint(results.length? `${results.length} hasil untuk "${query}"` : `Tidak ada effect bernama "${query}"`));
    const grid=document.createElement('div'); grid.className='preset-grid';
    results.forEach(([cat,label,type])=> grid.appendChild(buildEffectItem(clip,cat,label,type,favs)));
    body.appendChild(grid);
  } else {
    // Favorites row (only shown when at least one effect is starred)
    if(favs.length){
      const favLabel=document.createElement('div'); favLabel.className='muted'; favLabel.style.margin='6px 2px'; favLabel.textContent='⭐ Favorite';
      body.appendChild(favLabel);
      const favGrid=document.createElement('div'); favGrid.className='preset-grid';
      favs.forEach(type=>{
        for(const c of cats){ const found=EFFECT_CATEGORIES[c].find(([l,t])=>t===type); if(found){ favGrid.appendChild(buildEffectItem(clip,c,found[0],type,favs)); break; } }
      });
      body.appendChild(favGrid);
    }
    // Recent effects (last 8 distinct types added across the project, most-recent first)
    if(App._recentEffects && App._recentEffects.length){
      const recLabel=document.createElement('div'); recLabel.className='muted'; recLabel.style.margin='10px 2px 6px'; recLabel.textContent='🕘 Recent';
      body.appendChild(recLabel);
      const recGrid=document.createElement('div'); recGrid.className='preset-grid';
      App._recentEffects.forEach(type=>{
        for(const c of cats){ const found=EFFECT_CATEGORIES[c].find(([l,t])=>t===type); if(found){ recGrid.appendChild(buildEffectItem(clip,c,found[0],type,favs)); break; } }
      });
      body.appendChild(recGrid);
    }

    const catRow=document.createElement('div'); catRow.className='panel-tabgroup';
    let curCat = App._fxCurCat || cats[0];
    cats.forEach(c=>{ const b=document.createElement('button'); b.textContent=c; if(c===curCat) b.classList.add('active');
      b.addEventListener('click', ()=>{ App._fxCurCat=c; renderEffectPanel(clip); }); catRow.appendChild(b); });
    body.appendChild(catRow);

    const grid=document.createElement('div'); grid.className='preset-grid';
    EFFECT_CATEGORIES[curCat].forEach(([label,type])=> grid.appendChild(buildEffectItem(clip,curCat,label,type,favs)));
    body.appendChild(grid);

    renderUserPresetList(body, 'effect', data=>{
      clip.effects = clip.effects||[];
      data.forEach(fx=>{
        if(!clip.effects.some(e=>e.type===fx.type)) clip.effects.push(Object.assign({},fx,{id:uid('fx')}));
      });
      renderEffectPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
      toast('Preset diterapkan');
    });
  }

  // ---- Active effects stack: enable/disable, reorder, duplicate, delete ----
  const active = clip.effects||[];
  if(active.length){
    const activeLabel=document.createElement('div'); activeLabel.className='muted'; activeLabel.style.margin='14px 2px 6px'; activeLabel.textContent='Effect Aktif (urutan mempengaruhi hasil)';
    body.appendChild(activeLabel);
    active.forEach((fx,i)=>{
      const row=document.createElement('div'); row.className='fx-active-row'+(fx.enabled===false?' disabled':'');
      const head=document.createElement('div'); head.className='fx-active-head';
      head.innerHTML = `<span>${escapeHtml(fx.label)}</span>`;
      const ctrls=document.createElement('div'); ctrls.className='fx-active-ctrls';
      const mkBtn=(txt,title,fn)=>{ const b=document.createElement('button'); b.textContent=txt; b.title=title; b.addEventListener('click',fn); return b; };
      ctrls.appendChild(mkBtn(fx.enabled===false?'👁‍🗨':'👁','Enable/disable', ()=>{ fx.enabled = fx.enabled===false; Editor.renderFrame(Editor.curTime); renderEffectPanel(clip); pushUndoSnapshot(); }));
      ctrls.appendChild(mkBtn('⬆','Naikkan urutan', ()=>{ if(i>0){ [active[i-1],active[i]]=[active[i],active[i-1]]; Editor.renderFrame(Editor.curTime); renderEffectPanel(clip); pushUndoSnapshot(); } }));
      ctrls.appendChild(mkBtn('⬇','Turunkan urutan', ()=>{ if(i<active.length-1){ [active[i+1],active[i]]=[active[i],active[i+1]]; Editor.renderFrame(Editor.curTime); renderEffectPanel(clip); pushUndoSnapshot(); } }));
      ctrls.appendChild(mkBtn('⧉','Duplikat', ()=>{ active.splice(i+1,0,Object.assign({},fx,{id:uid('fx'),params:Object.assign({},fx.params)})); renderEffectPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
      ctrls.appendChild(mkBtn('✕','Hapus', ()=>{ active.splice(i,1); renderEffectPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
      head.appendChild(ctrls);
      row.appendChild(head);
      const range = intensityRangeFor(fx.category, fx.type);
      row.appendChild(sliderRow('Intensity', fx.params.amount, range.min, range.max, range.step, (v,commit)=>{
        fx.params.amount=v; Editor.renderFrame(Editor.curTime); if(commit) pushUndoSnapshot();
      }));
      body.appendChild(row);
    });
    const actions=document.createElement('div'); actions.className='action-row';
    actions.innerHTML = `<button class="pill-btn ghost" id="bSavePreset">Save as Preset</button>`;
    body.appendChild(actions);
    actions.querySelector('#bSavePreset').addEventListener('click', saveCurrentPreset);
  }
}
function buildEffectItem(clip, cat, label, type, favs){
  const wrap=document.createElement('div'); wrap.className='preset-item-wrap';
  const active = (clip.effects||[]).some(e=>e.type===type);
  const item=document.createElement('button'); item.className='preset-item'+(active?' active':''); item.textContent=label;
  item.addEventListener('click', ()=>{
    clip.effects = clip.effects||[];
    const idx = clip.effects.findIndex(e=>e.type===type);
    if(idx>=0){ clip.effects.splice(idx,1); }
    else {
      clip.effects.push({id:uid('fx'), category:cat, type, label, params:{amount: defaultAmountFor(cat, type)}, enabled:true});
      App._recentEffects = [type].concat((App._recentEffects||[]).filter(t=>t!==type)).slice(0,8);
    }
    renderEffectPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });
  wrap.appendChild(item);
  const star=document.createElement('button'); star.className='preset-fav-star'+(favs.includes(type)?' active':''); star.textContent=favs.includes(type)?'★':'☆';
  star.addEventListener('click', e=>{ e.stopPropagation(); toggleFavoriteEffect(type); renderEffectPanel(clip); });
  wrap.appendChild(star);
  return wrap;
}
function defaultAmountFor(cat, type){
  const overrides = { pixelateFx:16, posterizeFx:6, levelsFx:0, displacement:14, neon:0.6 };
  if(type && overrides[type]!==undefined) return overrides[type];
  if(cat==='Beat'||cat==='Zoom') return 0.3;
  if(cat==='Stylize') return 20;
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
function intensityRangeFor(cat, type){
  // Fase 7 — a few new effects need their own natural range regardless
  // of which category slider governs everything else in that category.
  const overrides = {
    pixelateFx: {min:2,max:64,step:1}, posterizeFx: {min:2,max:16,step:1},
    levelsFx: {min:0,max:100,step:1}, displacement: {min:0,max:60,step:1}, neon: {min:0,max:1,step:0.01},
  };
  if(type && overrides[type]) return overrides[type];
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
  return {min:0,max:100,step:1};}
/* Fase 9 — generic "My Presets" list UI: shown in Effect / Color /
   Text / Transition panels. `onApply(data)` gets the saved preset's raw
   data object; `body` is whatever panel element to append into. */
function renderUserPresetList(body, kind, onApply){
  const list = getUserPresets(kind);
  if(!list.length) return;
  const label=document.createElement('div'); label.className='muted'; label.style.margin='12px 2px 6px'; label.textContent='My Presets';
  body.appendChild(label);
  const wrap=document.createElement('div'); wrap.className='mask-list';
  list.forEach(p=>{
    const row=document.createElement('div'); row.className='mask-list-row';
    const nameBtn=document.createElement('span'); nameBtn.textContent=p.name; nameBtn.style.cursor='pointer'; nameBtn.style.flex='1';
    nameBtn.addEventListener('click', ()=> onApply(p.data));
    row.appendChild(nameBtn);
    const del=document.createElement('button'); del.className='mask-list-del'; del.textContent='✕';
    del.addEventListener('click', e=>{ e.stopPropagation(); deleteUserPreset(kind, p.id); row.remove(); if(!wrap.children.length){ wrap.remove(); label.remove(); } });
    row.appendChild(del);
    wrap.appendChild(row);
  });
  body.appendChild(wrap);
}
function saveCurrentPreset(){
  const clip=getSelectedClip(); if(!clip) return;
  const name = prompt('Nama preset:', 'My Preset');
  if(!name) return;
  addUserPreset('effect', name, deepClone(clip.effects));
  toast('Preset disimpan ke My Presets');
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
  actions.innerHTML=`<button class="pill-btn ghost" id="bResetAdjust">Reset</button><button class="pill-btn ghost" id="bSaveColorPreset">Save as Preset</button>`;
  body.appendChild(actions);
  $('#bResetAdjust').addEventListener('click', ()=>{ clip.adjust={}; renderAdjustPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
  $('#bSaveColorPreset').addEventListener('click', ()=>{
    const name=prompt('Nama preset warna:','My Color'); if(!name) return;
    addUserPreset('adjust', name, deepClone(clip.adjust));
    renderAdjustPanel(clip); toast('Preset warna disimpan');
  });
  renderUserPresetList(body, 'adjust', data=>{
    clip.adjust = Object.assign({}, deepClone(data));
    renderAdjustPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    toast('Preset diterapkan');
  });

  // Fase 8 — Audio-Reactive: this VISUAL layer's transform pulses along
  // with the project's bass energy, sampled from the root audio track.
  const arLabel=document.createElement('div'); arLabel.className='muted'; arLabel.style.margin='16px 2px 6px'; arLabel.textContent='🔊 Audio-Reactive';
  body.appendChild(arLabel);
  clip.audioReactive = clip.audioReactive || {enabled:false, target:'scale', amount:0.4};
  const ar = clip.audioReactive;
  body.appendChild(toggleRowEl('Aktifkan', !!ar.enabled, v=>{ ar.enabled=v; renderAdjustPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));
  if(ar.enabled){
    const targetRow=document.createElement('div'); targetRow.className='panel-tabgroup';
    [['Scale','scale'],['Position','position'],['Rotation','rotation'],['Glow','glow'],['Shake','shake'],['Opacity','opacity']].forEach(([label,val])=>{
      const b=document.createElement('button'); b.textContent=label; if(ar.target===val) b.classList.add('active');
      b.addEventListener('click', ()=>{ ar.target=val; renderAdjustPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
      targetRow.appendChild(b);
    });
    body.appendChild(targetRow);
    body.appendChild(sliderRow('Sensitivitas', ar.amount, 0, 1, 0.01, (v,c)=>{ ar.amount=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
    const hasAudio = App.project.tracks.find(tr=>tr.kind==='audio').clips.length>0;
    if(!hasAudio) body.appendChild(mkHint('Belum ada audio di project — tambahkan lewat menu + > Audio supaya efek ini benar-benar bereaksi.'));
  }
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

  // Fase 4 — Reverse & Freeze Frame (only meaningful for video clips)
  if(clip.type==='video'){
    const revRow=document.createElement('div'); revRow.className='toggle-row';
    revRow.innerHTML = `<span>Reverse (putar mundur)</span><div class="switch ${clip.reversed?'on':''}"></div>`;
    revRow.querySelector('.switch').addEventListener('click', function(){
      clip.reversed = !clip.reversed;
      this.classList.toggle('on', clip.reversed);
      Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    });
    body.appendChild(revRow);
    body.appendChild(mkHint('Video akan diputar mundur dengan cara di-seek manual (bukan pemutaran mundur asli), jadi bisa terasa kurang mulus dibanding maju.'));

    const freezeActions=document.createElement('div'); freezeActions.className='action-row';
    freezeActions.innerHTML = `<button class="pill-btn ghost" id="bFreezeFrame">❄️ Freeze Frame di Playhead</button>`;
    body.appendChild(freezeActions);
    freezeActions.querySelector('#bFreezeFrame').addEventListener('click', ()=> freezeFrameAtPlayhead(clip));
    body.appendChild(mkHint('Menyisipkan frame diam (1.5 detik) tepat di posisi playhead, memotong clip menjadi dua di sekitarnya.'));
  }
}
/* Fase 4 — Freeze Frame: captures the exact frame under the playhead as a
   still image, splits the clip there, and inserts that still as a new
   image clip for a fixed hold duration — a real still image, not a
   simulated pause. */
async function freezeFrameAtPlayhead(clip){
  const t = Editor.curTime;
  if(t<=clip.start+0.05 || t>=clip.start+clip.duration-0.05){ toast('Playhead harus berada di tengah clip'); return; }
  const entry = App.mediaCache[clip.mediaId];
  const videoEl = entry && entry.el;
  if(!videoEl){ toast('Media video tidak ditemukan'); return; }

  const localTime = t-clip.start;
  const sourceTime = (clip.trimStart||0) + localTime*(clip.speed||1);
  await new Promise(resolve=>{
    const onSeeked=()=>{ videoEl.removeEventListener('seeked', onSeeked); resolve(); };
    videoEl.addEventListener('seeked', onSeeked);
    try{ videoEl.currentTime = sourceTime; }catch(e){ resolve(); }
    setTimeout(resolve, 300); // safety timeout if 'seeked' never fires
  });

  const canvas=document.createElement('canvas');
  canvas.width = videoEl.videoWidth||1080; canvas.height = videoEl.videoHeight||1920;
  const cctx = canvas.getContext('2d');
  try{ cctx.drawImage(videoEl,0,0,canvas.width,canvas.height); }catch(e){ toast('Gagal mengambil frame'); return; }

  const blob = await new Promise(res=> canvas.toBlob(res,'image/jpeg',0.92));
  if(!blob){ toast('Gagal mengambil frame'); return; }
  const mediaId = uid('MED');
  const url = URL.createObjectURL(blob);
  await idbPutMedia({ id:mediaId, blob });
  App.project.mediaLibrary.push({ id:mediaId, kind:'image', name:'Freeze Frame', duration:3, width:canvas.width, height:canvas.height });
  App.mediaCache[mediaId] = { blob, url, kind:'image', width:canvas.width, height:canvas.height, duration:3, el:(()=>{ const im=new Image(); im.src=url; return im; })() };

  const freezeDur = 1.5;
  const track = getClipTrack(clip.id);
  // split the original clip at the playhead
  const rightPart = deepClone(clip);
  rightPart.id = uid('clip');
  rightPart.start = t+freezeDur;
  rightPart.duration = clip.duration - localTime;
  if(clip.trimStart!==undefined) rightPart.trimStart = clip.trimStart + localTime*(clip.speed||1);
  clip.duration = localTime;
  if(clip.keyframes){ clip.keyframes = clip.keyframes.filter(k=>k.time<=localTime); rightPart.keyframes = rightPart.keyframes.filter(k=>k.time>=localTime).map(k=>({...k,time:k.time-localTime})); }

  // shift every later clip in the same track to make room
  track.clips.forEach(c=>{ if(c.start>=t-0.001) c.start += freezeDur; });

  const freezeClip = {
    id: uid('clip'), type:'image', mediaId, name:'Freeze Frame',
    start:t, duration:freezeDur, trimStart:0, trimEnd:freezeDur, speed:1, fit:clip.fit||'fill',
    effects:[], keyframes:[], adjust:Object.assign({},clip.adjust||{}), mask:null, transitionOut:null,
    baseTransform: deepClone(clip.baseTransform||{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100}),
  };
  ensureLayerFields(freezeClip, nextZIndex());
  track.clips.push(rightPart);
  track.clips.push(freezeClip);
  computeProjectDuration(); Editor.renderTimeline(); selectClip(freezeClip.id);
  toast('Freeze frame ditambahkan');
  pushUndoSnapshot();
}
function applySpeed(clip, newSpeed){
  const span = (clip.trimEnd!==undefined? clip.trimEnd-clip.trimStart : clip.duration*(clip.speed||1));
  clip.speed = newSpeed;
  if(clip.type==='video'||clip.type==='audio'){ clip.duration = Math.max(0.1, span/newSpeed); }
  computeProjectDuration(); Editor.renderTimeline(); Editor.renderFrame(Editor.curTime);
}

/* ---- Mask tab (Fase 6: multi-mask stack + Pen Tool for Custom Path) ---- */
function renderMaskPanel(clip){
  $('#panelTitle').textContent='Mask';
  const body=$('#panelBody'); body.innerHTML='';
  body.appendChild(tabStripEl('mask'));
  clip.masks = clip.masks||[];

  const addRow=document.createElement('div'); addRow.className='action-row';
  addRow.innerHTML = `<button class="pill-btn accent" id="bAddMask">+ Tambah Mask</button>`;
  body.appendChild(addRow);
  addRow.querySelector('#bAddMask').addEventListener('click', ()=>{
    clip.masks.push({id:uid('mask'), shape:'Circle', mode: clip.masks.length? 'add':'add', invert:false,
      x:0,y:0,rotation:0,scale:1,width:70,height:70,feather:12,opacity:1,expansion:0,pos:0.5,sides:6,points:[]});
    App._maskEditIndex = clip.masks.length-1;
    renderMaskPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });

  if(!clip.masks.length){ body.appendChild(mkHint('Belum ada mask. Bisa tambah lebih dari satu, digabung dengan mode Add/Subtract/Intersect/Difference.')); return; }

  const listWrap=document.createElement('div'); listWrap.className='mask-list';
  clip.masks.forEach((mask,i)=>{
    const row=document.createElement('div'); row.className='mask-list-row'+(App._maskEditIndex===i?' active':'');
    row.innerHTML = `<span>${i+1}. ${mask.shape}${i>0?' · '+(MASK_BLEND_MODES.find(m=>m[1]===(mask.mode||'add'))||['Add'])[0]:''}${mask.invert?' · Invert':''}</span>`;
    const del=document.createElement('button'); del.textContent='✕'; del.className='mask-list-del';
    del.addEventListener('click', e=>{ e.stopPropagation(); clip.masks.splice(i,1); App._maskEditIndex=null; renderMaskPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
    row.appendChild(del);
    row.addEventListener('click', ()=>{ App._maskEditIndex = App._maskEditIndex===i? null : i; renderMaskPanel(clip); });
    listWrap.appendChild(row);
  });
  body.appendChild(listWrap);

  const idx = App._maskEditIndex;
  if(idx===null || idx===undefined || !clip.masks[idx]) return;
  const mask = clip.masks[idx];

  const shapeRow=document.createElement('div'); shapeRow.className='panel-tabgroup';
  MASK_SHAPES.forEach(s=>{ const b=document.createElement('button'); b.textContent=s; if(mask.shape===s) b.classList.add('active');
    b.addEventListener('click', ()=>{ mask.shape=s; renderMaskPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }); shapeRow.appendChild(b); });
  body.appendChild(shapeRow);

  if(idx>0){
    const modeLabel=document.createElement('div'); modeLabel.className='muted'; modeLabel.style.margin='8px 2px 4px'; modeLabel.textContent='Gabung dengan mask di atasnya';
    body.appendChild(modeLabel);
    const modeRow=document.createElement('div'); modeRow.className='panel-tabgroup';
    MASK_BLEND_MODES.forEach(([label,val])=>{
      const b=document.createElement('button'); b.textContent=label; if((mask.mode||'add')===val) b.classList.add('active');
      b.addEventListener('click', ()=>{ mask.mode=val; renderMaskPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
      modeRow.appendChild(b);
    });
    body.appendChild(modeRow);
  }

  body.appendChild(toggleRowEl('Invert', !!mask.invert, v=>{ mask.invert=v; Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); }));

  if(mask.shape==='Polygon'){
    body.appendChild(sliderRow('Sisi (sides)', mask.sides||6, 3, 12, 1, (v,c)=>{ mask.sides=Math.round(v); Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  }
  if(mask.shape==='Custom Path'){
    const pathActions=document.createElement('div'); pathActions.className='action-row';
    pathActions.innerHTML = `<button class="pill-btn ghost" id="bEditPath">${App._penEditing? '✓ Selesai Edit Path':'✏️ Edit Path (Pen Tool)'}</button><button class="pill-btn ghost" id="bClearPath">Kosongkan</button>`;
    body.appendChild(pathActions);
    pathActions.querySelector('#bEditPath').addEventListener('click', ()=>{
      App._penEditing = !App._penEditing;
      App._penEditMaskIndex = App._penEditing? idx : null;
      renderMaskPanel(clip); updatePenToolOverlay();
    });
    pathActions.querySelector('#bClearPath').addEventListener('click', ()=>{ mask.points=[]; Editor.renderFrame(Editor.curTime); updatePenToolOverlay(); pushUndoSnapshot(); });
    body.appendChild(mkHint('Ketuk area preview untuk menambah titik, geser titik untuk memindah, tahan titik untuk menghapus. Path otomatis tertutup (garis lurus antar titik — belum mendukung kurva bezier per titik).'));
  }

  body.appendChild(sliderRow('Feather', mask.feather, 0, 60, 1, (v,c)=>{ mask.feather=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Opacity', mask.opacity, 0, 1, 0.01, (v,c)=>{ mask.opacity=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Position X', mask.x, -600, 600, 1, (v,c)=>{ mask.x=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Position Y', mask.y, -600, 600, 1, (v,c)=>{ mask.y=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Rotation', mask.rotation||0, -180, 180, 1, (v,c)=>{ mask.rotation=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Scale', mask.scale, 0.1, 2.5, 0.01, (v,c)=>{ mask.scale=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Width %', mask.width, 5, 100, 1, (v,c)=>{ mask.width=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Height %', mask.height, 5, 100, 1, (v,c)=>{ mask.height=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Expansion (px)', mask.expansion||0, -100, 100, 1, (v,c)=>{ mask.expansion=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
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

  const tPresetActions=document.createElement('div'); tPresetActions.className='action-row';
  tPresetActions.innerHTML = `<button class="pill-btn ghost" id="bSaveTransPreset">Save as Preset</button>`;
  body.appendChild(tPresetActions);
  tPresetActions.querySelector('#bSaveTransPreset').addEventListener('click', ()=>{
    const name=prompt('Nama preset transisi:','My Transition'); if(!name) return;
    addUserPreset('transition', name, deepClone(clip.transitionOut));
    toast('Preset transisi disimpan');
  });
  renderUserPresetList(body, 'transition', data=>{
    clip.transitionOut = deepClone(data);
    renderTransitionPanel(clip); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
    toast('Preset diterapkan');
  });
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

  // Fase 8 — Generate Beat Keyframes: turns beat markers into ready-made
  // pulse keyframes on a chosen clip+property, alternating between two
  // values on every Nth beat.
  const genLabel=document.createElement('div'); genLabel.className='muted'; genLabel.style.margin='16px 2px 6px'; genLabel.textContent='Generate Beat Keyframes';
  body.appendChild(genLabel);
  if(!App.project.beatMarkers.length){
    body.appendChild(mkHint('Deteksi atau tambahkan beat marker dulu di atas.'));
  } else {
    const selClip = getSelectedClip();
    if(!selClip || selClip.type==='audio'){
      body.appendChild(mkHint('Pilih dulu clip visual (video/foto/shape/teks/sticker) di timeline, lalu kembali ke panel ini.'));
    } else {
      App._beatKfProp = App._beatKfProp || 'scale';
      const propRow=document.createElement('div'); propRow.className='panel-tabgroup';
      ['scale','opacity','rotation','y'].forEach(p=>{ const b=document.createElement('button'); b.textContent=p; if(App._beatKfProp===p) b.classList.add('active');
        b.addEventListener('click', ()=>{ App._beatKfProp=p; openBeatPanel(); }); propRow.appendChild(b); });
      body.appendChild(propRow);
      App._beatKfInterval = App._beatKfInterval || 1;
      const intervalLabel=document.createElement('div'); intervalLabel.className='muted'; intervalLabel.style.margin='8px 2px 4px'; intervalLabel.textContent='Preset';
      body.appendChild(intervalLabel);
      const intervalRow=document.createElement('div'); intervalRow.className='panel-tabgroup';
      [['Every beat',1],['Every 2 beats',2],['Every 4 beats',4]].forEach(([label,n])=>{
        const b=document.createElement('button'); b.textContent=label; if(App._beatKfInterval===n) b.classList.add('active');
        b.addEventListener('click', ()=>{ App._beatKfInterval=n; openBeatPanel(); }); intervalRow.appendChild(b);
      });
      body.appendChild(intervalRow);
      const genActions=document.createElement('div'); genActions.className='action-row';
      genActions.innerHTML = `<button class="pill-btn accent" id="bGenBeatKf">⚡ Generate</button>`;
      body.appendChild(genActions);
      genActions.querySelector('#bGenBeatKf').addEventListener('click', ()=> generateBeatKeyframes(selClip, App._beatKfProp, App._beatKfInterval));
    }
  }

  openSheet('#sheetPanel');
}
/* Fase 8 — pulses `prop` between its current value and a slightly
   boosted value on every Nth beat marker that falls within the clip,
   using Hold+Bounce-ish easing (linear in/out around each pulse) so it
   reads as a rhythmic punch rather than a smooth ramp. */
function generateBeatKeyframes(clip, prop, interval){
  const beats = App.project.beatMarkers.filter((b,i)=> i%interval===0 && b>=clip.start && b<clip.start+clip.duration);
  if(!beats.length){ toast('Tidak ada beat marker di rentang clip ini'); return; }
  const base = (clip.baseTransform||{})[prop];
  const baseVal = base!==undefined? base : (KF_PROP_RANGES[prop]? (KF_PROP_RANGES[prop][0]+KF_PROP_RANGES[prop][1])/2 : 1);
  const boost = prop==='scale'? baseVal*1.15 : prop==='opacity'? Math.max(0,baseVal-0.3) : prop==='rotation'? baseVal+8 : baseVal-20;
  clip.keyframes = (clip.keyframes||[]).filter(k=>k.prop!==prop); // replace any existing generated set for this prop
  clip.keyframes.push({prop, time:0, value:baseVal, easing:'linear'});
  beats.forEach(b=>{
    const t = b-clip.start;
    clip.keyframes.push({prop, time:Math.max(0,t-0.06), value:baseVal, easing:'linear'});
    clip.keyframes.push({prop, time:t, value:boost, easing:'easeOut'});
    clip.keyframes.push({prop, time:Math.min(clip.duration,t+0.12), value:baseVal, easing:'easeIn'});
  });
  Editor.renderFrame(Editor.curTime);
  toast(beats.length+' beat keyframe dibuat pada '+prop);
  pushUndoSnapshot();
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

/* Fase 8 — Audio-reactive: precomputed low-frequency ("bass") energy
   envelope for an audio buffer, sampled by time. Precomputing once (like
   detectBeats already does for onsets) instead of a live AnalyserNode
   means it gives IDENTICAL results in live preview, scrubbing, AND
   export — a live analyser only reflects whatever is playing right now
   and would be silent/wrong during offline export rendering. */
function analyzeBassEnergy(buffer){
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const rc = 1/(2*Math.PI*150); // ~150Hz one-pole lowpass approximates the bass band
  const dt = 1/sr, alpha = dt/(rc+dt);
  const hop = Math.max(1,Math.floor(sr*0.03));
  const energies=[]; let filtered=0, sum=0, count=0;
  for(let i=0;i<data.length;i++){
    filtered += alpha*(data[i]-filtered);
    sum += filtered*filtered; count++;
    if(count>=hop){ energies.push(Math.sqrt(sum/count)); sum=0; count=0; }
  }
  if(count>0) energies.push(Math.sqrt(sum/count));
  const max = Math.max(...energies, 1e-6);
  return { hop, sr, values: energies.map(e=>e/max) };
}
/* Samples the bass envelope at `timeSec`, averaged over a small window
   (rather than a single instant) so the result is naturally smoothed —
   purely a function of time, so it's identical every time it's queried
   (no per-frame accumulated state to keep in sync between preview/export). */
function sampleBassEnergy(bassData, timeSec, smoothSeconds){
  if(!bassData || !bassData.values.length) return 0;
  const stepSec = bassData.hop/bassData.sr;
  const halfWin = Math.max(0, Math.round((smoothSeconds||0.08)/2/stepSec));
  const centerIdx = clamp(Math.round(timeSec/stepSec), 0, bassData.values.length-1);
  let sum=0, n=0;
  for(let i=centerIdx-halfWin;i<=centerIdx+halfWin;i++){
    const idx=clamp(i,0,bassData.values.length-1); sum+=bassData.values[idx]; n++;
  }
  return n? sum/n : bassData.values[centerIdx];
}
/* Finds whichever ROOT-project audio clip is playing at time t and
   returns its precomputed bass envelope (computing + caching it on first
   use). Audio-reactive only ever looks at the root audio track — see
   the scope note on scheduleAudioPlayback for why compositions don't
   have their own mixed audio yet. */
function getActiveBassEnergyAt(t){
  const audioTrack = App.project.tracks.find(tr=>tr.kind==='audio');
  if(!audioTrack) return 0;
  const clip = audioTrack.clips.find(c=> t>=c.start && t<c.start+c.duration);
  if(!clip) return 0;
  const media = App.mediaCache[clip.mediaId];
  if(!media || !media.buffer) return 0;
  if(!media.bassEnergy) media.bassEnergy = analyzeBassEnergy(media.buffer);
  const sourceTime = (clip.trimStart||0) + (t-clip.start)*(clip.speed||1);
  return sampleBassEnergy(media.bassEnergy, sourceTime);
}
/* Fase 8 — applies a clip's Audio-Reactive setting on top of its already-
   resolved transform, right before rendering. No-op (and zero extra
   work) unless the clip has audioReactive.enabled turned on. */
function applyAudioReactive(clip, tf, t){
  const ar = clip.audioReactive;
  if(!ar || !ar.enabled) return;
  const bass = getActiveBassEnergyAt(t) * (ar.amount!==undefined?ar.amount:0.4);
  switch(ar.target){
    case 'scale': tf.scaleX=(tf.scaleX||1)*(1+bass*0.6); tf.scaleY=(tf.scaleY||1)*(1+bass*0.6); break;
    case 'position': tf.dy = (tf.dy||0) - bass*60; break;
    case 'rotation': tf.rotation = (tf.rotation||0) + bass*20; break;
    case 'glow': tf.glow = Math.max(tf.glow||0, bass*1.4); break;
    case 'shake': { const seed=clip.id.length; tf.dx=(tf.dx||0)+Math.sin(t*53+seed)*bass*14; tf.dy=(tf.dy||0)+Math.cos(t*47+seed)*bass*14; break; }
    case 'opacity': tf.alpha = clamp((tf.alpha!==undefined?tf.alpha:1) * (1-bass*0.5), 0, 1); break;
  }
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
$('#btnZoomIn').addEventListener('click', ()=>{ setZoom(App.zoomPxPerSec*1.4); });
$('#btnZoomOut').addEventListener('click', ()=>{ setZoom(App.zoomPxPerSec/1.4); });

/* ============================================================
   Fase 4 — Timeline Pro
   ============================================================ */
function setZoom(px){
  App.zoomPxPerSec = clamp(px,20,1200);
  $('#zoomSlider').value = App.zoomPxPerSec;
  Editor.renderTimeline();
}
$('#zoomSlider').addEventListener('input', e=> setZoom(parseFloat(e.target.value)));

/* Frame stepping — steps by exactly one project frame using the
   project's fps, snapping the playhead to a whole-frame boundary. */
function frameStep(dir){
  const fps = App.project.fps||30;
  const frameDur = 1/fps;
  let t = Math.round(Editor.curTime/frameDur)*frameDur + dir*frameDur;
  Editor.seek(Math.max(0,t));
}
$('#btnFrameBack').addEventListener('click', ()=> frameStep(-1));
$('#btnFrameFwd').addEventListener('click', ()=> frameStep(1));

/* Generic named markers (distinct from beat markers) — quick flags on the
   ruler for marking scenes/notes/sync points, independent of BPM. */
$('#btnAddMarker').addEventListener('click', ()=>{
  App.project.markers = App.project.markers||[];
  App.project.markers.push({id:uid('mk'), time:Editor.curTime, label:'Marker', color:'#FFB020'});
  Editor.renderTimeline(); pushUndoSnapshot();
});
$('#btnCamera').addEventListener('click', ()=> openCameraPanel());

/* Ripple Delete toggle */
$('#btnRipple').addEventListener('click', function(){
  App.rippleMode = !App.rippleMode;
  this.classList.toggle('active', App.rippleMode);
  toast(App.rippleMode? 'Ripple Delete: ON — hapus clip akan menutup celah otomatis' : 'Ripple Delete: OFF');
});

/* Multi-select mode: tapping clips toggles membership in the selection
   instead of opening the edit panel; dragging any selected clip moves
   the whole group together (horizontally, same-track only). */
$('#btnMultiSelect').addEventListener('click', function(){
  App.multiSelectMode = !App.multiSelectMode;
  this.classList.toggle('active', App.multiSelectMode);
  if(!App.multiSelectMode){ App.multiSelectedClipIds=[]; updateMultiSelectBar(); }
  hideClipTabs(); App.selectedClipId=null; Editor.renderTimeline();
  toast(App.multiSelectMode? 'Mode multi-select aktif — ketuk beberapa clip' : 'Mode multi-select nonaktif');
});
function updateMultiSelectBar(){
  const bar=$('#multiSelectBar');
  const n=App.multiSelectedClipIds.length;
  bar.classList.toggle('hidden', n===0);
  $('#multiSelectCount').textContent = n+' dipilih';
}
$('#bMultiSelDel').addEventListener('click', ()=>{
  const ids=new Set(App.multiSelectedClipIds);
  getActiveTracks().forEach(tr=> tr.clips=tr.clips.filter(c=>!ids.has(c.id)));
  App.multiSelectedClipIds=[]; updateMultiSelectBar();
  computeProjectDuration(); Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
});
$('#bMultiSelDup').addEventListener('click', ()=>{
  const copies=[];
  App.multiSelectedClipIds.forEach(id=>{
    const clip=findClipById(id); if(!clip) return;
    const track=getClipTrack(id);
    const copy=deepClone(clip); copy.id=uid('clip'); copy.start=clip.start+clip.duration+0.05; copy.zIndex=nextZIndex();
    track.clips.push(copy); copies.push(copy.id);
  });
  App.multiSelectedClipIds=copies; updateMultiSelectBar();
  computeProjectDuration(); Editor.renderTimeline(); pushUndoSnapshot();
});
$('#bMultiSelHide').addEventListener('click', ()=>{
  App.multiSelectedClipIds.forEach(id=>{ const c=findClipById(id); if(c) c.visible = !(c.visible!==false); });
  Editor.renderTimeline(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
});
$('#bMultiSelLock').addEventListener('click', ()=>{
  App.multiSelectedClipIds.forEach(id=>{ const c=findClipById(id); if(c) c.locked = !c.locked; });
  Editor.renderTimeline(); pushUndoSnapshot();
});
$('#bMultiSelPrecompose').addEventListener('click', ()=> preComposeSelected());

/* Fase 5 — Pre-compose: groups the currently multi-selected layers into
   a single new 'composition' clip. The selected clips are removed from
   their tracks and copied into the composition's own nested tracks
   (re-timed so 0 = the earliest selected clip's original start), then
   the composition clip is inserted spanning their combined extent.
   Audio clips are excluded — see the scope note on scheduleAudioPlayback:
   only the root project's audio track is ever mixed into playback/export. */
function preComposeSelected(){
  const ids = App.multiSelectedClipIds.slice();
  const clips = ids.map(id=>findClipById(id)).filter(Boolean).filter(c=>c.type!=='audio');
  if(clips.length<2){ toast('Pilih minimal 2 layer visual untuk di-precompose'); return; }

  const groupStart = Math.min(...clips.map(c=>c.start));
  const groupEnd = Math.max(...clips.map(c=>c.start+c.duration));
  const compTracks = makeStandardTracks();
  const idMap = {}; // old id -> re-inserted clip (for re-pointing parentId within the group)

  clips.forEach(clip=>{
    const track = getClipTrack(clip.id);
    track.clips = track.clips.filter(c=>c.id!==clip.id);
    const moved = deepClone(clip);
    moved.start = clip.start - groupStart; // re-time relative to the new composition's own t=0
    const destTrack = compTracks.find(t=>t.kind===track.kind) || compTracks[0];
    destTrack.clips.push(moved);
    idMap[clip.id] = moved;
  });
  // parentId relationships between the grouped clips still make sense
  // inside the new composition; a parentId pointing OUTSIDE the group
  // (to a layer left behind) can no longer be resolved, so it's dropped.
  Object.values(idMap).forEach(c=>{ if(c.parentId && !idMap[c.parentId]) c.parentId=null; });

  const compClip = {
    id: uid('clip'), type:'composition', name:'Composition',
    start:groupStart, duration:groupEnd-groupStart, trimStart:0, trimEnd:groupEnd-groupStart, speed:1,
    effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
    baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100},
    tracks: compTracks,
  };
  ensureLayerFields(compClip, nextZIndex());

  const hostTrack = getActiveTracks().find(t=>t.kind==='video') || getActiveTracks()[0];
  hostTrack.clips.push(compClip);

  App.multiSelectedClipIds=[]; updateMultiSelectBar();
  computeProjectDuration(); Editor.renderTimeline(); selectClip(compClip.id);
  toast('Pre-compose dibuat — ketuk dua kali untuk membuka isinya');
  pushUndoSnapshot();
}

/* Fase 5 — Null Object: an invisible helper clip other layers can be
   parented to (a common motion-graphics trick — move the null, every
   child follows, without the null itself ever being drawn). */
function addNullObject(){
  const track = getActiveTracks().find(t=>t.kind==='video') || getActiveTracks()[0];
  const clip = {
    id: uid('clip'), type:'null', name:'Null Object',
    start: Editor.curTime||0, duration: Math.max(2, (App.project.duration||3)-(Editor.curTime||0)),
    trimStart:0, trimEnd:0, speed:1, effects:[], keyframes:[], adjust:{}, mask:null, transitionOut:null,
    baseTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,width:100,height:100},
  };
  ensureLayerFields(clip, nextZIndex());
  track.clips.push(clip);
  computeProjectDuration(); Editor.renderTimeline(); selectClip(clip.id); closeSheet('#sheetAdd');
  toast('Null Object ditambahkan — parent-kan layer lain ke sini lewat tab Layer');
  pushUndoSnapshot();
}

/* Pinch-to-zoom on the timeline (2-finger touch) — zooms around the
   pinch midpoint and keeps that point stationary on screen. */
(function initTimelinePinchZoom(){
  const scroll = $('#timelineScroll');
  const active = new Map();
  let startDist=0, startZoom=70, anchorTime=0;
  scroll.addEventListener('pointerdown', e=>{
    if(e.pointerType!=='touch') return;
    active.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if(active.size===2){
      const pts=[...active.values()];
      startDist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y)||1;
      startZoom = App.zoomPxPerSec;
      const midX = (pts[0].x+pts[1].x)/2;
      const rect = scroll.getBoundingClientRect();
      anchorTime = (midX-rect.left+scroll.scrollLeft)/App.zoomPxPerSec;
    }
  });
  scroll.addEventListener('pointermove', e=>{
    if(!active.has(e.pointerId)) return;
    active.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if(active.size===2){
      const pts=[...active.values()];
      const dist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y)||1;
      const midX = (pts[0].x+pts[1].x)/2;
      setZoom(startZoom*(dist/startDist));
      const rect = scroll.getBoundingClientRect();
      scroll.scrollLeft = anchorTime*App.zoomPxPerSec - (midX-rect.left);
    }
  });
  function clear(e){ active.delete(e.pointerId); }
  scroll.addEventListener('pointerup', clear);
  scroll.addEventListener('pointercancel', clear);
})();
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
  // Fase 9 — Performance Monitor toggle (off by default, per the original
  // spec: "Tidak perlu selalu tampil. Bisa diaktifkan melalui Settings.")
  const perfRow=document.createElement('div'); perfRow.className='toggle-row';
  perfRow.innerHTML = `<span>Performance Monitor</span><div class="switch ${App.perfMonitorOn?'on':''}"></div>`;
  perfRow.querySelector('.switch').addEventListener('click', function(){
    App.perfMonitorOn = !App.perfMonitorOn;
    this.classList.toggle('on', App.perfMonitorOn);
    $('#perfMonitor').classList.toggle('hidden', !App.perfMonitorOn);
  });
  body.appendChild(perfRow);
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
  if(project.markers && project.markers.length){
    xml += `  <markers>\n`;
    project.markers.forEach(mk=> xml += `    <marker${attrs({id:mk.id, time:mk.time.toFixed(3), label:mk.label, color:mk.color})}/>\n`);
    xml += `  </markers>\n`;
  }
  if(project.camera){
    const cam=project.camera;
    xml += `  <camera${attrs({x:cam.x,y:cam.y,zoom:cam.zoom,rotation:cam.rotation,shake:cam.shake})}>\n`;
    (cam.keyframes||[]).forEach(k=> xml += `    <kf${attrs({prop:k.prop, time:k.time.toFixed(3), value:k.value, easing:k.easing})}/>\n`);
    xml += `  </camera>\n`;
  }
  xml += `  <mediaLibrary>\n`;
  project.mediaLibrary.forEach(m=>{
    xml += `    <media${attrs({id:m.id, kind:m.kind, name:m.name, duration:(m.duration||0).toFixed(3), width:m.width||0, height:m.height||0})}/>\n`;
  });
  xml += `  </mediaLibrary>\n`;
  xml += buildTracksXml(project.tracks, '  ');
  xml += `  <presets>\n`;
  (project.presets||[]).forEach(p=>{
    xml += `    <preset${attrs({id:p.id, name:p.name})}>\n`;
    (p.effects||[]).forEach(e=> xml += `      <effect${attrs({type:e.type, amount:e.params?e.params.amount:undefined})}/>\n`);
    xml += `    </preset>\n`;
  });
  xml += `  </presets>\n</jedagProject>\n`;
  return xml;
}
/* Fase 5 — recursive: a composition clip's own nested <tracks> block is
   serialized the same way as the project's root <tracks>, so nesting
   compositions inside compositions round-trips through XML correctly.
   Also fixes a pre-existing gap where layer fields (visible/locked/solo/
   blendMode/name/zIndex/parentId/colorLabel) and Reverse were silently
   never written to the exported template at all. */
function buildTracksXml(tracks, indent){
  let xml = `${indent}<tracks>\n`;
  tracks.forEach(track=>{
    xml += `${indent}  <track${attrs({id:track.id, kind:track.kind})}>\n`;
    track.clips.forEach(clip=>{
      xml += `${indent}    <clip${attrs({
        id:clip.id, type:clip.type, mediaRef:clip.mediaId, start:clip.start.toFixed(3), duration:clip.duration.toFixed(3),
        trimStart:clip.trimStart, trimEnd:clip.trimEnd, speed:clip.speed, fit:clip.fit, overlayType:clip.overlayType,
        intensity:clip.intensity, shapeType:clip.shapeType, color:clip.color, sticker:clip.sticker,
        name:clip.name, visible:clip.visible, locked:clip.locked, solo:clip.solo, blendMode:clip.blendMode,
        colorLabel:clip.colorLabel, zIndex:clip.zIndex, parentId:clip.parentId, reversed:clip.reversed, autoOrient:clip.autoOrient,
        arEnabled: clip.audioReactive?clip.audioReactive.enabled:undefined, arTarget: clip.audioReactive?clip.audioReactive.target:undefined, arAmount: clip.audioReactive?clip.audioReactive.amount:undefined,
      })}>\n`;
      if(clip.baseTransform) xml += `${indent}      <baseTransform${attrs(clip.baseTransform)}/>\n`;
      if(clip.keyframes && clip.keyframes.length){
        xml += `${indent}      <keyframes>\n`;
        clip.keyframes.forEach(k=> xml += `${indent}        <kf${attrs({prop:k.prop, time:k.time.toFixed(3), value:k.value, easing:k.easing, bx1:k.bezier?k.bezier.x1:undefined, by1:k.bezier?k.bezier.y1:undefined, bx2:k.bezier?k.bezier.x2:undefined, by2:k.bezier?k.bezier.y2:undefined})}/>\n`);
        xml += `${indent}      </keyframes>\n`;
      }
      if(clip.effects && clip.effects.length){
        xml += `${indent}      <effects>\n`;
        clip.effects.forEach(e=> xml += `${indent}        <effect${attrs({type:e.type, category:e.category, label:e.label, amount:e.params?e.params.amount:undefined, enabled:e.enabled})}/>\n`);
        xml += `${indent}      </effects>\n`;
      }
      if(clip.adjust && Object.keys(clip.adjust).length) xml += `${indent}      <adjust${attrs(clip.adjust)}/>\n`;
      if(clip.masks && clip.masks.length){
        xml += `${indent}      <masks>\n`;
        clip.masks.forEach(m=>{
          xml += `${indent}        <mask${attrs({
            shape:m.shape, x:m.x, y:m.y, scale:m.scale, width:m.width, height:m.height, feather:m.feather,
            opacity:m.opacity, pos:m.pos, rotation:m.rotation, expansion:m.expansion, invert:m.invert, mode:m.mode, sides:m.sides,
          })}${(m.points&&m.points.length)? '' : '/'}>\n`;
          if(m.points && m.points.length){
            m.points.forEach(p=> xml += `${indent}          <pt${attrs({x:p.x,y:p.y})}/>\n`);
            xml += `${indent}        </mask>\n`;
          }
        });
        xml += `${indent}      </masks>\n`;
      }
      if(clip.transitionOut) xml += `${indent}      <transitionOut${attrs(clip.transitionOut)}/>\n`;
      if(clip.text) xml += `${indent}      <text${attrs(Object.assign({content:clip.text.text, anim:clip.text.anim, animMode:clip.text.animMode, staggerDelay:clip.text.staggerDelay}, clip.text.style))}/>\n`;
      if(clip.type==='composition' && clip.tracks) xml += buildTracksXml(clip.tracks, indent+'      ');
      xml += `${indent}    </clip>\n`;
    });
    xml += `${indent}  </track>\n`;
  });
  xml += `${indent}</tracks>\n`;
  return xml;
}
function exportTemplateXml(){
  computeProjectDuration();
  const xml = buildProjectXml(App.project);
  const blob = new Blob([xml], {type:'application/xml'});
  downloadBlob(blob, sanitizeFileName(App.project.name)+'.jedag.xml');
  toast('Template XML diexport');
}
$('#btnImportXmlHome').addEventListener('click', ()=> $('#fileInputXml').click());
$('#btnRestoreProject').addEventListener('click', ()=> $('#fileInputRestore').click());
$('#fileInputRestore').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(file) restoreProjectFromFile(file);
  e.target.value='';
});
$('#fileInputXml').addEventListener('change', async e=>{
  const file = e.target.files[0]; if(!file) return;
  const text = await file.text();
  try{ parseAndOpenXmlTemplate(text); }catch(err){ console.error(err); toast('XML tidak valid'); }
  e.target.value='';
});
let pendingImport = null;
/* Fase 5 — recursive counterpart to buildTracksXml: parses a <tracks>
   element into a tracks array, remapping regenerated clip ids so
   parentId links (which only ever point within the SAME level) survive
   the round trip, and recursing into a composition clip's own nested
   <tracks> so nested compositions import correctly too. */
function parseTracksXml(tracksEl){
  if(!tracksEl) return [];
  const tracks = [];
  const idMap = {}; // this file's old clip id -> the freshly created clip object (scoped to this level)
  const pendingParents = [];
  Array.from(tracksEl.children).filter(el=>el.tagName==='track').forEach(trackEl=>{
    const track = { id: uid('trk'), kind: trackEl.getAttribute('kind'), clips: [] };
    Array.from(trackEl.children).filter(el=>el.tagName==='clip').forEach(clipEl=>{
      const oldId = clipEl.getAttribute('id');
      const clip = {
        id: uid('clip'), type: clipEl.getAttribute('type'), mediaId: clipEl.getAttribute('mediaRef')||null,
        start: parseFloat(clipEl.getAttribute('start'))||0, duration: parseFloat(clipEl.getAttribute('duration'))||1,
        trimStart: numAttr(clipEl,'trimStart'), trimEnd: numAttr(clipEl,'trimEnd'), speed: numAttr(clipEl,'speed',1),
        fit: clipEl.getAttribute('fit')||'fill', overlayType: clipEl.getAttribute('overlayType')||undefined,
        intensity: numAttr(clipEl,'intensity'), shapeType: clipEl.getAttribute('shapeType')||undefined,
        color: clipEl.getAttribute('color')||undefined, sticker: clipEl.getAttribute('sticker')||undefined,
        name: clipEl.getAttribute('name')||undefined,
        visible: clipEl.getAttribute('visible')===null? undefined : clipEl.getAttribute('visible')==='true',
        locked: clipEl.getAttribute('locked')==='true',
        solo: clipEl.getAttribute('solo')==='true',
        blendMode: clipEl.getAttribute('blendMode')||undefined,
        colorLabel: clipEl.getAttribute('colorLabel')||undefined,
        zIndex: clipEl.getAttribute('zIndex')!==null? parseInt(clipEl.getAttribute('zIndex')) : undefined,
        reversed: clipEl.getAttribute('reversed')==='true',
        autoOrient: clipEl.getAttribute('autoOrient')==='true',
        audioReactive: clipEl.getAttribute('arEnabled')!==null? { enabled: clipEl.getAttribute('arEnabled')==='true', target: clipEl.getAttribute('arTarget')||'scale', amount: numAttr(clipEl,'arAmount',0.4) } : undefined,
        effects: [], keyframes: [], adjust:{}, mask:null, transitionOut:null,
      };
      const bt = clipEl.querySelector('baseTransform');
      if(bt) clip.baseTransform = {
        x:numAttr(bt,'x',0), y:numAttr(bt,'y',0), scale:numAttr(bt,'scale',1), rotation:numAttr(bt,'rotation',0), opacity:numAttr(bt,'opacity',1),
        width:numAttr(bt,'width',100), height:numAttr(bt,'height',100),
        scaleX:numAttr(bt,'scaleX',numAttr(bt,'scale',1)), scaleY:numAttr(bt,'scaleY',numAttr(bt,'scale',1)),
        anchorX:numAttr(bt,'anchorX',0), anchorY:numAttr(bt,'anchorY',0), skewX:numAttr(bt,'skewX',0), skewY:numAttr(bt,'skewY',0),
      };
      clipEl.querySelectorAll(':scope > keyframes > kf').forEach(k=>{
        const kf={prop:k.getAttribute('prop'), time:parseFloat(k.getAttribute('time'))||0, value:parseFloat(k.getAttribute('value'))||0, easing:k.getAttribute('easing')||'linear'};
        if(k.getAttribute('bx1')!==null){ kf.bezier={x1:parseFloat(k.getAttribute('bx1')), y1:parseFloat(k.getAttribute('by1')), x2:parseFloat(k.getAttribute('bx2')), y2:parseFloat(k.getAttribute('by2'))}; }
        clip.keyframes.push(kf);
      });
      clipEl.querySelectorAll(':scope > effects > effect').forEach(e=> clip.effects.push({id:uid('fx'), category:e.getAttribute('category'), type:e.getAttribute('type'), label:e.getAttribute('label'), params:{amount:parseFloat(e.getAttribute('amount'))||0}, enabled: e.getAttribute('enabled')!=='false'}));
      const adjEl = clipEl.querySelector(':scope > adjust');
      if(adjEl) ADJUST_KEYS.forEach(([l,key])=>{ const v=adjEl.getAttribute(key); if(v!==null) clip.adjust[key]=parseFloat(v); });
      const maskEl = clipEl.querySelector(':scope > mask'); // legacy single-mask templates
      if(maskEl) clip.masks = [{ id:uid('mask'), shape:maskEl.getAttribute('shape'), x:numAttr(maskEl,'x',0), y:numAttr(maskEl,'y',0), scale:numAttr(maskEl,'scale',1), width:numAttr(maskEl,'width',70), height:numAttr(maskEl,'height',70), feather:numAttr(maskEl,'feather',10), opacity:numAttr(maskEl,'opacity',1), pos:numAttr(maskEl,'pos',0.5), rotation:0, expansion:0, invert:false, mode:'add', sides:6, points:[] }];
      const masksEl = clipEl.querySelector(':scope > masks');
      if(masksEl){
        clip.masks = Array.from(masksEl.children).filter(el=>el.tagName==='mask').map(m=>({
          id:uid('mask'), shape:m.getAttribute('shape'), x:numAttr(m,'x',0), y:numAttr(m,'y',0), scale:numAttr(m,'scale',1),
          width:numAttr(m,'width',70), height:numAttr(m,'height',70), feather:numAttr(m,'feather',10), opacity:numAttr(m,'opacity',1),
          pos:numAttr(m,'pos',0.5), rotation:numAttr(m,'rotation',0), expansion:numAttr(m,'expansion',0),
          invert:m.getAttribute('invert')==='true', mode:m.getAttribute('mode')||'add', sides:numAttr(m,'sides',6),
          points: Array.from(m.children).filter(el=>el.tagName==='pt').map(p=>({x:numAttr(p,'x',0), y:numAttr(p,'y',0)})),
        }));
      }
      const trEl = clipEl.querySelector(':scope > transitionOut');
      if(trEl) clip.transitionOut = { type:trEl.getAttribute('type'), duration:numAttr(trEl,'duration',0.4), intensity:numAttr(trEl,'intensity',1), direction:trEl.getAttribute('direction'), easing:trEl.getAttribute('easing')||'easeInOut' };
      const textEl = clipEl.querySelector(':scope > text');
      if(textEl){
        clip.text = { text: textEl.getAttribute('content')||'', anim: textEl.getAttribute('anim')||'None',
          animMode: textEl.getAttribute('animMode')||'Whole', staggerDelay: numAttr(textEl,'staggerDelay',0.045), style: {
          font: textEl.getAttribute('font')||"'Inter',sans-serif", size:numAttr(textEl,'size',48), bold: textEl.getAttribute('bold')==='true', italic: textEl.getAttribute('italic')==='true',
          align: textEl.getAttribute('align')||'center', color: textEl.getAttribute('color')||'#fff', gradient: textEl.getAttribute('gradient')==='true', color2: textEl.getAttribute('color2')||'#16E8A6',
          stroke: textEl.getAttribute('stroke')==='true', strokeColor: textEl.getAttribute('strokeColor')||'#000', strokeWidth:numAttr(textEl,'strokeWidth',3),
          shadow: textEl.getAttribute('shadow')==='true', glow: textEl.getAttribute('glow')==='true', letterSpacing:numAttr(textEl,'letterSpacing',0), lineHeight:numAttr(textEl,'lineHeight',1.2),
          x:numAttr(textEl,'x',0), y:numAttr(textEl,'y',0), rotation:numAttr(textEl,'rotation',0), opacity:numAttr(textEl,'opacity',1),
        }};
      }
      if(clip.type==='composition'){
        const nestedTracksEl = Array.from(clipEl.children).find(el=>el.tagName==='tracks');
        clip.tracks = parseTracksXml(nestedTracksEl);
      }
      const oldParentId = clipEl.getAttribute('parentId');
      if(oldParentId) pendingParents.push({clip, oldParentId});
      if(oldId) idMap[oldId]=clip;
      track.clips.push(clip);
    });
    tracks.push(track);
  });
  pendingParents.forEach(({clip,oldParentId})=>{ clip.parentId = idMap[oldParentId]? idMap[oldParentId].id : null; });
  return tracks;
}
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
  project.markers = Array.from(doc.querySelectorAll('markers marker')).map(m=>({
    id:m.getAttribute('id')||uid('mk'), time:parseFloat(m.getAttribute('time'))||0,
    label:m.getAttribute('label')||'Marker', color:m.getAttribute('color')||'#FFB020',
  }));
  const camEl = Array.from(root.children).find(el=>el.tagName==='camera');
  project.camera = camEl? {
    x:numAttr(camEl,'x',0), y:numAttr(camEl,'y',0), zoom:numAttr(camEl,'zoom',1), rotation:numAttr(camEl,'rotation',0), shake:numAttr(camEl,'shake',0),
    keyframes: Array.from(camEl.children).filter(el=>el.tagName==='kf').map(k=>({prop:k.getAttribute('prop'), time:parseFloat(k.getAttribute('time'))||0, value:parseFloat(k.getAttribute('value'))||0, easing:k.getAttribute('easing')||'linear'})),
  } : {x:0,y:0,zoom:1,rotation:0,shake:0,keyframes:[]};

  const mediaMap = {}; // placeholderId -> {kind,name,duration,width,height,file:null,newId:null}
  doc.querySelectorAll('mediaLibrary media').forEach(m=>{
    mediaMap[m.getAttribute('id')] = { kind:m.getAttribute('kind'), name:m.getAttribute('name'), duration:parseFloat(m.getAttribute('duration'))||3, width:parseInt(m.getAttribute('width'))||1080, height:parseInt(m.getAttribute('height'))||1920, file:null };
  });

  const rootTracksEl = Array.from(root.children).find(el=>el.tagName==='tracks');
  project.tracks = parseTracksXml(rootTracksEl);
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
  // Fase 5 — recurse into composition clips' own nested tracks too, so
  // media placeholders used inside a composition get remapped as well.
  const remapMediaIds = tracks=> tracks.forEach(tr=> tr.clips.forEach(c=>{
    if(c.mediaId && idRemap[c.mediaId]) c.mediaId = idRemap[c.mediaId];
    if(c.type==='composition' && c.tracks) remapMediaIds(c.tracks);
  }));
  remapMediaIds(project.tracks);
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
  updateExportEstimate();
  $('#modalExport').classList.add('show');
});
$('#btnCancelExport').addEventListener('click', ()=>{
  if(Editor.exportMode){
    App._exportCancelled = true;
    if(App._exportRecorder && App._exportRecorder.state!=='inactive') App._exportRecorder.stop();
    toast('Export dibatalkan');
  } else {
    $('#modalExport').classList.remove('show');
  }
});
$$('#segRes .seg-opt').forEach(b=> b.addEventListener('click', ()=>{ $$('#segRes .seg-opt').forEach(x=>x.classList.remove('active')); b.classList.add('active'); updateExportEstimate(); }));
$$('#segFps .seg-opt').forEach(b=> b.addEventListener('click', ()=>{ $$('#segFps .seg-opt').forEach(x=>x.classList.remove('active')); b.classList.add('active'); updateExportEstimate(); }));

function pickMimeType(){
  const candidates = ['video/mp4;codecs=avc1.42E01E','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  for(const c of candidates){ if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c; }
  return 'video/webm';
}
function updateExportFormatNote(){
  const mt = pickMimeType();
  $('#exportFormatNote').textContent = mt.includes('mp4') ? 'Format output: MP4' : 'Format output: WebM (MP4 tidak didukung browser ini)';
}
/* Fase 9 — Export panel: bitrate table used both for the actual
   MediaRecorder bitsPerSecond AND the file-size estimate shown before
   export starts, so the estimate is honest (matches what actually gets
   encoded) rather than a made-up number. */
function bitrateForRes(res){
  return {480:2_500_000, 720:6_000_000, 1080:10_000_000, 1440:16_000_000}[res] || 6_000_000;
}
function updateExportEstimate(){
  const res = parseInt($('#segRes .seg-opt.active').dataset.res);
  const dur = App.project.duration||0;
  const bytes = (bitrateForRes(res)/8)*dur * 1.08; // +8% for the audio track muxed alongside
  const mb = bytes/1_000_000;
  $('#exportSizeEstimate').textContent = `Estimasi ukuran file: ~${mb<1? (mb*1000).toFixed(0)+' KB' : mb.toFixed(1)+' MB'}`+(res>=1440? ' (1440p bisa berat di HP kelas menengah)':'');
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
  try{ recorder = new MediaRecorder(combined, {mimeType, videoBitsPerSecond: bitrateForRes(res)}); }
  catch(e){ recorder = new MediaRecorder(combined); }
  App._exportRecorder = recorder;
  App._exportCancelled = false;
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
    if(App._exportCancelled) return; // recorder.stop() already triggered from the Cancel button
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
        if(recorder.state!=='inactive') recorder.stop();
      }, 200);
    }
  }
  recorder.onstop = ()=>{
    stopAudioPlayback();
    Editor.exportMode=false;
    $('#exportProgress').classList.add('hidden');
    $('#btnStartExport').disabled=false;
    if(App._exportCancelled){
      $('#modalExport').classList.remove('show');
      Editor.renderFrame(Editor.curTime);
      return; // cancelled — no file, nothing to download
    }
    const blob = new Blob(chunks, {type:mimeType});
    downloadBlob(blob, sanitizeFileName(App.project.name)+(mimeType.includes('mp4')?'.mp4':'.webm'));
    $('#modalExport').classList.remove('show');
    toast('Export selesai, file diunduh');
    Editor.renderFrame(Editor.curTime);
  };
  requestAnimationFrame(exportFrame);
}
function renderFrameToCanvas(ctx, W, H, t){
  ctx.save();
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#000'; ctx.fillRect(0,0,W,H);
  // Fase 5 — export always renders the TRUE root project, regardless of
  // which composition the user happens to be viewing/editing right now,
  // and now shares the exact same draw loop as the live preview — so
  // hide/solo/blend-mode/transitions (previously only honored in the
  // live preview, not in exported video) render correctly here too.
  // renderTracksToContext/drawSingleClip read the current frame off the
  // module-global Editor.curTime, so it's pointed at the export clock
  // for the duration of this call and restored right after.
  const savedCur = Editor.curTime;
  Editor.curTime = t;
  try{
    renderTracksToContext(ctx, App.project.tracks, t, W, H);
    applyCameraTransform(ctx, W, H, t); // Fase 8 — camera bakes into exported video too
  }
  finally{ Editor.curTime = savedCur; }
  ctx.restore();
}

/* ============================================================
   Fase 8 — Camera System
   ============================================================ */
function getCameraTransformAt(t){
  const cam = App.project.camera;
  const base = {x:cam.x||0, y:cam.y||0, scale:cam.zoom||1, rotation:cam.rotation||0};
  if(cam.keyframes && cam.keyframes.length){
    const kf = interpKeyframes({keyframes:cam.keyframes}, t);
    ['x','y','scale','rotation'].forEach(p=>{ if(!cam.keyframes.some(k=>k.prop===p)) kf[p]=base[p]; });
    return kf;
  }
  return base;
}
/* Applies the whole-frame virtual camera (pan/zoom/rotate/shake) as a
   final post-process pass over everything renderTracksToContext already
   drew — a snapshot-and-redraw so it works identically whether there's
   one clip or fifty. Skipped entirely (zero cost) when the camera is at
   its default resting transform. */
function applyCameraTransform(ctx, W, H, t){
  const cam = App.project.camera;
  if(!cam) return;
  const tr = getCameraTransformAt(t);
  const shakeAmt = cam.shake||0;
  const sx = shakeAmt? Math.sin(t*37.1)*shakeAmt*10 : 0;
  const sy = shakeAmt? Math.cos(t*29.3)*shakeAmt*10 : 0;
  if(!tr.x && !tr.y && tr.scale===1 && !tr.rotation && !shakeAmt) return;
  const snapshot=document.createElement('canvas'); snapshot.width=W; snapshot.height=H;
  snapshot.getContext('2d').drawImage(ctx.canvas,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.save();
  ctx.translate(W/2+tr.x+sx, H/2+tr.y+sy);
  ctx.rotate((tr.rotation||0)*Math.PI/180);
  ctx.scale(tr.scale||1, tr.scale||1);
  ctx.translate(-W/2,-H/2);
  ctx.drawImage(snapshot,0,0);
  ctx.restore();
}
function openCameraPanel(){
  $('#panelTitle').textContent='Camera';
  const body=$('#panelBody'); body.innerHTML='';
  const cam = App.project.camera;

  body.appendChild(sliderRow('Position X', cam.x, -400, 400, 1, (v,c)=>{ cam.x=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Position Y', cam.y, -400, 400, 1, (v,c)=>{ cam.y=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Zoom', cam.zoom, 0.5, 3, 0.01, (v,c)=>{ cam.zoom=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Rotation', cam.rotation, -45, 45, 1, (v,c)=>{ cam.rotation=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));
  body.appendChild(sliderRow('Camera Shake', cam.shake, 0, 1, 0.01, (v,c)=>{ cam.shake=v; Editor.renderFrame(Editor.curTime); if(c) pushUndoSnapshot(); }));

  const kfActions=document.createElement('div'); kfActions.className='action-row';
  kfActions.innerHTML = `<button class="pill-btn accent" id="bCamKf">+ Keyframe Kamera di Playhead</button><button class="pill-btn ghost" id="bCamReset">Reset Kamera</button>`;
  body.appendChild(kfActions);
  kfActions.querySelector('#bCamKf').addEventListener('click', ()=>{
    ['x','y','scale','rotation'].forEach(prop=>{
      const val = prop==='scale'? cam.zoom : cam[prop];
      cam.keyframes = cam.keyframes.filter(k=>!(k.prop===prop && Math.abs(k.time-Editor.curTime)<0.05));
      cam.keyframes.push({prop, time:Editor.curTime, value:val, easing:'easeInOut'});
    });
    toast('Keyframe kamera ditambahkan'); pushUndoSnapshot();
  });
  kfActions.querySelector('#bCamReset').addEventListener('click', ()=>{
    Object.assign(cam, {x:0,y:0,zoom:1,rotation:0,shake:0,keyframes:[]});
    openCameraPanel(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot();
  });
  if(cam.keyframes.length) body.appendChild(mkHint(cam.keyframes.length+' keyframe kamera tersimpan. Buka tab Animation pada sebuah clip untuk kurva editor tidak berlaku di sini — kamera pakai easing tetap (Ease In Out); hapus semua lewat Reset Kamera.'));

  const presetLabel=document.createElement('div'); presetLabel.className='muted'; presetLabel.style.margin='14px 2px 6px'; presetLabel.textContent='Preset';
  body.appendChild(presetLabel);
  const presetGrid=document.createElement('div'); presetGrid.className='preset-grid';
  const dur = App.project.duration||5;
  const presets = {
    'Smooth Zoom': ()=>{ cam.keyframes=[{prop:'scale',time:0,value:1,easing:'easeInOut'},{prop:'scale',time:dur,value:1.18,easing:'easeInOut'}]; },
    'Push In': ()=>{ cam.keyframes=[{prop:'scale',time:0,value:1,easing:'easeIn'},{prop:'scale',time:dur,value:1.35,easing:'easeIn'}]; },
    'Pull Out': ()=>{ cam.keyframes=[{prop:'scale',time:0,value:1.35,easing:'easeOut'},{prop:'scale',time:dur,value:1,easing:'easeOut'}]; },
    'Pan': ()=>{ cam.keyframes=[{prop:'x',time:0,value:-150,easing:'easeInOut'},{prop:'x',time:dur,value:150,easing:'easeInOut'}]; },
    'Dolly': ()=>{ cam.keyframes=[{prop:'x',time:0,value:-100,easing:'easeInOut'},{prop:'x',time:dur,value:100,easing:'easeInOut'},{prop:'scale',time:0,value:1,easing:'easeInOut'},{prop:'scale',time:dur,value:1.2,easing:'easeInOut'}]; },
    'Camera Shake': ()=>{ cam.shake=0.4; },
  };
  Object.keys(presets).forEach(name=>{
    const b=document.createElement('button'); b.className='preset-item'; b.textContent=name;
    b.addEventListener('click', ()=>{ presets[name](); openCameraPanel(); Editor.renderFrame(Editor.curTime); pushUndoSnapshot(); });
    presetGrid.appendChild(b);
  });
  body.appendChild(presetGrid);
  openSheet('#sheetPanel');
}
/* ============================================================
   Bootstrap
   ============================================================ */
document.addEventListener('DOMContentLoaded', ()=>{
  showPage('home');
});
if(document.readyState!=='loading') showPage('home');

})();
