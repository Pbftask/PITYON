/* ==========================================================================
   COMMUNITY CREATOR MODULE (community-creator.js)
   PHASE 2a — builds on community.js's shell + Firestore helpers.

   Owns:
   - Preset upload / edit / delete / use / copy
   - Overlay upload / edit / delete / "pasang di foto"
   - The overlay compositing engine: layers array + canvas render hook
     (registered into script.js via PEBridge.registerOverlayHook) + the
     floating Layer Panel UI for position/scale/rotation/opacity/blend
     mode/flip/order.

   Does NOT touch script.js internals directly — only through PEBridge.
   Does NOT touch community.js's own state — only through window.PECommunity.
   ========================================================================== */
(function(){
"use strict";

function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

ready(function(){
  const B = window.PEBridge;
  const C = window.PECommunity;
  if(!B || !C){ console.error('community-creator.js: PEBridge/PECommunity not found — load order wrong?'); return; }

  /* ------------------------------------------------------------------
     0. GENERIC MODAL SHELL (shared with community-social.js via
        window.PECommunityUI so every dynamic form/detail view looks the
        same and there's only one modal DOM node on the page at a time).
     ------------------------------------------------------------------ */
  let modalRoot=document.getElementById('peModalRoot');
  if(!modalRoot){
    modalRoot=document.createElement('div');
    modalRoot.id='peModalRoot';
    modalRoot.className='modal-backdrop';
    modalRoot.innerHTML='<div class="modal-card pe-modal-card" id="peModalCard"></div>';
    document.body.appendChild(modalRoot);
    modalRoot.addEventListener('click',(e)=>{ if(e.target===modalRoot) closeModal(); });
  }
  const modalCard=document.getElementById('peModalCard');
  function openModal(html){ modalCard.innerHTML=html; modalRoot.classList.add('active'); }
  function closeModal(){ modalRoot.classList.remove('active'); modalCard.innerHTML=''; }
  function onModal(sel,evt,fn){ const n=modalCard.querySelector(sel); if(n) n.addEventListener(evt,fn); }
  function onModalAll(sel,evt,fn){ modalCard.querySelectorAll(sel).forEach(n=>n.addEventListener(evt,fn)); }

  window.PECommunityUI = { openModal, closeModal, onModal, onModalAll, modalCard };

  const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function myDisplayName(){
    const p=B.getUserProfile();
    return (p && (p.username||p.name)) || 'Creator';
  }

  /* ------------------------------------------------------------------
     1. PRESET — upload / edit / delete / apply / copy
     ------------------------------------------------------------------ */
  let appliedPreset=null; // {id, creatorUid, creatorName} — used by watermark module

  function presetFormHTML(existing){
    const cats=C.PRESET_CATEGORIES;
    const d=existing||{};
    const tags=(d.tags||[]).join(', ');
    return `
      <div class="modal-head"><h3>${existing?'Edit Preset':'Buat Preset'}</h3><button class="icon-btn" data-close>&times;</button></div>
      <div class="modal-section">
        <div class="pe-thumb-pick" id="peThumbPick">
          ${d.thumbnail?`<img src="${esc(d.thumbnail)}">`:'<span>+ Thumbnail</span>'}
        </div>
        <input type="file" accept="image/*" id="peThumbFile" hidden>
        <p style="font-size:11px;color:var(--text-dim);margin-top:6px;">Kosongkan untuk pakai preview hasil edit saat ini sebagai thumbnail.</p>
      </div>
      <div class="modal-section">
        <input class="auth-input" id="peName" placeholder="Nama preset" value="${esc(d.name)}" maxlength="40">
      </div>
      <div class="modal-section">
        <textarea class="auth-input pe-textarea" id="peDesc" placeholder="Deskripsi singkat" maxlength="200">${esc(d.description)}</textarea>
      </div>
      <div class="modal-section">
        <select class="auth-input" id="peCategory">
          ${cats.map(c=>`<option value="${c}" ${d.category===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="modal-section">
        <input class="auth-input" id="peTags" placeholder="Tag (pisahkan koma)" value="${esc(tags)}">
      </div>
      <div class="modal-section pe-color-row">
        <label>Warna Tema</label>
        <input type="color" id="peColor" value="${esc(d.themeColor||'#ffb020')}">
      </div>
      <button class="btn-primary" id="peSubmit" style="width:100%;justify-content:center;">${existing?'Simpan Perubahan':'Publikasikan Preset'}</button>
    `;
  }

  function openPresetForm(existing){
    if(!B.getUid()){ B.toast('Login dulu untuk membuat preset.'); return; }
    if(!existing && !B.state.originalCanvas){ B.toast('Pilih & edit foto dulu — preset diambil dari pengaturan editmu saat ini.'); return; }
    openModal(presetFormHTML(existing));
    let thumbFile=null, thumbUrl=(existing&&existing.thumbnail)||'';
    onModal('[data-close]','click',closeModal);
    onModal('#peThumbPick','click',()=>modalCard.querySelector('#peThumbFile').click());
    onModal('#peThumbFile','change',(e)=>{
      const f=e.target.files[0]; if(!f) return;
      if(!/^image\//.test(f.type)){ B.toast('Hanya file gambar yang bisa dipakai sebagai thumbnail preset. Video tidak didukung.','error'); return; }
      thumbFile=f;
      const url=URL.createObjectURL(f);
      modalCard.querySelector('#peThumbPick').innerHTML=`<img src="${url}">`;
    });
    onModal('#peSubmit','click', async ()=>{
      const name=modalCard.querySelector('#peName').value.trim();
      const description=modalCard.querySelector('#peDesc').value.trim();
      const category=modalCard.querySelector('#peCategory').value;
      const tags=modalCard.querySelector('#peTags').value.split(',').map(t=>t.trim()).filter(Boolean).slice(0,10);
      const themeColor=modalCard.querySelector('#peColor').value;
      if(!name){ B.toast('Nama preset wajib diisi.'); return; }
      const btn=modalCard.querySelector('#peSubmit'); btn.disabled=true; btn.textContent='Menyimpan...';
      try{
        if(thumbFile){
          thumbUrl=await B.uploadImageToImgbb(thumbFile);
        }else if(!thumbUrl && B.state.previewCanvas){
          const blob=await new Promise(res=>document.getElementById('canvasAfter').toBlob(res,'image/jpeg',0.85));
          if(blob) thumbUrl=await B.uploadImageToImgbb(new File([blob],'thumb.jpg',{type:'image/jpeg'}));
        }
        const settings=B.cloneSettings(B.state.settings);
        if(existing){
          await C.updateDocById('presets', existing.id, {
            name, description, category, tags, themeColor, thumbnail:thumbUrl, settings,
            version: C.increment(1)
          });
          B.toast('Preset diperbarui.','success');
        }else{
          await C.createDoc('presets', {
            name, description, category, tags, themeColor, thumbnail:thumbUrl, settings,
            creatorName: myDisplayName(), creatorUid: B.getUid(),
            likeCount:0, downloadCount:0, useCount:0, favoriteCount:0, version:1
          });
          B.toast('Preset berhasil dipublikasikan.','success');
        }
        closeModal();
        C.refreshCurrentTab();
      }catch(err){
        console.error(err);
        B.toast('Gagal menyimpan preset: '+(err.message||'coba lagi'),'error');
        btn.disabled=false; btn.textContent=existing?'Simpan Perubahan':'Publikasikan Preset';
      }
    });
  }

  // Holds a preset waiting to be applied once the user picks a photo
  // (set by applyPreset when no photo is loaded yet).
  let pendingPresetApply=null;

  function applyPreset(id, d){
    if(!B.state.originalCanvas){
      // No photo yet: jump straight to the editor and open the photo
      // picker immediately, then apply this preset as soon as the photo
      // finishes loading (see the photo-ready hook registered below).
      pendingPresetApply={ id, d };
      B.goToPage('home');
      B.toast(`Pilih foto untuk memakai preset "${d.name}"...`);
      B.pickFile();
      return;
    }
    doApplyPreset(id, d);
  }

  function doApplyPreset(id, d){
    B.state.settings = B.cloneSettings(d.settings);
    B.recalcPreviewCanvas();
    B.pushHistory();
    B.updateUndoRedoButtons();
    B.refreshOpenSheet();
    appliedPreset = { id, name:d.name, creatorUid:d.creatorUid, creatorName:d.creatorName };
    C.incrementCounter('presets', id, 'useCount', 1);
    if(B.getUid() && d.creatorUid!==B.getUid()) C.incrementCounter('profiles', d.creatorUid, 'presetUseCount', 1);
    B.goToPage('home');
    B.toast(`Preset "${d.name}" diterapkan.`,'success');
  }

  B.registerPhotoReadyHook(()=>{
    if(pendingPresetApply){
      const {id,d}=pendingPresetApply;
      pendingPresetApply=null;
      doApplyPreset(id,d);
    }
  });

  async function duplicatePreset(id, d, {silent}={}){
    if(!B.getUid()){ B.toast('Login dulu.'); return; }
    try{
      const newId=await C.createDoc('presets', {
        name:d.name+' (copy)', description:d.description||'', category:d.category, tags:d.tags||[],
        themeColor:d.themeColor||'#ffb020', thumbnail:d.thumbnail||'', settings:d.settings,
        creatorName: myDisplayName(), creatorUid: B.getUid(),
        likeCount:0, downloadCount:0, useCount:0, favoriteCount:0, version:1
      });
      C.incrementCounter('presets', id, 'downloadCount', 1);
      if(!silent) B.toast('Preset disimpan ke koleksimu.','success');
      return newId;
    }catch(err){ console.error(err); B.toast('Gagal menyalin preset.','error'); }
  }

  async function deletePreset(id, ownerUid){
    if(B.getUid()!==ownerUid){ B.toast('Kamu bukan pemilik preset ini.'); return; }
    if(!confirm('Hapus preset ini? Tindakan ini tidak bisa dibatalkan.')) return;
    try{ await C.deleteDocById('presets', id); closeModal(); C.refreshCurrentTab(); B.toast('Preset dihapus.'); }
    catch(err){ console.error(err); B.toast('Gagal menghapus preset.','error'); }
  }

  /* ------------------------------------------------------------------
     2. OVERLAY — upload / edit / delete
     ------------------------------------------------------------------ */
  function overlayFormHTML(existing){
    const cats=C.OVERLAY_CATEGORIES;
    const d=existing||{};
    const tags=(d.tags||[]).join(', ');
    return `
      <div class="modal-head"><h3>${existing?'Edit Overlay':'Unggah Overlay'}</h3><button class="icon-btn" data-close>&times;</button></div>
      <div class="modal-section">
        <div class="pe-thumb-pick pe-thumb-pick--overlay" id="peOvPick">
          ${d.pngUrl?`<img src="${esc(d.pngUrl)}">`:'<span>+ PNG Transparan</span>'}
        </div>
        <input type="file" accept="image/png" id="peOvFile" hidden>
      </div>
      <div class="modal-section"><input class="auth-input" id="peOvName" placeholder="Nama overlay" value="${esc(d.name)}" maxlength="40"></div>
      <div class="modal-section">
        <select class="auth-input" id="peOvCategory">${cats.map(c=>`<option value="${c}" ${d.category===c?'selected':''}>${c}</option>`).join('')}</select>
      </div>
      <div class="modal-section"><input class="auth-input" id="peOvTags" placeholder="Tag (pisahkan koma)" value="${esc(tags)}"></div>
      <button class="btn-primary" id="peOvSubmit" style="width:100%;justify-content:center;">${existing?'Simpan Perubahan':'Unggah Overlay'}</button>
    `;
  }

  function openOverlayForm(existing){
    if(!B.getUid()){ B.toast('Login dulu untuk mengunggah overlay.'); return; }
    openModal(overlayFormHTML(existing));
    let pngFile=null, pngUrl=(existing&&existing.pngUrl)||'';
    onModal('[data-close]','click',closeModal);
    onModal('#peOvPick','click',()=>modalCard.querySelector('#peOvFile').click());
    onModal('#peOvFile','change',(e)=>{
      const f=e.target.files[0]; if(!f) return;
      if(f.type!=='image/png'){ B.toast('Overlay harus berupa PNG transparan.'); return; }
      pngFile=f;
      modalCard.querySelector('#peOvPick').innerHTML=`<img src="${URL.createObjectURL(f)}">`;
    });
    onModal('#peOvSubmit','click', async ()=>{
      const name=modalCard.querySelector('#peOvName').value.trim();
      const category=modalCard.querySelector('#peOvCategory').value;
      const tags=modalCard.querySelector('#peOvTags').value.split(',').map(t=>t.trim()).filter(Boolean).slice(0,10);
      if(!name){ B.toast('Nama overlay wajib diisi.'); return; }
      if(!pngUrl && !pngFile){ B.toast('Pilih file PNG overlay.'); return; }
      const btn=modalCard.querySelector('#peOvSubmit'); btn.disabled=true; btn.textContent='Mengunggah...';
      try{
        if(pngFile) pngUrl=await B.uploadImageToImgbb(pngFile);
        if(existing){
          await C.updateDocById('overlays', existing.id, { name, category, tags, pngUrl, thumbnail:pngUrl });
          B.toast('Overlay diperbarui.','success');
        }else{
          await C.createDoc('overlays', {
            name, category, tags, pngUrl, thumbnail:pngUrl,
            creatorName: myDisplayName(), creatorUid: B.getUid(),
            likeCount:0, favoriteCount:0, downloadCount:0
          });
          B.toast('Overlay berhasil diunggah.','success');
        }
        closeModal();
        C.refreshCurrentTab();
      }catch(err){
        console.error(err);
        B.toast('Gagal menyimpan overlay: '+(err.message||'coba lagi'),'error');
        btn.disabled=false; btn.textContent=existing?'Simpan Perubahan':'Unggah Overlay';
      }
    });
  }

  async function deleteOverlay(id, ownerUid){
    if(B.getUid()!==ownerUid){ B.toast('Kamu bukan pemilik overlay ini.'); return; }
    if(!confirm('Hapus overlay ini?')) return;
    try{ await C.deleteDocById('overlays', id); closeModal(); C.refreshCurrentTab(); B.toast('Overlay dihapus.'); }
    catch(err){ console.error(err); B.toast('Gagal menghapus overlay.','error'); }
  }

  /* ------------------------------------------------------------------
     3. OVERLAY COMPOSITING ENGINE — layers + render hook + panel UI
     ------------------------------------------------------------------ */
  const layers=[]; // {id, overlayId, url, creatorUid, creatorName, x,y,scale,rotation,opacity,blendMode,flipH,flipV,order}
  const imgCache=new Map();
  function loadImg(url){
    if(imgCache.has(url)) return imgCache.get(url);
    const p=new Promise((resolve)=>{
      const img=new Image();
      img.crossOrigin='anonymous';
      img.onload=()=>resolve(img);
      img.onerror=()=>resolve(null);
      img.src=url;
    });
    imgCache.set(url,p);
    return p;
  }

  B.registerOverlayHook(async (ctx,w,h,isExport)=>{
    if(!layers.length) return;
    const sorted=[...layers].sort((a,b)=>a.order-b.order);
    for(const layer of sorted){
      const img=await loadImg(layer.url);
      if(!img) continue;
      const drawW=w*layer.scale;
      const drawH=drawW*(img.naturalHeight/img.naturalWidth || 1);
      const cx=w*layer.x, cy=h*layer.y;
      ctx.save();
      ctx.globalAlpha=Math.max(0,Math.min(1,layer.opacity));
      ctx.globalCompositeOperation=layer.blendMode||'source-over';
      ctx.translate(cx,cy);
      ctx.rotate((layer.rotation||0)*Math.PI/180);
      ctx.scale(layer.flipH?-1:1, layer.flipV?-1:1);
      ctx.drawImage(img, -drawW/2, -drawH/2, drawW, drawH);
      ctx.restore();
    }
  });

  B.registerNewPhotoHook(()=>{
    layers.length=0;
    appliedPreset=null;
    updateLayerFab();
    closeLayerPanel();
  });

  // Holds an overlay waiting to be pinned once the user picks a photo.
  let pendingOverlayApply=null;

  function addOverlayLayer(overlay, overlayId){
    if(!B.state.originalCanvas){
      pendingOverlayApply={ overlay, overlayId };
      B.goToPage('home');
      B.toast(`Pilih foto untuk memasang overlay "${overlay.name}"...`);
      B.pickFile();
      return;
    }
    doAddOverlayLayer(overlay, overlayId);
  }

  function doAddOverlayLayer(overlay, overlayId){
    const layer={
      id:'l'+Date.now()+Math.random().toString(36).slice(2,6),
      overlayId, url:overlay.pngUrl, creatorUid:overlay.creatorUid, creatorName:overlay.creatorName,
      x:0.5, y:0.5, scale:0.5, rotation:0, opacity:1, blendMode:'source-over',
      flipH:false, flipV:false, order:layers.length
    };
    layers.push(layer);
    loadImg(layer.url);
    C.incrementCounter('overlays', overlayId, 'downloadCount', 1);
    if(B.getUid() && overlay.creatorUid!==B.getUid()) C.incrementCounter('profiles', overlay.creatorUid, 'overlayUseCount', 1);
    B.renderPreview(true);
    updateLayerFab();
    openLayerPanel();
    B.goToPage('home');
    B.toast(`Overlay "${overlay.name}" ditambahkan.`,'success');
  }

  B.registerPhotoReadyHook(()=>{
    if(pendingOverlayApply){
      const {overlay,overlayId}=pendingOverlayApply;
      pendingOverlayApply=null;
      doAddOverlayLayer(overlay, overlayId);
    }
  });

  /* ---- Floating pill (shows on editor page when layers exist) ---- */
  let fab=document.getElementById('peOverlayFab');
  if(!fab){
    fab=document.createElement('button');
    fab.id='peOverlayFab';
    fab.className='pe-overlay-fab';
    fab.style.display='none';
    document.body.appendChild(fab);
    fab.addEventListener('click', ()=>{ B.haptic(); openLayerPanel(); });
  }
  function updateLayerFab(){
    fab.innerHTML = layers.length ? `<i class="fa-solid fa-layer-group"></i> ${layers.length} Overlay Aktif` : '';
    fab.style.display = layers.length ? 'flex' : 'none';
  }

  const BLEND_MODES=['source-over','multiply','screen','overlay','lighten','darken','color-dodge','soft-light','hard-light'];
  const BLEND_LABELS={'source-over':'Normal',multiply:'Multiply',screen:'Screen',overlay:'Overlay',lighten:'Lighten',darken:'Darken','color-dodge':'Color Dodge','soft-light':'Soft Light','hard-light':'Hard Light'};

  let panel=document.getElementById('peLayerPanel');
  if(!panel){
    panel=document.createElement('div');
    panel.id='peLayerPanel';
    panel.className='pe-layer-panel';
    document.body.appendChild(panel);
  }
  function closeLayerPanel(){ panel.classList.remove('active'); }
  function openLayerPanel(){
    panel.classList.add('active');
    renderLayerPanel();
  }
  function renderLayerPanel(){
    if(!layers.length){ panel.innerHTML=`<div class="sheet-handle"></div><p class="pe-layer-empty">Belum ada overlay dipasang. Buka menu Overlay lalu pilih "Pasang di Foto".</p>`; return; }
    const sorted=[...layers].sort((a,b)=>a.order-b.order);
    panel.innerHTML=`
      <div class="sheet-handle"></div>
      <div class="pe-layer-head"><h4>Overlay di Foto (${layers.length})</h4><button class="icon-btn" id="peLayerClose">&times;</button></div>
      <div class="pe-layer-list">
        ${sorted.map((l,i)=>`
          <div class="pe-layer-item" data-lid="${l.id}">
            <div class="pe-layer-row-top">
              <img class="pe-layer-thumb" src="${esc(l.url)}">
              <span class="pe-layer-name">Layer ${i+1}</span>
              <div class="pe-layer-order">
                <button data-act="up" ${i===0?'disabled':''}><i class="fa-solid fa-caret-up"></i></button>
                <button data-act="down" ${i===sorted.length-1?'disabled':''}><i class="fa-solid fa-caret-down"></i></button>
                <button data-act="flipH">FlipH</button>
                <button data-act="flipV">FlipV</button>
                <button data-act="remove" class="pe-layer-remove"><i class="fa-solid fa-xmark"></i></button>
              </div>
            </div>
            <label>Posisi X <input type="range" min="0" max="100" value="${Math.round(l.x*100)}" data-prop="x"></label>
            <label>Posisi Y <input type="range" min="0" max="100" value="${Math.round(l.y*100)}" data-prop="y"></label>
            <label>Scale <input type="range" min="5" max="150" value="${Math.round(l.scale*100)}" data-prop="scale"></label>
            <label>Rotation <input type="range" min="0" max="360" value="${Math.round(l.rotation)}" data-prop="rotation"></label>
            <label>Opacity <input type="range" min="0" max="100" value="${Math.round(l.opacity*100)}" data-prop="opacity"></label>
            <label>Blend
              <select data-prop="blendMode">
                ${BLEND_MODES.map(m=>`<option value="${m}" ${l.blendMode===m?'selected':''}>${BLEND_LABELS[m]}</option>`).join('')}
              </select>
            </label>
          </div>
        `).join('')}
      </div>
    `;
    panel.querySelector('#peLayerClose').addEventListener('click', closeLayerPanel);
    const rerender=B.debounce(()=>B.renderPreview(true), 60);
    panel.querySelectorAll('.pe-layer-item').forEach(item=>{
      const lid=item.dataset.lid;
      const layer=layers.find(l=>l.id===lid);
      item.querySelectorAll('input[data-prop]').forEach(inp=>{
        inp.addEventListener('input', ()=>{
          const prop=inp.dataset.prop, val=Number(inp.value);
          if(prop==='x'||prop==='y') layer[prop]=val/100;
          else if(prop==='scale') layer.scale=val/100;
          else if(prop==='opacity') layer.opacity=val/100;
          else layer[prop]=val;
          rerender();
        });
      });
      item.querySelector('select[data-prop="blendMode"]').addEventListener('change',(e)=>{
        layer.blendMode=e.target.value; rerender();
      });
      item.querySelectorAll('button[data-act]').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const act=btn.dataset.act;
          if(act==='flipH') layer.flipH=!layer.flipH;
          else if(act==='flipV') layer.flipV=!layer.flipV;
          else if(act==='remove'){
            const idx=layers.findIndex(l=>l.id===lid);
            if(idx!==-1) layers.splice(idx,1);
            layers.forEach((l,i)=>l.order=i);
            updateLayerFab();
            renderLayerPanel();
            B.renderPreview(true);
            return;
          }else if(act==='up'||act==='down'){
            const arr=[...layers].sort((a,b)=>a.order-b.order);
            const i=arr.findIndex(l=>l.id===lid);
            const j=act==='up'?i-1:i+1;
            if(j<0||j>=arr.length) return;
            [arr[i].order,arr[j].order]=[arr[j].order,arr[i].order];
            renderLayerPanel();
            B.renderPreview(true);
            return;
          }
          B.renderPreview(true);
        });
      });
    });
  }

  /* ------------------------------------------------------------------
     4. DETAIL VIEWS (opened from community.js card clicks via openDetail)
     ------------------------------------------------------------------ */
  async function openDetail(type, id){
    const db=B.getFirestore();
    if(!db){ B.toast('Belum terhubung ke server.'); return; }
    if(type==='preset') return openPresetDetail(id);
    if(type==='overlay') return openOverlayDetail(id);
    if(type==='feed' && window.PECommunity.openFeedDetail) return window.PECommunity.openFeedDetail(id);
  }

  async function openPresetDetail(id){
    const db=B.getFirestore();
    // FIX: wrap the read in try/catch so a denied/failed request (e.g.
    // "Missing or insufficient permissions") shows a toast instead of
    // throwing an unhandled promise rejection.
    let snap;
    try{ snap=await db.collection('presets').doc(id).get(); }
    catch(err){ console.error('openPresetDetail error', err); B.toast('Gagal memuat preset.','error'); return; }
    if(!snap.exists){ B.toast('Preset tidak ditemukan.'); return; }
    const d=snap.data();
    const isOwner=B.getUid()===d.creatorUid;
    openModal(`
      <div class="modal-head"><h3>${esc(d.name)}</h3><button class="icon-btn" data-close>&times;</button></div>
      ${d.thumbnail?`<img class="pe-detail-thumb" src="${esc(d.thumbnail)}">`:''}
      <div class="modal-section">
        <p class="pe-detail-creator" data-creator-uid="${esc(d.creatorUid)}">by @${esc(d.creatorName)}</p>
        <p class="pe-detail-desc">${esc(d.description)||'<i>Tidak ada deskripsi.</i>'}</p>
        <div class="pe-detail-stats">
          <span><i class="fa-solid fa-heart"></i> ${d.likeCount||0}</span><span><i class="fa-solid fa-download"></i> ${d.downloadCount||0}</span>
          <span><i class="fa-solid fa-rotate"></i> ${d.useCount||0}</span><span><i class="fa-solid fa-star"></i> ${d.favoriteCount||0}</span>
        </div>
        <div class="pe-detail-tags">${(d.tags||[]).map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="pe-detail-actions">
        <button class="btn-primary" id="peUseBtn" style="flex:2;justify-content:center;">Gunakan Preset</button>
        <button class="btn-ghost" id="peLikeBtn"><i class="fa-solid fa-heart"></i> Like</button>
        <button class="btn-ghost" id="peFavBtn"><i class="fa-solid fa-star"></i> Favorit</button>
      </div>
      <div class="pe-detail-actions">
        <button class="btn-ghost" id="peCopyBtn" style="flex:1;">Copy</button>
        <button class="btn-ghost" id="peDownloadBtn" style="flex:1;">Download</button>
        <button class="btn-ghost" id="peShareLinkBtn" style="flex:1;"><i class="fa-solid fa-link"></i> Salin Link</button>
        ${isOwner?'<button class="btn-ghost" id="peEditBtn" style="flex:1;">Edit</button><button class="btn-ghost" id="peDeleteBtn" style="flex:1;color:#ff5c7a;">Hapus</button>':''}
      </div>
    `);
    onModal('[data-close]','click',closeModal);
    onModal('#peUseBtn','click', ()=>{ applyPreset(id,d); closeModal(); });
    onModal('#peLikeBtn','click', async ()=>{ B.haptic(); const liked=await C.toggleLike('preset',id); if(liked!==null) B.toast(liked?'Disukai':'Batal suka'); });
    onModal('#peFavBtn','click', async ()=>{ B.haptic(); const fav=await C.toggleFavorite('preset',id); if(fav!==null) B.toast(fav?'Ditambah ke favorit':'Dihapus dari favorit'); });
    onModal('#peCopyBtn','click', ()=>duplicatePreset(id,d));
    onModal('#peDownloadBtn','click', async ()=>{ await C.incrementCounter('presets',id,'downloadCount',1); B.toast('Preset disimpan.','success'); });
    onModal('#peShareLinkBtn','click', ()=>C.copyShareLink('preset',id));
    onModal('#peEditBtn','click', ()=>openPresetForm({id,...d}));
    onModal('#peDeleteBtn','click', ()=>deletePreset(id,d.creatorUid));
    onModal('.pe-detail-creator','click', ()=>{ if(window.PECommunity.openProfile) window.PECommunity.openProfile(d.creatorUid); });
  }

  async function openOverlayDetail(id){
    const db=B.getFirestore();
    // FIX: same permission/error guard as openPresetDetail above.
    let snap;
    try{ snap=await db.collection('overlays').doc(id).get(); }
    catch(err){ console.error('openOverlayDetail error', err); B.toast('Gagal memuat overlay.','error'); return; }
    if(!snap.exists){ B.toast('Overlay tidak ditemukan.'); return; }
    const d=snap.data();
    const isOwner=B.getUid()===d.creatorUid;
    openModal(`
      <div class="modal-head"><h3>${esc(d.name)}</h3><button class="icon-btn" data-close>&times;</button></div>
      <div class="pe-ov-preview"><img src="${esc(d.pngUrl)}"></div>
      <div class="modal-section">
        <p class="pe-detail-creator" data-creator-uid="${esc(d.creatorUid)}">by @${esc(d.creatorName)}</p>
        <div class="pe-detail-stats">
          <span><i class="fa-solid fa-heart"></i> ${d.likeCount||0}</span><span><i class="fa-solid fa-download"></i> ${d.downloadCount||0}</span><span><i class="fa-solid fa-star"></i> ${d.favoriteCount||0}</span>
        </div>
        <div class="pe-detail-tags">${(d.tags||[]).map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="pe-detail-actions">
        <button class="btn-primary" id="peOvAddBtn" style="flex:2;justify-content:center;">Pasang di Foto</button>
        <button class="btn-ghost" id="peOvLikeBtn"><i class="fa-solid fa-heart"></i> Like</button>
        <button class="btn-ghost" id="peOvFavBtn"><i class="fa-solid fa-star"></i> Favorit</button>
      </div>
      <div class="pe-detail-actions">
        <button class="btn-ghost" id="peOvShareLinkBtn" style="flex:1;"><i class="fa-solid fa-link"></i> Salin Link</button>
        ${isOwner?'<button class="btn-ghost" id="peOvEditBtn" style="flex:1;">Edit</button><button class="btn-ghost" id="peOvDeleteBtn" style="flex:1;color:#ff5c7a;">Hapus</button>':''}
      </div>
    `);
    onModal('[data-close]','click',closeModal);
    onModal('#peOvAddBtn','click', ()=>{ addOverlayLayer(d,id); closeModal(); });
    onModal('#peOvLikeBtn','click', async ()=>{ B.haptic(); const liked=await C.toggleLike('overlay',id); if(liked!==null) B.toast(liked?'Disukai':'Batal suka'); });
    onModal('#peOvFavBtn','click', async ()=>{ B.haptic(); const fav=await C.toggleFavorite('overlay',id); if(fav!==null) B.toast(fav?'Ditambah ke favorit':'Dihapus dari favorit'); });
    onModal('#peOvShareLinkBtn','click', ()=>C.copyShareLink('overlay',id));
    onModal('#peOvEditBtn','click', ()=>openOverlayForm({id,...d}));
    onModal('#peOvDeleteBtn','click', ()=>deleteOverlay(id,d.creatorUid));
    onModal('.pe-detail-creator','click', ()=>{ if(window.PECommunity.openProfile) window.PECommunity.openProfile(d.creatorUid); });
  }

  /* ------------------------------------------------------------------
     5. UPLOAD ENTRY POINT — called by community.js's "Create" button
        with the currently active sub-tab ('feed'|'preset'|'overlay').
        community-social.js overrides the 'feed' case once it loads.
     ------------------------------------------------------------------ */
  function openUpload(tab){
    if(!B.getUid()){ B.toast('Login dulu untuk membuat konten.'); return; }
    if(tab==='preset') return openPresetForm(null);
    if(tab==='overlay') return openOverlayForm(null);
    if(window.PECommunity.openPostForm) return window.PECommunity.openPostForm();
    B.toast('Buka tab Feed untuk membagikan hasil editanmu.');
  }

  /* ------------------------------------------------------------------
     6. EXPORTS
     ------------------------------------------------------------------ */
  Object.assign(window.PECommunity, {
    openDetail, openUpload,
    openPresetForm, openOverlayForm,
    applyPreset, addOverlayLayer,
    getAppliedPreset: ()=>appliedPreset,
    getOverlayLayers: ()=>layers.slice(),
    clearAppliedPreset: ()=>{ appliedPreset=null; }
  });
});

})();
