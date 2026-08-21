/* ==========================================================================
   DIAMOND / REFERRAL / MISSION MODULE (diamond-referral.js)
   Adds: an invite-friends system (referrer gets Diamond per friend who
   redeems their code, the friend gets a one-time bonus), a Diamond ->
   PRO-3-hari redemption, and simple "misi" (like a feed/preset/overlay,
   share the app to WhatsApp/Facebook/Telegram/other) that also pay out
   Diamond once each.

   Loads AFTER script.js (needs window.PEBridge) and AFTER community.js /
   community-creator.js / community-watermark.js / community-social.js
   (it wraps window.PECommunity.toggleLike to hook the "like" missions).
   Talks to Firebase Realtime Database directly via the shared firebase
   compat SDK already loaded on the page (same pattern script.js itself
   uses for premiumUntil).

   ==========================================================================
   REALTIME DATABASE SCHEMA THIS FILE OWNS
   ==========================================================================
   users/$uid/diamonds          number, default 0
   users/$uid/inviteCode        string, 6-char code generated once per user
   users/$uid/invitedBy         uid of whoever invited this user (or absent)
   users/$uid/usedInviteCode    bool — true once this user has redeemed ANY
                                 invite code (a user may only do this once)
   users/$uid/referredCount     number — how many people this user invited
   users/$uid/referrals/$uid2   true — audit marker, one per invited friend
   users/$uid/missions/$key     bool — true once a given one-time mission
                                 (see MISSION_LABELS below) has been claimed

   inviteCodes/$code            uid — reverse index so a typed code can be
                                 resolved back to its owner

   IMPORTANT — Firebase Security Rules:
   This module writes to users/$uid/diamonds, /premiumUntil (self-write, to
   redeem Diamond for PRO), /inviteCode, /invitedBy, /usedInviteCode,
   /referredCount, /referrals, /missions/*, and to inviteCodes/$code. Your
   Realtime Database rules must allow an authenticated user to write these
   paths for THEIR OWN uid (see the suggested rules block shared alongside
   this file). Without that, every action here will fail with a
   "permission_denied" error — including the premiumUntil self-write, which
   today is admin-only per script.js's own comments.
   ========================================================================== */
(function(){
"use strict";

function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

ready(function(){
  const B = window.PEBridge;
  if(!B){ console.error('diamond-referral.js: PEBridge not found — is script.js loaded first?'); return; }
  const $ = B.$;

  /* ------------------------------------------------------------------
     0. CONFIG — every reward number lives here so it's easy to tune.
     ------------------------------------------------------------------ */
  const SHARE_APP_URL = 'https://pbftask.github.io/luminux.store/store';
  const SHARE_MESSAGE = 'Yuk edit & upgrade fotomu bareng Luminux PhotoLab! Pakai kode undangan aku biar kamu dapat Diamond gratis \uD83D\uDC8E';

  const REWARD = {
    inviterPerFriend: 1,   // diamond the INVITER earns per friend who redeems their code
    inviteeOnJoin: 5,      // diamond the INVITEE earns once, on redeeming a code
    proCostDiamond: 20,    // diamond cost to redeem 3 days of PRO
    proDays: 3,
    mission: {
      likeFeed: 2, likePreset: 2, likeOverlay: 2,
      shareWhatsapp: 3, shareFacebook: 3, shareTelegram: 3, shareOther: 3
    }
  };

  const MISSION_LABELS = {
    likeFeed:     'Sukai 1 postingan di Feed',
    likePreset:   'Sukai 1 Preset',
    likeOverlay:  'Sukai 1 Overlay',
    shareWhatsapp:'Bagikan aplikasi ke WhatsApp',
    shareFacebook:'Bagikan aplikasi ke Facebook',
    shareTelegram:'Bagikan aplikasi ke Telegram',
    shareOther:   'Bagikan aplikasi ke lainnya'
  };

  /* ------------------------------------------------------------------
     1. DOM refs — all optional; if the markup isn't on the current page
        we just no-op instead of throwing.
     ------------------------------------------------------------------ */
  const diamondNumEl     = $('diamondBalanceNum');
  const inviteCodeText   = $('myInviteCodeText');
  const btnCopyInviteCode= $('btnCopyInviteCode');
  const btnShareInvite   = $('btnShareInviteGeneric');
  const referredCountEl  = $('referredCountNum');
  const redeemSection    = $('redeemInviteSection');
  const redeemInput      = $('redeemInviteInput');
  const btnRedeemInvite  = $('btnRedeemInvite');
  const redeemStatusEl   = $('redeemInviteStatus');
  const usedCodeInfoEl   = $('usedInviteInfo');
  const btnRedeemPro     = $('btnRedeemDiamondPro');
  const missionListEl    = $('diamondMissionList');

  if(!diamondNumEl){ return; } // markup not present on this page — nothing to wire up

  const PRO_BTN_LABEL = `Tukar ${REWARD.proCostDiamond} \uD83D\uDC8E \u2192 PRO ${REWARD.proDays} Hari`;

  let myData = null;   // latest snapshot of users/$uid
  let dataRef = null;

  function fb(){ return B.getFirebase(); }
  function db(){ const f=fb(); return f ? f.database() : null; }
  function inc(n){ const f=fb(); return f.database.ServerValue.increment(n); }

  /* ------------------------------------------------------------------
     2. Invite code: generate once per user, reserved atomically against
        the inviteCodes/$code reverse index so two users can never collide.
     ------------------------------------------------------------------ */
  function genCode(){
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read/type
    let s='';
    for(let i=0;i<6;i++) s+=chars[Math.floor(Math.random()*chars.length)];
    return s;
  }

  async function ensureInviteCode(uid){
    const database=db(); if(!database) return null;
    try{
      const snap = await database.ref('users/'+uid+'/inviteCode').once('value');
      if(snap.exists() && snap.val()) return snap.val();
    }catch(e){ console.warn('ensureInviteCode read failed', e); return null; }

    for(let attempt=0; attempt<8; attempt++){
      const code=genCode();
      try{
        const res = await database.ref('inviteCodes/'+code).transaction(current=> current===null ? uid : undefined);
        if(res.committed){
          await database.ref('users/'+uid+'/inviteCode').set(code);
          return code;
        }
      }catch(e){ console.warn('ensureInviteCode reserve attempt failed', e); }
    }
    console.error('ensureInviteCode: could not reserve a unique code after 8 attempts');
    return null;
  }

  /* ------------------------------------------------------------------
     3. Render — one function keeps every bit of UI in sync with the
        live users/$uid snapshot.
     ------------------------------------------------------------------ */
  function renderMissions(missions){
    if(!missionListEl) return;
    missions = missions || {};
    missionListEl.innerHTML = Object.keys(MISSION_LABELS).map(key=>{
      const done = !!missions[key];
      const reward = REWARD.mission[key];
      const isShare = key.indexOf('share')===0;
      const actionHtml = done
        ? `<span class="mission-done"><i class="fa-solid fa-circle-check"></i> Selesai</span>`
        : (isShare
            ? `<button class="btn-ghost mission-action" data-mission="${key}" type="button">Bagikan</button>`
            : `<span class="mission-pending">+${reward} \uD83D\uDC8E</span>`);
      return `<div class="mission-item ${done?'is-done':''}">
        <div class="mission-info"><b>${MISSION_LABELS[key]}</b><span>+${reward} Diamond</span></div>
        ${actionHtml}
      </div>`;
    }).join('');
  }

  function render(data){
    myData = data || {};
    if(diamondNumEl) diamondNumEl.textContent = String(myData.diamonds||0);
    if(inviteCodeText) inviteCodeText.textContent = myData.inviteCode || '\u2013';
    if(referredCountEl) referredCountEl.textContent = String(myData.referredCount||0);
    if(btnRedeemPro){
      btnRedeemPro.disabled = (myData.diamonds||0) < REWARD.proCostDiamond;
      if(!btnRedeemPro.dataset.busy) btnRedeemPro.innerHTML = `<i class="fa-solid fa-bolt"></i>&nbsp;${PRO_BTN_LABEL}`;
    }

    const used = !!myData.usedInviteCode;
    if(redeemSection) redeemSection.style.display = used ? 'none' : '';
    if(usedCodeInfoEl) usedCodeInfoEl.style.display = used ? '' : 'none';

    renderMissions(myData.missions);
  }

  function watchUser(uid){
    const database=db(); if(!database) return;
    if(dataRef){ try{ dataRef.off(); }catch(e){} }
    dataRef = database.ref('users/'+uid);
    dataRef.on('value', snap=>{ render(snap.val()); }, err=>{
      console.error('users/'+uid+' listener error', err);
    });
  }

  async function init(){
    const uid=B.getUid();
    if(!uid) return;
    await ensureInviteCode(uid);
    watchUser(uid);
  }

  // PEBridge doesn't expose an "auth state changed" hook, so — same as
  // community.js's resolveSharedLink() — we poll briefly for a uid to
  // show up, then also re-check on tab focus in case of a later login.
  let authTries=0;
  (function waitForAuth(){
    if(B.getUid()){ init(); return; }
    if(authTries++<40) setTimeout(waitForAuth, 250);
  })();
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden && B.getUid() && !dataRef) init();
  });

  /* ------------------------------------------------------------------
     4. Small UI helpers
     ------------------------------------------------------------------ */
  function setRedeemStatus(msg, type){
    if(!redeemStatusEl) return;
    redeemStatusEl.textContent = msg;
    redeemStatusEl.className = 'admin-status' + (type==='error' ? ' error' : (type==='success' ? ' success' : ''));
  }
  function setBtnBusy(btn, busy, busyLabel, restLabel){
    if(!btn) return;
    btn.disabled = busy;
    btn.dataset.busy = busy ? '1' : '';
    btn.textContent = busy ? busyLabel : restLabel;
  }

  /* ------------------------------------------------------------------
     5. Redeem a friend's invite code
     ------------------------------------------------------------------ */
  async function redeemInviteCode(){
    const uid=B.getUid();
    if(!uid){ B.toast('Login dulu untuk melanjutkan.'); return; }
    const raw = ((redeemInput && redeemInput.value) || '').trim().toUpperCase();
    if(!raw){ setRedeemStatus('Masukkan kode undangan terlebih dahulu.','error'); return; }
    if(myData && myData.inviteCode && raw===myData.inviteCode){
      setRedeemStatus('Tidak bisa memakai kode milik sendiri.','error'); return;
    }
    const database=db(); if(!database){ setRedeemStatus('Database belum siap, coba lagi sebentar.','error'); return; }

    setBtnBusy(btnRedeemInvite, true, 'Memproses…', 'Konfirmasi');
    setRedeemStatus('Memeriksa kode…');
    try{
      const idxSnap = await database.ref('inviteCodes/'+raw).once('value');
      const ownerUid = idxSnap.val();
      if(!ownerUid){ setRedeemStatus('Kode undangan tidak ditemukan.','error'); return; }
      if(ownerUid===uid){ setRedeemStatus('Tidak bisa memakai kode milik sendiri.','error'); return; }

      // Idempotency lock: only the transaction call that flips
      // usedInviteCode from falsy -> true is allowed to grant diamonds,
      // so a double-tap or a retried request can never double-credit.
      const lock = await database.ref('users/'+uid+'/usedInviteCode').transaction(cur=> cur ? undefined : true);
      if(!lock.committed){ setRedeemStatus('Kamu sudah pernah memakai kode undangan sebelumnya.','error'); return; }

      const updates={};
      updates['users/'+uid+'/invitedBy'] = ownerUid;
      updates['users/'+uid+'/diamonds'] = inc(REWARD.inviteeOnJoin);
      updates['users/'+ownerUid+'/diamonds'] = inc(REWARD.inviterPerFriend);
      updates['users/'+ownerUid+'/referredCount'] = inc(1);
      updates['users/'+ownerUid+'/referrals/'+uid] = true;
      await database.ref().update(updates);

      setRedeemStatus(`Berhasil! Kamu dapat +${REWARD.inviteeOnJoin} Diamond \uD83C\uDF89`,'success');
      B.toast(`+${REWARD.inviteeOnJoin} Diamond dari kode undangan!`,'success');
      if(redeemInput) redeemInput.value='';
    }catch(err){
      console.error('redeemInviteCode error', err);
      setRedeemStatus('Gagal memproses kode. Coba lagi.','error');
    }finally{
      setBtnBusy(btnRedeemInvite, false, 'Memproses…', 'Konfirmasi');
    }
  }
  if(btnRedeemInvite) btnRedeemInvite.addEventListener('click', redeemInviteCode);

  /* ------------------------------------------------------------------
     6. Copy / share own invite code
     ------------------------------------------------------------------ */
  function myInviteLink(){
    const code=(myData && myData.inviteCode) || '';
    return SHARE_APP_URL + (code ? ('?ref='+encodeURIComponent(code)) : '');
  }
  if(btnCopyInviteCode) btnCopyInviteCode.addEventListener('click', async ()=>{
    const code=(myData && myData.inviteCode) || '';
    if(!code){ B.toast('Kode belum siap, coba lagi sebentar.'); return; }
    try{ await navigator.clipboard.writeText(code); B.toast('Kode undangan disalin.','success'); }
    catch(e){ B.toast('Gagal menyalin kode.'); }
  });
  if(btnShareInvite) btnShareInvite.addEventListener('click', shareInviteGeneric);

  async function shareInviteGeneric(){
    const text = `${SHARE_MESSAGE}\nKode: ${(myData&&myData.inviteCode)||'-'}\n${myInviteLink()}`;
    if(navigator.share){
      try{ await navigator.share({ title:'Luminux PhotoLab', text, url: myInviteLink() }); await awardMissionOnce('shareOther'); }
      catch(e){ /* user cancelled the native share sheet — nothing to do */ }
      return;
    }
    try{ await navigator.clipboard.writeText(text); B.toast('Teks undangan disalin, tempel di mana saja.','success'); await awardMissionOnce('shareOther'); }
    catch(e){ B.toast('Gagal membagikan.'); }
  }

  /* ------------------------------------------------------------------
     7. Missions — share-to-platform buttons
     ------------------------------------------------------------------ */
  function shareUrlFor(platform){
    const text = encodeURIComponent(SHARE_MESSAGE+' '+SHARE_APP_URL);
    const url = encodeURIComponent(SHARE_APP_URL);
    if(platform==='shareWhatsapp') return 'https://wa.me/?text='+text;
    if(platform==='shareFacebook') return 'https://www.facebook.com/sharer/sharer.php?u='+url;
    if(platform==='shareTelegram') return 'https://t.me/share/url?url='+url+'&text='+encodeURIComponent(SHARE_MESSAGE);
    return null;
  }

  if(missionListEl) missionListEl.addEventListener('click', async (e)=>{
    const btn = e.target.closest('.mission-action');
    if(!btn) return;
    const key = btn.getAttribute('data-mission');
    if(!key) return;
    if(B.haptic) B.haptic();
    const url = shareUrlFor(key);
    if(url) window.open(url, '_blank', 'noopener');
    // These are outbound web share links with no completion callback, so
    // — like most referral programs — the mission is credited on the
    // deliberate tap that opens the share target, once per platform ever.
    await awardMissionOnce(key);
  });

  async function awardMissionOnce(key){
    const uid=B.getUid();
    if(!uid) return;
    const database=db(); if(!database) return;
    const reward = REWARD.mission[key];
    if(!reward) return;
    try{
      const lock = await database.ref('users/'+uid+'/missions/'+key).transaction(cur=> cur ? undefined : true);
      if(!lock.committed) return; // already claimed earlier
      await database.ref('users/'+uid+'/diamonds').set(inc(reward));
      B.toast(`+${reward} Diamond \u2014 misi selesai!`,'success');
    }catch(err){ console.error('awardMissionOnce error', key, err); }
  }

  /* ------------------------------------------------------------------
     8. Hook the like missions onto the existing like button plumbing —
        wraps window.PECommunity.toggleLike (community.js) so Feed /
        Preset / Overlay likes don't need any changes of their own.
     ------------------------------------------------------------------ */
  (function hookLikeMissions(){
    let attempts=0;
    (function attach(){
      const C=window.PECommunity;
      if(C && typeof C.toggleLike==='function' && !C.__diamondHooked){
        const original=C.toggleLike;
        C.toggleLike = async function(type, itemId){
          const result = await original(type, itemId);
          if(result===true){
            const key = type==='feed' ? 'likeFeed' : type==='preset' ? 'likePreset' : type==='overlay' ? 'likeOverlay' : null;
            if(key) awardMissionOnce(key);
          }
          return result;
        };
        C.__diamondHooked = true;
      }else if(attempts++<40){
        setTimeout(attach, 200);
      }
    })();
  })();

  /* ------------------------------------------------------------------
     9. Redeem Diamond -> 3 days of PRO
     ------------------------------------------------------------------ */
  if(btnRedeemPro) btnRedeemPro.addEventListener('click', async ()=>{
    const uid=B.getUid();
    if(!uid){ B.toast('Login dulu untuk melanjutkan.'); return; }
    const database=db(); if(!database){ B.toast('Database belum siap.'); return; }
    if((myData && myData.diamonds||0) < REWARD.proCostDiamond){
      B.toast(`Diamond kamu belum cukup (butuh ${REWARD.proCostDiamond}).`); return;
    }

    setBtnBusy(btnRedeemPro, true, 'Memproses…', PRO_BTN_LABEL);
    try{
      // Spend first, guarded by a transaction so the balance can never go
      // negative even under a double-tap race.
      const spend = await database.ref('users/'+uid+'/diamonds').transaction(cur=>{
        const bal = Number(cur)||0;
        if(bal < REWARD.proCostDiamond) return; // abort — balance untouched
        return bal - REWARD.proCostDiamond;
      });
      if(!spend.committed){ B.toast('Diamond tidak cukup.'); return; }

      // Extend premiumUntil the same way the admin panel does: from the
      // current expiry if still active, otherwise from now.
      const addMs = REWARD.proDays*24*60*60*1000;
      const result = await database.ref('users/'+uid+'/premiumUntil').transaction(current=>{
        const base = (Number(current)||0) > Date.now() ? Number(current) : Date.now();
        return base + addMs;
      });
      if(!result.committed){
        // Couldn't extend PRO (e.g. Firebase Rules reject the self-write)
        // — refund the diamonds so nothing is lost.
        await database.ref('users/'+uid+'/diamonds').set(inc(REWARD.proCostDiamond));
        B.toast('Gagal upgrade PRO. Diamond dikembalikan.','error');
        return;
      }
      B.toast(`Berhasil! PRO aktif +${REWARD.proDays} hari \uD83C\uDF89`,'success');
    }catch(err){
      console.error('redeem diamond -> pro error', err);
      B.toast('Terjadi kesalahan, coba lagi.','error');
    }finally{
      setBtnBusy(btnRedeemPro, false, 'Memproses…', PRO_BTN_LABEL);
    }
  });
});

})();
