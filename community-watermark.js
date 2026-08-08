/* ==========================================================================
   COMMUNITY SOCIAL MODULE (community-social.js)
   PHASE 2b — feed posting, comments/replies, follow, share/report, and the
   creator Profile panel. Loads after community-creator.js and reuses its
   generic modal shell (window.PECommunityUI) instead of building its own.
   ========================================================================== */
(function(){
"use strict";

function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

ready(function(){
  const B = window.PEBridge;
  const C = window.PECommunity;
  const UI = window.PECommunityUI;
  if(!B || !C || !UI){ console.error('community-social.js: dependencies not found — load order wrong?'); return; }

  const { openModal, closeModal, onModal, onModalAll, modalCard } = UI;
  const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function myDisplayName(){ const p=B.getUserProfile(); return (p && (p.username||p.name)) || 'Creator'; }
  function timeAgo(ts){
    if(!ts || !ts.toDate) return '';
    const s=Math.floor((Date.now()-ts.toDate().getTime())/1000);
    if(s<60) return 'baru saja';
    if(s<3600) return Math.floor(s/60)+'m';
    if(s<86400) return Math.floor(s/3600)+'j';
    return Math.floor(s/86400)+'h';
  }

  /* ------------------------------------------------------------------
     1. POST — share the current edit result to the feed
     ------------------------------------------------------------------ */
  function openPostForm(){
    if(!B.getUid()){ B.toast('Login dulu untuk membagikan hasil editanmu.'); return; }
    if(!B.state.previewCanvas){ B.toast('Pilih & edit foto dulu sebelum membagikannya.'); return; }
    openModal(`
      <div class="modal-head"><h3>Bagikan Hasil Edit</h3><button class="icon-btn" data-close>&times;</button></div>
      <div class="pe-post-preview"><img id="pePostPreviewImg" src="${B.$('canvasAfter').toDataURL('image/jpeg',0.85)}"></div>
      <div class="modal-section"><input class="auth-input" id="pePostTitle" placeholder="Judul postingan" maxlength="60"></div>
      <div class="modal-section"><textarea class="auth-input pe-textarea" id="pePostDesc" placeholder="Ceritakan tentang hasil editanmu" maxlength="300"></textarea></div>
      <button class="btn-primary" id="pePostSubmit" style="width:100%;justify-content:center;">Bagikan ke Community</button>
    `);
    onModal('[data-close]','click',closeModal);
    onModal('#pePostSubmit','click', async ()=>{
      const title=modalCard.querySelector('#pePostTitle').value.trim();
      const description=modalCard.querySelector('#pePostDesc').value.trim();
      if(!title){ B.toast('Judul wajib diisi.'); return; }
      const btn=modalCard.querySelector('#pePostSubmit'); btn.disabled=true; btn.textContent='Mengunggah...';
      try{
        const resultBlob=await new Promise(res=>B.$('canvasAfter').toBlob(res,'image/jpeg',0.9));
        const resultUrl=await B.uploadImageToImgbb(new File([resultBlob],'result.jpg',{type:'image/jpeg'}));
        let originalUrl='';
        if(B.state.originalCanvas){
          const origBlob=await new Promise(res=>B.state.originalCanvas.toBlob(res,'image/jpeg',0.85));
          if(origBlob) originalUrl=await B.uploadImageToImgbb(new File([origBlob],'original.jpg',{type:'image/jpeg'}));
        }
        const applied=C.getAppliedPreset ? C.getAppliedPreset() : null;
        const overlayIds=(C.getOverlayLayers ? C.getOverlayLayers() : []).map(l=>l.overlayId);
        await C.createDoc('posts', {
          thumbnail:resultUrl, resultUrl, originalUrl, title, description,
          presetId: applied?applied.id:null, presetName: applied?applied.name:null,
          overlayIds, creatorName: myDisplayName(), creatorUid: B.getUid(),
          likeCount:0, commentCount:0, downloadCount:0
        });
        C.incrementCounter('profiles', B.getUid(), 'totalUpload', 1);
        closeModal();
        B.toast('Berhasil dibagikan ke Community!','success');
        C.refreshCurrentTab();
      }catch(err){
        console.error(err);
        B.toast('Gagal membagikan: '+(err.message||'coba lagi'),'error');
        btn.disabled=false; btn.textContent='Bagikan ke Community';
      }
    });
  }

  /* ------------------------------------------------------------------
     2. FEED DETAIL — image, stats, like/fav/share/report/download,
        follow creator, comments + replies
     ------------------------------------------------------------------ */
  async function openFeedDetail(id){
    const db=B.getFirestore();
    // FIX: wrap the read in try/catch so a permission-denied or network
    // error surfaces as a toast instead of an unhandled promise rejection.
    let snap;
    try{ snap=await db.collection('posts').doc(id).get(); }
    catch(err){ console.error('openFeedDetail error', err); B.toast('Gagal memuat postingan.','error'); return; }
    if(!snap.exists){ B.toast('Postingan tidak ditemukan.'); return; }
    const d=snap.data();
    const isOwner=B.getUid()===d.creatorUid;
    openModal(`
      <div class="modal-head"><h3>${esc(d.title)}</h3><button class="icon-btn" data-close>&times;</button></div>
      <img class="pe-detail-thumb" src="${esc(d.resultUrl||d.thumbnail)}">
      <div class="modal-section">
        <div class="pe-post-creator-row">
          <span class="pe-detail-creator" data-creator-uid="${esc(d.creatorUid)}">@${esc(d.creatorName)}</span>
          ${isOwner?'':'<button class="btn-ghost pe-follow-btn" id="peFollowBtn">+ Follow</button>'}
        </div>
        <p class="pe-detail-desc">${esc(d.description)}</p>
        <div class="pe-detail-stats">
          <span><i class="fa-solid fa-heart"></i> <span id="peLikeCount">${d.likeCount||0}</span></span>
          <span><i class="fa-solid fa-comment"></i> ${d.commentCount||0}</span>
          <span><i class="fa-solid fa-download"></i> ${d.downloadCount||0}</span>
        </div>
      </div>
      <div class="pe-detail-actions">
        <button class="btn-ghost" id="peFdLike"><i class="fa-solid fa-heart"></i> Like</button>
        <button class="btn-ghost" id="peFdFav"><i class="fa-solid fa-star"></i> Favorit</button>
        <button class="btn-ghost" id="peFdShare"><i class="fa-solid fa-share"></i> Share</button>
        <button class="btn-ghost" id="peFdDownload"><i class="fa-solid fa-download"></i> Download</button>
        <button class="btn-ghost" id="peFdReport" style="color:#ff5c7a;">Report</button>
      </div>
      <div class="modal-section pe-comments-section">
        <h4>Komentar</h4>
        <div id="peCommentList" class="pe-comment-list"><p class="pe-comment-loading">Memuat komentar...</p></div>
        <div class="pe-comment-input-row">
          <input class="auth-input" id="peCommentInput" placeholder="Tulis komentar..." maxlength="300">
          <button class="btn-primary" id="peCommentSend">Kirim</button>
        </div>
        <p id="peReplyingTo" style="display:none;font-size:11px;color:var(--text-dim);"></p>
      </div>
    `);
    onModal('[data-close]','click',closeModal);
    onModal('.pe-detail-creator','click', ()=>{ if(C.openProfile) C.openProfile(d.creatorUid); });
    onModal('#peFdLike','click', async ()=>{
      B.haptic();
      const liked=await C.toggleLike('feed',id);
      if(liked!==null){
        const el=modalCard.querySelector('#peLikeCount');
        el.textContent=Number(el.textContent)+(liked?1:-1);
      }
    });
    onModal('#peFdFav','click', async ()=>{ B.haptic(); const fav=await C.toggleFavorite('feed',id); if(fav!==null) B.toast(fav?'Ditambah ke favorit':'Dihapus dari favorit'); });
    onModal('#peFdShare','click', async ()=>{
      const shareUrl=location.href.split('#')[0]+'#post-'+id;
      if(navigator.share){ try{ await navigator.share({title:d.title, text:d.description, url:shareUrl}); }catch(e){} }
      else{ try{ await navigator.clipboard.writeText(shareUrl); B.toast('Link disalin.','success'); }catch(e){ B.toast('Gagal menyalin link.'); } }
    });
    onModal('#peFdDownload','click', async ()=>{
      const a=document.createElement('a'); a.href=d.resultUrl||d.thumbnail; a.download=(d.title||'photo')+'.jpg'; a.target='_blank';
      document.body.appendChild(a); a.click(); a.remove();
      C.incrementCounter('posts',id,'downloadCount',1);
    });
    onModal('#peFdReport','click', async ()=>{
      if(!B.getUid()){ B.toast('Login dulu.'); return; }
      const reason=prompt('Alasan report postingan ini:');
      if(!reason) return;
      try{
        await C.createDoc('reports', { type:'post', itemId:id, reason, reporterUid:B.getUid() });
        B.toast('Laporan terkirim. Terima kasih.','success');
      }catch(err){ console.error(err); B.toast('Gagal mengirim laporan.'); }
    });

    const followBtn=modalCard.querySelector('#peFollowBtn');
    if(followBtn) setupFollowButton(followBtn, d.creatorUid);

    loadComments(id);
    let replyTo=null;
    onModal('#peCommentSend','click', ()=>submitComment(id));
    onModal('#peCommentInput','keydown', (e)=>{ if(e.key==='Enter') submitComment(id); });

    async function submitComment(postId){
      if(!B.getUid()){ B.toast('Login dulu untuk berkomentar.'); return; }
      const input=modalCard.querySelector('#peCommentInput');
      const text=input.value.trim();
      if(!text) return;
      const p=B.getUserProfile();
      try{
        await B.getFirestore().collection('posts').doc(postId).collection('comments').add({
          text, uid:B.getUid(), name:(p&&(p.username||p.name))||'User', photo:(p&&p.photo)||'',
          parentId: replyTo, createdAt: C.serverTS()
        });
        await C.incrementCounter('posts', postId, 'commentCount', 1);
        input.value='';
        clearReply();
        loadComments(postId);
      }catch(err){ console.error(err); B.toast('Gagal mengirim komentar.'); }
    }
    function setReply(commentId, name){
      replyTo=commentId;
      const el=modalCard.querySelector('#peReplyingTo');
      if(el){ el.style.display='block'; el.textContent=`Membalas @${name} — `; }
      const cancel=document.createElement('button');
      cancel.textContent='batal';
      cancel.style.cssText='background:none;color:var(--accent);font-weight:700;margin-left:4px;';
      cancel.addEventListener('click', clearReply);
      if(el){ el.appendChild(cancel); modalCard.querySelector('#peCommentInput').focus(); }
    }
    function clearReply(){
      replyTo=null;
      const el=modalCard.querySelector('#peReplyingTo');
      if(el){ el.style.display='none'; el.innerHTML=''; }
    }

    async function loadComments(postId){
      const listEl=modalCard.querySelector('#peCommentList');
      if(!listEl) return;
      try{
        const csnap=await B.getFirestore().collection('posts').doc(postId).collection('comments').orderBy('createdAt','asc').limit(200).get();
        if(!modalCard.querySelector('#peCommentList')) return; // modal closed meanwhile
        if(csnap.empty){ listEl.innerHTML='<p class="pe-comment-empty">Belum ada komentar. Jadilah yang pertama!</p>'; return; }
        const all=csnap.docs.map(doc=>({id:doc.id,...doc.data()}));
        const top=all.filter(c=>!c.parentId);
        const byParent={};
        all.filter(c=>c.parentId).forEach(c=>{ (byParent[c.parentId]=byParent[c.parentId]||[]).push(c); });
        listEl.innerHTML=top.map(c=>commentHTML(c, byParent[c.id]||[])).join('');
        listEl.querySelectorAll('[data-reply-id]').forEach(btn=>{
          btn.addEventListener('click', ()=>setReply(btn.dataset.replyId, btn.dataset.replyName));
        });
      }catch(err){ console.error(err); listEl.innerHTML='<p class="pe-comment-empty">Gagal memuat komentar.</p>'; }
    }
    function commentHTML(c, replies){
      return `
        <div class="pe-comment">
          <img class="pe-comment-avatar" src="${esc(c.photo)||'data:,'}">
          <div class="pe-comment-body">
            <span class="pe-comment-name">${esc(c.name)}</span>
            <span class="pe-comment-text">${esc(c.text)}</span>
            <button class="pe-comment-reply" data-reply-id="${c.id}" data-reply-name="${esc(c.name)}">Balas</button>
            ${replies.map(r=>`
              <div class="pe-comment pe-comment-reply-item">
                <img class="pe-comment-avatar" src="${esc(r.photo)||'data:,'}">
                <div class="pe-comment-body">
                  <span class="pe-comment-name">${esc(r.name)}</span>
                  <span class="pe-comment-text">${esc(r.text)}</span>
                </div>
              </div>`).join('')}
          </div>
        </div>`;
    }
  }

  /* ------------------------------------------------------------------
     3. FOLLOW
     ------------------------------------------------------------------ */
  async function isFollowing(targetUid){
    const uid=B.getUid(); if(!uid) return false;
    const db=B.getFirestore();
    // FIX: reading the follow marker needs an authenticated uid under our
    // rules (uid is already required above), and is now wrapped so a
    // denied/failed read doesn't throw into the caller unhandled.
    try{
      const snap=await db.collection('follows').doc(`${uid}_${targetUid}`).get();
      return snap.exists;
    }catch(err){
      console.error('isFollowing error', err);
      return false;
    }
  }
  async function toggleFollow(targetUid){
    const uid=B.getUid();
    // FIX: explicit login guard (equivalent to checking auth.currentUser)
    // before any Firestore read/write below.
    if(!uid){ B.toast('Login dulu untuk follow creator.'); return null; }
    if(uid===targetUid){ B.toast('Tidak bisa follow diri sendiri.'); return null; }
    const db=B.getFirestore();
    const ref=db.collection('follows').doc(`${uid}_${targetUid}`);
    // FIX: wrap the whole follow/unfollow sequence in try/catch so a
    // "Missing or insufficient permissions" error (or any other Firestore
    // failure) shows a toast instead of crashing/leaving an unhandled
    // promise rejection.
    try{
      const snap=await ref.get();
      if(snap.exists){
        await ref.delete();
        C.incrementCounter('profiles', uid, 'followingCount', -1);
        C.incrementCounter('profiles', targetUid, 'followerCount', -1);
        return false;
      }else{
        await ref.set({ followerUid:uid, followingUid:targetUid, createdAt:C.serverTS() });
        C.incrementCounter('profiles', uid, 'followingCount', 1);
        C.incrementCounter('profiles', targetUid, 'followerCount', 1);
        return true;
      }
    }catch(err){
      console.error('toggleFollow error', err);
      B.toast('Gagal memperbarui follow, coba lagi.','error');
      return null;
    }
  }
  async function setupFollowButton(btn, targetUid){
    if(!B.getUid()){ btn.textContent='+ Follow'; }
    else{
      const following=await isFollowing(targetUid);
      btn.textContent=following?'Following':'+ Follow';
      btn.classList.toggle('following', following);
    }
    btn.addEventListener('click', async ()=>{
      B.haptic();
      const nowFollowing=await toggleFollow(targetUid);
      if(nowFollowing!==null){
        btn.textContent=nowFollowing?'Following':'+ Follow';
        btn.classList.toggle('following', nowFollowing);
      }
    });
  }

  /* ------------------------------------------------------------------
     4. PROFILE PANEL
     ------------------------------------------------------------------ */
  let profilePanel=document.getElementById('peProfilePanel');
  if(!profilePanel){
    profilePanel=document.createElement('div');
    profilePanel.id='peProfilePanel';
    profilePanel.className='pe-profile-panel';
    document.body.appendChild(profilePanel);
  }
  function closeProfile(){ profilePanel.classList.remove('active'); }

  const PROFILE_TABS=[
    {id:'posts', label:'Postingan', collection:'posts', field:'creatorUid'},
    {id:'preset', label:'Preset', collection:'presets', field:'creatorUid'},
    {id:'overlay', label:'Overlay', collection:'overlays', field:'creatorUid'},
    {id:'favorit', label:'Favorit', collection:'favorites', field:'uid'}
  ];

  function miniCard(type,id,d){
    const thumb=d.thumbnail||d.pngUrl||d.resultUrl||'';
    const title=d.name||d.title||'Untitled';
    return `<div class="community-card" data-id="${id}" data-type="${type}">
      ${thumb?`<img class="community-card-thumb" src="${esc(thumb)}" loading="lazy">`:'<div class="community-card-thumb"></div>'}
      <div class="community-card-body"><span class="community-card-title">${esc(title)}</span></div>
    </div>`;
  }

  async function openProfile(uid){
    if(!uid){ B.toast('Profil tidak ditemukan.'); return; }
    const db=B.getFirestore();
    profilePanel.classList.add('active');
    profilePanel.innerHTML=`<div class="pe-profile-loading">Memuat profil...</div>`;
    let prof={};
    try{
      const snap=await db.collection('profiles').doc(uid).get();
      if(snap.exists) prof=snap.data();
    }catch(err){ console.error(err); }
    const isMe=B.getUid()===uid;
    const name=prof.username||prof.name||'Creator';
    profilePanel.innerHTML=`
      <div class="pe-profile-head">
        <button class="icon-btn" id="peProfileBack"><i class="fa-solid fa-arrow-left"></i></button>
        <span>Profil</span>
        <span style="width:34px;"></span>
      </div>
      <div class="pe-profile-scroll">
        <div class="pe-profile-hero">
          <img class="pe-profile-avatar" src="${esc(prof.photoURL)||'data:,'}">
          <h2>@${esc(name)}</h2>
          <p class="pe-profile-bio">${esc(prof.bio)||''}</p>
          <div class="pe-profile-stats">
            <div><b>${prof.followerCount||0}</b><span>Follower</span></div>
            <div><b>${prof.followingCount||0}</b><span>Following</span></div>
            <div><b>${prof.totalUpload||0}</b><span>Upload</span></div>
            <div><b>${prof.totalLike||0}</b><span>Like</span></div>
          </div>
          ${isMe?'<button class="btn-ghost" id="peEditBio">Edit Bio</button>':'<button class="btn-ghost pe-follow-btn" id="peProfileFollowBtn">+ Follow</button>'}
          ${isMe?renderWatermarkPicker(prof.watermarkPosition||'bottom-right'):''}
        </div>
        <div class="community-subnav" id="peProfileTabs">
          ${PROFILE_TABS.map((t,i)=>`<button class="community-subnav-btn${i===0?' active':''}" data-ptab="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div class="community-grid" id="peProfileGrid"></div>
      </div>
    `;
    profilePanel.querySelector('#peProfileBack').addEventListener('click', closeProfile);
    const editBio=profilePanel.querySelector('#peEditBio');
    if(editBio) editBio.addEventListener('click', async ()=>{
      // FIX: explicit login guard even though this button only renders for
      // isMe — protects against a stale session expiring mid-view.
      if(!B.getUid()){ B.toast('Login dulu untuk mengedit bio.'); return; }
      const bio=prompt('Bio baru:', prof.bio||'');
      if(bio===null) return;
      try{ await db.collection('profiles').doc(uid).set({bio}, {merge:true}); B.toast('Bio diperbarui.','success'); openProfile(uid); }
      catch(err){ console.error(err); B.toast('Gagal menyimpan bio.'); }
    });
    const followBtn=profilePanel.querySelector('#peProfileFollowBtn');
    if(followBtn) setupFollowButton(followBtn, uid);
    if(isMe) wireWatermarkPicker(uid);

    profilePanel.querySelector('#peProfileTabs').addEventListener('click',(e)=>{
      const btn=e.target.closest('[data-ptab]'); if(!btn) return;
      profilePanel.querySelectorAll('[data-ptab]').forEach(b=>b.classList.toggle('active', b===btn));
      loadProfileTab(btn.dataset.ptab, uid);
    });
    loadProfileTab('posts', uid);

    const grid=profilePanel.querySelector('#peProfileGrid');
    grid.addEventListener('click',(e)=>{
      const card=e.target.closest('.community-card'); if(!card) return;
      if(C.openDetail) C.openDetail(card.dataset.type, card.dataset.id);
    });
  }

  async function loadProfileTab(tabId, uid){
    const grid=profilePanel.querySelector('#peProfileGrid');
    if(!grid) return;
    grid.innerHTML='<p style="padding:20px;color:var(--text-dim);font-size:12.5px;">Memuat...</p>';
    const db=B.getFirestore();
    try{
      if(tabId==='favorit'){
        const fsnap=await db.collection('favorites').where('uid','==',uid).limit(30).get();
        if(fsnap.empty){ grid.innerHTML='<p style="padding:20px;color:var(--text-dim);font-size:12.5px;">Belum ada favorit.</p>'; return; }
        const refs=fsnap.docs.map(d=>d.data());
        const colOf={preset:'presets',overlay:'overlays',feed:'posts'};
        const docs=await Promise.all(refs.map(r=>db.collection(colOf[r.type]||r.type).doc(r.itemId).get().catch(()=>null)));
        grid.innerHTML='';
        docs.forEach((snap,i)=>{
          if(snap && snap.exists) grid.insertAdjacentHTML('beforeend', miniCard(refs[i].type, snap.id, snap.data()));
        });
        if(!grid.innerHTML) grid.innerHTML='<p style="padding:20px;color:var(--text-dim);font-size:12.5px;">Belum ada favorit.</p>';
        return;
      }
      const meta=PROFILE_TABS.find(t=>t.id===tabId);
      const snap=await db.collection(meta.collection).where('creatorUid','==',uid).orderBy('createdAt','desc').limit(30).get();
      if(snap.empty){ grid.innerHTML=`<p style="padding:20px;color:var(--text-dim);font-size:12.5px;">Belum ada ${meta.label.toLowerCase()}.</p>`; return; }
      grid.innerHTML=snap.docs.map(doc=>miniCard(tabId==='posts'?'feed':tabId, doc.id, doc.data())).join('');
    }catch(err){
      console.error(err);
      grid.innerHTML='<p style="padding:20px;color:var(--text-dim);font-size:12.5px;">Gagal memuat data.</p>';
    }
  }

  /* ---- Watermark position picker (own profile only) ---- */
  function renderWatermarkPicker(current){
    const positions=[['bottom-right','Kanan Bawah'],['bottom-left','Kiri Bawah'],['top-right','Kanan Atas'],['top-left','Kiri Atas']];
    return `
      <div class="modal-section" style="width:100%;text-align:left;margin-top:16px;">
        <h4>Posisi Watermark</h4>
        <div class="watermark-pos-grid">
          ${positions.map(([id,label])=>`<button class="watermark-pos-btn${current===id?' active':''}" data-wmpos="${id}">${label}</button>`).join('')}
        </div>
      </div>`;
  }
  function wireWatermarkPicker(uid){
    const db=B.getFirestore();
    profilePanel.querySelectorAll('[data-wmpos]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        // FIX: explicit login guard (this picker only renders for isMe,
        // but guard the write itself in case the session expired).
        if(!B.getUid()){ B.toast('Login dulu.'); return; }
        profilePanel.querySelectorAll('[data-wmpos]').forEach(b=>b.classList.toggle('active', b===btn));
        try{ await db.collection('profiles').doc(uid).set({watermarkPosition:btn.dataset.wmpos}, {merge:true}); }
        catch(err){ console.error(err); B.toast('Gagal menyimpan posisi watermark.'); }
      });
    });
  }

  /* ------------------------------------------------------------------
     5. TOPBAR "My Profile" ENTRY
     ------------------------------------------------------------------ */
  const subnav=B.$('communitySubnav');
  if(subnav && subnav.parentElement){
    const topbar=document.querySelector('.community-topbar');
    const createBtn=B.$('btnCommunityCreate');
    if(topbar && createBtn && !document.getElementById('btnCommunityProfile')){
      const btn=document.createElement('button');
      btn.className='icon-btn'; btn.id='btnCommunityProfile'; btn.title='Profil Saya';
      btn.innerHTML='<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20c1.5-4 4.5-6 7.5-6s6 2 7.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      createBtn.parentElement.insertBefore(btn, createBtn);
      btn.addEventListener('click', ()=>{
        if(!B.getUid()){ B.toast('Login dulu untuk melihat profilmu.'); return; }
        openProfile(B.getUid());
      });
    }
  }

  /* ------------------------------------------------------------------
     6. EXPORTS
     ------------------------------------------------------------------ */
  Object.assign(window.PECommunity, { openPostForm, openFeedDetail, openProfile, toggleFollow });
});

})();
