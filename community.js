/* ==========================================================================
   COMMUNITY MODULE (community.js)
   Adds the "Creator Community" system on top of the existing Photo Enhance
   app WITHOUT touching script.js's editing/export pipeline. This file talks
   to script.js only through the small `window.PEBridge` surface it exposes
   (see the end of script.js) — nothing in here reaches into the host app's
   internals directly, so the old features can never be broken by this file.

   PHASE 1 of the build: Firestore schema + Community nav shell.
   This phase wires up navigation, sub-tabs, search/filter/sort UI, live
   (currently-empty) Firestore reads with skeleton loading + infinite
   scroll, and the shared Firestore read/write helpers that later phases
   (Preset Creator, Overlay Creator, Feed posting, Watermarking, Profile)
   will build on. No Firebase Storage is used anywhere — every image is a
   URL already hosted on ImgBB (via PEBridge.uploadImageToImgbb, which the
   host app already uses for profile photos).

   ==========================================================================
   FIRESTORE SCHEMA (collections this module owns)
   ==========================================================================
   presets/{presetId}
     name, description, thumbnail(ImgBB url), category, tags:[string],
     themeColor, settings:{...all editor slider values}, creatorName,
     creatorUid, likeCount, downloadCount, useCount, favoriteCount,
     createdAt(serverTimestamp), version(number)

   overlays/{overlayId}
     name, thumbnail(ImgBB url), pngUrl(ImgBB url, transparent PNG),
     category, tags:[string], creatorName, creatorUid, likeCount,
     favoriteCount, downloadCount, createdAt(serverTimestamp)

   posts/{postId}                          -- Community feed
     thumbnail, resultUrl, originalUrl, title, description,
     presetId, presetName, overlayIds:[string], creatorName, creatorUid,
     likeCount, commentCount, downloadCount, createdAt(serverTimestamp)

   posts/{postId}/comments/{commentId}     -- sub-collection
     text, uid, name, photo, createdAt(serverTimestamp), parentId(or null)

   profiles/{uid}                          -- EXTENDS the doc script.js
     already writes (username/photoURL/email). Community-only fields are
     merged in on top, never overwriting the existing ones:
     bio, followerCount, followingCount, totalUpload, totalLike,
     totalDownload, presetUseCount, overlayUseCount,
     accountType:'free'|'pro'

   follows/{followerUid_targetUid}
     followerUid, followingUid, createdAt(serverTimestamp)

   likes/{type_itemId_uid}                 -- type: 'preset'|'overlay'|'post'
     type, itemId, uid, createdAt(serverTimestamp)

   favorites/{type_itemId_uid}
     type, itemId, uid, createdAt(serverTimestamp)
   ========================================================================== */
(function(){
"use strict";

function ready(fn){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

ready(function(){
  const B = window.PEBridge;
  if(!B){ console.error('community.js: PEBridge not found — is script.js loaded first?'); return; }

  const $ = B.$;
  B.registerPage('community');

  /* ------------------------------------------------------------------
     0. CONFIG — categories, sorts, per-collection metadata
     ------------------------------------------------------------------ */
  const PRESET_CATEGORIES = ['Portrait','Landscape','Anime','HDR','Vintage','Black & White','Food','Night','Cinematic','Custom'];
  const OVERLAY_CATEGORIES = ['Fire','Water','Smoke','Snow','Rain','Spark','Lens Flare','Magic','Dust','Shadow','Light','Custom'];

  const SORTS = {
    preset:  [ {id:'newest', label:'Terbaru', field:'createdAt'}, {id:'popular', label:'Populer', field:'likeCount'}, {id:'used', label:'Paling Digunakan', field:'useCount'} ],
    overlay: [ {id:'newest', label:'Terbaru', field:'createdAt'}, {id:'popular', label:'Populer', field:'likeCount'} ],
    feed:    [ {id:'trending', label:'Trending', field:'likeCount'}, {id:'newest', label:'Terbaru', field:'createdAt'}, {id:'popular', label:'Populer', field:'downloadCount'} ]
  };

  const TAB_META = {
    feed:    { collection:'posts',    categories:null,             emptyTitle:'Belum Ada Postingan', emptyText:'Jadilah yang pertama membagikan hasil editanmu di sini.' },
    preset:  { collection:'presets',  categories:PRESET_CATEGORIES, emptyTitle:'Belum Ada Preset',    emptyText:'Buat preset dari pengaturan edit yang sedang kamu pakai.' },
    overlay: { collection:'overlays', categories:OVERLAY_CATEGORIES,emptyTitle:'Belum Ada Overlay',   emptyText:'Unggah overlay PNG transparan pertamamu.' }
  };

  const PAGE_SIZE = 12;

  const state = {
    tab:'feed',
    category:null,
    sort:SORTS.feed[0].id,
    search:'',
    items:[],
    lastDoc:null,
    loading:false,
    exhausted:false,
    initedTabs:{}
  };

  /* ------------------------------------------------------------------
     1. DOM REFS
     ------------------------------------------------------------------ */
  const subnav=$('communitySubnav');
  const categoryRow=$('communityCategoryRow');
  const sortRow=$('communitySortRow');
  const searchInput=$('communitySearchInput');
  const btnSort=$('btnCommunitySort');
  const grid=$('communityGrid');
  const emptyEl=$('communityEmpty');
  const emptyTitleEl=$('communityEmptyTitle');
  const emptyTextEl=$('communityEmptyText');
  const emptyActionBtn=$('btnCommunityEmptyAction');
  const scrollEl=$('communityScroll');
  const sentinel=$('communitySentinel');
  const btnCreate=$('btnCommunityCreate');
  const subtitleEl=$('communitySubtitle');

  if(!subnav || !grid) return; // markup not present — nothing to wire up

  /* ------------------------------------------------------------------
     2. GENERIC FIRESTORE HELPERS (used by this phase + future phases)
     ------------------------------------------------------------------ */
  function fs(){ return B.getFirestore(); }
  function fb(){ return B.getFirebase(); }
  function serverTS(){ const f=fb(); return f ? f.firestore.FieldValue.serverTimestamp() : null; }
  function increment(n){ const f=fb(); return f ? f.firestore.FieldValue.increment(n) : n; }

  // FIX: helper to consistently check login state before any Firestore
  // call that requires an authenticated user (mirrors `auth.currentUser`).
  // B.getUid() reflects the live Firebase auth uid exposed by script.js.
  function isLoggedIn(){ return !!B.getUid(); }

  async function createDoc(collection, data){
    const db=fs(); if(!db) throw new Error('Firestore belum siap.');
    // FIX: creating docs (posts/presets/overlays/reports/etc.) always needs
    // an authenticated uid under our rules — guard here too, in addition to
    // the UI-level checks each caller already does, so this helper is safe
    // to call directly and never throws "Missing or insufficient permissions".
    if(!isLoggedIn()){ console.warn('User belum login.'); throw new Error('Login dulu untuk melanjutkan.'); }
    try{
      const ref=await db.collection(collection).add({ ...data, createdAt:serverTS() });
      return ref.id;
    }catch(err){
      console.error('createDoc error', err);
      throw err; // caller already wraps its own try/catch + toast
    }
  }

  async function updateDocById(collection, id, data){
    const db=fs(); if(!db) throw new Error('Firestore belum siap.');
    // FIX: writes that need a user context now guard on login first so we
    // never hit "Missing or insufficient permissions" from an anonymous call.
    if(!isLoggedIn()){ console.warn('User belum login.'); return; }
    try{
      await db.collection(collection).doc(id).set(data, { merge:true });
    }catch(err){
      console.error('updateDocById error', err);
      throw err; // caller already wraps its own try/catch + toast
    }
  }
  async function deleteDocById(collection, id){
    const db=fs(); if(!db) throw new Error('Firestore belum siap.');
    if(!isLoggedIn()){ console.warn('User belum login.'); return; }
    try{
      await db.collection(collection).doc(id).delete();
    }catch(err){
      console.error('deleteDocById error', err);
      throw err;
    }
  }
  async function incrementCounter(collection, id, field, delta){
    const db=fs(); if(!db) return;
    // FIX: counter increments are writes too — require login and never
    // let a rejected promise go unhandled (this is called "fire-and-forget"
    // in several places, so it must swallow its own errors safely).
    if(!isLoggedIn()){ console.warn('User belum login.'); return; }
    try{
      await db.collection(collection).doc(id).set({ [field]: increment(delta) }, { merge:true });
    }catch(err){
      console.error('incrementCounter error', err);
    }
  }

  // Toggle like/favorite via a marker doc keyed by type_itemId_uid, so a
  // user's like state is O(1) to check and the counter never drifts from
  // double-clicks (the marker doc's existence IS the source of truth).
  async function toggleMark(kind /* 'likes'|'favorites' */, type, itemId, countField){
    const uid=B.getUid();
    if(!uid){ B.requireLogin('Login untuk melanjutkan.'); return null; }
    const db=fs(); if(!db) return null;
    const markId=`${type}_${itemId}_${uid}`;
    const ref=db.collection(kind).doc(markId);
    // FIX: wrap the whole read/write sequence in try/catch so a denied
    // permission (e.g. rules briefly out of sync with auth state) never
    // throws an unhandled promise rejection up into the click handler.
    try{
      const snap=await ref.get();
      if(snap.exists){
        await ref.delete();
        await incrementCounter(TAB_META[type] ? TAB_META[type].collection : type+'s', itemId, countField, -1);
        return false;
      }else{
        await ref.set({ type, itemId, uid, createdAt:serverTS() });
        await incrementCounter(TAB_META[type] ? TAB_META[type].collection : type+'s', itemId, countField, 1);
        return true;
      }
    }catch(err){
      console.error('toggleMark error', err);
      B.toast('Gagal memperbarui, coba lagi.','error');
      return null;
    }
  }
  const toggleLike = (type,itemId)=>toggleMark('likes', type, itemId, 'likeCount');
  const toggleFavorite = (type,itemId)=>toggleMark('favorites', type, itemId, 'favoriteCount');

  // Ensures community-only fields exist on the user's profile doc without
  // ever overwriting fields script.js already owns (username/photoURL/email).
  async function ensureCommunityProfileFields(uid){
    const db=fs(); if(!db || !uid) return;
    // FIX: require an authenticated user matching this uid before writing —
    // Firestore rules for `profiles/{uid}` typically require
    // request.auth.uid == uid, so calling this while logged out (or for a
    // uid that isn't the current user) is exactly what produced the
    // "Missing or insufficient permissions" error.
    if(!isLoggedIn() || B.getUid()!==uid){ console.warn('User belum login.'); return; }
    try{
      // FIX: "merge" and "mergeFields" can never both be passed to set().
      // We want to merge the whole object of default fields without
      // clobbering fields script.js already owns, so we keep ONLY
      // `merge:true` and drop `mergeFields` entirely. (mergeFields would
      // only be needed if we wanted to restrict the write to a subset of
      // the keys in the object — we don't, since the object already
      // contains exactly the community-owned fields.)
      await db.collection('profiles').doc(uid).set({
        bio:'', followerCount:0, followingCount:0, totalUpload:0, totalLike:0,
        totalDownload:0, presetUseCount:0, overlayUseCount:0, accountType:'free'
      }, { merge:true });
    }catch(err){ /* non-fatal — profile fields just won't show counts yet */ console.warn('ensureCommunityProfileFields', err); }
  }

  // Expose the write/read layer so Preset/Overlay/Feed phases (and their
  // own separately-loaded files) can reuse it instead of re-implementing
  // Firestore access.
  // Builds a shareable link that reopens the right detail view when
  // visited. type is 'feed' | 'preset' | 'overlay'; id is the Firestore
  // doc id. Kept centralized here so every "Salin Link" button across
  // feed/preset/overlay produces the exact same URL shape.
  function buildShareLink(type, id){
    return 'https://luminux.my.id/photolab.html?open=' + encodeURIComponent(type) + '-' + encodeURIComponent(id);
  }

  // Copies a share link to the clipboard and toasts the result. Shared by
  // the feed/preset/overlay "Salin Link" buttons.
  async function copyShareLink(type, id){
    const url = buildShareLink(type, id);
    try{
      await navigator.clipboard.writeText(url);
      B.toast('Link disalin.', 'success');
    }catch(e){
      B.toast('Gagal menyalin link.');
    }
  }

  // If the page was opened via a shared link (?open=type-id), reopen the
  // matching detail modal. Called once the user is authenticated (the app
  // is gated behind login, so there's nothing to show before that) — see
  // the resolveSharedLink() call wired into photolab-script.js's
  // handleAuthenticatedState(). Safe to call more than once; it only
  // triggers on the first successful match, then cleans the URL so a
  // refresh/back-nav doesn't reopen it.
  let sharedLinkResolved = false;
  function resolveSharedLink(){
    if(sharedLinkResolved) return;
    const params = new URLSearchParams(location.search);
    const open = params.get('open');
    if(!open) return;
    const sep = open.indexOf('-');
    if(sep < 1) return;
    const type = open.slice(0, sep);
    const id = open.slice(sep + 1);
    if(!['feed', 'preset', 'overlay'].includes(type) || !id) return;
    sharedLinkResolved = true;
    // Strip the query param so it doesn't reopen on refresh/back.
    const cleanUrl = location.pathname + location.hash;
    history.replaceState(null, '', cleanUrl);
    // window.PECommunity.openDetail is attached by community-creator.js,
    // which loads right after this file — by the time auth resolves
    // (a network round trip) it's always ready, but retry briefly just
    // in case of unusual load ordering.
    let tries = 0;
    (function attempt(){
      if(window.PECommunity && typeof window.PECommunity.openDetail === 'function'){
        window.PECommunity.openDetail(type, id);
      }else if(tries++ < 20){
        setTimeout(attempt, 100);
      }
    })();
  }

  window.PECommunity = {
    PRESET_CATEGORIES, OVERLAY_CATEGORIES, SORTS, TAB_META,
    createDoc, updateDocById, deleteDocById, incrementCounter,
    toggleLike, toggleFavorite, ensureCommunityProfileFields,
    serverTS, increment,
    refreshCurrentTab: ()=>loadPage(true),
    buildShareLink, copyShareLink, resolveSharedLink
  };

  /* ------------------------------------------------------------------
     3. SUB-TAB / CHIP / SORT UI
     ------------------------------------------------------------------ */
  function renderCategoryChips(){
    const meta=TAB_META[state.tab];
    if(!meta.categories){ categoryRow.innerHTML=''; categoryRow.style.display='none'; return; }
    categoryRow.style.display='flex';
    categoryRow.innerHTML = ['Semua', ...meta.categories].map(cat=>{
      const val = cat==='Semua' ? '' : cat;
      const active = (state.category||'')===val ? ' active' : '';
      return `<button class="chip${active}" data-cat="${val}">${cat}</button>`;
    }).join('');
  }
  function renderSortChips(){
    sortRow.innerHTML = SORTS[state.tab].map(s=>{
      const active = state.sort===s.id ? ' active' : '';
      return `<button class="chip${active}" data-sort="${s.id}">${s.label}</button>`;
    }).join('');
  }
  categoryRow.addEventListener('click',(e)=>{
    const btn=e.target.closest('[data-cat]'); if(!btn) return;
    state.category = btn.dataset.cat || null;
    renderCategoryChips();
    loadPage(true);
  });
  sortRow.addEventListener('click',(e)=>{
    const btn=e.target.closest('[data-sort]'); if(!btn) return;
    state.sort = btn.dataset.sort;
    renderSortChips();
    loadPage(true);
  });
  subnav.addEventListener('click',(e)=>{
    const btn=e.target.closest('.community-subnav-btn'); if(!btn) return;
    const tab=btn.dataset.sub;
    if(tab===state.tab) return;
    state.tab=tab; state.category=null; state.sort=SORTS[tab][0].id; state.search='';
    if(searchInput) searchInput.value='';
    subnav.querySelectorAll('.community-subnav-btn').forEach(b=>b.classList.toggle('active', b.dataset.sub===tab));
    grid.className = 'community-grid' + (tab==='feed' ? ' feed-grid' : '');
    if(subtitleEl){
      subtitleEl.textContent = tab==='feed' ? 'Karya terbaru dari para creator'
        : tab==='preset' ? 'Preset siap pakai dari komunitas'
        : 'Overlay PNG transparan dari komunitas';
    }
    B.haptic();
    renderCategoryChips();
    renderSortChips();
    loadPage(true);
  });

  let searchDebounced;
  if(searchInput){
    searchDebounced = B.debounce((val)=>{ state.search=val.trim().toLowerCase(); loadPage(true); }, 350);
    searchInput.addEventListener('input',(e)=> searchDebounced(e.target.value));
  }

  if(btnSort){
    btnSort.addEventListener('click', ()=>{
      // Cycle to the next sort option as a quick affordance; the chip row
      // above remains the precise control.
      const opts=SORTS[state.tab];
      const idx=opts.findIndex(o=>o.id===state.sort);
      state.sort = opts[(idx+1)%opts.length].id;
      renderSortChips();
      loadPage(true);
      B.haptic();
    });
  }

  if(btnCreate){
    btnCreate.addEventListener('click', ()=>{
      if(!B.getUid()){ B.requireLogin('Login untuk membuat konten.'); return; }
      if(window.PECommunity && typeof window.PECommunity.openUpload==='function'){
        window.PECommunity.openUpload(state.tab);
      }else{
        B.toast('Modul upload belum dimuat.');
      }
    });
  }

  if(emptyActionBtn){
    emptyActionBtn.addEventListener('click', ()=>{
      // Reuses the exact same open-upload flow as the header "+" button,
      // just surfaced right where the person is looking (the empty feed).
      if(btnCreate) btnCreate.click();
    });
  }

  /* ------------------------------------------------------------------
     4. DATA LOADING (live Firestore reads, currently-empty collections
        render the empty state correctly; real docs from later phases
        will render as cards automatically)
     ------------------------------------------------------------------ */
  function buildQuery(){
    const db=fs();
    const meta=TAB_META[state.tab];
    let q=db.collection(meta.collection);
    if(state.category) q=q.where('category','==',state.category);
    const sortDef=SORTS[state.tab].find(s=>s.id===state.sort) || SORTS[state.tab][0];
    q=q.orderBy(sortDef.field,'desc');
    if(state.lastDoc) q=q.startAfter(state.lastDoc);
    q=q.limit(PAGE_SIZE);
    return q;
  }

  function renderSkeletons(){
    const n = state.tab==='feed' ? 4 : 6;
    grid.innerHTML = Array.from({length:n}).map(()=>
      `<div class="skeleton-block skeleton-card${state.tab==='feed'?' feed':''}"></div>`
    ).join('');
  }

  function cardHTML(type, id, d){
    const thumb = d.thumbnail || d.pngUrl || d.resultUrl || '';
    const title = d.name || d.title || 'Untitled';
    const creator = d.creatorName || 'Creator';
    const likeCount = d.likeCount||0, useCount=d.useCount, downloadCount=d.downloadCount||0, commentCount=d.commentCount;
    const statBits = [`<i class="fa-solid fa-heart"></i> ${likeCount}`];
    if(type==='preset') statBits.push(`<i class="fa-solid fa-download"></i> ${d.downloadCount||0}`, `<i class="fa-solid fa-rotate"></i> ${useCount||0}`);
    else if(type==='overlay') statBits.push(`<i class="fa-solid fa-download"></i> ${downloadCount}`);
    else statBits.push(`<i class="fa-solid fa-comment"></i> ${commentCount||0}`, `<i class="fa-solid fa-download"></i> ${downloadCount}`);
    return `
      <div class="community-card" data-id="${id}" data-type="${type}">
        ${d.category ? `<span class="community-card-badge">${d.category}</span>` : ''}
        <button class="community-card-like" data-like="${id}" aria-label="Like">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.5-9.3-9A5 5 0 0 1 12 6a5 5 0 0 1 9.3 5c-2.3 4.5-9.3 9-9.3 9Z" stroke="currentColor" stroke-width="1.8"/></svg>
        </button>
        ${thumb ? `<img class="community-card-thumb" src="${thumb}" alt="" loading="lazy">` : `<div class="community-card-thumb"></div>`}
        <div class="community-card-body">
          <span class="community-card-title">${title}</span>
          <span class="community-card-creator" data-creator-uid="${d.creatorUid||''}">${creator}</span>
          <span class="community-card-stats">${statBits.join('<span>&nbsp;</span>')}</span>
        </div>
      </div>`;
  }

  function passesSearch(d){
    if(!state.search) return true;
    const hay = `${d.name||''} ${d.title||''} ${d.creatorName||''} ${(d.tags||[]).join(' ')}`.toLowerCase();
    return hay.indexOf(state.search)!==-1;
  }

  async function loadPage(reset){
    if(state.loading) return;
    const db=fs();
    if(!db){ renderEmpty('Belum Terhubung', 'Menunggu koneksi ke server. Coba lagi sebentar.'); return; }
    if(reset){ state.items=[]; state.lastDoc=null; state.exhausted=false; grid.innerHTML=''; emptyEl.style.display='none'; renderSkeletons(); }
    if(state.exhausted) return;
    state.loading=true;
    try{
      const snap=await buildQuery().get();
      if(reset) grid.innerHTML='';
      if(snap.empty && state.items.length===0){
        renderEmpty();
      }else{
        emptyEl.style.display='none';
        snap.forEach(doc=>{
          const d=doc.data();
          if(!passesSearch(d)) return;
          state.items.push(doc.id);
          grid.insertAdjacentHTML('beforeend', cardHTML(state.tab, doc.id, d));
        });
      }
      if(snap.docs.length>0) state.lastDoc=snap.docs[snap.docs.length-1];
      if(snap.docs.length < PAGE_SIZE) state.exhausted=true;
    }catch(err){
      console.error('community loadPage error', err);
      if(state.items.length===0){
        // FIX: distinguish "permission-denied" from other failures so the
        // empty-state message actually reflects what happened — most
        // often this means the user isn't logged in yet and the
        // Firestore rules for this collection require auth to read.
        if(err && err.code==='permission-denied'){
          renderEmpty('Belum Bisa Memuat', 'Login dulu untuk melihat konten ini.');
        }else{
          // Most common cause on a fresh project: Firestore composite index
          // missing for (category + orderBy) or security rules not yet
          // deployed for these collections — surface it plainly.
          renderEmpty('Belum Bisa Memuat', 'Terjadi kendala memuat data. Coba lagi nanti.');
        }
      }
    }finally{
      state.loading=false;
    }
  }

  function renderEmpty(title, text){
    grid.innerHTML='';
    emptyEl.style.display='flex';
    emptyTitleEl.textContent = title || TAB_META[state.tab].emptyTitle;
    emptyTextEl.textContent = text || TAB_META[state.tab].emptyText;
    // Only show the "Bagikan Karya" CTA for the genuine no-content-yet case
    // on the Feed tab — not for connection/permission error states, where
    // creating a post wouldn't help anyway.
    if(emptyActionBtn){
      const isGenericEmpty = !title; // renderEmpty() called with no args = default empty
      emptyActionBtn.style.display = (state.tab==='feed' && isGenericEmpty) ? 'inline-flex' : 'none';
    }
  }

  // Like button (event delegation) — works once real cards render.
  grid.addEventListener('click', async (e)=>{
    const likeBtn=e.target.closest('[data-like]');
    if(!likeBtn) return;
    e.stopPropagation();
    const card=likeBtn.closest('.community-card');
    const id=card.dataset.id, type=card.dataset.type;
    B.haptic();
    const liked=await toggleLike(type, id);
    if(liked!==null) likeBtn.classList.toggle('liked', liked);
  });

  // Creator name (event delegation) — opens the creator's profile.
  grid.addEventListener('click', (e)=>{
    const creatorEl=e.target.closest('[data-creator-uid]');
    if(!creatorEl || !creatorEl.dataset.creatorUid) return;
    e.stopPropagation();
    if(window.PECommunity && typeof window.PECommunity.openProfile==='function'){
      window.PECommunity.openProfile(creatorEl.dataset.creatorUid);
    }
  });

  // Card body (event delegation) — opens the detail view for that item.
  grid.addEventListener('click', (e)=>{
    if(e.target.closest('[data-like]') || e.target.closest('[data-creator-uid]')) return;
    const card=e.target.closest('.community-card');
    if(!card) return;
    if(window.PECommunity && typeof window.PECommunity.openDetail==='function'){
      window.PECommunity.openDetail(card.dataset.type, card.dataset.id);
    }
  });

  /* ------------------------------------------------------------------
     5. INFINITE SCROLL
     ------------------------------------------------------------------ */
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{ if(entry.isIntersecting) loadPage(false); });
  }, { root:scrollEl, rootMargin:'200px' }) : null;
  if(io && sentinel) io.observe(sentinel);

  /* ------------------------------------------------------------------
     6. PAGE-CHANGE HOOK — called by script.js's goToPage() via the
        onAppPageChange bridge. Lazily initializes on first visit only.
     ------------------------------------------------------------------ */
  const prevOnPageChange = window.onAppPageChange;
  window.onAppPageChange = function(name){
    if(typeof prevOnPageChange==='function') prevOnPageChange(name);
    if(name!=='community') return;
    const uid=B.getUid();
    if(uid) ensureCommunityProfileFields(uid);
    if(!state.initedTabs[state.tab]){
      state.initedTabs[state.tab]=true;
      renderCategoryChips();
      renderSortChips();
      loadPage(true);
    }
  };

  // Initial chip render so the shell looks correct even before the user
  // ever opens the Community tab.
  renderCategoryChips();
  renderSortChips();
});

})();
