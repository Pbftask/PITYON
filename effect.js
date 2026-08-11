/* ============================================================
   PITY STUDIO — EFFECTS ENGINE EXTENSION
   Adds Group 1-6 effects (color/light, blur, warp, procedural,
   move/transform, matte/key) on top of the core engine exposed
   as window.JS_CORE by script.js.

   Load order required in the HTML:
     <script src="script.js"></script>
     <script src="effects.js"></script>
     <script src="editor.js"></script>

   Effects here are split into two kinds:
   1) "Transform" effects — cheap, mutate ctx.tf directly (dx/dy/
      rotation/scale/brightness/etc), same pattern as the core FX.
   2) "Pixel" effects — need real per-pixel processing (color
      grading, warps, chroma key, wipes...). These are queued on
      ctx.tf.postFX = [{type, params}] and executed by a patched
      version of drawMediaWithFX, which renders the clip into a
      small offscreen canvas (for speed), runs the pixel ops,
      then draws the (upscaled) result back — preserving proper
      alpha compositing with whatever was already drawn.
   ============================================================ */
(function(){
"use strict";
const C = window.JS_CORE;
if(!C){ console.warn('effects.js: JS_CORE not found — load script.js first'); return; }
const { FX, EFFECT_CATEGORIES, clamp, mulberry32 } = C;

/* ---------------------------------------------------------
   Patch drawMediaWithFX so any clip carrying tf.postFX jobs
   gets pixel-processed in an isolated, alpha-safe layer.
   --------------------------------------------------------- */
const _origDrawMediaWithFX = C.drawMediaWithFX;
const PFX_MAXW = 480; // working width for pixel ops (perf)

C.drawMediaWithFX = function(ctx2d, srcEl, srcW, srcH, boxCX, boxCY, boxW, boxH, fit, tf, seed, t){
  if(!tf || !tf.postFX || !tf.postFX.length){
    return _origDrawMediaWithFX(ctx2d, srcEl, srcW, srcH, boxCX, boxCY, boxW, boxH, fit, tf, seed, t);
  }
  const W = ctx2d.canvas.width, H = ctx2d.canvas.height;
  if(!W || !H) return _origDrawMediaWithFX(ctx2d, srcEl, srcW, srcH, boxCX, boxCY, boxW, boxH, fit, tf, seed, t);

  const scale = Math.min(1, PFX_MAXW / W);
  const sw = Math.max(2, Math.round(W*scale)), sh = Math.max(2, Math.round(H*scale));
  const small = document.createElement('canvas'); small.width = sw; small.height = sh;
  const sctx = small.getContext('2d');
  sctx.save();
  sctx.scale(scale, scale);
  try{ _origDrawMediaWithFX(sctx, srcEl, srcW, srcH, boxCX, boxCY, boxW, boxH, fit, tf, seed, t); }catch(e){}
  sctx.restore();

  try{ applyPostFXPixels(sctx, sw, sh, tf.postFX, t, seed); }catch(e){ console.warn('postFX failed', e); }

  ctx2d.save();
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.drawImage(small, 0, 0, W, H);
  ctx2d.restore();
};

/* ---------------------------------------------------------
   Pixel processing core
   --------------------------------------------------------- */
function cl(v,a,b){ return v<a?a:(v>b?b:v); }
function idx(x,y,w){ return (y*w+x)*4; }

function applyPostFXPixels(ctx, w, h, list, t, seed){
  if(!list || !list.length) return;
  let imgData = ctx.getImageData(0,0,w,h);
  list.forEach(item=>{
    const fn = PIXEL_FX[item.type];
    if(fn){ try{ imgData = fn(imgData, w, h, item.params||{}, t, seed) || imgData; }catch(e){ console.warn('pixel fx error', item.type, e); } }
  });
  ctx.putImageData(imgData, 0, 0);
}

function remapImage(imgData, w, h, mapFn){
  const src = imgData.data;
  const out = new Uint8ClampedArray(src.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const r = mapFn(x,y);
      const sx = cl(Math.round(r.sx), 0, w-1), sy = cl(Math.round(r.sy), 0, h-1);
      const si = idx(sx,sy,w), di = idx(x,y,w);
      if(r.blend!==undefined && r.blend<1){
        const b = r.blend;
        out[di]   = src[di]  *(1-b) + src[si]  *b;
        out[di+1] = src[di+1]*(1-b) + src[si+1]*b;
        out[di+2] = src[di+2]*(1-b) + src[si+2]*b;
        out[di+3] = src[di+3]*(1-b) + src[si+3]*b;
      } else {
        out[di]=src[si]; out[di+1]=src[si+1]; out[di+2]=src[si+2]; out[di+3]=src[si+3];
      }
    }
  }
  return new ImageData(out,w,h);
}

function mapColor(imgData, fn){
  const d = imgData.data;
  for(let i=0;i<d.length;i+=4){
    const px = fn(d[i], d[i+1], d[i+2], d[i+3]);
    d[i]=px[0]; d[i+1]=px[1]; d[i+2]=px[2]; d[i+3]=px[3];
  }
  return imgData;
}

function multiSample(imgData, w, h, offsetsFn){
  const src = imgData.data;
  const out = new Uint8ClampedArray(src.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const offs = offsetsFn(x,y);
      let r=0,g=0,b=0,a=0,ws=0;
      for(let k=0;k<offs.length;k++){
        const o = offs[k];
        const sx = cl(Math.round(x+o[0]),0,w-1), sy = cl(Math.round(y+o[1]),0,h-1);
        const si = idx(sx,sy,w), wt = o[2]!==undefined?o[2]:1;
        r+=src[si]*wt; g+=src[si+1]*wt; b+=src[si+2]*wt; a+=src[si+3]*wt; ws+=wt;
      }
      const di = idx(x,y,w);
      out[di]=r/ws; out[di+1]=g/ws; out[di+2]=b/ws; out[di+3]=a/ws;
    }
  }
  return new ImageData(out,w,h);
}

function hsvToRgb(h,s,v){
  const i=Math.floor(h*6), f=h*6-i, p=v*(1-s), q=v*(1-f*s), u=v*(1-(1-f)*s);
  let r,g,b;
  switch(i%6){
    case 0: r=v;g=u;b=p; break; case 1: r=q;g=v;b=p; break;
    case 2: r=p;g=v;b=u; break; case 3: r=p;g=q;b=v; break;
    case 4: r=u;g=p;b=v; break; default: r=v;g=p;b=q;
  }
  return [r*255,g*255,b*255];
}

/* ---------------------------------------------------------
   PIXEL_FX implementations — keyed by postFX "type"
   Each: (imgData, w, h, params, t, seed) -> ImageData
   --------------------------------------------------------- */
const PIXEL_FX = {};

/* ===== Group 1: Color & Light ===== */
PIXEL_FX.threeColorGradient = (img,w,h,p)=>{
  const strength = cl(Math.abs(p.amount||30)/100,0,1)*0.75;
  const shadow=[26,32,74], mid=[255,150,120], hi=[255,236,182];
  return mapColor(img,(r,g,b,a)=>{
    const lum=(0.299*r+0.587*g+0.114*b)/255;
    let target, wgt;
    if(lum<0.42){ target=shadow; wgt=(0.42-lum)/0.42; }
    else if(lum<0.72){ target=mid; wgt=1-Math.abs(lum-0.57)/0.15; }
    else { target=hi; wgt=(lum-0.62)/0.38; }
    wgt = cl(wgt,0,1)*strength;
    return [ r+(target[0]-r)*wgt, g+(target[1]-g)*wgt, b+(target[2]-b)*wgt, a ];
  });
};
PIXEL_FX.colorBalance = (img,w,h,p)=>{
  const amt = (p.amount||0);
  return mapColor(img,(r,g,b,a)=>{
    const lum=(0.299*r+0.587*g+0.114*b)/255;
    const shadowF = 1-cl(lum*2,0,1);
    const hiF = cl((lum-0.5)*2,0,1);
    const nr = r + amt*0.5*hiF - amt*0.3*shadowF;
    const nb = b - amt*0.5*hiF + amt*0.3*shadowF;
    return [nr,g,nb,a];
  });
};
PIXEL_FX.gamma = (img,w,h,p)=>{
  const amt = (p.amount||0);
  const g = cl(1 + amt/100*1.4, 0.2, 3.2);
  const invG = 1/g;
  const lut = new Uint8ClampedArray(256);
  for(let i=0;i<256;i++) lut[i] = 255*Math.pow(i/255, invG);
  return mapColor(img,(r,g2,b,a)=> [lut[r|0], lut[g2|0], lut[b|0], a]);
};
PIXEL_FX.hotColor = (img,w,h,p)=>{
  const amt=(p.amount||30);
  return mapColor(img,(r,g,b,a)=> [ r+amt*0.4, g+amt*0.08, b-amt*0.4, a ]);
};
PIXEL_FX.vibrance = (img,w,h,p)=>{
  const factor = (p.amount||30)/100;
  return mapColor(img,(r,g,b,a)=>{
    const max=Math.max(r,g,b), avg=(r+g+b)/3;
    const sat = cl((max-avg)/128,0,2);
    const adj = factor*(1-Math.min(1,sat))*1.4;
    return [ r+(r-avg)*adj, g+(g-avg)*adj, b+(b-avg)*adj, a ];
  });
};

/* ===== Group 2: Blur ===== */
PIXEL_FX.lensBlur = (img,w,h,p)=>{
  const radius = (p.amount||30)/100*16;
  return multiSample(img,w,h,()=>{
    const offs=[[0,0,1.6]];
    for(let i=0;i<8;i++){ const a=i/8*Math.PI*2; offs.push([Math.cos(a)*radius, Math.sin(a)*radius, 1]); }
    return offs;
  });
};
PIXEL_FX.hexagonBlur = (img,w,h,p)=>{
  const radius = (p.amount||30)/100*14;
  const angles=[0,60,120,180,240,300].map(d=>d*Math.PI/180);
  return multiSample(img,w,h,()=>{
    const offs=[[0,0,2]];
    angles.forEach(a=> offs.push([Math.cos(a)*radius, Math.sin(a)*radius, 1]));
    return offs;
  });
};
PIXEL_FX.spinBlurPro = (img,w,h,p)=>{
  const amt=(p.amount||30);
  const maxAngle = (amt/100)*0.6;
  const cx=w/2, cy=h/2, steps=6;
  return remapSpin(img,w,h,cx,cy,maxAngle,steps);
};
function remapSpin(img,w,h,cx,cy,maxAngle,steps){
  const src=img.data; const out=new Uint8ClampedArray(src.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const dx=x-cx, dy=y-cy, dist=Math.hypot(dx,dy), ang=Math.atan2(dy,dx);
      let r=0,g=0,b=0,a=0;
      for(let s=0;s<steps;s++){
        const tt=(s/(steps-1)-0.5)*2*maxAngle;
        const sx=cl(Math.round(cx+Math.cos(ang+tt)*dist),0,w-1);
        const sy=cl(Math.round(cy+Math.sin(ang+tt)*dist),0,h-1);
        const si=idx(sx,sy,w);
        r+=src[si]; g+=src[si+1]; b+=src[si+2]; a+=src[si+3];
      }
      const di=idx(x,y,w);
      out[di]=r/steps; out[di+1]=g/steps; out[di+2]=b/steps; out[di+3]=a/steps;
    }
  }
  return new ImageData(out,w,h);
}
/* legacy stubs that previously did nothing visually — wire them up */
PIXEL_FX.spinBlur = (img,w,h,p)=>{
  const amt=(p.amount||6);
  const maxAngle=(amt/30)*0.5;
  return remapSpin(img,w,h,w/2,h/2,maxAngle,6);
};
PIXEL_FX.radialBlur = (img,w,h,p)=>{
  const amt=(p.amount||8);
  const strength=(amt/30)*0.35;
  const cx=w/2, cy=h/2, steps=6;
  const src=img.data; const out=new Uint8ClampedArray(src.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const dx=x-cx, dy=y-cy;
      let r=0,g=0,b=0,a=0;
      for(let s=0;s<steps;s++){
        const f=1-strength*(s/(steps-1));
        const sx=cl(Math.round(cx+dx*f),0,w-1), sy=cl(Math.round(cy+dy*f),0,h-1);
        const si=idx(sx,sy,w);
        r+=src[si]; g+=src[si+1]; b+=src[si+2]; a+=src[si+3];
      }
      const di=idx(x,y,w);
      out[di]=r/steps; out[di+1]=g/steps; out[di+2]=b/steps; out[di+3]=a/steps;
    }
  }
  return new ImageData(out,w,h);
};
PIXEL_FX.directionalBlur = (img,w,h,p)=>{
  const amt=(p.amount||10);
  const dist=(amt/30)*22;
  const rad=(p.angle||0)*Math.PI/180;
  const dx0=Math.cos(rad), dy0=Math.sin(rad);
  const steps=7;
  return multiSample(img,w,h,()=>{
    const offs=[];
    for(let s=0;s<steps;s++){ const len=(s/(steps-1)-0.5)*2*dist; offs.push([dx0*len, dy0*len, 1]); }
    return offs;
  });
};
PIXEL_FX.focusBlur = (img,w,h,p)=>{
  const amt=(p.amount||8);
  const factor=(amt/30);
  const src=img.data; const out=new Uint8ClampedArray(src.length);
  const cy=h/2;
  for(let y=0;y<h;y++){
    const distF=Math.min(1,Math.abs(y-cy)/(h*0.5));
    const radius=Math.round(distF*factor*10);
    for(let x=0;x<w;x++){
      const di=idx(x,y,w);
      if(radius<=0){ out[di]=src[di];out[di+1]=src[di+1];out[di+2]=src[di+2];out[di+3]=src[di+3]; continue; }
      let r=0,g=0,b=0,a=0,c=0;
      const step=Math.max(1,Math.round(radius/3));
      for(let k=-radius;k<=radius;k+=step){
        const sx=cl(x+k,0,w-1); const si=idx(sx,y,w);
        r+=src[si];g+=src[si+1];b+=src[si+2];a+=src[si+3];c++;
      }
      out[di]=r/c; out[di+1]=g/c; out[di+2]=b/c; out[di+3]=a/c;
    }
  }
  return new ImageData(out,w,h);
};

/* ===== Group 3: Distortion & Warp ===== */
PIXEL_FX.mirror = (img,w,h,p)=>{
  const blend = cl((p.amount||30)/100,0,1);
  return remapImage(img,w,h,(x,y)=>({ sx: w-1-x, sy: y, blend }));
};
PIXEL_FX.squeeze = (img,w,h,p)=>{
  const factor = (p.amount||30)/100*0.6;
  const cx=w/2, cy=h/2;
  return remapImage(img,w,h,(x,y)=>{
    const dx=x-cx, dy=y-cy;
    const nx = cx + dx*(1+factor*Math.abs(dy)/cy);
    return { sx:nx, sy:y };
  });
};
PIXEL_FX.tiles = (img,w,h,p)=>{
  const n = cl(2+Math.floor((p.amount||30)/10), 2, 12);
  const tw=w/n, th=h/n;
  return remapImage(img,w,h,(x,y)=>({ sx:(x%tw)*n, sy:(y%th)*n }));
};
PIXEL_FX.displacementMap = (img,w,h,p,t,seed)=>{
  const amt=(p.amount||30)*0.4;
  return remapImage(img,w,h,(x,y)=>({
    sx: x + Math.sin(y*0.08 + t*1.5 + seed)*amt,
    sy: y + Math.cos(x*0.08 + t*1.3 + seed)*amt,
  }));
};
PIXEL_FX.fractalWarp = (img,w,h,p,t,seed)=>{
  const amt=(p.amount||30);
  return remapImage(img,w,h,(x,y)=>({
    sx: x + Math.sin(y*0.05+t)*amt*0.3 + Math.sin(y*0.13+t*1.7+seed)*amt*0.15 + Math.sin(y*0.31+t*0.6)*amt*0.08,
    sy: y + Math.cos(x*0.05+t)*amt*0.3 + Math.cos(x*0.13+t*1.7+seed)*amt*0.15 + Math.cos(x*0.31+t*0.6)*amt*0.08,
  }));
};
PIXEL_FX.circularRipple = (img,w,h,p,t)=>{
  const amt=(p.amount||30)*0.5;
  const cx=w/2, cy=h/2;
  return remapImage(img,w,h,(x,y)=>{
    const dx=x-cx, dy=y-cy, dist=Math.hypot(dx,dy), ang=Math.atan2(dy,dx);
    const rd = dist + Math.sin(dist*0.05 - t*4)*amt;
    return { sx: cx+Math.cos(ang)*rd, sy: cy+Math.sin(ang)*rd };
  });
};

/* ===== Group 4: Procedural ===== */
PIXEL_FX.kaleidoscope = (img,w,h,p)=>{
  const n = cl(3+Math.floor((p.amount||40)/12), 3, 11);
  const cx=w/2, cy=h/2, wedge=Math.PI*2/n;
  return remapImage(img,w,h,(x,y)=>{
    const dx=x-cx, dy=y-cy, dist=Math.hypot(dx,dy);
    let ang=Math.atan2(dy,dx);
    let a2 = ((ang % wedge)+wedge)%wedge;
    if(a2>wedge/2) a2 = wedge-a2;
    return { sx: cx+Math.cos(a2)*dist, sy: cy+Math.sin(a2)*dist };
  });
};
PIXEL_FX.voronoi = (img,w,h,p,t,seed)=>{
  const k = cl(4+Math.floor((p.amount||40)/8), 4, 16);
  const rnd = mulberry32(seed + Math.floor(t*2));
  const pts=[]; for(let i=0;i<k;i++) pts.push([rnd()*w, rnd()*h]);
  const soften = 0.15;
  return remapImage(img,w,h,(x,y)=>{
    let best=Infinity, bi=0;
    for(let i=0;i<pts.length;i++){ const dx=x-pts[i][0], dy=y-pts[i][1]; const d=dx*dx+dy*dy; if(d<best){ best=d; bi=i; } }
    return { sx: pts[bi][0], sy: pts[bi][1], blend: 1-soften };
  });
};
// plasma needs pixel coordinates, so implement directly instead of via mapColor
PIXEL_FX.plasma = (img,w,h,p,t)=>{
  const blend = (p.amount||40)/100*0.55;
  const d = img.data;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const v = Math.sin(x*0.02+t) + Math.sin(y*0.03-t*1.3) + Math.sin((x+y)*0.015+t*0.7) + Math.sin(Math.hypot(x,y)*0.02);
      const hue = ((v+4)/8)%1;
      const [pr,pg,pb] = hsvToRgb(hue,0.8,1);
      const i = idx(x,y,w);
      d[i]   = d[i]  *(1-blend) + pr*blend;
      d[i+1] = d[i+1]*(1-blend) + pg*blend;
      d[i+2] = d[i+2]*(1-blend) + pb*blend;
    }
  }
  return img;
};
PIXEL_FX.posterize = (img,w,h,p)=>{
  const levels = cl(Math.round(2+(100-(p.amount||40))/8), 2, 16);
  const step = 255/(levels-1);
  return mapColor(img,(r,g,b,a)=> [
    Math.round(Math.round(r/step)*step),
    Math.round(Math.round(g/step)*step),
    Math.round(Math.round(b/step)*step), a
  ]);
};
PIXEL_FX.duotone = (img,w,h,p)=>{
  const blend = (p.amount||40)/100;
  const dark=[11,20,45], light=[22,232,166];
  return mapColor(img,(r,g,b,a)=>{
    const lum=(0.299*r+0.587*g+0.114*b)/255;
    const mr=dark[0]+(light[0]-dark[0])*lum, mg=dark[1]+(light[1]-dark[1])*lum, mb=dark[2]+(light[2]-dark[2])*lum;
    return [ r+(mr-r)*blend, g+(mg-g)*blend, b+(mb-b)*blend, a ];
  });
};

/* ===== Group 6: Matte / Mask / Key ===== */
function colorDist(r,g,b,key){ const dr=r-key[0],dg=g-key[1],db=b-key[2]; return Math.sqrt(dr*dr+dg*dg+db*db); }
function chromaKey(img,w,h,p,key){
  const tol = (p.amount!==undefined?p.amount:40);
  const low = 20+tol*0.55, high = low+45;
  return mapColor(img,(r,g,b,a)=>{
    const d = colorDist(r,g,b,key);
    let na = a;
    if(d<low) na=0; else if(d<high) na = a*((d-low)/(high-low));
    return [r,g,b,na];
  });
}
PIXEL_FX.chromaKeyGreen = (img,w,h,p)=> chromaKey(img,w,h,p,[40,180,60]);
PIXEL_FX.chromaKeyBlue  = (img,w,h,p)=> chromaKey(img,w,h,p,[30,100,190]);
PIXEL_FX.lumaKey = (img,w,h,p)=>{
  const amt=(p.amount!==undefined?p.amount:40);
  const threshold = 255 - amt*2;
  return mapColor(img,(r,g,b,a)=>{
    const lum=(r+g+b)/3;
    let na=a;
    if(lum>threshold) na=0; else if(lum>threshold-40) na=a*((threshold-lum)/40);
    return [r,g,b,na];
  });
};
function wipe(img,w,h,p,t,dir){
  const amt=(p.amount!==undefined?p.amount:40);
  const speed = 0.4+amt/50;
  const progress = Math.sin(t*speed)*0.5+0.5; // 0..1 oscillating reveal
  const d = img.data;
  const feather = (dir==='left'||dir==='right'? w:h)*0.05;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let edge, pos, forward;
      if(dir==='left'){ edge=progress*w; pos=x; forward=true; }
      else if(dir==='right'){ edge=(1-progress)*w; pos=x; forward=false; }
      else if(dir==='up'){ edge=(1-progress)*h; pos=y; forward=false; }
      else { edge=progress*h; pos=y; forward=true; } // down
      const i = idx(x,y,w);
      let vis;
      if(forward) vis = pos<edge-feather ? 1 : (pos>edge+feather ? 0 : 1-((pos-(edge-feather))/(2*feather)));
      else vis = pos>edge+feather ? 1 : (pos<edge-feather ? 0 : (pos-(edge-feather))/(2*feather));
      d[i+3] = d[i+3]*cl(vis,0,1);
    }
  }
  return img;
}
PIXEL_FX.wipeLeft  = (img,w,h,p,t)=> wipe(img,w,h,p,t,'left');
PIXEL_FX.wipeRight = (img,w,h,p,t)=> wipe(img,w,h,p,t,'right');
PIXEL_FX.wipeUp    = (img,w,h,p,t)=> wipe(img,w,h,p,t,'up');
PIXEL_FX.wipeDown  = (img,w,h,p,t)=> wipe(img,w,h,p,t,'down');

/* ---------------------------------------------------------
   FX registrations (what the Effect panel actually toggles)
   --------------------------------------------------------- */
function pushPostFX(type){
  return (p,ctx)=>{ ctx.tf.postFX = ctx.tf.postFX || []; ctx.tf.postFX.push({ type, params: p||{} }); };
}

/* Group 1: Color & Light */
FX.threeColorGradient  = pushPostFX('threeColorGradient');
FX.brightnessContrastFx = (p,ctx)=>{ const amt=(p.amount||0)/100; ctx.tf.brightness+=amt*0.6; ctx.tf.contrast+=amt*0.4; };
FX.colorBalanceFx      = pushPostFX('colorBalance');
FX.gammaFx             = pushPostFX('gamma');
FX.hotColorFx          = pushPostFX('hotColor');
FX.vibranceFx          = pushPostFX('vibrance');

/* Group 2: Blur (also repair previously inert legacy blur types) */
FX.lensBlurFx    = pushPostFX('lensBlur');
FX.hexagonBlurFx = pushPostFX('hexagonBlur');
FX.spinBlurFx    = pushPostFX('spinBlurPro');
FX.spinBlur         = pushPostFX('spinBlur');
FX.radialBlur       = pushPostFX('radialBlur');
FX.directionalBlur  = pushPostFX('directionalBlur');
FX.focusBlur        = pushPostFX('focusBlur');

/* Group 3: Distortion & Warp */
FX.mirrorFx          = pushPostFX('mirror');
FX.squeezeFx         = pushPostFX('squeeze');
FX.tilesFx           = pushPostFX('tiles');
FX.displacementMapFx = pushPostFX('displacementMap');
FX.fractalWarpFx     = pushPostFX('fractalWarp');
FX.circularRippleFx  = pushPostFX('circularRipple');

/* Group 4: Procedural (bonus set — "terserah") */
FX.kaleidoscopeFx = pushPostFX('kaleidoscope');
FX.voronoiFx      = pushPostFX('voronoi');
FX.plasmaFx       = pushPostFX('plasma');
FX.posterizeFx    = pushPostFX('posterize');
FX.duotoneFx      = pushPostFX('duotone');

/* Group 5: Move / Transform — cheap, direct tf mutation */
FX.oscillateFx = (p,ctx)=>{
  const amt=(p.amount!==undefined?p.amount:20);
  const freq=1+(amt/100)*3;
  ctx.tf.dx += Math.sin(ctx.clipTime*freq*2+ctx.seed)*amt*0.6;
  ctx.tf.dy += Math.cos(ctx.clipTime*freq*1.6+ctx.seed*1.3)*amt*0.4;
};
FX.randomDisplacementFx = (p,ctx)=>{
  const amt=(p.amount!==undefined?p.amount:20);
  ctx.tf.dx += (ctx.rnd()-0.5)*amt;
  ctx.tf.dy += (ctx.rnd()-0.5)*amt;
};
FX.swingFx = (p,ctx)=>{
  const amt=(p.amount!==undefined?p.amount:20);
  ctx.tf.rotation += Math.sin(ctx.clipTime*(1.2+amt/50))*amt*0.5;
};
FX.spinFx = (p,ctx)=>{
  const amt=(p.amount!==undefined?p.amount:20);
  ctx.tf.rotation += (ctx.clipTime*(20+amt*3))%360;
};

/* Group 6: Matte / Mask / Key */
FX.chromaKeyGreenFx = pushPostFX('chromaKeyGreen');
FX.chromaKeyBlueFx  = pushPostFX('chromaKeyBlue');
FX.lumaKeyFx        = pushPostFX('lumaKey');
FX.wipeLeftFx  = pushPostFX('wipeLeft');
FX.wipeRightFx = pushPostFX('wipeRight');
FX.wipeUpFx    = pushPostFX('wipeUp');
FX.wipeDownFx  = pushPostFX('wipeDown');

/* ---------------------------------------------------------
   Wire the new effect categories into the Effect panel.
   EFFECT_CATEGORIES is the exact object referenced by
   renderEffectPanel() — pushing new keys here makes them show
   up as new category tabs automatically, no editor.js changes
   needed for the listing itself.
   --------------------------------------------------------- */
Object.assign(EFFECT_CATEGORIES, {
  'Color Grade': [
    ['3-Color Gradient','threeColorGradient'],
    ['Brightness/Contrast','brightnessContrastFx'],
    ['Color Balance','colorBalanceFx'],
    ['Exposure/Gamma','gammaFx'],
    ['Hot Color','hotColorFx'],
    ['Hue Shift','hueFx'],
    ['Saturation/Vibrance','vibranceFx'],
  ],
  'Blur FX': [
    ['Lens Blur','lensBlurFx'],
    ['Motion Blur','motionBlur'],
    ['Spin Blur','spinBlurFx'],
    ['Gaussian Blur','gaussianBlur'],
    ['Hexagon Blur','hexagonBlurFx'],
  ],
  'Warp & Distort': [
    ['Mirror','mirrorFx'],
    ['Squeeze','squeezeFx'],
    ['Swirl','swirl'],
    ['Tiles','tilesFx'],
    ['Wave Warp','wave'],
    ['Displacement Map','displacementMapFx'],
    ['Fractal Warp','fractalWarpFx'],
    ['Circular Ripple','circularRippleFx'],
  ],
  'Procedural': [
    ['Kaleidoscope','kaleidoscopeFx'],
    ['Voronoi Cells','voronoiFx'],
    ['Plasma','plasmaFx'],
    ['Posterize','posterizeFx'],
    ['Duotone','duotoneFx'],
  ],
  'Transform': [
    ['Oscillate','oscillateFx'],
    ['Random Displacement','randomDisplacementFx'],
    ['Swing','swingFx'],
    ['Spin','spinFx'],
  ],
  'Key & Matte': [
    ['Chroma Key (Green)','chromaKeyGreenFx'],
    ['Chroma Key (Blue)','chromaKeyBlueFx'],
    ['Luma Key','lumaKeyFx'],
    ['Wipe Left','wipeLeftFx'],
    ['Wipe Right','wipeRightFx'],
    ['Wipe Up','wipeUpFx'],
    ['Wipe Down','wipeDownFx'],
  ],
});

console.log('[Pity Studio] effects.js loaded — 6 groups, %d total effect entries', Object.values(EFFECT_CATEGORIES).reduce((s,a)=>s+a.length,0));

})();
