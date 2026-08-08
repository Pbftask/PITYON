/* ==========================================================================
   COMMUNITY WATERMARK MODULE (community-watermark.js)
   PHASE 2c — draws the "◯ @username" glass badge directly into the
   exported pixels whenever the user's export used another creator's
   preset or overlay and the user's own account is FREE.

   Must load AFTER community-creator.js (which registers the overlay
   compositing hook) so the watermark is always drawn on top of overlays.
   ========================================================================== */
(function(){
"use strict";

function ready(fn){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

ready(function(){
  const B = window.PEBridge;
  const C = window.PECommunity;
  if(!B || !C){ console.error('community-watermark.js: dependencies not found — load order wrong?'); return; }

  const profileCache=new Map(); // uid -> {username, photoURL, accountType, ts}
  const CACHE_MS=60000;
  async function getProfile(uid){
    const cached=profileCache.get(uid);
    if(cached && (Date.now()-cached.ts)<CACHE_MS) return cached;
    const db=B.getFirestore();
    let data={username:'', photoURL:'', accountType:'free', watermarkPosition:'bottom-right'};
    try{
      if(db){
        const snap=await db.collection('profiles').doc(uid).get();
        if(snap.exists){
          const d=snap.data();
          data={ username:d.username||'', photoURL:d.photoURL||'', accountType:d.accountType||'free', watermarkPosition:d.watermarkPosition||'bottom-right' };
        }
      }
    }catch(err){ console.warn('watermark profile fetch failed', err); }
    data.ts=Date.now();
    profileCache.set(uid, data);
    return data;
  }

  function resolveForeignCreator(){
    const myUid=B.getUid();
    const applied=C.getAppliedPreset && C.getAppliedPreset();
    if(applied && applied.creatorUid && applied.creatorUid!==myUid){
      return { uid:applied.creatorUid, fallbackName:applied.creatorName };
    }
    const layers=C.getOverlayLayers ? C.getOverlayLayers() : [];
    const foreign=layers.find(l=>l.creatorUid && l.creatorUid!==myUid);
    if(foreign) return { uid:foreign.creatorUid, fallbackName:foreign.creatorName };
    return null;
  }

  const imgCache=new Map();
  function loadImg(url){
    if(!url) return Promise.resolve(null);
    if(imgCache.has(url)) return imgCache.get(url);
    const p=new Promise(resolve=>{
      const img=new Image();
      img.crossOrigin='anonymous';
      img.onload=()=>resolve(img);
      img.onerror=()=>resolve(null);
      img.src=url;
    });
    imgCache.set(url,p);
    return p;
  }

  function roundedRectPath(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }

  async function drawWatermark(ctx, w, h, creatorUid, fallbackName, myWatermarkPosition){
    const prof=await getProfile(creatorUid);
    const username=prof.username || fallbackName || 'creator';

    // Size everything relative to canvas so it stays proportional and
    // never gets cut off, regardless of export resolution.
    const badgeH=Math.max(30, Math.min(64, h*0.045));
    const avatarD=badgeH*0.72;
    const pad=badgeH*0.18;
    const margin=Math.max(14, Math.min(w,h)*0.03);
    ctx.save();
    ctx.font=`700 ${Math.round(badgeH*0.34)}px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;
    const textW=ctx.measureText('@'+username).width;
    const badgeW=pad+avatarD+pad*0.8+textW+pad;

    const pos=myWatermarkPosition||'bottom-right';
    let x,y;
    if(pos==='bottom-right'){ x=w-margin-badgeW; y=h-margin-badgeH; }
    else if(pos==='bottom-left'){ x=margin; y=h-margin-badgeH; }
    else if(pos==='top-right'){ x=w-margin-badgeW; y=margin; }
    else { x=margin; y=margin; }
    x=Math.max(margin, Math.min(x, w-margin-badgeW));
    y=Math.max(margin, Math.min(y, h-margin-badgeH));

    ctx.globalAlpha=0.5; // 45–55% per spec
    roundedRectPath(ctx, x, y, badgeW, badgeH, badgeH/2);
    ctx.fillStyle='rgba(20,22,26,0.55)';
    ctx.fill();
    ctx.lineWidth=Math.max(1,badgeH*0.02);
    ctx.strokeStyle='rgba(255,255,255,0.25)';
    ctx.stroke();

    const avatar=await loadImg(prof.photoURL);
    const acx=x+pad+avatarD/2, acy=y+badgeH/2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(acx, acy, avatarD/2, 0, Math.PI*2);
    ctx.closePath();
    ctx.clip();
    if(avatar){
      ctx.drawImage(avatar, acx-avatarD/2, acy-avatarD/2, avatarD, avatarD);
    }else{
      ctx.fillStyle='rgba(255,255,255,0.3)';
      ctx.fill();
    }
    ctx.restore();

    ctx.globalAlpha=0.9;
    ctx.fillStyle='#ffffff';
    ctx.textBaseline='middle';
    ctx.fillText('@'+username, x+pad+avatarD+pad*0.8, y+badgeH/2+badgeH*0.03);
    ctx.restore();
  }

  B.registerOverlayHook(async (ctx,w,h,isExport)=>{
    if(!isExport) return; // watermark is baked only into the actual exported file
    const myUid=B.getUid();
    if(!myUid) return; // guest exports can't be attributed anyway
    const foreign=resolveForeignCreator();
    if(!foreign) return;
    try{
      const myProfile=await getProfile(myUid);
      if(myProfile.accountType==='pro') return; // PRO accounts never get watermarked
      await drawWatermark(ctx, w, h, foreign.uid, foreign.fallbackName, myProfile.watermarkPosition);
    }catch(err){ console.error('watermark render failed', err); }
  });
});

})();
