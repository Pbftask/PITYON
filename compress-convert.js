/* ==========================================================================
   COMPRESS & CONVERT — standalone, 100% on-device tool.
   - Turunkan resolusi foto/video
   - Turunkan FPS video
   - Preset "Ultra Low Quality" untuk foto & video
   - Convert format: PNG/JPG/WEBP (foto) dan MP4/WEBM (video)
   No API/server calls are made anywhere in this file — everything runs in
   the browser via Canvas, MediaRecorder and (for mp4 muxing when the
   browser can't record mp4 natively) the ffmpeg.wasm instance already
   loaded by photolab-script.js.
   ========================================================================== */
(function(){
  'use strict';

  const RES_PRESETS_PHOTO=[
    {key:'100', label:'100%'},
    {key:'75',  label:'75%'},
    {key:'50',  label:'50%'},
    {key:'25',  label:'25%'},
    {key:'10',  label:'10%'},
  ];
  const RES_PRESETS_VIDEO=[
    {key:'original', label:'Original'},
    {key:'1080', label:'1080p'},
    {key:'720',  label:'720p'},
    {key:'480',  label:'480p'},
    {key:'360',  label:'360p'},
    {key:'240',  label:'240p'},
    {key:'144',  label:'144p (Ultra Low)'},
  ];
  const FPS_PRESETS=[
    {key:'original', label:'Original'},
    {key:'30', label:'30'},
    {key:'24', label:'24'},
    {key:'15', label:'15'},
    {key:'10', label:'10'},
    {key:'5',  label:'5 (Ultra Low)'},
  ];

  const cc={
    file:null, kind:null, // 'image' | 'video'
    img:null, video:null, objUrl:null,
    fmt:null, res:'100', fps:'original', quality:70,
    resultBlob:null, resultName:null,
  };

  function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }
  function fmtBytes(n){
    if(n<1024) return n+' B';
    if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
    return (n/1024/1024).toFixed(2)+' MB';
  }

  /* ---------------- build & inject modal markup ---------------- */
  function buildModal(){
    const backdrop=el(`
      <div id="ccBackdrop">
        <div id="ccCard">
          <div class="cc-head">
            <div><h3>Compress &amp; Convert</h3><p>Perkecil ukuran, ubah FPS, atau ganti format — semua diproses di perangkatmu.</p></div>
            <button class="icon-btn" id="ccClose" type="button" aria-label="Tutup">
              <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>

          <div class="cc-dropzone" id="ccDropzone">
            <i class="fa-solid fa-file-arrow-up"></i>
            <b>Pilih atau seret foto/video</b>
            <span>JPG, PNG, WEBP, MP4, WEBM, MOV</span>
          </div>
          <input type="file" id="ccFileInput" accept="image/*,video/*" hidden>

          <div class="cc-preview" id="ccPreviewWrap">
            <button class="cc-clear-btn" id="ccClear" type="button" aria-label="Hapus"><i class="fa-solid fa-xmark"></i></button>
            <img id="ccPreviewImg" style="display:none;">
            <video id="ccPreviewVideo" muted playsinline controls style="display:none;"></video>
            <div class="cc-file-meta">
              <span id="ccMetaLeft">–</span><span id="ccMetaRight">–</span>
            </div>
          </div>

          <div class="cc-section" id="ccSectionFormat">
            <h4>Format Output</h4>
            <div class="cc-chip-row" id="ccFormatRow"></div>
          </div>

          <div class="cc-section" id="ccSectionRes">
            <div class="cc-row-label"><b>Resolusi</b></div>
            <div class="cc-chip-row" id="ccResRow"></div>
            <div class="cc-custom-w" id="ccCustomWWrap" style="display:none;">
              <input type="number" id="ccCustomW" placeholder="Lebar custom (px)" min="16" max="8000">
              <span>px lebar, tinggi menyesuaikan</span>
            </div>
          </div>

          <div class="cc-section" id="ccSectionFps">
            <div class="cc-row-label"><b>Frame Rate (FPS)</b></div>
            <div class="cc-chip-row" id="ccFpsRow"></div>
          </div>

          <div class="cc-section" id="ccSectionQuality">
            <div class="cc-row cc-row-label"><b>Kualitas</b><span id="ccQualityVal">70%</span></div>
            <input type="range" id="ccQualitySlider" min="1" max="100" step="1" value="70">
          </div>

          <button class="cc-ultra-btn" id="ccUltraBtn" type="button" style="display:none;">
            <i class="fa-solid fa-bolt-lightning"></i> Terapkan Ultra Low Quality
          </button>

          <button class="cc-go-btn" id="ccGoBtn" type="button" disabled>
            <svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M12 4v11m0 0-4-4m4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            Proses &amp; Download
          </button>

          <div class="cc-progress-wrap" id="ccProgressWrap">
            <div class="cc-progress-track"><div class="cc-progress-fill" id="ccProgressFill"></div></div>
            <div class="cc-progress-text" id="ccProgressText">Memproses...</div>
          </div>

          <div id="ccResultCard">
            <i class="fa-solid fa-circle-check"></i>
            <b id="ccResultTitle">Selesai!</b>
            <span id="ccResultSub"></span>
            <button class="cc-download-btn" id="ccDownloadBtn" type="button">Download File</button>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function openModal(){
    if(!document.getElementById('ccBackdrop')) buildModal();
    wireOnce();
    resetState();
    document.getElementById('ccBackdrop').classList.add('active');
  }
  function closeModal(){
    const b=document.getElementById('ccBackdrop');
    if(b) b.classList.remove('active');
  }

  function resetState(){
    cc.file=null; cc.kind=null; cc.img=null; cc.video=null;
    if(cc.objUrl){ URL.revokeObjectURL(cc.objUrl); cc.objUrl=null; }
    cc.resultBlob=null; cc.resultName=null;
    cc.res='100'; cc.fps='original'; cc.quality=70; cc.fmt=null;
    $('ccPreviewWrap').classList.remove('active');
    $('ccPreviewImg').style.display='none';
    $('ccPreviewVideo').style.display='none';
    $('ccPreviewVideo').removeAttribute('src');
    ['ccSectionFormat','ccSectionRes','ccSectionFps','ccSectionQuality'].forEach(id=>$(id).classList.remove('active'));
    $('ccUltraBtn').style.display='none';
    $('ccGoBtn').disabled=true;
    $('ccProgressWrap').classList.remove('active');
    $('ccResultCard').classList.remove('active');
    $('ccQualitySlider').value=70; $('ccQualityVal').textContent='70%';
  }

  function $(id){ return document.getElementById(id); }

  let wired=false;
  function wireOnce(){
    if(wired) return; wired=true;

    $('ccClose').addEventListener('click', closeModal);
    $('ccBackdrop').addEventListener('click', (e)=>{ if(e.target.id==='ccBackdrop') closeModal(); });
    $('ccClear').addEventListener('click', resetState);

    $('ccDropzone').addEventListener('click', ()=> $('ccFileInput').click());
    $('ccFileInput').addEventListener('change', (e)=>{ if(e.target.files[0]) handleFile(e.target.files[0]); });

    ['dragover','dragenter'].forEach(ev=>{
      $('ccDropzone').addEventListener(ev,(e)=>{ e.preventDefault(); $('ccDropzone').classList.add('drag'); });
    });
    ['dragleave','drop'].forEach(ev=>{
      $('ccDropzone').addEventListener(ev,(e)=>{ e.preventDefault(); $('ccDropzone').classList.remove('drag'); });
    });
    $('ccDropzone').addEventListener('drop',(e)=>{
      const f=e.dataTransfer.files && e.dataTransfer.files[0];
      if(f) handleFile(f);
    });

    $('ccQualitySlider').addEventListener('input',(e)=>{
      cc.quality=parseInt(e.target.value,10);
      $('ccQualityVal').textContent=cc.quality+'%';
    });

    $('ccUltraBtn').addEventListener('click', applyUltraLow);
    $('ccGoBtn').addEventListener('click', runProcess);
    $('ccDownloadBtn').addEventListener('click', downloadResult);
  }

  function handleFile(file){
    const isImg=file.type.startsWith('image/');
    const isVid=file.type.startsWith('video/');
    if(!isImg && !isVid){ alert('File harus berupa foto atau video.'); return; }

    cc.file=file; cc.kind=isImg?'image':'video';
    if(cc.objUrl) URL.revokeObjectURL(cc.objUrl);
    cc.objUrl=URL.createObjectURL(file);

    $('ccPreviewWrap').classList.add('active');
    $('ccMetaLeft').textContent=file.name.length>28?file.name.slice(0,25)+'...':file.name;
    $('ccMetaRight').textContent=fmtBytes(file.size);

    if(isImg){
      $('ccPreviewImg').style.display='block';
      $('ccPreviewVideo').style.display='none';
      $('ccPreviewImg').src=cc.objUrl;
      const img=new Image();
      img.onload=()=>{
        cc.img=img;
        $('ccMetaRight').textContent=`${img.naturalWidth}×${img.naturalHeight} · ${fmtBytes(file.size)}`;
        setupPhotoUI();
      };
      img.src=cc.objUrl;
    }else{
      $('ccPreviewImg').style.display='none';
      $('ccPreviewVideo').style.display='block';
      $('ccPreviewVideo').src=cc.objUrl;
      $('ccPreviewVideo').onloadedmetadata=()=>{
        cc.video=$('ccPreviewVideo');
        const dur=cc.video.duration;
        $('ccMetaRight').textContent=`${cc.video.videoWidth}×${cc.video.videoHeight} · ${dur?dur.toFixed(1)+'s':''} · ${fmtBytes(file.size)}`;
        setupVideoUI();
      };
    }
  }

  function buildChipRow(container, presets, selectedKey, onPick){
    container.innerHTML='';
    presets.forEach(p=>{
      const chip=el(`<button class="cc-chip ${p.key===selectedKey?'active':''}" data-key="${p.key}">${p.label}</button>`);
      chip.addEventListener('click', ()=>{
        container.querySelectorAll('.cc-chip').forEach(c=>c.classList.remove('active'));
        chip.classList.add('active');
        onPick(p.key);
      });
      container.appendChild(chip);
    });
  }

  function setupPhotoUI(){
    cc.fmt='jpeg';
    $('ccSectionFormat').classList.add('active');
    $('ccSectionRes').classList.add('active');
    $('ccSectionFps').classList.remove('active');
    $('ccSectionQuality').classList.add('active');
    $('ccUltraBtn').style.display='flex';
    $('ccGoBtn').disabled=false;

    buildChipRow($('ccFormatRow'), [
      {key:'jpeg',label:'JPG'},{key:'png',label:'PNG'},{key:'webp',label:'WEBP'}
    ], cc.fmt, (k)=>{
      cc.fmt=k;
      $('ccSectionQuality').classList.toggle('active', k!=='png');
    });

    buildChipRow($('ccResRow'), [...RES_PRESETS_PHOTO, {key:'custom',label:'Custom'}], cc.res, (k)=>{
      cc.res=k;
      $('ccCustomWWrap').style.display=(k==='custom')?'flex':'none';
    });
    $('ccCustomWWrap').style.display='none';
  }

  function setupVideoUI(){
    cc.fmt='mp4';
    $('ccSectionFormat').classList.add('active');
    $('ccSectionRes').classList.add('active');
    $('ccSectionFps').classList.add('active');
    $('ccSectionQuality').classList.add('active');
    $('ccUltraBtn').style.display='flex';
    $('ccGoBtn').disabled=false;

    buildChipRow($('ccFormatRow'), [{key:'mp4',label:'MP4'},{key:'webm',label:'WEBM'}], cc.fmt, (k)=>{ cc.fmt=k; });
    buildChipRow($('ccResRow'), RES_PRESETS_VIDEO, cc.res==='100'?'original':cc.res, (k)=>{ cc.res=k; });
    cc.res='original';
    buildChipRow($('ccFpsRow'), FPS_PRESETS, cc.fps, (k)=>{ cc.fps=k; });
    $('ccCustomWWrap').style.display='none';
  }

  function applyUltraLow(){
    if(cc.kind==='image'){
      cc.res='10'; cc.fmt='jpeg'; cc.quality=25;
      buildChipRow($('ccFormatRow'), [{key:'jpeg',label:'JPG'},{key:'png',label:'PNG'},{key:'webp',label:'WEBP'}], cc.fmt, (k)=>{ cc.fmt=k; });
      buildChipRow($('ccResRow'), [...RES_PRESETS_PHOTO, {key:'custom',label:'Custom'}], cc.res, (k)=>{ cc.res=k; $('ccCustomWWrap').style.display=(k==='custom')?'flex':'none'; });
      $('ccCustomWWrap').style.display='none';
    }else{
      cc.res='144'; cc.fps='5'; cc.quality=8;
      buildChipRow($('ccResRow'), RES_PRESETS_VIDEO, cc.res, (k)=>{ cc.res=k; });
      buildChipRow($('ccFpsRow'), FPS_PRESETS, cc.fps, (k)=>{ cc.fps=k; });
    }
    $('ccQualitySlider').value=cc.quality;
    $('ccQualityVal').textContent=cc.quality+'%';
  }

  function setProgress(pct, text){
    $('ccProgressWrap').classList.add('active');
    $('ccProgressFill').style.width=Math.max(0,Math.min(100,pct))+'%';
    if(text) $('ccProgressText').textContent=text;
  }

  async function runProcess(){
    if(!cc.file) return;
    $('ccGoBtn').disabled=true;
    $('ccResultCard').classList.remove('active');
    setProgress(2, 'Mempersiapkan...');
    try{
      if(cc.kind==='image') await processImage();
      else await processVideo();
    }catch(err){
      console.error('Compress & Convert error:', err);
      alert('Gagal memproses file: '+(err && err.message ? err.message : 'unknown error'));
    }
    $('ccGoBtn').disabled=false;
  }

  /* ---------------- IMAGE PIPELINE ---------------- */
  async function processImage(){
    const img=cc.img;
    let targetW=img.naturalWidth, targetH=img.naturalHeight;

    if(cc.res==='custom'){
      const w=parseInt($('ccCustomW').value,10);
      if(w && w>0){
        targetW=w;
        targetH=Math.round(img.naturalHeight*(w/img.naturalWidth));
      }
    }else{
      const pct=parseInt(cc.res,10)/100;
      targetW=Math.max(1,Math.round(img.naturalWidth*pct));
      targetH=Math.max(1,Math.round(img.naturalHeight*pct));
    }

    setProgress(30,'Menggambar ulang gambar...');
    const canvas=document.createElement('canvas');
    canvas.width=targetW; canvas.height=targetH;
    const ctx=canvas.getContext('2d');
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(img,0,0,targetW,targetH);

    setProgress(70,'Mengonversi format...');
    const mime={jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[cc.fmt]||'image/jpeg';
    const q=cc.fmt==='png' ? undefined : Math.max(0.05, cc.quality/100);

    const blob=await new Promise(resolve=>canvas.toBlob(resolve, mime, q));
    if(!blob){ throw new Error('Browser gagal membuat file gambar.'); }

    setProgress(100,'Selesai!');
    const ext=cc.fmt==='jpeg'?'jpg':cc.fmt;
    const baseName=cc.file.name.replace(/\.[^.]+$/,'');
    finishResult(blob, `${baseName}-${targetW}x${targetH}.${ext}`,
      `${targetW}×${targetH} · ${fmtBytes(blob.size)} (asal ${fmtBytes(cc.file.size)})`);
  }

  /* ---------------- VIDEO PIPELINE ---------------- */
  function resolveVideoTargetSize(video, resKey){
    const srcW=video.videoWidth, srcH=video.videoHeight;
    if(resKey==='original') return {w:srcW,h:srcH};
    const longEdge=parseInt(resKey,10);
    const srcLong=Math.max(srcW,srcH);
    if(longEdge>=srcLong) return {w:srcW,h:srcH};
    const scale=longEdge/srcLong;
    return {w:Math.round(srcW*scale/2)*2, h:Math.round(srcH*scale/2)*2};
  }

  // NOTE: We deliberately never ask MediaRecorder to record 'video/mp4'
  // directly. Some Android browsers report isTypeSupported('video/mp4')===true
  // but then throw "The given encoder configuration is not supported by the
  // encoder" the moment start() is called with a small resolution / low
  // bitrate (common with the low-res / ultra-low presets here). WebM
  // recording is far more reliably supported across devices, so we always
  // record WebM and — if the user asked for MP4 — mux/transcode to MP4
  // afterwards with ffmpeg.wasm (same approach the main editor uses as its
  // own fallback path).
  function pickVideoMime(){
    const webmCands=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
    for(const c of webmCands){
      if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)){
        return c;
      }
    }
    return 'video/webm';
  }

  async function processVideo(){
    const video=cc.video;
    if(!window.MediaRecorder){ throw new Error('Browser ini tidak mendukung export video.'); }
    if(!video.duration || !isFinite(video.duration)){ throw new Error('Video belum siap, coba lagi.'); }

    let {w:outW,h:outH}=resolveVideoTargetSize(video, cc.res);
    // Floor the dimensions so we never hand the encoder something tiny like
    // 82x144 — very small frames are exactly what trips the "encoder
    // configuration not supported" error on some hardware encoders.
    const MIN_EDGE=160;
    if(Math.min(outW,outH)<MIN_EDGE){
      const s=MIN_EDGE/Math.min(outW,outH);
      outW=Math.round(outW*s/2)*2; outH=Math.round(outH*s/2)*2;
    }
    const fpsTarget = cc.fps==='original' ? 30 : parseInt(cc.fps,10);

    const canvas=document.createElement('canvas');
    canvas.width=outW; canvas.height=outH;
    const ctx=canvas.getContext('2d');

    const canvasStream=canvas.captureStream(fpsTarget);
    try{
      if(typeof video.captureStream==='function'){
        const vs=video.captureStream();
        vs.getAudioTracks().forEach(t=>canvasStream.addTrack(t));
      }
    }catch(e){ /* audio capture not available on this browser — continue silently */ }

    const mimeType=pickVideoMime();
    const needsMux = cc.fmt==='mp4';
    // Quality slider (1-100) -> bits-per-pixel-ish factor, lower = smaller file.
    // Floored well above zero so the encoder is never handed an unusably low
    // bitrate that some devices will reject outright.
    const bpp = 0.01 + (cc.quality/100)*0.13; // 0.01 (ultra low) .. 0.14 (max)
    const videoBitsPerSecond=Math.max(150_000, Math.min(20_000_000, Math.round(outW*outH*fpsTarget*bpp/10)));

    let recorder;
    try{
      recorder=new MediaRecorder(canvasStream,{mimeType, videoBitsPerSecond});
    }catch(e){
      // Extremely defensive fallback: retry with no explicit bitrate/mime
      // options at all, letting the browser pick safe defaults.
      recorder=new MediaRecorder(canvasStream);
    }
    const chunks=[];
    function attachRecorderHandlers(rec){
      rec.ondataavailable=(e)=>{ if(e.data && e.data.size>0) chunks.push(e.data); };
    }
    attachRecorderHandlers(recorder);

    let rafId=null;
    function drawLoop(){
      if(video.paused || video.ended) return;
      ctx.drawImage(video,0,0,outW,outH);
      const pct=Math.min(85, 5 + (video.currentTime/video.duration)*80);
      setProgress(pct, `Merender video... ${video.currentTime.toFixed(1)}s / ${video.duration.toFixed(1)}s`);
      rafId=requestAnimationFrame(drawLoop);
    }

    video.currentTime=0;
    await new Promise(res=>{ video.onseeked=res; });
    const wasMuted=video.muted;
    video.muted=true;
    try{
      recorder.start(250);
    }catch(e){
      // Same defensive fallback as above, in case start() itself is what
      // rejects the configuration rather than the constructor.
      recorder=new MediaRecorder(canvasStream);
      attachRecorderHandlers(recorder);
      recorder.start(250);
    }
    const finished=new Promise((resolve,reject)=>{
      recorder.onstop=resolve;
      recorder.onerror=(e)=>reject(e.error||new Error('MediaRecorder error'));
    });
    await video.play();
    rafId=requestAnimationFrame(drawLoop);

    await new Promise(resolve=>{
      video.onended=resolve;
      setTimeout(resolve,(video.duration*1000)+4000);
    });
    cancelAnimationFrame(rafId);
    setProgress(88,'Menyiapkan file...');
    recorder.stop();
    video.muted=wasMuted;
    await finished;

    const recordedBlob=new Blob(chunks,{type:mimeType.split(';')[0]});
    let outBlob=recordedBlob, outExt = needsMux ? 'mp4' : (cc.fmt==='mp4' ? 'mp4' : 'webm');

    if(needsMux){
      // Recorded as WebM but user wants MP4 — reuse the ffmpeg.wasm instance
      // already set up by photolab-script.js (loaded on the same page) to
      // mux/transcode client-side, exactly like the main editor's export.
      if(typeof window.convertWebmBlobToMp4 !== 'function'){
        setProgress(100,'Selesai (disimpan sebagai WebM, MP4 encoder belum siap).');
        outExt='webm';
      }else{
        setProgress(90,'Mengonversi ke MP4...');
        try{
          outBlob=await window.convertWebmBlobToMp4(recordedBlob, (frac)=>{
            setProgress(90+frac*10, `Mengonversi ke MP4... ${Math.round(frac*100)}%`);
          }, 'veryfast');
          outExt='mp4';
        }catch(err){
          console.error('MP4 mux failed, falling back to WebM:', err);
          outBlob=recordedBlob; outExt='webm';
        }
      }
    }

    setProgress(100,'Selesai!');
    const baseName=cc.file.name.replace(/\.[^.]+$/,'');
    finishResult(outBlob, `${baseName}-${outW}x${outH}-${fpsTarget}fps.${outExt}`,
      `${outW}×${outH} · ${fpsTarget}fps · ${fmtBytes(outBlob.size)} (asal ${fmtBytes(cc.file.size)})`);
  }

  function finishResult(blob, filename, subtext){
    cc.resultBlob=blob; cc.resultName=filename;
    $('ccResultSub').textContent=subtext;
    $('ccResultCard').classList.add('active');
  }

  function downloadResult(){
    if(!cc.resultBlob) return;
    const a=document.createElement('a');
    a.href=URL.createObjectURL(cc.resultBlob);
    a.download=cc.resultName||'output';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1000);
  }

  /* ---------------- wire trigger button ---------------- */
  function wireTrigger(){
    const btn=document.getElementById('btnCompressConvert');
    if(btn) btn.addEventListener('click', openModal);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', wireTrigger);
  }else{
    wireTrigger();
  }

  // Expose for manual triggering if needed elsewhere in the app.
  window.openCompressConvertTool=openModal;
})();
