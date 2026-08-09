(function(){
"use strict";

/* ==========================================================================
   0. CONFIG (on-device only — no cloud AI API. Buy Credit page + Firebase)
   ========================================================================== */
const CONFIG = {
  FREE_DAILY_LIMIT: 20,
  // Get a free key at https://api.imgbb.com/ (login with Google, click
  // "Add API key"), then paste it below. Used only to host the user's
  // uploaded profile photo — no other images are ever sent anywhere.
  IMGBB_API_KEY: "4b5b5ba36295e875f1c44a632408c8c7"
};
const BUY_CREDIT_URL =
  "chat.html?uid=BQy28ApNQPYPTRLQNKOgx5VmX9z1";

// Firebase configuration — used for Authentication and for reading/writing
// the user's own credit balance. All photo processing (Free AND Premium)
// runs fully on-device in the browser; there is no cloud AI backend. When a
// Premium (credit-costing) feature is used, the credit is decremented via a
// Firebase transaction that only allows a self-write of exactly "-1" (see
// chargeCreditIfNeeded()) — this must be matched by equivalent Realtime
// Database security rules server-side, or the deduction will be rejected.
const firebaseConfig = {
  apiKey: "AIzaSyAVALbkISki4F7kp0nWE_Eoa3qkfebiw7w",
  authDomain: "vidly-23088.firebaseapp.com",
  databaseURL: "https://vidly-23088-default-rtdb.firebaseio.com",
  projectId: "vidly-23088",
  storageBucket: "vidly-23088.firebasestorage.app",
  messagingSenderId: "236826762345",
  appId: "1:236826762345:web:0ac7d331689067b83b56f8"
};

/* ==========================================================================
   1. STATE
   ========================================================================== */
const defaultSettings = {
  scale:1, sharpen:0, denoise:0,
  brightness:0, contrast:0, saturation:0, vibrance:0,
  temperature:0, highlights:0, shadows:0, gamma:0, hue:0,
  faceDetail:false, activePreset:null, activeSharpenPreset:null, activeDenoisePreset:null,
  activeFilter:null, activeFilterPremium:false,
  aspectRatio:null // {width, height} or null for original
};

const S = {
  file:null,
  originalCanvas:null,   // full resolution source (capped)
  previewCanvas:null,    // downscaled working canvas for interactive edits
  settings:{...defaultSettings},
  history:[], historyIndex:-1,
  zoom:1, panX:0, panY:0, fitZoom:1,
  compare:0.5,
  stayLocked:false,       // "Stay" — when true, photo ignores pan/pinch drag
  baMode:'after',         // 'after' | 'before' — full-view Before/After toggle
  quickCompareActive:false, // whether the draggable yellow divider is shown
  draggingLayer:null,     // {type, id} while dragging a mosaic/sticker/text handle on canvas
  worker:null, workerBusy:false,
  origWidth:0, origHeight:0,
  exportFormat:'jpeg', exportQuality:'high', exportUpscale:2,
  prefs:{ previewQuality:'balanced', autoOnLoad:false, hwAccel:true, useGpu:true, darkMode:true, haptic:false, defaultFormat:'jpeg', defaultQuality:'high', defaultUpscale:2 },
  renderPending:false, renderHiQPending:false,
  exportCancelled:false,

  // ---- Account / Premium credit state (all processing is on-device) ----
  uid:null,
  credits:null,                // null = not loaded yet
  isAdmin:false,
  userProfile:null,            // { name, username, email, photo } once signed in
  chargingCredit:false,

  // ---- Text & Mosaic edit layers (baked in at render/export time) ----
  textLayers:[],    // {id, text, x, y, size, color, bold, stroke, opacity, order}
  mosaicLayers:[],  // {id, x, y, w, h, block, order}
  stickerLayers:[], // {id, url, premium, x, y, scale, rotation, opacity, order}

  // ---- Custom filter editor state (not reset with settings) ----
  editingCustomFilterId:null,
  editingCustomFilterName:null
};

/* ==========================================================================
   2. DOM REFS
   ========================================================================== */
const $ = (id)=>document.getElementById(id);
const emptyState=$('emptyState'), viewport=$('viewport'), dropHint=$('dropHint');
const fileInput=$('fileInput'), canvasHolder=$('canvasHolder');
const canvasBefore=$('canvasBefore'), canvasAfter=$('canvasAfter');
const compareDivider=$('compareDivider'), compareHandle=$('compareHandle');
const layerHandlesEl=$('layerHandles');
const processingOverlay=$('processingOverlay');
const infoStrip=$('infoStrip'), infoOrigRes=$('infoOrigRes'), infoOutRes=$('infoOutRes'), infoFileSize=$('infoFileSize'), infoZoom=$('infoZoom');
const bottomTabs=$('bottomTabs'), toolSheet=$('toolSheet'), sheetBackdrop=$('sheetBackdrop'), sheetBody=$('sheetBody'), sheetTitle=$('sheetTitle');
const sheetLivePreviewCanvas=$('sheetLivePreview'), sheetLivePreviewWrap=$('sheetLivePreviewWrap');
const warnBanner=$('warnBanner'), warnText=$('warnText');
const stage=$('stage');
const exportOverlay=$('exportOverlay'), progressCircle=$('progressCircle'), progressPercent=$('progressPercent'), progressFill=$('progressFill'), exportStatusText=$('exportStatusText'), exportGlow=$('exportGlow');

// Starts the same glowing ring animation used by the initial page loader,
// but for the export progress overlay. Runs only while the overlay is active.
function startExportGlow(){
  animateLoaderGlow(exportGlow, ()=>exportOverlay.classList.contains('active'));
}

const ctxBefore=canvasBefore.getContext('2d');
const ctxAfter=canvasAfter.getContext('2d');

/* ==========================================================================
   3. UTILITIES
   ========================================================================== */
function clamp(v,min,max){return v<min?min:v>max?max:v;}
function clampByte(v){return v<0?0:v>255?255:v;}
function escHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatBytes(bytes){
  if(bytes<1024) return bytes+' B';
  if(bytes<1024*1024) return (bytes/1024).toFixed(1)+' KB';
  return (bytes/(1024*1024)).toFixed(2)+' MB';
}
function debounce(fn,ms){let t;return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}
function haptic(){ if(S.prefs.haptic && navigator.vibrate) navigator.vibrate(8); }
function nowStamp(){const d=new Date();return d.toISOString().replace(/[:.]/g,'-');}

function toast(msg,type){
  const host=$('toastHost');
  const el=document.createElement('div');
  el.className='toast'+(type?(' '+type):'');
  let icon='<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5m0 3h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/></svg>';
  if(type==='success') icon='<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5 9.5 17 19 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el.innerHTML=icon+'<span></span>';
  el.querySelector('span').textContent=msg;
  host.appendChild(el);
  setTimeout(()=>{el.style.opacity='0';el.style.transform='translateY(-8px)';el.style.transition='all .25s ease';setTimeout(()=>el.remove(),260);},2600);
}

/* ==========================================================================
   3b. MODE A — FREE DAILY USAGE COUNTER (localStorage only)
   ========================================================================== */
const FREE_USAGE_KEY='ufnai_free_usage';

function todayStr(){
  const d=new Date();
  const mm=String(d.getMonth()+1).padStart(2,'0');
  const dd=String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function getFreeUsage(){
  let obj=null;
  try{
    const raw=localStorage.getItem(FREE_USAGE_KEY);
    if(raw) obj=JSON.parse(raw);
  }catch(err){ obj=null; }
  const today=todayStr();
  if(!obj || obj.date!==today){
    obj={date:today, count:0};
    try{ localStorage.setItem(FREE_USAGE_KEY, JSON.stringify(obj)); }catch(err){}
  }
  return obj;
}

// Called only when the user actually finishes running/exporting a Free
// Enhance result — never on slider changes, undo/redo, or opening a file.
function incrementFreeUsage(){
  const obj=getFreeUsage();
  obj.count=Math.min(CONFIG.FREE_DAILY_LIMIT, obj.count+1);
  try{ localStorage.setItem(FREE_USAGE_KEY, JSON.stringify(obj)); }catch(err){}
  return obj;
}

function refreshFreeUsageUI(){
  const usage=getFreeUsage();
  const label=`${usage.count} / ${CONFIG.FREE_DAILY_LIMIT} USED TODAY`;
  const stripEl=document.getElementById('freeUsageStrip');
  if(stripEl) stripEl.textContent=label;
  const el=$('freeUsageText'); if(el) el.textContent=`${usage.count}/${CONFIG.FREE_DAILY_LIMIT} today`;
  const elAcc=$('freeUsageTextAcc'); if(elAcc) elAcc.textContent=`${usage.count}/${CONFIG.FREE_DAILY_LIMIT} today`;
  return usage;
}

/* ==========================================================================
   3c. FIREBASE — EMAIL/PASSWORD AUTHENTICATION + CREDIT BALANCE (PREMIUM)
   The whole app is gated behind Firebase Authentication (email/password).
   Frontend only READS the credit balance. It never decrements
   it — the Cloudflare Worker validates and reserves/refunds credits
   server-side.
   ========================================================================== */
let firebaseAuthRef=null, firebaseDbRef=null, firestoreDbRef=null, creditsWatchRef=null;
let authBusy=false;
let resendCooldownTimer=null;

const loginGate=$('loginGate');
const loginErrorEl=$('loginError');
const loginSuccessEl=$('loginSuccess');

// ---- Auth view switcher (login / register / forgot-password) ----
const AUTH_VIEWS=['viewLogin','viewRegister','viewForgot'];
function showAuthView(name){
  AUTH_VIEWS.forEach(id=>{
    const el=$(id);
    if(el) el.classList.toggle('active', id===name);
  });
  setAuthError('');
  setAuthSuccess('');
}

function showLoginGate(){
  if(!loginGate) return;
  loginGate.classList.remove('hidden');
}
function hideLoginGate(){
  if(!loginGate) return;
  loginGate.classList.add('hidden');
  setAuthError('');
  setAuthSuccess('');
}
function setAuthError(msg){
  if(!loginErrorEl) return;
  loginErrorEl.textContent=msg||'';
  loginErrorEl.style.display=msg?'block':'none';
  if(msg && loginSuccessEl){ loginSuccessEl.style.display='none'; }
}
function setAuthSuccess(msg){
  if(!loginSuccessEl) return;
  loginSuccessEl.textContent=msg||'';
  loginSuccessEl.style.display=msg?'block':'none';
  if(msg && loginErrorEl){ loginErrorEl.style.display='none'; }
}

// Maps Firebase Authentication error codes to friendly Indonesian messages.
function mapFirebaseError(err){
  const code=err && err.code ? err.code : '';
  switch(code){
    case 'auth/email-already-in-use': return 'Email ini sudah terdaftar. Silakan login.';
    case 'auth/invalid-email': return 'Format email tidak valid.';
    case 'auth/weak-password': return 'Password terlalu lemah. Gunakan minimal 8 karakter.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password': return 'Email atau password salah.';
    case 'auth/user-not-found': return 'Akun dengan email ini tidak ditemukan.';
    case 'auth/user-disabled': return 'Akun ini telah dinonaktifkan.';
    case 'auth/too-many-requests': return 'Terlalu banyak percobaan. Silakan tunggu sebentar lalu coba lagi.';
    case 'auth/network-request-failed': return 'Koneksi internet bermasalah. Periksa koneksi kamu.';
    case 'auth/missing-email': return 'Email wajib diisi.';
    case 'auth/popup-closed-by-user': return '';
    default: return (err && err.message) ? 'Terjadi kesalahan. Silakan coba lagi.' : 'Terjadi kesalahan. Silakan coba lagi.';
  }
}

function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||'');
}

function setBtnLoading(btn, busy, idleLabel){
  if(!btn) return;
  btn.disabled=busy;
  btn.textContent = busy ? 'Memproses…' : idleLabel;
}

function initFirebase(){
  try{
    if(typeof firebase==='undefined'){
      showLoginGate();
      setAuthError('Tidak dapat memuat sistem login. Periksa koneksi internet lalu muat ulang halaman.');
      return;
    }
    const app = (firebase.apps && firebase.apps.length) ? firebase.apps[0] : firebase.initializeApp(firebaseConfig);
    firebaseAuthRef = firebase.auth(app);
    firebaseDbRef = firebase.database(app);
    // Firestore stores the user's profile (username + uploaded photo URL),
    // separate from the Realtime Database which only holds credits.
    try{
      firestoreDbRef = (typeof firebase.firestore==='function') ? firebase.firestore(app) : null;
      subscribeStickers();
    }catch(err){
      console.warn('Firestore init error', err);
      firestoreDbRef = null;
    }

    firebaseAuthRef.onAuthStateChanged((user)=>{
      if(!user){
        handleLoggedOutState();
      }else{
        handleAuthenticatedState(user);
      }
    });
  }catch(err){
    console.error('Firebase init error', err);
    showLoginGate();
    setAuthError('Terjadi kesalahan saat memuat sistem login.');
  }
}

// ---- STATE 1: NOT_LOGGED_IN ----
function handleLoggedOutState(){
  S.uid=null; S.credits=null; S.userProfile=null; S.isAdmin=false;
  if(creditsWatchRef){ try{ creditsWatchRef.off(); }catch(e){} creditsWatchRef=null; }
  stopResendCooldown();
  updateCreditsUI();
  updateUserProfileUI();
  showLoginGate();
  showAuthView('viewLogin');
}

// ---- STATE 2: AUTHENTICATED ----
const ADMIN_EMAILS=['opintar114@gmail.com'];
function handleAuthenticatedState(user){
  S.uid=user.uid;
  S.userProfile={ name:(user.email||'').split('@')[0], username:'', email:user.email||'', photo:'' };
  S.isAdmin = ADMIN_EMAILS.includes((user.email||'').toLowerCase());
  stopResendCooldown();
  hideLoginGate();
  subscribeCredits(user.uid);
  updateUserProfileUI();
  saveUserProfileToDb(user);
  loadUserProfileFromFirestore(user.uid);
}

// Loads the user's username + uploaded profile photo URL from Firestore
// (collection "profiles", one document per uid) and merges it into S.userProfile.
async function loadUserProfileFromFirestore(uid){
  if(!firestoreDbRef || !S.userProfile) return;
  try{
    const doc = await firestoreDbRef.collection('profiles').doc(uid).get();
    if(doc.exists && S.uid===uid){
      const data=doc.data()||{};
      if(data.username){ S.userProfile.username=data.username; S.userProfile.name=data.username; }
      if(data.photoURL){ S.userProfile.photo=data.photoURL; }
      updateUserProfileUI();
    }
  }catch(err){
    console.warn('Load profile from Firestore skipped', err);
  }
}

// Store minimal, non-sensitive profile data keyed by UID (never by email).
function saveUserProfileToDb(user){
  try{
    if(!firebaseDbRef) return;
    firebaseDbRef.ref('users/'+user.uid).update({
      uid:user.uid,
      email:user.email||'',
      emailVerified:!!user.emailVerified,
      createdAt:firebase.database.ServerValue.TIMESTAMP
    }).catch((err)=>{ console.warn('Profile save skipped', err); });
  }catch(err){ console.warn('Profile save skipped', err); }
}

/* ---- REGISTER ---- */
const formRegister=$('formRegister');
if(formRegister) formRegister.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(authBusy) return;
  const email=($('regEmail').value||'').trim();
  const password=$('regPassword').value||'';
  const confirm=$('regPasswordConfirm').value||'';

  setAuthError(''); setAuthSuccess('');
  if(!isValidEmail(email)){ setAuthError('Format email tidak valid.'); return; }
  if(password.length<8){ setAuthError('Password minimal 8 karakter.'); return; }
  if(password!==confirm){ setAuthError('Password dan konfirmasi password tidak sama.'); return; }
  if(!firebaseAuthRef){ setAuthError('Sistem login belum siap. Coba lagi sebentar.'); return; }

  authBusy=true;
  const btn=$('btnRegisterSubmit');
  setBtnLoading(btn, true, 'Daftar');
  try{
    await firebaseAuthRef.createUserWithEmailAndPassword(email, password);
    formRegister.reset();
    // onAuthStateChanged will route straight into the app once created.
  }catch(err){
    console.error('Register error', err);
    setAuthError(mapFirebaseError(err));
  }finally{
    authBusy=false;
    setBtnLoading(btn, false, 'Daftar');
  }
});

/* ---- LOGIN ---- */
const formLogin=$('formLogin');
if(formLogin) formLogin.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(authBusy) return;
  const email=($('loginEmail').value||'').trim();
  const password=$('loginPassword').value||'';

  setAuthError(''); setAuthSuccess('');
  if(!isValidEmail(email)){ setAuthError('Format email tidak valid.'); return; }
  if(!password){ setAuthError('Password wajib diisi.'); return; }
  if(!firebaseAuthRef){ setAuthError('Sistem login belum siap. Coba lagi sebentar.'); return; }

  authBusy=true;
  const btn=$('btnLoginSubmit');
  setBtnLoading(btn, true, 'Login');
  try{
    await firebaseAuthRef.signInWithEmailAndPassword(email, password);
    formLogin.reset();
    // onAuthStateChanged routes into the app automatically.
  }catch(err){
    console.error('Login error', err);
    setAuthError(mapFirebaseError(err));
  }finally{
    authBusy=false;
    setBtnLoading(btn, false, 'Login');
  }
});

function stopResendCooldown(){ /* no-op: email verification removed */ }

/* ---- FORGOT PASSWORD ---- */
const formForgot=$('formForgot');
if(formForgot) formForgot.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(authBusy) return;
  const email=($('forgotEmail').value||'').trim();

  setAuthError(''); setAuthSuccess('');
  if(!isValidEmail(email)){ setAuthError('Format email tidak valid.'); return; }
  if(!firebaseAuthRef){ setAuthError('Sistem login belum siap. Coba lagi sebentar.'); return; }

  authBusy=true;
  const btn=$('btnForgotSubmit');
  setBtnLoading(btn, true, 'Kirim Link Reset Password');
  try{
    await firebaseAuthRef.sendPasswordResetEmail(email);
    formForgot.reset();
    setAuthSuccess('Link reset password telah dikirim ke email kamu. Periksa inbox atau folder spam.');
  }catch(err){
    console.error('Reset password error', err);
    setAuthError(mapFirebaseError(err));
  }finally{
    authBusy=false;
    setBtnLoading(btn, false, 'Kirim Link Reset Password');
  }
});

/* ---- VIEW NAVIGATION LINKS ---- */
const linkGoToRegister=$('linkGoToRegister');
if(linkGoToRegister) linkGoToRegister.addEventListener('click', ()=>showAuthView('viewRegister'));
const linkGoToLogin=$('linkGoToLogin');
if(linkGoToLogin) linkGoToLogin.addEventListener('click', ()=>showAuthView('viewLogin'));
const linkForgotPassword=$('linkForgotPassword');
if(linkForgotPassword) linkForgotPassword.addEventListener('click', ()=>showAuthView('viewForgot'));
const linkForgotToLogin=$('linkForgotToLogin');
if(linkForgotToLogin) linkForgotToLogin.addEventListener('click', ()=>showAuthView('viewLogin'));

/* ---- LOGOUT ---- */
async function signOutUser(){
  try{
    if(creditsWatchRef){ try{ creditsWatchRef.off(); }catch(e){} creditsWatchRef=null; }
    if(firebaseAuthRef) await firebaseAuthRef.signOut();
    closeCreditCenter();
    toast('Berhasil logout.','success');
  }catch(err){
    console.error('Sign out error', err);
    toast('Gagal keluar. Coba lagi.','error');
  }
}

function updateUserProfileUI(){
  const p=S.userProfile;
  const nameEl=$('userProfileName');
  const emailEl=$('userProfileEmail');
  const avatarEl=$('userProfileAvatar');
  if(nameEl) nameEl.textContent = p ? (p.name||'Pengguna') : '';
  if(emailEl) emailEl.textContent = p ? (p.email||'') : '';
  if(avatarEl){
    if(p && p.photo){ avatarEl.src=p.photo; avatarEl.style.display='block'; }
    else{ avatarEl.style.display='none'; }
  }
  const nameElAcc=$('userProfileNameAcc');
  const emailElAcc=$('userProfileEmailAcc');
  const avatarElAcc=$('userProfileAvatarAcc');
  if(nameElAcc) nameElAcc.textContent = p ? (p.name||'Pengguna') : '';
  if(emailElAcc) emailElAcc.textContent = p ? (p.email||'') : '';
  if(avatarElAcc){
    if(p && p.photo){ avatarElAcc.src=p.photo; avatarElAcc.style.display='block'; }
    else{ avatarElAcc.style.display='none'; }
  }
  const uidEl=$('myUidText'); if(uidEl) uidEl.textContent = S.uid || '–';
  const adminSection=$('adminSection'); if(adminSection) adminSection.style.display = S.isAdmin ? 'block' : 'none';
  // If the sticker picker is open when admin status resolves (e.g. right
  // after login), re-render it so the upload/delete controls appear
  // without the user having to close and reopen the Edit tab.
  if(sheetBody && sheetBody.querySelector('#stickerPickerGrid')) renderEditTab();

  // Top-left header logo: shows the user's uploaded profile photo once set,
  // falls back to the default app icon otherwise (never disappears).
  const brandIcon=$('brandMarkIcon');
  const brandAvatar=$('brandMarkAvatar');
  if(brandIcon && brandAvatar){
    if(p && p.photo){
      brandAvatar.src=p.photo;
      brandAvatar.style.display='block';
      brandIcon.style.display='none';
    }else{
      brandAvatar.style.display='none';
      brandIcon.style.display='block';
    }
  }
  // Account page avatar fallback glyph
  const avatarFallbackAcc=$('profileAvatarFallbackAcc');
  if(avatarFallbackAcc) avatarFallbackAcc.style.display = (p && p.photo) ? 'none' : 'flex';
}

const btnSignOut=$('btnSignOut');
if(btnSignOut) btnSignOut.addEventListener('click', signOutUser);

/* ==========================================================================
   3d. PROFILE PHOTO (imgbb hosting) + USERNAME (Firestore)
   The photo file itself is uploaded to imgbb (free image host, returns a
   public URL) — only that URL is then saved to Firestore, never the raw
   file. Username is validated client-side and saved the same way.
   ========================================================================== */
async function uploadImageToImgbb(file){
  const apiKey=CONFIG.IMGBB_API_KEY;
  if(!apiKey || apiKey.indexOf('GANTI')===0){
    throw new Error('imgbb API key belum diatur di CONFIG.IMGBB_API_KEY.');
  }
  const formData=new FormData();
  formData.append('image', file);
  const res=await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
    method:'POST',
    body:formData
  });
  const data=await res.json().catch(()=>null);
  if(!res.ok || !data || !data.success){
    const msg=(data && data.error && data.error.message) || 'Upload foto gagal.';
    throw new Error(msg);
  }
  return (data.data && (data.data.display_url || data.data.url)) || '';
}

async function handleProfilePhotoSelected(file){
  if(!file) return;
  if(!S.uid){ toast('Login dulu untuk mengganti foto profil.'); return; }
  if(!/^image\//.test(file.type)){ toast('File harus berupa gambar.','error'); return; }
  if(file.size > 6*1024*1024){ toast('Ukuran foto maksimal 6MB.','error'); return; }

  const statusEl=$('avatarUploadStatus');
  if(statusEl){ statusEl.style.display='block'; statusEl.textContent='Mengunggah foto profil...'; }

  try{
    const url=await uploadImageToImgbb(file);
    if(!url) throw new Error('imgbb tidak mengembalikan URL foto.');
    if(!firestoreDbRef) throw new Error('Firestore belum siap. Coba lagi sebentar.');

    await firestoreDbRef.collection('profiles').doc(S.uid).set({
      photoURL:url,
      email:(S.userProfile && S.userProfile.email) || '',
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });

    if(S.userProfile) S.userProfile.photo=url;
    updateUserProfileUI();
    toast('Foto profil berhasil diperbarui.','success');
  }catch(err){
    console.error('Profile photo upload error', err);
    toast('Gagal mengunggah foto: '+(err.message||'coba lagi.'), 'error');
  }finally{
    if(statusEl) statusEl.style.display='none';
  }
}

const profilePhotoInput=$('profilePhotoInput');
const btnChangeAvatar=$('btnChangeAvatar');
if(btnChangeAvatar) btnChangeAvatar.addEventListener('click', ()=>{
  if(!S.uid){ toast('Login dulu untuk mengganti foto profil.'); return; }
  if(profilePhotoInput) profilePhotoInput.click();
});
if(profilePhotoInput) profilePhotoInput.addEventListener('change', (e)=>{
  const file=e.target.files && e.target.files[0];
  handleProfilePhotoSelected(file);
  e.target.value=''; // allow re-selecting the same file later
});

function isValidUsername(name){
  return /^[a-zA-Z0-9_.]{3,24}$/.test(name||'');
}

async function saveUsername(rawName){
  if(!S.uid){ toast('Login dulu untuk membuat username.'); return; }
  const name=(rawName||'').trim();
  if(!isValidUsername(name)){
    toast('Username 3-24 karakter, hanya huruf/angka/underscore/titik.','error');
    return;
  }
  try{
    if(!firestoreDbRef) throw new Error('Firestore belum siap. Coba lagi sebentar.');
    await firestoreDbRef.collection('profiles').doc(S.uid).set({
      username:name,
      email:(S.userProfile && S.userProfile.email) || '',
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });

    if(S.userProfile){ S.userProfile.username=name; S.userProfile.name=name; }
    updateUserProfileUI();
    toast('Username berhasil disimpan.','success');
  }catch(err){
    console.error('Save username error', err);
    toast('Gagal menyimpan username: '+(err.message||'coba lagi.'), 'error');
  }
}

const usernameDisplayRow=$('usernameDisplayRow');
const usernameEditRow=$('usernameEditRow');
const usernameInput=$('usernameInput');
const btnEditUsername=$('btnEditUsername');
const btnSaveUsername=$('btnSaveUsername');
const btnCancelUsername=$('btnCancelUsername');

function openUsernameEdit(){
  if(!S.uid){ toast('Login dulu untuk membuat username.'); return; }
  if(usernameInput) usernameInput.value=(S.userProfile && S.userProfile.username) || '';
  if(usernameDisplayRow) usernameDisplayRow.style.display='none';
  if(usernameEditRow) usernameEditRow.style.display='flex';
  if(usernameInput) usernameInput.focus();
}
function closeUsernameEdit(){
  if(usernameDisplayRow) usernameDisplayRow.style.display='flex';
  if(usernameEditRow) usernameEditRow.style.display='none';
}
if(btnEditUsername) btnEditUsername.addEventListener('click', openUsernameEdit);
if(btnCancelUsername) btnCancelUsername.addEventListener('click', closeUsernameEdit);
if(btnSaveUsername) btnSaveUsername.addEventListener('click', async ()=>{
  await saveUsername(usernameInput ? usernameInput.value : '');
  closeUsernameEdit();
});
if(usernameInput) usernameInput.addEventListener('keydown',(e)=>{
  if(e.key==='Enter'){ e.preventDefault(); btnSaveUsername && btnSaveUsername.click(); }
  else if(e.key==='Escape'){ closeUsernameEdit(); }
});

function subscribeCredits(uid){
  try{
    if(creditsWatchRef) creditsWatchRef.off();
    creditsWatchRef=firebaseDbRef.ref('users/'+uid+'/credits');
    creditsWatchRef.on('value',(snap)=>{
      S.credits = snap.exists() ? (Number(snap.val())||0) : 0;
      updateCreditsUI();
    },(err)=>{
      console.error('Credits listener error', err);
      // Surface this instead of leaving the credit pill stuck on "–" forever
      // with no explanation — a permission error here means Firebase Rules
      // are blocking this user from reading their own credits.
      const pill=$('creditCountText'); if(pill) pill.textContent='!';
      const hero=$('creditHeroNum'); if(hero) hero.textContent='!';
      const heroAcc=$('creditHeroNumAcc'); if(heroAcc) heroAcc.textContent='!';
    });
  }catch(err){
    console.error(err);
  }
}

function updateCreditsUI(){
  const text = S.credits===null ? '–' : String(S.credits);
  const pill=$('creditCountText'); if(pill) pill.textContent=text;
  const hero=$('creditHeroNum'); if(hero) hero.textContent=text;
  const heroAcc=$('creditHeroNumAcc'); if(heroAcc) heroAcc.textContent=text;
  const shLeft=$('shCreditsLeft'); if(shLeft) shLeft.textContent = S.credits===null ? '' : `(${S.credits} left)`;
}

async function getIdTokenSafe(){
  try{
    if(firebaseAuthRef && firebaseAuthRef.currentUser) return await firebaseAuthRef.currentUser.getIdToken();
  }catch(err){
    console.warn('getIdToken failed', err);
  }
  return null;
}

function openBuyCreditPage(){
  window.open(BUY_CREDIT_URL, '_blank', 'noopener');
}

/* ---- Credit Center modal ---- */
const creditCenterModal=$('creditCenterModal');
function openCreditCenter(){ creditCenterModal.classList.add('active'); refreshFreeUsageUI(); updateCreditsUI(); updateUserProfileUI(); }
function closeCreditCenter(){ creditCenterModal.classList.remove('active'); }
$('btnCreditCenter').addEventListener('click', openCreditCenter);
$('btnCloseCreditCenter').addEventListener('click', closeCreditCenter);
$('btnCloseCreditCenter2').addEventListener('click', closeCreditCenter);
creditCenterModal.addEventListener('click',(e)=>{ if(e.target===creditCenterModal) closeCreditCenter(); });
$('btnBuyCredit').addEventListener('click', openBuyCreditPage);
document.querySelectorAll('.credit-pkg').forEach(btn=>btn.addEventListener('click', openBuyCreditPage));

/* ---- Out of credit modal ---- */
const outOfCreditModal=$('outOfCreditModal');
function openOutOfCreditModal(){ outOfCreditModal.classList.add('active'); }
function closeOutOfCreditModal(){ outOfCreditModal.classList.remove('active'); }
$('btnBuyCreditFromModal').addEventListener('click',()=>{ openBuyCreditPage(); closeOutOfCreditModal(); });
$('btnCloseOutOfCredit').addEventListener('click', closeOutOfCreditModal);
outOfCreditModal.addEventListener('click',(e)=>{ if(e.target===outOfCreditModal) closeOutOfCreditModal(); });

/* ==========================================================================
   3d. APP-LEVEL NAVIGATION (Home / Project / Akun)
   ========================================================================== */
const appNav=$('appNav');
const PAGES=['home','project','account'];
function goToPage(name){
  if(PAGES.indexOf(name)===-1) name='home';
  PAGES.forEach(p=>{
    const el=$('page'+p.charAt(0).toUpperCase()+p.slice(1));
    if(el) el.classList.toggle('active', p===name);
  });
  if(appNav){
    appNav.querySelectorAll('.app-nav-btn').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.page===name);
    });
  }
  if(name==='project') renderProjectPage();
  if(name==='account'){ updateUserProfileUI(); updateCreditsUI(); refreshFreeUsageUI(); }
  // Lets separately-loaded modules (e.g. community.js) react to page changes
  // without this file needing to know anything about them.
  if(typeof window.onAppPageChange==='function'){
    try{ window.onAppPageChange(name); }catch(err){ console.error('onAppPageChange error', err); }
  }
}
if(appNav){
  appNav.querySelectorAll('.app-nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{ goToPage(btn.dataset.page); haptic(); });
  });
}

/* ---- Account page: reuse the same actions as Credit Center ---- */
const btnSignOutAccount=$('btnSignOutAccount');
if(btnSignOutAccount) btnSignOutAccount.addEventListener('click', signOutUser);
const btnBuyCreditAccount=$('btnBuyCreditAccount');
if(btnBuyCreditAccount) btnBuyCreditAccount.addEventListener('click', openBuyCreditPage);
const btnOpenSettingsAccount=$('btnOpenSettingsAccount');
if(btnOpenSettingsAccount) btnOpenSettingsAccount.addEventListener('click', ()=>openSettings());

/* ---- Copy my UID ---- */
const btnCopyUid=$('btnCopyUid');
if(btnCopyUid) btnCopyUid.addEventListener('click', async ()=>{
  if(!S.uid) return;
  try{
    await navigator.clipboard.writeText(S.uid);
    toast('UID disalin','success');
  }catch(err){
    // Fallback for browsers/webviews without Clipboard API permission
    try{
      const ta=document.createElement('textarea');
      ta.value=S.uid; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('UID disalin','success');
    }catch(err2){
      toast('Gagal menyalin UID','error');
    }
  }
});

/* ==========================================================================
   3f. ADMIN PANEL — add credit to any user by UID (visible only when the
   logged-in email is in ADMIN_EMAILS). The email check above only controls
   what the UI *shows*; the actual write is only safe if Firebase Realtime
   Database security rules also restrict writes to /users/$uid/credits to
   trusted admin UID(s) server-side. Without that rule change this button
   will simply fail with a permission error for non-admin accounts.
   ========================================================================== */
let adminFoundUid=null;
const adminTargetUidInput=$('adminTargetUid');
const adminCreditAmountInput=$('adminCreditAmount');
const btnAdminFindUser=$('btnAdminFindUser');
const btnAdminAddCredit=$('btnAdminAddCredit');
const adminUserFound=$('adminUserFound');
const adminFoundEmail=$('adminFoundEmail');
const adminFoundCredits=$('adminFoundCredits');
const adminFindStatus=$('adminFindStatus');
const adminAddStatus=$('adminAddStatus');

function setAdminFindStatus(msg,type){
  if(!adminFindStatus) return;
  adminFindStatus.textContent=msg||'';
  adminFindStatus.className='admin-status'+(type?' '+type:'');
}
function setAdminAddStatus(msg,type){
  if(!adminAddStatus) return;
  adminAddStatus.textContent=msg||'';
  adminAddStatus.className='admin-status'+(type?' '+type:'');
}
function resetAdminFoundUser(){
  adminFoundUid=null;
  if(adminUserFound) adminUserFound.style.display='none';
  if(btnAdminAddCredit) btnAdminAddCredit.disabled=true;
}

if(adminTargetUidInput) adminTargetUidInput.addEventListener('input', ()=>{
  resetAdminFoundUser();
  setAdminFindStatus(''); setAdminAddStatus('');
});

if(btnAdminFindUser) btnAdminFindUser.addEventListener('click', async ()=>{
  const uid=(adminTargetUidInput.value||'').trim();
  resetAdminFoundUser();
  setAdminAddStatus('');
  if(!uid){ setAdminFindStatus('Masukkan UID terlebih dahulu.','error'); return; }
  if(!firebaseDbRef){ setAdminFindStatus('Database belum siap. Coba lagi sebentar.','error'); return; }
  setBtnLoading(btnAdminFindUser, true, 'Cari');
  setAdminFindStatus('Mencari…');
  try{
    const snap=await firebaseDbRef.ref('users/'+uid).once('value');
    if(!snap.exists()){
      setAdminFindStatus('User dengan UID ini tidak ditemukan.','error');
      return;
    }
    const data=snap.val()||{};
    adminFoundUid=uid;
    if(adminFoundEmail) adminFoundEmail.textContent=data.email||'–';
    if(adminFoundCredits) adminFoundCredits.textContent=String(Number(data.credits)||0);
    if(adminUserFound) adminUserFound.style.display='block';
    setAdminFindStatus('User ditemukan.','success');
    if(btnAdminAddCredit) btnAdminAddCredit.disabled=false;
  }catch(err){
    console.error('Admin find user error', err);
    setAdminFindStatus('Gagal mencari user. Periksa izin akses database.','error');
  }finally{
    setBtnLoading(btnAdminFindUser, false, 'Cari');
  }
});

if(btnAdminAddCredit) btnAdminAddCredit.addEventListener('click', async ()=>{
  if(!adminFoundUid){ setAdminAddStatus('Cari user terlebih dahulu.','error'); return; }
  const amount=Math.floor(Number(adminCreditAmountInput.value));
  if(!amount || amount<=0){ setAdminAddStatus('Masukkan jumlah credit yang valid (angka positif).','error'); return; }
  if(!firebaseDbRef){ setAdminAddStatus('Database belum siap. Coba lagi sebentar.','error'); return; }
  setBtnLoading(btnAdminAddCredit, true, 'Tambah Credit');
  setAdminAddStatus('Menambahkan credit…');
  try{
    // Use a transaction instead of ServerValue.increment: it's supported by
    // every version of the compat SDK, works even if the "credits" field
    // doesn't exist yet, and gives us the final committed value directly —
    // no separate read-back needed, so we can tell for certain whether the
    // write actually landed on the server.
    const result=await firebaseDbRef.ref('users/'+adminFoundUid+'/credits')
      .transaction(current => (Number(current)||0) + amount);

    if(!result.committed){
      setAdminAddStatus('Perubahan tidak tersimpan di server (transaksi dibatalkan). Coba lagi.','error');
      return;
    }
    const newBalance=Number(result.snapshot.val())||0;
    if(adminFoundCredits) adminFoundCredits.textContent=String(newBalance);
    setAdminAddStatus(`Berhasil menambahkan ${amount} credit. Saldo sekarang: ${newBalance}.`,'success');
    toast('Credit berhasil ditambahkan','success');
    adminCreditAmountInput.value='';
  }catch(err){
    console.error('Admin add credit error', err);
    const detail = (err && (err.code || err.message)) || 'unknown error';
    setAdminAddStatus(`Gagal menambahkan credit (${detail}). Kemungkinan besar Firebase Rules belum mengizinkan UID admin ini menulis ke "credits".`,'error');
  }finally{
    setBtnLoading(btnAdminAddCredit, false, 'Tambah Credit');
  }
});

/* ==========================================================================
   3e. PROJECT HISTORY (localStorage — thumbnails of enhanced/exported photos)
   ========================================================================== */
const PROJECTS_KEY='photoEnhance.projects';
const PROJECTS_LIMIT=30;

function loadProjectsList(){
  try{
    const raw=localStorage.getItem(PROJECTS_KEY);
    const arr=raw?JSON.parse(raw):[];
    return Array.isArray(arr)?arr:[];
  }catch(err){ return []; }
}
function saveProjectsList(list){
  try{ localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)); }catch(err){ /* storage full/unavailable — ignore */ }
}

// Save a thumbnail + metadata record of a photo the user just finished
// exporting/downloading. Keeps only a small downsized preview (never the
// full-resolution file) to stay within localStorage limits.
function saveProjectRecord(sourceCanvas, filename){
  try{
    if(!sourceCanvas) return;
    const maxDim=360;
    const w=sourceCanvas.width, h=sourceCanvas.height;
    const scale=Math.min(1, maxDim/Math.max(w,h));
    const tw=Math.max(1,Math.round(w*scale)), th=Math.max(1,Math.round(h*scale));
    const thumb=document.createElement('canvas');
    thumb.width=tw; thumb.height=th;
    thumb.getContext('2d').drawImage(sourceCanvas,0,0,tw,th);
    const dataUrl=thumb.toDataURL('image/jpeg',0.72);

    const list=loadProjectsList();
    list.unshift({
      id:'p_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),
      name:filename||'photo',
      date:new Date().toISOString(),
      width:w, height:h,
      thumb:dataUrl
    });
    while(list.length>PROJECTS_LIMIT) list.pop();
    saveProjectsList(list);
  }catch(err){ console.warn('saveProjectRecord failed', err); }
}

function formatProjectDate(iso){
  try{
    const d=new Date(iso);
    return d.toLocaleDateString('id-ID',{day:'2-digit',month:'short'})+' · '+d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
  }catch(err){ return ''; }
}

function renderProjectPage(){
  const grid=$('projectGrid'), empty=$('projectEmpty');
  if(!grid||!empty) return;
  const list=loadProjectsList();
  if(!list.length){
    empty.style.display='flex';
    grid.style.display='none';
    grid.innerHTML='';
    return;
  }
  empty.style.display='none';
  grid.style.display='grid';
  grid.innerHTML=list.map(item=>`
    <div class="project-card" data-id="${item.id}">
      <img src="${item.thumb}" alt="${item.name}" loading="lazy">
      <button class="project-card-del" data-id="${item.id}" title="Hapus" aria-label="Hapus">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="project-card-info">
        <b>${item.name}</b>
        <span>${item.width}×${item.height} · ${formatProjectDate(item.date)}</span>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.project-card-del').forEach(btn=>{
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      deleteProject(btn.dataset.id);
    });
  });
}

function deleteProject(id){
  const list=loadProjectsList().filter(p=>p.id!==id);
  saveProjectsList(list);
  renderProjectPage();
}

const btnClearProjects=$('btnClearProjects');
if(btnClearProjects) btnClearProjects.addEventListener('click', ()=>{
  if(!loadProjectsList().length){ toast('Belum ada project.'); return; }
  saveProjectsList([]);
  renderProjectPage();
  toast('Semua project dihapus');
});

// ---- New Project button ----
const btnNewProject=$('btnNewProject');
if(btnNewProject) btnNewProject.addEventListener('click', ()=>{
  goToPage('home');
  toast('Buka foto baru untuk memulai project','success');
});

/* ==========================================================================
   4. PIXEL PROCESSING (shared with Web Worker via toString())
   ========================================================================== */
function px_clamp(v){return v<0?0:v>255?255:v;}

function px_boxBlur(data,w,h,radius){
  if(radius<=0) return data;
  const src=new Uint8ClampedArray(data);
  const tmp=new Uint8ClampedArray(data.length);
  const r=radius;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let rs=0,gs=0,bs=0,as=0,cnt=0;
      for(let k=-r;k<=r;k++){
        const xx=x+k;
        if(xx<0||xx>=w) continue;
        const idx=(y*w+xx)*4;
        rs+=src[idx];gs+=src[idx+1];bs+=src[idx+2];as+=src[idx+3];cnt++;
      }
      const o=(y*w+x)*4;
      tmp[o]=rs/cnt;tmp[o+1]=gs/cnt;tmp[o+2]=bs/cnt;tmp[o+3]=as/cnt;
    }
  }
  const out=new Uint8ClampedArray(data.length);
  for(let x=0;x<w;x++){
    for(let y=0;y<h;y++){
      let rs=0,gs=0,bs=0,as=0,cnt=0;
      for(let k=-r;k<=r;k++){
        const yy=y+k;
        if(yy<0||yy>=h) continue;
        const idx=(yy*w+x)*4;
        rs+=tmp[idx];gs+=tmp[idx+1];bs+=tmp[idx+2];as+=tmp[idx+3];cnt++;
      }
      const o=(y*w+x)*4;
      out[o]=rs/cnt;out[o+1]=gs/cnt;out[o+2]=bs/cnt;out[o+3]=as/cnt;
    }
  }
  return out;
}

function px_unsharpMask(data,w,h,amount){
  if(amount<=0) return data;
  const strength=amount/100;
  const radius=1;
  const blurred=px_boxBlur(data,w,h,radius);
  const out=new Uint8ClampedArray(data.length);
  for(let i=0;i<data.length;i+=4){
    out[i]=px_clamp(data[i]+(data[i]-blurred[i])*strength*2.2);
    out[i+1]=px_clamp(data[i+1]+(data[i+1]-blurred[i+1])*strength*2.2);
    out[i+2]=px_clamp(data[i+2]+(data[i+2]-blurred[i+2])*strength*2.2);
    out[i+3]=data[i+3];
  }
  return out;
}

function px_denoise(data,w,h,amount){
  if(amount<=0) return data;
  const raw=amount/100;
  const strength=raw<0?0:raw>1?1:raw;
  const radius=strength>0.6?2:1;
  const blurred=px_boxBlur(data,w,h,radius);
  const out=new Uint8ClampedArray(data.length);
  const mix=strength*0.85;
  for(let i=0;i<data.length;i+=4){
    out[i]=data[i]*(1-mix)+blurred[i]*mix;
    out[i+1]=data[i+1]*(1-mix)+blurred[i+1]*mix;
    out[i+2]=data[i+2]*(1-mix)+blurred[i+2]*mix;
    out[i+3]=data[i+3];
  }
  return out;
}

function px_adjust(data,settings){
  const brightness=settings.brightness||0;
  const contrast=settings.contrast||0;
  const contrastFactor=(259*(contrast+255))/(255*(259-contrast));
  const satMul=1+(settings.saturation||0)/100;
  const vib=(settings.vibrance||0)/100;
  const temp=settings.temperature||0;
  const highlights=(settings.highlights||0)/100;
  const shadows=(settings.shadows||0)/100;
  const gammaVal=settings.gamma||0;
  // gamma slider -100..100 -> exponent 0.1 (bright midtones) .. 1.9 (dark midtones)
  const gammaExp=1-(gammaVal/100)*0.9;
  const applyGamma=gammaVal!==0;
  const hueDeg=settings.hue||0;
  const applyHue=hueDeg!==0;
  let hm; // hue rotation matrix coefficients
  if(applyHue){
    const a=hueDeg*Math.PI/180, cosA=Math.cos(a), sinA=Math.sin(a);
    hm=[
      0.213+cosA*0.787-sinA*0.213, 0.715-cosA*0.715-sinA*0.715, 0.072-cosA*0.072+sinA*0.928,
      0.213-cosA*0.213+sinA*0.143, 0.715+cosA*0.285+sinA*0.140, 0.072-cosA*0.072-sinA*0.283,
      0.213-cosA*0.213-sinA*0.787, 0.715-cosA*0.715+sinA*0.715, 0.072+cosA*0.928+sinA*0.072
    ];
  }

  for(let i=0;i<data.length;i+=4){
    let r=data[i],g=data[i+1],b=data[i+2];
    r+=temp*0.55; b-=temp*0.55;
    r+=brightness; g+=brightness; b+=brightness;
    r=contrastFactor*(r-128)+128;
    g=contrastFactor*(g-128)+128;
    b=contrastFactor*(b-128)+128;
    const lum=0.299*r+0.587*g+0.114*b;
    if(shadows!==0){
      const m=Math.max(0,1-lum/128)*shadows*90;
      r+=m; g+=m; b+=m;
    }
    if(highlights!==0){
      const m=Math.max(0,(lum-128)/127)*highlights*90;
      r+=m; g+=m; b+=m;
    }
    if(applyGamma){
      r=255*Math.pow(Math.max(0,Math.min(255,r))/255,gammaExp);
      g=255*Math.pow(Math.max(0,Math.min(255,g))/255,gammaExp);
      b=255*Math.pow(Math.max(0,Math.min(255,b))/255,gammaExp);
    }
    const gray=0.299*r+0.587*g+0.114*b;
    r=gray+(r-gray)*satMul;
    g=gray+(g-gray)*satMul;
    b=gray+(b-gray)*satMul;
    if(vib!==0){
      const mx=Math.max(r,g,b),mn=Math.min(r,g,b);
      const sat=(mx-mn)/255;
      const boost=(1-sat)*vib;
      r=gray+(r-gray)*(1+boost);
      g=gray+(g-gray)*(1+boost);
      b=gray+(b-gray)*(1+boost);
    }
    if(applyHue){
      const rr=r*hm[0]+g*hm[1]+b*hm[2];
      const gg=r*hm[3]+g*hm[4]+b*hm[5];
      const bb=r*hm[6]+g*hm[7]+b*hm[8];
      r=rr; g=gg; b=bb;
    }
    data[i]=px_clamp(r);data[i+1]=px_clamp(g);data[i+2]=px_clamp(b);
  }
  return data;
}

function px_pipeline(imageDataLike,settings){
  const w=imageDataLike.width,h=imageDataLike.height;
  let data=imageDataLike.data;
  data=px_adjust(data,settings);
  if(settings.denoise>0) data=px_denoise(data,w,h,settings.denoise);
  if(settings.faceDetail) data=px_unsharpMask(data,w,h,18);
  if(settings.sharpen>0) data=px_unsharpMask(data,w,h,settings.sharpen);
  return {data,width:w,height:h};
}

/* ==========================================================================
   5. WEB WORKER
   ========================================================================== */
function buildWorker(){
  try{
    const src = `
      self.onmessage = function(e){
        const {data,width,height,settings} = e.data;
        ${px_clamp.toString()}
        ${px_boxBlur.toString()}
        ${px_unsharpMask.toString()}
        ${px_denoise.toString()}
        ${px_adjust.toString()}
        ${px_pipeline.toString()}
        try{
          const result = px_pipeline({data:new Uint8ClampedArray(data), width, height}, settings);
          self.postMessage({ok:true, data:result.data, width:result.width, height:result.height}, [result.data.buffer]);
        }catch(err){
          self.postMessage({ok:false, error:String(err)});
        }
      };
    `;
    const blob=new Blob([src],{type:'application/javascript'});
    return new Worker(URL.createObjectURL(blob));
  }catch(err){
    console.warn('Worker unavailable, falling back to main thread.',err);
    return null;
  }
}

function processWithWorker(imageData,settings){
  return new Promise((resolve,reject)=>{
    if(!S.worker || !S.prefs.hwAccel){
      try{
        const result=px_pipeline({data:new Uint8ClampedArray(imageData.data),width:imageData.width,height:imageData.height},settings);
        resolve(new ImageData(new Uint8ClampedArray(result.data),result.width,result.height));
      }catch(err){reject(err);}
      return;
    }
    let settled=false;
    // Safety net: on some (mostly low-end Android) devices a Worker can be
    // silently killed by the OS/browser under memory pressure — no error
    // event fires, it just never posts back. Without a timeout the export
    // would hang forever at "Menerapkan enhancement...". If that happens,
    // rebuild the worker and finish the job on the main thread instead.
    const timeoutMs=20000;
    const timer=setTimeout(()=>{
      if(settled) return;
      settled=true;
      S.worker.removeEventListener('message',handle);
      console.warn('Worker timed out after '+timeoutMs+'ms — falling back to main thread.');
      try{ S.worker.terminate(); }catch(e){}
      S.worker=buildWorker();
      try{
        const result=px_pipeline({data:new Uint8ClampedArray(imageData.data),width:imageData.width,height:imageData.height},settings);
        resolve(new ImageData(new Uint8ClampedArray(result.data),result.width,result.height));
      }catch(err){reject(err);}
    },timeoutMs);
    const handle=(e)=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      S.worker.removeEventListener('message',handle);
      if(e.data.ok){
        resolve(new ImageData(new Uint8ClampedArray(e.data.data),e.data.width,e.data.height));
      }else{
        reject(new Error(e.data.error||'Worker error'));
      }
    };
    S.worker.addEventListener('message',handle);
    S.worker.addEventListener('error',(err)=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      S.worker.removeEventListener('message',handle);
      console.warn('Worker error — falling back to main thread.',err);
      try{ S.worker.terminate(); }catch(e){}
      S.worker=buildWorker();
      try{
        const result=px_pipeline({data:new Uint8ClampedArray(imageData.data),width:imageData.width,height:imageData.height},settings);
        resolve(new ImageData(new Uint8ClampedArray(result.data),result.width,result.height));
      }catch(err2){reject(err2);}
    },{once:true});
    const copy=new Uint8ClampedArray(imageData.data);
    S.worker.postMessage({data:copy,width:imageData.width,height:imageData.height,settings},[copy.buffer]);
  });
}

/* ==========================================================================
   6. FILE HANDLING
   ========================================================================== */
const MAX_SOURCE_DIM=8192;
const MAX_PREVIEW_DIM=1100;
const LARGE_IMAGE_MP=24;

function pickFile(){ fileInput.click(); }

fileInput.addEventListener('change',(e)=>{
  const f=e.target.files && e.target.files[0];
  if(f) handleFile(f);
  fileInput.value='';
});

function handleFile(file){
  try{
    // Accept any image type the browser itself is willing to decode
    // (JPG, PNG, WEBP, GIF, BMP, AVIF, and HEIC/HEIF on browsers that
    // support it, etc.) instead of a hardcoded whitelist. If the browser
    // can't actually decode the file, img.onerror below catches it with a
    // clear message rather than silently failing.
    if(file.type && !/^image\//.test(file.type)){
      toast('File ini bukan gambar. Pilih file foto (JPG, PNG, WEBP, HEIC, dll).','error');
      return;
    }
    if(file.size>60*1024*1024){
      toast('File terlalu besar (maks 60MB).','error');
      return;
    }
    const reader=new FileReader();
    reader.onerror=()=>toast('Gagal membaca file. Coba foto lain.','error');
    reader.onload=(ev)=>{
      const img=new Image();
      img.onerror=()=>toast('Format gambar ini tidak bisa dibuka oleh browser kamu. Coba convert ke JPG/PNG dulu.','error');
      img.onload=()=>{
        try{ loadImage(img,file); }
        catch(err){ console.error(err); toast('Gagal memproses gambar ini.','error'); }
      };
      img.src=ev.target.result;
    };
    reader.readAsDataURL(file);
  }catch(err){
    console.error(err);
    toast('Terjadi kesalahan saat membuka file.','error');
  }
}

function loadImage(img,file){
  S.file=file;
  let w=img.naturalWidth, h=img.naturalHeight;
  if(!w||!h){ toast('Gambar tidak valid.','error'); return; }

  const mp=(w*h)/1e6;
  if(mp>LARGE_IMAGE_MP){
    warnText.textContent='Large image detected. Processing may take longer on this device.';
    warnBanner.classList.add('active');
  } else {
    warnBanner.classList.remove('active');
  }

  let scaleCap=1;
  if(Math.max(w,h)>MAX_SOURCE_DIM){ scaleCap=MAX_SOURCE_DIM/Math.max(w,h); }
  const srcW=Math.round(w*scaleCap), srcH=Math.round(h*scaleCap);

  const oc=document.createElement('canvas');
  oc.width=srcW; oc.height=srcH;
  const octx=oc.getContext('2d');
  octx.imageSmoothingEnabled=true; octx.imageSmoothingQuality='high';
  octx.drawImage(img,0,0,srcW,srcH);
  S.originalCanvas=oc;
  S.origWidth=srcW; S.origHeight=srcH;
  S.settings.aspectRatio=null;

  let pScale=1;
  if(Math.max(srcW,srcH)>MAX_PREVIEW_DIM) pScale=MAX_PREVIEW_DIM/Math.max(srcW,srcH);
  const pw=Math.max(1,Math.round(srcW*pScale)), ph=Math.max(1,Math.round(srcH*pScale));
  const pc=document.createElement('canvas');
  pc.width=pw; pc.height=ph;
  const pctx=pc.getContext('2d');
  pctx.imageSmoothingEnabled=true; pctx.imageSmoothingQuality='high';
  pctx.drawImage(oc,0,0,pw,ph);
  S.previewCanvas=pc;

  S.settings={...defaultSettings};
  S.history=[cloneSettings(S.settings)];
  S.historyIndex=0;
  S.textLayers=[]; S.mosaicLayers=[]; S.stickerLayers=[];
  if(layerHandlesEl) layerHandlesEl.innerHTML='';
  setQuickCompare(false);
  S.baMode='after';
  applyBaMode();
  runNewPhotoHooks(); // let community.js clear its overlay layers / applied-preset state

  emptyState.style.display='none';
  viewport.classList.add('active');
  bottomTabs.classList.add('active');
  infoStrip.classList.add('active');

  infoOrigRes.textContent=`${w} × ${h}`;
  updateOutputResInfo();
  infoFileSize.textContent=formatBytes(file.size);

  fitToScreen();
  renderPreview(true);
  updateUndoRedoButtons();

  if(S.prefs.autoOnLoad){ setTimeout(autoEnhance,200); }
  toast('Foto berhasil dimuat','success');
  runPhotoReadyHooks(); // let community.js apply a pending "use template" preset/overlay, if any
}

['dragenter','dragover'].forEach(ev=>{
  stage.addEventListener(ev,(e)=>{ e.preventDefault(); dropHint.classList.add('active'); });
});
['dragleave','drop'].forEach(ev=>{
  stage.addEventListener(ev,(e)=>{ e.preventDefault(); if(ev==='drop'){ const f=e.dataTransfer.files[0]; if(f) handleFile(f); } dropHint.classList.remove('active'); });
});

/* ==========================================================================
   7. RENDER PIPELINE
   ========================================================================== */
function updateOutputResInfo(){
  const factor=S.settings.scale;
  let ow=S.origWidth*factor, oh=S.origHeight*factor;
  if(S.settings.aspectRatio){
    const ratioW=S.settings.aspectRatio.width;
    const ratioH=S.settings.aspectRatio.height;
    const currentRatio=ow/oh;
    const targetRatio=ratioW/ratioH;
    if(targetRatio>currentRatio){
      ow=oh*targetRatio;
    }else{
      oh=ow/targetRatio;
    }
  }
  infoOutRes.textContent=`${Math.round(ow)} × ${Math.round(oh)}`;
}

function sizeCanvasesToPreview(){
  const pc=S.previewCanvas;
  canvasBefore.width=pc.width; canvasBefore.height=pc.height;
  canvasAfter.width=pc.width; canvasAfter.height=pc.height;
  canvasHolder.style.width=pc.width+'px';
  canvasHolder.style.height=pc.height+'px';
}

let quickRenderQueued=false;
let previewWorkerBusy=false;
let previewWorkerDirty=false;
function renderPreview(force){
  if(!S.previewCanvas) return;
  if(canvasBefore.width!==S.previewCanvas.width) sizeCanvasesToPreview();

  ctxBefore.clearRect(0,0,canvasBefore.width,canvasBefore.height);
  ctxBefore.drawImage(S.previewCanvas,0,0);

  if(quickRenderQueued && !force) return;
  quickRenderQueued=true;
  requestAnimationFrame(()=>{
    quickRenderQueued=false;
    runPreviewPipeline();
  });
  updateOutputResInfo();
}

// Mirrors the current after-canvas into the small thumbnail that lives
// inside the tool sheet, so people always have a live, unobstructed view
// of what their adjustment looks like — even while the sheet covers most
// of the screen. Uses a "cover" fit (scaled + center-cropped) so the
// thumbnail always fills its box without distorting the photo.
function updateSheetLivePreview(){
  if(!sheetLivePreviewCanvas || !sheetLivePreviewWrap) return;
  if(!S.previewCanvas || !canvasAfter.width || !canvasAfter.height) return;
  const cw=sheetLivePreviewWrap.clientWidth||300, ch=sheetLivePreviewWrap.clientHeight||118;
  if(cw<=0||ch<=0) return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const targetW=Math.round(cw*dpr), targetH=Math.round(ch*dpr);
  if(sheetLivePreviewCanvas.width!==targetW) sheetLivePreviewCanvas.width=targetW;
  if(sheetLivePreviewCanvas.height!==targetH) sheetLivePreviewCanvas.height=targetH;
  const ctx=sheetLivePreviewCanvas.getContext('2d');
  const srcW=canvasAfter.width, srcH=canvasAfter.height;
  const scale=Math.max(targetW/srcW, targetH/srcH);
  const dw=srcW*scale, dh=srcH*scale;
  const dx=(targetW-dw)/2, dy=(targetH-dh)/2;
  ctx.clearRect(0,0,targetW,targetH);
  ctx.drawImage(canvasAfter,dx,dy,dw,dh);
}

// Runs the (potentially expensive) pixel pipeline off the main thread via
// the same Worker used for export, instead of blocking the UI thread on
// every slider tick. If a new edit comes in while a worker job is still
// running, we don't queue it — we just mark "dirty" and re-run once with
// whatever the latest settings are when the current job finishes. This
// keeps slider dragging smooth instead of piling up a backlog of stale
// frames on slow/mobile devices.
function runPreviewPipeline(){
  if(!S.previewCanvas) return;
  if(previewWorkerBusy){ previewWorkerDirty=true; return; }
  previewWorkerBusy=true;
  try{
    const srcCtx=S.previewCanvas.getContext('2d');
    const imgData=srcCtx.getImageData(0,0,S.previewCanvas.width,S.previewCanvas.height);
    const settingsSnapshot={...S.settings};
    processWithWorker(imgData,settingsSnapshot).then(resultImageData=>{
      ctxAfter.putImageData(resultImageData,0,0);
      // Let community.js draw overlay layers on top of the live preview
      // (fire-and-forget — this is just the interactive preview, export
      // below awaits the same hooks so the final file is always correct).
      runOverlayHooks(ctxAfter, canvasAfter.width, canvasAfter.height, false);
      updateSheetLivePreview();
    }).catch(err=>{
      console.error('Render error',err);
    }).finally(()=>{
      previewWorkerBusy=false;
      if(previewWorkerDirty){
        previewWorkerDirty=false;
        runPreviewPipeline();
      }
    });
  }catch(err){
    previewWorkerBusy=false;
    console.error('Render error',err);
  }
}

/* ==========================================================================
   8. BEFORE / AFTER COMPARE SLIDER
   ==========================================================================
   Three ways to compare, all built on the same S.compare ratio + the same
   yellow divider line (never removed from the DOM, only shown/hidden):

   1. Before/After toggle (btnBeforeAfter) — flips between a full "After"
      view and a full "Before" view with one tap. No dragging needed.
   2. Quick Compare (btnQuickCompare) — reveals the draggable yellow divider
      + handle for a manual side-by-side split, for when the person wants
      fine control. Tapping again hides it and returns to the Before/After
      full view.
   3. Hold to Compare (btnHoldCompare) — press & hold to peek at the
      original, unrelated to the divider.
   ========================================================================== */
function setCompare(ratio){
  S.compare=clamp(ratio,0,1);
  canvasAfter.style.clipPath=`inset(0 0 0 ${S.compare*100}%)`;
  compareDivider.style.left=(S.compare*100)+'%';
  compareHandle.style.left=(S.compare*100)+'%';
}
setCompare(0); // default view: full "After" (edited) result, divider hidden

let dragging=false;
function pointerToRatio(clientX){
  const rect=canvasHolder.getBoundingClientRect();
  return (clientX-rect.left)/rect.width;
}
compareHandle.addEventListener('pointerdown',(e)=>{ dragging=true; compareHandle.setPointerCapture(e.pointerId); });
window.addEventListener('pointermove',(e)=>{ if(!dragging) return; setCompare(pointerToRatio(e.clientX)); });
window.addEventListener('pointerup',()=>{ dragging=false; });
canvasHolder.addEventListener('pointerdown',(e)=>{

  if(e.target === compareHandle || e.target.closest('.layer-handle')){
    return;
  }

  // The divider can only be repositioned by tapping the photo while
  // Quick Compare is actively showing it — otherwise a tap on the photo
  // shouldn't silently move a hidden line.
  if(!S.quickCompareActive){
    return;
  }

  /*
   * Jika foto sedang di-zoom,
   * jangan ubah divider.
   * Gesture digunakan untuk pan.
   */

  if(S.zoom > S.fitZoom * 1.001){
    return;
  }

  setCompare(
    pointerToRatio(e.clientX)
  );

});

const holdBtn=$('btnHoldCompare');
function showOriginal(show){
  canvasAfter.style.visibility=show?'hidden':'visible';
  holdBtn.classList.toggle('pressed',show);
}
holdBtn.addEventListener('pointerdown',(e)=>{ e.stopPropagation(); showOriginal(true); });
holdBtn.addEventListener('pointerup',()=>showOriginal(false));
holdBtn.addEventListener('pointerleave',()=>showOriginal(false));
holdBtn.addEventListener('pointercancel',()=>showOriginal(false));

/* ---- Before/After full-view toggle ------------------------------------- */
const beforeAfterBtn=$('btnBeforeAfter'), baToggleLabel=$('baToggleLabel'), afterTag=$('afterTag'), beforeTag=$('beforeTag');
function applyBaMode(){
  // Full-view mode always wins over whatever ratio Quick Compare left
  // behind, so a single tap reliably shows 100% Before or 100% After.
  setCompare(S.baMode==='before' ? 1 : 0);
  baToggleLabel.textContent = S.baMode==='before' ? 'Before' : 'After';
  beforeAfterBtn.classList.toggle('active', S.baMode==='before');
  if(afterTag) afterTag.style.opacity = S.baMode==='before' ? '0' : '1';
  if(beforeTag) beforeTag.style.opacity = S.baMode==='before' ? '1' : '0';
}
beforeAfterBtn.addEventListener('click',()=>{
  if(!S.previewCanvas){ toast('Pilih foto terlebih dahulu.'); return; }
  // Switching modes implies the person wants the full view again, not the
  // manual split — so Quick Compare turns itself off.
  if(S.quickCompareActive) setQuickCompare(false);
  S.baMode = S.baMode==='before' ? 'after' : 'before';
  applyBaMode();
  haptic();
});

/* ---- Quick Compare — reveal the yellow divider on demand --------------- */
const quickCompareBtn=$('btnQuickCompare');
function setQuickCompare(active){
  S.quickCompareActive=active;
  compareDivider.classList.toggle('active',active);
  compareHandle.classList.toggle('active',active);
  quickCompareBtn.classList.toggle('active',active);
  if(active){
    setCompare(0.5);
    if(afterTag) afterTag.style.opacity='1';
    if(beforeTag) beforeTag.style.opacity='1';
  }else{
    applyBaMode();
  }
}
quickCompareBtn.addEventListener('click',()=>{
  if(!S.previewCanvas){ toast('Pilih foto terlebih dahulu.'); return; }
  setQuickCompare(!S.quickCompareActive);
  haptic();
});
applyBaMode();

/* ==========================================================================
   9. ZOOM / PAN
   ========================================================================== */
/* ==========================================================================
   9. ZOOM / PAN — GOOGLE PHOTOS / CAPCUT STYLE
   ========================================================================== */

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

const pointers = new Map();

let gestureMode = 'none';

let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

let pinchStartDistance = 0;
let pinchStartZoom = 1;

let pinchStartCenterX = 0;
let pinchStartCenterY = 0;

let pinchStartPanX = 0;
let pinchStartPanY = 0;


/* ---------------------------------------------------------
   TRANSFORM
--------------------------------------------------------- */

function applyTransform(){

  canvasHolder.style.transform =
    `translate3d(${S.panX}px, ${S.panY}px, 0) scale(${S.zoom})`;

  const percent =
    S.fitZoom > 0
      ? Math.round((S.zoom / S.fitZoom) * 100)
      : 100;

  infoZoom.textContent = percent + '%';
}


/* ---------------------------------------------------------
   GET POINTER CENTER
--------------------------------------------------------- */

function getPointerCenter(){

  const pts = [...pointers.values()];

  if(pts.length < 2) return null;

  return {
    x:(pts[0].x + pts[1].x) / 2,
    y:(pts[0].y + pts[1].y) / 2
  };
}


/* ---------------------------------------------------------
   GET PINCH DISTANCE
--------------------------------------------------------- */

function getPointerDistance(){

  const pts = [...pointers.values()];

  if(pts.length < 2) return 0;

  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;

  return Math.hypot(dx,dy);
}


/* ---------------------------------------------------------
   CLAMP PAN
--------------------------------------------------------- */

function clampPan(){

  if(!S.previewCanvas) return;

  const rect = canvasHolder.getBoundingClientRect();

  const viewportRect = viewport.getBoundingClientRect();

  const viewportWidth = viewportRect.width;
  const viewportHeight = viewportRect.height;

  const imageWidth = rect.width;
  const imageHeight = rect.height;

  /*
   * Allow the image to move enough so the user can
   * inspect the edges, but prevent it from disappearing
   * completely.
   */

  const maxX = Math.max(
    0,
    (imageWidth - viewportWidth) / 2 + viewportWidth * 0.25
  );

  const maxY = Math.max(
    0,
    (imageHeight - viewportHeight) / 2 + viewportHeight * 0.25
  );

  S.panX = clamp(S.panX,-maxX,maxX);
  S.panY = clamp(S.panY,-maxY,maxY);
}


/* ---------------------------------------------------------
   APPLY ZOOM AROUND A POINT
   --------------------------------------------------------- */

function zoomAtPoint(newZoom, clientX, clientY){

  const oldZoom = S.zoom;

  newZoom = clamp(
    newZoom,
    MIN_ZOOM,
    MAX_ZOOM
  );

  if(Math.abs(newZoom-oldZoom) < 0.00001){
    return;
  }

  /*
   * Convert screen position into coordinates relative
   * to the center of the transformed image.
   */

  const viewportRect =
    viewport.getBoundingClientRect();

  const centerX =
    viewportRect.left + viewportRect.width / 2;

  const centerY =
    viewportRect.top + viewportRect.height / 2;

  const localX =
    (clientX - centerX - S.panX) / oldZoom;

  const localY =
    (clientY - centerY - S.panY) / oldZoom;

  /*
   * Keep the same image point underneath the fingers.
   */

  S.zoom = newZoom;

  S.panX =
    (clientX - centerX) -
    localX * newZoom;

  S.panY =
    (clientY - centerY) -
    localY * newZoom;

  clampPan();

  applyTransform();
}


/* ---------------------------------------------------------
   FIT TO SCREEN
--------------------------------------------------------- */

function fitToScreen(){

  if(!S.previewCanvas) return;

  const vw = viewport.clientWidth - 32;
  const vh = viewport.clientHeight - 32;

  const scale = Math.min(
    vw / S.previewCanvas.width,
    vh / S.previewCanvas.height,
    1.6
  );

  S.fitZoom = scale;

  S.zoom = scale;

  S.panX = 0;
  S.panY = 0;

  applyTransform();
}


/* ---------------------------------------------------------
   BUTTON ZOOM
--------------------------------------------------------- */

$('btnFit').addEventListener('click',()=>{

  fitToScreen();

  haptic();

});


$('btn100').addEventListener('click',()=>{

  /*
   * 100% = actual preview canvas size.
   */

  const center =
    viewport.getBoundingClientRect();

  zoomAtPoint(
    1,
    center.left + center.width / 2,
    center.top + center.height / 2
  );

  haptic();

});


$('btnZoomIn').addEventListener('click',()=>{

  const rect =
    viewport.getBoundingClientRect();

  zoomAtPoint(
    S.zoom * 1.25,
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );

  haptic();

});


$('btnZoomOut').addEventListener('click',()=>{

  const rect =
    viewport.getBoundingClientRect();

  zoomAtPoint(
    S.zoom / 1.25,
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );

  haptic();

});

/* ---------------------------------------------------------
   STAY — lock the photo so pan/pinch drag doesn't move it
--------------------------------------------------------- */

const btnStayLock=$('btnStayLock');
btnStayLock.addEventListener('click',()=>{
  S.stayLocked = !S.stayLocked;
  btnStayLock.classList.toggle('active', S.stayLocked);
  btnStayLock.title = S.stayLocked
    ? 'Lepas kunci posisi foto'
    : 'Kunci posisi foto (Stay) — foto tidak ikut jari saat digeser';
  toast(S.stayLocked ? 'Foto dikunci — tidak akan ikut geseran jari.' : 'Kunci foto dilepas.');
  haptic();
});


/* ---------------------------------------------------------
   POINTER DOWN
--------------------------------------------------------- */

viewport.addEventListener('pointerdown',(e)=>{

  /*
   * Don't interfere with compare handle.
   */

  if(e.target === compareHandle){
    return;
  }

  /*
   * Don't interfere with buttons.
   */

  if(e.target.closest('button')){
    return;
  }

  if(e.target.closest('.layer-handle')){
    return;
  }

  pointers.set(e.pointerId,{
    x:e.clientX,
    y:e.clientY
  });

  viewport.setPointerCapture?.(e.pointerId);

  /*
   * "Stay" lock — the photo stays put and ignores pan/pinch drag
   * gestures entirely (e.g. while positioning a mosaic/sticker).
   * Zoom buttons and wheel-zoom still work.
   */

  if(S.stayLocked){
    gestureMode = 'none';
    return;
  }


  /* =========================
     TWO FINGER PINCH
  ========================= */

  if(pointers.size === 2){

    gestureMode = 'pinch';

    const center = getPointerCenter();

    pinchStartCenterX = center.x;
    pinchStartCenterY = center.y;

    pinchStartDistance =
      getPointerDistance();

    pinchStartZoom = S.zoom;

    pinchStartPanX = S.panX;
    pinchStartPanY = S.panY;

    return;
  }


  /* =========================
     ONE FINGER PAN
  ========================= */

  if(pointers.size === 1){

    /*
     * Only pan when zoomed beyond fit.
     *
     * At fit zoom, normal tap can still be
     * used for the Before/After slider.
     */

    if(S.zoom > S.fitZoom * 1.001){

      gestureMode = 'pan';

      panStartX = e.clientX;
      panStartY = e.clientY;

      panOriginX = S.panX;
      panOriginY = S.panY;

      canvasHolder.style.cursor = 'grabbing';

    }else{

      gestureMode = 'none';

    }

  }

},{passive:false});


/* ---------------------------------------------------------
   POINTER MOVE
--------------------------------------------------------- */

viewport.addEventListener('pointermove',(e)=>{

  if(!pointers.has(e.pointerId)){
    return;
  }

  pointers.set(e.pointerId,{
    x:e.clientX,
    y:e.clientY
  });


  /* =========================
     PINCH
  ========================= */

  if(
    gestureMode === 'pinch' &&
    pointers.size >= 2
  ){

    e.preventDefault();

    const center =
      getPointerCenter();

    const distance =
      getPointerDistance();

    if(!distance || !pinchStartDistance){
      return;
    }


    /*
     * Calculate zoom from pinch distance.
     */

    const newZoom =
      pinchStartZoom *
      (distance / pinchStartDistance);


    /*
     * Calculate movement of the pinch center.
     *
     * This makes the whole image move when the
     * two fingers move together.
     */

    const centerDX =
      center.x - pinchStartCenterX;

    const centerDY =
      center.y - pinchStartCenterY;


    /*
     * Zoom around the original pinch center.
     */

    const viewportRect =
      viewport.getBoundingClientRect();

    const viewportCenterX =
      viewportRect.left +
      viewportRect.width / 2;

    const viewportCenterY =
      viewportRect.top +
      viewportRect.height / 2;


    const oldZoom = pinchStartZoom;

    const localX =
      (
        pinchStartCenterX -
        viewportCenterX -
        pinchStartPanX
      ) / oldZoom;

    const localY =
      (
        pinchStartCenterY -
        viewportCenterY -
        pinchStartPanY
      ) / oldZoom;


    S.zoom =
      clamp(
        newZoom,
        MIN_ZOOM,
        MAX_ZOOM
      );


    S.panX =
      (
        pinchStartCenterX +
        centerDX -
        viewportCenterX
      ) -
      localX * S.zoom;


    S.panY =
      (
        pinchStartCenterY +
        centerDY -
        viewportCenterY
      ) -
      localY * S.zoom;


    clampPan();

    applyTransform();

    return;
  }


  /* =========================
     ONE FINGER PAN
  ========================= */

  if(
    gestureMode === 'pan' &&
    pointers.size === 1
  ){

    e.preventDefault();

    const dx =
      e.clientX - panStartX;

    const dy =
      e.clientY - panStartY;


    S.panX =
      panOriginX + dx;

    S.panY =
      panOriginY + dy;


    clampPan();

    applyTransform();

  }

},{passive:false});


/* ---------------------------------------------------------
   POINTER UP
--------------------------------------------------------- */

function endPointer(e){

  pointers.delete(e.pointerId);

  try{
    viewport.releasePointerCapture?.(e.pointerId);
  }catch(err){}


  /*
   * When pinch ends with one finger still touching,
   * continue seamlessly into pan.
   */

  if(pointers.size === 1){

    const remaining =
      [...pointers.values()][0];

    if(!S.stayLocked && S.zoom > S.fitZoom * 1.001){

      gestureMode = 'pan';

      panStartX = remaining.x;
      panStartY = remaining.y;

      panOriginX = S.panX;
      panOriginY = S.panY;

      canvasHolder.style.cursor =
        'grabbing';

    }

    return;
  }


  if(pointers.size === 0){

    gestureMode = 'none';

    canvasHolder.style.cursor =
      'grab';

  }

}


viewport.addEventListener(
  'pointerup',
  endPointer
);

viewport.addEventListener(
  'pointercancel',
  endPointer
);

viewport.addEventListener(
  'pointerleave',
  (e)=>{
    /*
     * Don't cancel while the pointer is captured.
     */
    if(!viewport.hasPointerCapture?.(e.pointerId)){
      endPointer(e);
    }
  }
);


/* ---------------------------------------------------------
   WHEEL ZOOM — DESKTOP
--------------------------------------------------------- */

viewport.addEventListener('wheel',(e)=>{

  if(!S.previewCanvas){
    return;
  }

  e.preventDefault();

  const factor =
    e.deltaY < 0
      ? 1.12
      : 1 / 1.12;

  zoomAtPoint(
    S.zoom * factor,
    e.clientX,
    e.clientY
  );

},{passive:false});

/* ==========================================================================
   10. SLIDERS / TOOL SHEET UI
   ========================================================================== */
function cloneSettings(s){ return JSON.parse(JSON.stringify(s)); }

function slider(id,label,min,max,key,step){
  step=step||1;
  const v=S.settings[key];
  const fillPct=((v-min)/(max-min))*100;
  return `
    <div class="control-row">
      <div class="control-label"><b>${label}</b><span class="val" id="val_${key}">${v}</span></div>
      <input type="range" id="slider_${key}" min="${min}" max="${max}" step="${step}" value="${v}" style="--fill:${fillPct}%">
    </div>`;
}

function wireSlider(key,onInput){
  const el=$('slider_'+key);
  if(!el) return;
  el.addEventListener('input',()=>{
    const v=parseFloat(el.value);
    S.settings[key]=v;
    $('val_'+key).textContent=v;
    const pct=((v-el.min)/(el.max-el.min))*100;
    el.style.setProperty('--fill',pct+'%');
    if(onInput) onInput(v);
    renderPreview(false);
    haptic();
  });
  el.addEventListener('change',()=>{ pushHistory(); });
}

const TABS={
  auto:{title:'Auto Enhance', render:renderAutoTab},
  upscale:{title:'Upscale & Aspect Ratio', render:renderUpscaleTab},
  detail:{title:'Sharpen & Denoise', render:renderDetailTab},
  color:{title:'Color Enhance', render:renderColorTab},
  filter:{title:'Filters', render:renderFilterTab},
  face:{title:'Face Detail', render:renderFaceTab},
  edit:{title:'Text & Mosaic', render:renderEditTab},
  export:{title:'Export', render:renderExportTab},
};

function openSheet(tabKey){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tabKey));
  sheetTitle.textContent=TABS[tabKey].title;
  TABS[tabKey].render();
  toolSheet.classList.add('active');
  sheetBackdrop.classList.add('active');
  requestAnimationFrame(updateSheetLivePreview);
  // Layer drag-handles (mosaic/sticker) only make sense while the
  // Text & Mosaic (Edit) sheet is open.
  if(tabKey==='edit'){
    layerHandlesEl.classList.add('active');
    renderLayerHandles();
  }else{
    layerHandlesEl.classList.remove('active');
  }
  haptic();
}
function closeSheet(){
  toolSheet.classList.remove('active');
  sheetBackdrop.classList.remove('active');
  layerHandlesEl.classList.remove('active');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
}
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    if(!S.previewCanvas){ toast('Pilih foto terlebih dahulu.'); return; }
    if(toolSheet.classList.contains('active') && btn.classList.contains('active')){ closeSheet(); return; }
    openSheet(btn.dataset.tab);
  });
});
$('btnCloseSheet').addEventListener('click',closeSheet);
sheetBackdrop.addEventListener('click',closeSheet);

/* ---- AUTO TAB ---- */
function renderAutoTab(){
  sheetBody.innerHTML=`
    <button class="auto-btn" id="btnAutoEnhance">
      <svg viewBox="0 0 24 24" fill="none"><path d="m12 3 1.9 4.5L18 9.3l-4.1 1.8L12 15.5l-1.9-4.4L6 9.3l4.1-1.8L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
      Auto Enhance
    </button>
    <p style="font-size:12px;color:var(--text-dim);line-height:1.5;margin:10px 2px 0;">
      Menganalisis foto dan menyeimbangkan pencahayaan, kontras, warna, ketajaman, dan noise secara otomatis dengan hasil yang tetap natural.
    </p>
    <div class="control-row" style="margin-top:16px;">
      <div class="control-label"><b>Preset Cepat</b></div>
      <div class="chip-row">
        <button class="chip" id="chipCompareOriginal">Lihat Original</button>
        <button class="chip" id="chipUndoAuto">Undo Terakhir</button>
      </div>
    </div>`;
  $('btnAutoEnhance').addEventListener('click',autoEnhance);
  $('chipCompareOriginal').addEventListener('click',()=>{
    if(S.quickCompareActive) setQuickCompare(false);
    S.baMode='before'; applyBaMode();
  });
  $('chipUndoAuto').addEventListener('click',undo);
}

function sampleLuminanceStats(){
  const c=S.previewCanvas, ctx=c.getContext('2d');
  const data=ctx.getImageData(0,0,c.width,c.height).data;
  let sum=0,count=0,min=255,max=0;
  const step=16;
  for(let i=0;i<data.length;i+=step){
    const lum=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    sum+=lum; count++;
    if(lum<min)min=lum; if(lum>max)max=lum;
  }
  const mean=sum/count;
  let varSum=0;
  for(let i=0;i<data.length;i+=step){
    const lum=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    varSum+=(lum-mean)*(lum-mean);
  }
  const stdev=Math.sqrt(varSum/count);
  return {mean,stdev,min,max};
}

function autoEnhance(){
  showProcessing(true);
  setTimeout(()=>{
    try{
      const stats=sampleLuminanceStats();
      const s={...S.settings};
      s.brightness=clamp(Math.round((128-stats.mean)*0.35),-40,40);
      s.contrast=clamp(Math.round((48-stats.stdev)*0.8),0,35);
      s.saturation=clamp(s.saturation+8,-100,100);
      s.vibrance=clamp(s.vibrance+16,-100,100);
      s.shadows=clamp(s.shadows+10,-100,100);
      s.highlights=clamp(s.highlights-8,-100,100);
      s.sharpen=Math.max(s.sharpen,32);
      s.denoise=Math.max(s.denoise,12);
      s.activePreset=null; s.activeSharpenPreset=null; s.activeDenoisePreset=null;
      S.settings=s;
      renderPreview(true);
      pushHistory();
      showProcessing(false);
      toast('Auto Enhance diterapkan','success');
      if(toolSheet.classList.contains('active')) renderAutoTab();
    }catch(err){
      console.error(err); showProcessing(false);
      toast('Auto Enhance gagal diterapkan.','error');
    }
  },30);
}

/* ---- UPSCALE TAB (with 10x and Aspect Ratio) ---- */
const upscaleOptions = [1,2,3,4,5];
const PREMIUM_UPSCALE_MIN = 3; // 1-2x = free, 3-5x = premium (1 credit)
const aspectRatios = [
  {label:'Original', w:0, h:0, icon:'<i class="fa-solid fa-arrows-rotate"></i>'},
  {label:'1:1', w:1, h:1, icon:'<i class="fa-regular fa-square"></i>'},
  {label:'16:9', w:16, h:9, icon:'<i class="fa-solid fa-tv"></i>'},
  {label:'9:16', w:9, h:16, icon:'<i class="fa-solid fa-mobile-screen-button"></i>'},
  {label:'4:5', w:4, h:5, icon:'<i class="fa-regular fa-image"></i>'},
  {label:'5:4', w:5, h:4, icon:'<i class="fa-regular fa-image"></i>'},
  {label:'2:3 Poster', w:2, h:3, icon:'<i class="fa-solid fa-file-image"></i>'},
  {label:'1:1.41 A4', w:1000, h:1414, icon:'<i class="fa-regular fa-file-lines"></i>'}
];

function premiumBadgeHtml(){
  return '<span class="premium-badge"><i class="fa-solid fa-bolt"></i> PRO</span>';
}

function renderUpscaleTab(){
  const w=S.origWidth,h=S.origHeight;
  let scaleGrid = '<div class="scale-grid">';
  upscaleOptions.forEach(val => {
    const active = S.settings.scale===val ? 'active' : '';
    const premium = val>=PREMIUM_UPSCALE_MIN;
    scaleGrid += `<button class="scale-card ${active} ${premium?'is-premium':''}" data-scale="${val}">
      ${premium?premiumBadgeHtml():''}
      <div class="sc-x">${val}×</div>
      <div class="sc-res">${Math.round(w*val)} × ${Math.round(h*val)}</div>
    </button>`;
  });
  scaleGrid += '</div>';

  const currentRatio = S.settings.aspectRatio;
  let aspectGrid = '<div class="aspect-grid">';
  aspectRatios.forEach(ratio => {
    const isActive = currentRatio && ratio.w>0 && currentRatio.width===ratio.w && currentRatio.height===ratio.h;
    const isOriginal = !currentRatio && ratio.w===0;
    const active = (isActive || isOriginal) ? 'active' : '';
    aspectGrid += `<button class="aspect-card ${active}" data-aw="${ratio.w}" data-ah="${ratio.h}">
      <span class="ratio-icon">${ratio.icon}</span>${ratio.label}
    </button>`;
  });
  aspectGrid += '</div>';

  const usage=getFreeUsage();

  sheetBody.innerHTML=`
    <div class="free-usage-strip" id="freeUsageStrip">${usage.count} / ${CONFIG.FREE_DAILY_LIMIT} FREE USED TODAY</div>
    <div class="control-row">
      <div class="control-label"><b>Upscale Factor</b></div>
      ${scaleGrid}
    </div>
    <p class="premium-hint"><i class="fa-solid fa-bolt"></i> 3×–5× adalah fitur <b>PRO</b> — 1 credit terpakai saat export.</p>
    <div class="control-row">
      <div class="control-label"><b>Aspect Ratio</b></div>
      ${aspectGrid}
    </div>
    <p style="font-size:12px;color:var(--text-dim);line-height:1.5;margin:10px 0 0;">
      Resolusi akhir dan rasio aspek diterapkan saat export. Preview menyesuaikan rasio aspek yang dipilih.
    </p>`;

  sheetBody.querySelectorAll('.scale-card').forEach(card=>{
    card.addEventListener('click',()=>{
      S.settings.scale=parseInt(card.dataset.scale,10);
      renderUpscaleTab();
      updateOutputResInfo();
      pushHistory();
      haptic();
      if(S.settings.scale>=PREMIUM_UPSCALE_MIN){
        toast(`Upscale ${S.settings.scale}× dipilih — fitur PRO, 1 credit terpakai saat export`);
      }else{
        toast(`Upscale ${S.settings.scale}× dipilih — akan diterapkan saat export`);
      }
    });
  });

  sheetBody.querySelectorAll('.aspect-card').forEach(card=>{
    card.addEventListener('click',()=>{
      const aw=parseInt(card.dataset.aw,10);
      const ah=parseInt(card.dataset.ah,10);
      if(aw===0 && ah===0){
        S.settings.aspectRatio=null;
      }else{
        S.settings.aspectRatio={width:aw, height:ah};
      }
      // Recalculate preview canvas to show aspect ratio preview
      recalcPreviewCanvas();
      renderUpscaleTab();
      updateOutputResInfo();
      pushHistory();
      haptic();
      toast(`Rasio ${card.textContent.trim()} diterapkan`);
    });
  });
}

function recalcPreviewCanvas(){
  if(!S.originalCanvas) return;
  const srcW=S.origWidth, srcH=S.origHeight;
  let targetW=srcW, targetH=srcH;
  if(S.settings.aspectRatio){
    const ratioW=S.settings.aspectRatio.width;
    const ratioH=S.settings.aspectRatio.height;
    const currentRatio=srcW/srcH;
    const targetRatio=ratioW/ratioH;
    if(targetRatio>currentRatio){
      targetW=srcH*targetRatio;
      targetH=srcH;
    }else{
      targetW=srcW;
      targetH=srcW/targetRatio;
    }
  }
  // Create preview canvas with aspect ratio applied
  const pScale=Math.min(MAX_PREVIEW_DIM/Math.max(targetW,targetH), 1);
  const pw=Math.round(targetW*pScale), ph=Math.round(targetH*pScale);
  const pc=document.createElement('canvas');
  pc.width=pw; pc.height=ph;
  const pctx=pc.getContext('2d');
  pctx.imageSmoothingEnabled=true; pctx.imageSmoothingQuality='high';
  // Draw centered with aspect ratio
  if(S.settings.aspectRatio){
    const drawW=Math.min(srcW, pw);
    const drawH=Math.min(srcH, ph);
    const drawX=(pw-drawW)/2, drawY=(ph-drawH)/2;
    pctx.fillStyle='#000';
    pctx.fillRect(0,0,pw,ph);
    pctx.drawImage(S.originalCanvas, drawX, drawY, drawW, drawH);
  }else{
    pctx.drawImage(S.originalCanvas,0,0,pw,ph);
  }
  S.previewCanvas=pc;
  sizeCanvasesToPreview();
  fitToScreen();
  renderPreview(true);
}

/* ---- DETAIL TAB ---- */
const sharpenPresets={Soft:15,Natural:35,Sharp:60,'Ultra Sharp':85};
const denoisePresets={Off:0,Low:20,Medium:45,High:75};
const PREMIUM_SHARPEN=['Sharp','Ultra Sharp'];
const PREMIUM_DENOISE=['Low','Medium','High'];

function renderDetailTab(){
  sheetBody.innerHTML=`
    <div class="control-row"><div class="control-label"><b>Sharpen Preset</b></div>
      <div class="chip-row" id="sharpenChips">
        ${Object.keys(sharpenPresets).map(k=>{
          const premium=PREMIUM_SHARPEN.includes(k);
          return `<button class="chip ${S.settings.activeSharpenPreset===k?'active':''} ${premium?'is-premium':''}" data-preset="${k}">${premium?'<i class="fa-solid fa-bolt"></i> ':''}${k}</button>`;
        }).join('')}
      </div>
    </div>
    ${slider('sharpen','Sharpen',0,100,'sharpen')}
    <div class="control-row" style="border-top:1px solid var(--border);padding-top:16px;">
      <div class="control-label"><b>Denoise Preset</b></div>
      <div class="chip-row" id="denoiseChips">
        ${Object.keys(denoisePresets).map(k=>{
          const premium=PREMIUM_DENOISE.includes(k);
          return `<button class="chip ${S.settings.activeDenoisePreset===k?'active':''} ${premium?'is-premium':''}" data-preset="${k}">${premium?'<i class="fa-solid fa-bolt"></i> ':''}${k}</button>`;
        }).join('')}
      </div>
    </div>
    ${slider('denoise','Denoise',0,100,'denoise')}
    <p class="premium-hint"><i class="fa-solid fa-bolt"></i> Sharp, Ultra Sharp &amp; semua Denoise (Low/Medium/High) adalah fitur <b>PRO</b> — 1 credit terpakai saat export.</p>
  `;
  wireSlider('sharpen',()=>{ S.settings.activeSharpenPreset=null; });
  wireSlider('denoise',()=>{ S.settings.activeDenoisePreset=null; });
  sheetBody.querySelectorAll('#sharpenChips .chip').forEach(chip=>{
    chip.addEventListener('click',()=>{
      const k=chip.dataset.preset;
      S.settings.sharpen=sharpenPresets[k];
      S.settings.activeSharpenPreset=k;
      renderDetailTab(); renderPreview(true); pushHistory(); haptic();
      if(PREMIUM_SHARPEN.includes(k)) toast(`Sharpen "${k}" — fitur PRO, 1 credit terpakai saat export`);
    });
  });
  sheetBody.querySelectorAll('#denoiseChips .chip').forEach(chip=>{
    chip.addEventListener('click',()=>{
      const k=chip.dataset.preset;
      S.settings.denoise=denoisePresets[k];
      S.settings.activeDenoisePreset=k;
      renderDetailTab(); renderPreview(true); pushHistory(); haptic();
      if(PREMIUM_DENOISE.includes(k)) toast(`Denoise "${k}" — fitur PRO, 1 credit terpakai saat export`);
    });
  });
}

/* ---- COLOR TAB ---- */
const colorPresets={
  Natural:{brightness:5,contrast:8,saturation:6,vibrance:10,temperature:0,highlights:-5,shadows:8},
  Vivid:{brightness:2,contrast:12,saturation:25,vibrance:20,temperature:0,highlights:-4,shadows:4},
  Cinematic:{brightness:0,contrast:18,saturation:-6,vibrance:10,temperature:-6,highlights:-12,shadows:-8},
  'HDR Look':{brightness:2,contrast:10,saturation:8,vibrance:18,temperature:0,highlights:-20,shadows:22}
};
const PREMIUM_COLOR=['Vivid','Cinematic','HDR Look'];

function renderColorTab(){
  const editingId=S.editingCustomFilterId;
  const creatingNew=!editingId && S.creatingCustomFilter;
  sheetBody.innerHTML=`
    ${editingId?`
    <div class="control-row" style="background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.35);border-radius:12px;padding:10px 12px;">
      <div class="control-label"><b><i class="fa-solid fa-pen"></i> Mengedit: ${escHtml(S.editingCustomFilterName||'')}</b></div>
      <p style="font-size:11.5px;color:var(--text-dim);margin:2px 0 10px;">Atur slider di bawah sesuai selera, lalu simpan perubahannya.</p>
      <div class="chip-row">
        <button class="chip" id="btnUpdateCustomFilter"><i class="fa-solid fa-check"></i> Update Filter</button>
        <button class="chip" id="btnCancelEditFilter"><i class="fa-solid fa-xmark"></i> Batal</button>
      </div>
    </div>`:''}
    ${creatingNew?`
    <div class="control-row" style="background:rgba(45,212,191,.12);border:1px solid rgba(45,212,191,.35);border-radius:12px;padding:10px 12px;">
      <div class="control-label"><b><i class="fa-solid fa-wand-magic-sparkles"></i> Membuat Filter Baru</b></div>
      <p style="font-size:11.5px;color:var(--text-dim);margin:2px 0 10px;">Geser slider di bawah ini sampai hasilnya sesuai selera — filter tidak bisa disimpan sebelum ada yang diubah.</p>
      <div class="chip-row">
        <button class="chip" id="btnFinishCreateFilter"><i class="fa-solid fa-check"></i> Lanjut ke Nama &amp; Simpan</button>
        <button class="chip" id="btnCancelCreateFilterColor"><i class="fa-solid fa-xmark"></i> Batal</button>
      </div>
    </div>`:''}
    <div class="control-row"><div class="control-label"><b>Preset</b></div>
      <div class="preset-grid" id="colorPresetGrid">
        ${Object.keys(colorPresets).map(k=>{
          const premium=PREMIUM_COLOR.includes(k);
          return `
          <button class="preset-card ${S.settings.activePreset===k?'active':''} ${premium?'is-premium':''}" data-preset="${k}">
            ${premium?premiumBadgeHtml():''}
            <b>${k}</b><span>Tap untuk terapkan</span>
          </button>`;
        }).join('')}
      </div>
    </div>
    ${slider('brightness','Brightness',-100,100,'brightness')}
    ${slider('saturation','Saturation',-100,100,'saturation')}
    ${slider('vibrance','Vibrance',-100,100,'vibrance')}
    ${slider('temperature','Temperature',-100,100,'temperature')}

    <div class="control-row" style="margin-top:4px;">
      <div class="control-label"><b><i class="fa-solid fa-sliders"></i> Smart Control</b></div>
      <p style="font-size:11.5px;color:var(--text-dim);line-height:1.5;margin:0 0 10px;">Kontrol presisi untuk gamma, contrast, highlight, shadow &amp; hue.</p>
    </div>
    ${slider('gamma','Gamma',-100,100,'gamma')}
    ${slider('contrast','Contrast',-100,100,'contrast')}
    ${slider('highlights','Highlight',-100,100,'highlights')}
    ${slider('shadows','Shadow',-100,100,'shadows')}
    ${slider('hue','Hue',-180,180,'hue')}
    <p class="premium-hint"><i class="fa-solid fa-bolt"></i> Vivid, Cinematic &amp; HDR Look adalah fitur <b>PRO</b> — 1 credit terpakai saat export. Preset Natural tetap gratis.</p>
  `;
  ['brightness','contrast','saturation','vibrance','temperature','highlights','shadows','gamma','hue'].forEach(k=>{
    wireSlider(k,()=>{ S.settings.activePreset=null; S.settings.activeFilter=null; S.settings.activeFilterPremium=false; });
  });
  sheetBody.querySelectorAll('#colorPresetGrid .preset-card').forEach(card=>{
    card.addEventListener('click',()=>{
      const k=card.dataset.preset;
      Object.assign(S.settings,colorPresets[k]);
      S.settings.activePreset=k;
      S.settings.activeFilter=null; S.settings.activeFilterPremium=false;
      renderColorTab(); renderPreview(true); pushHistory(); haptic();
      if(PREMIUM_COLOR.includes(k)) toast(`Preset "${k}" — fitur PRO, 1 credit terpakai saat export`);
    });
  });
  if(editingId){
    $('btnUpdateCustomFilter').addEventListener('click',()=>{
      updateCustomFilterFromCurrent(editingId,S.editingCustomFilterName);
      const savedName=S.editingCustomFilterName;
      S.editingCustomFilterId=null; S.editingCustomFilterName=null;
      haptic();
      openSheet('filter');
      toast(`Filter "${savedName}" berhasil diperbarui.`,'success');
    });
    $('btnCancelEditFilter').addEventListener('click',()=>{
      S.editingCustomFilterId=null; S.editingCustomFilterName=null;
      haptic();
      openSheet('filter');
    });
  }
  if(creatingNew){
    $('btnFinishCreateFilter').addEventListener('click',()=>{
      if(settingsAreDefaultColor()){
        toast('Geser minimal satu slider dulu sebelum lanjut.');
        return;
      }
      haptic();
      openSheet('filter');
    });
    $('btnCancelCreateFilterColor').addEventListener('click',()=>{
      S.creatingCustomFilter=false;
      haptic();
      openSheet('filter');
    });
  }
}

/* ---- FILTER TAB ---- */
const COLOR_FIELDS=['brightness','contrast','saturation','vibrance','temperature','highlights','shadows','gamma','hue'];
function settingsAreDefaultColor(){
  return COLOR_FIELDS.every(f=>Number(S.settings[f]||0)===Number(defaultSettings[f]||0));
}
const filterPresets={
  'Original':      { premium:false, brightness:0, contrast:0,   saturation:0,    vibrance:0,  temperature:0,   highlights:0,   shadows:0,   gamma:0,   hue:0 },
  'B&W Classic':   { premium:false, brightness:0, contrast:10,  saturation:-100, vibrance:0,  temperature:0,   highlights:0,   shadows:0,   gamma:0,   hue:0 },
  'Warm Glow':     { premium:false, brightness:3, contrast:5,   saturation:5,    vibrance:8,  temperature:15,  highlights:0,   shadows:0,   gamma:0,   hue:0 },
  'Cool Tone':     { premium:false, brightness:0, contrast:5,   saturation:0,    vibrance:5,  temperature:-15, highlights:0,   shadows:0,   gamma:0,   hue:0 },
  'Soft Pastel':   { premium:false, brightness:6, contrast:-10, saturation:-15,  vibrance:10, temperature:6,   highlights:-8,  shadows:8,   gamma:-8,  hue:0 },
  'High Key BW':   { premium:false, brightness:10,contrast:20,  saturation:-100, vibrance:0,  temperature:0,   highlights:-20, shadows:20,  gamma:-6,  hue:0 },
  'Vintage Film':  { premium:true,  brightness:2, contrast:-8,  saturation:-20,  vibrance:0,  temperature:12,  highlights:-15, shadows:10,  gamma:6,   hue:-6 },
  'Noir':          { premium:true,  brightness:0, contrast:35,  saturation:-100, vibrance:0,  temperature:0,   highlights:10,  shadows:-15, gamma:-10, hue:0 },
  'Golden Hour':   { premium:true,  brightness:0, contrast:5,   saturation:15,   vibrance:20, temperature:25,  highlights:-10, shadows:15,  gamma:-4,  hue:6 },
  'Teal & Orange': { premium:true,  brightness:0, contrast:15,  saturation:20,   vibrance:15, temperature:8,   highlights:0,   shadows:-10, gamma:0,   hue:-14 },
  'Moody Blue':    { premium:true,  brightness:-4,contrast:18,  saturation:-10,  vibrance:10, temperature:-20, highlights:-12, shadows:-10, gamma:8,   hue:34 },
  'Cyberpunk':     { premium:true,  brightness:2, contrast:28,  saturation:35,   vibrance:25, temperature:-6,  highlights:5,   shadows:-18, gamma:-6,  hue:-52 },
  'Sunset Dream':  { premium:true,  brightness:4, contrast:8,   saturation:22,   vibrance:18, temperature:30,  highlights:-14, shadows:12,  gamma:-4,  hue:18 },
  'Matte Black':   { premium:true,  brightness:-6,contrast:-16, saturation:-8,   vibrance:0,  temperature:-4,  highlights:-22, shadows:22,  gamma:14,  hue:0 },
  'Duotone Purple':{ premium:true,  brightness:0, contrast:22,  saturation:10,   vibrance:15, temperature:-10, highlights:-8,  shadows:-8,  gamma:0,   hue:-96 }
};

/* ---- Custom (user-made) filters — saved locally on-device, always free ---- */
const CUSTOM_FILTER_KEY='pe_customFilters_v1';
function loadCustomFilters(){
  try{ return JSON.parse(localStorage.getItem(CUSTOM_FILTER_KEY))||[]; }catch(e){ return []; }
}
function saveCustomFiltersList(list){
  try{ localStorage.setItem(CUSTOM_FILTER_KEY, JSON.stringify(list)); }catch(e){}
}
function addCustomFilterFromCurrent(name){
  const list=loadCustomFilters();
  const settings={}; COLOR_FIELDS.forEach(f=>{ settings[f]=S.settings[f]; });
  list.push({ id:'cf'+Date.now()+Math.random().toString(36).slice(2,6), name, settings });
  saveCustomFiltersList(list);
  return list;
}
function deleteCustomFilter(id){
  const list=loadCustomFilters().filter(f=>f.id!==id);
  saveCustomFiltersList(list);
  return list;
}
function updateCustomFilterFromCurrent(id,name){
  const list=loadCustomFilters();
  const idx=list.findIndex(f=>f.id===id);
  if(idx===-1) return list;
  const settings={}; COLOR_FIELDS.forEach(f=>{ settings[f]=S.settings[f]; });
  list[idx]={...list[idx], name:(name||list[idx].name).slice(0,40), settings};
  saveCustomFiltersList(list);
  return list;
}

/* ---- .ptlab file export/import — lets people share filters they made ---- */
function ptlabSafeFilename(name){
  const safe=String(name||'filter').trim().replace(/[^a-z0-9\-_ ]/gi,'').replace(/\s+/g,'-');
  return (safe||'filter').slice(0,60);
}
function downloadFilterAsPtlab(name,settings){
  const payload={ format:'ptlab', app:'UFN AI Photo Editor', version:1, name:String(name||'Filter Saya').slice(0,40), settings };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=ptlabSafeFilename(name)+'.ptlab';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
function importPtlabFile(file){
  if(!file) return;
  if(!/\.ptlab$/i.test(file.name) && file.type!=='application/json'){
    toast('File harus berformat .ptlab.','error'); return;
  }
  const reader=new FileReader();
  reader.onload=(e)=>{
    let data;
    try{ data=JSON.parse(e.target.result); }catch(err){ toast('File .ptlab tidak valid atau rusak.','error'); return; }
    if(!data || typeof data!=='object' || typeof data.settings!=='object'){
      toast('File .ptlab tidak valid.','error'); return;
    }
    const settings={};
    COLOR_FIELDS.forEach(f=>{ const v=Number(data.settings[f]); settings[f]=isFinite(v)?v:0; });
    const name=String(data.name||file.name.replace(/\.ptlab$/i,'')||'Filter Impor').slice(0,40);
    const list=loadCustomFilters();
    list.push({ id:'cf'+Date.now()+Math.random().toString(36).slice(2,6), name, settings });
    saveCustomFiltersList(list);
    renderFilterTab(); haptic();
    toast(`Filter "${name}" berhasil diimpor.`,'success');
  };
  reader.onerror=()=>toast('Gagal membaca file .ptlab.','error');
  reader.readAsText(file);
}

function renderFilterTab(){
  const customFilters=loadCustomFilters();
  sheetBody.innerHTML=`
    <div class="control-row"><div class="control-label"><b>Pilih Filter</b></div>
      <div class="preset-grid" id="filterPresetGrid">
        ${Object.keys(filterPresets).map(k=>{
          const p=filterPresets[k];
          return `
          <button class="preset-card ${S.settings.activeFilter===k?'active':''} ${p.premium?'is-premium':''}" data-filter="${k}">
            ${p.premium?premiumBadgeHtml():''}
            <b>${k}</b><span>${p.premium?'PRO':'Gratis'}</span>
          </button>`;
        }).join('')}
      </div>
    </div>
    <p style="font-size:12px;color:var(--text-dim);line-height:1.5;margin:10px 2px 0;">
      Filter mengganti pengaturan warna di tab Color dengan tampilan siap pakai. Bisa disesuaikan lagi lewat tab Color setelahnya.
    </p>
    <p class="premium-hint"><i class="fa-solid fa-bolt"></i> Filter bertanda <b>PRO</b> memakai 1 credit saat export. Filter Gratis tidak memakai credit sama sekali.</p>

    <div class="control-row" style="margin-top:6px;">
      <div class="control-label"><b><i class="fa-solid fa-wand-magic-sparkles"></i> Buat Filter Sendiri</b></div>
      ${S.creatingCustomFilter ? `
        <p style="font-size:11.5px;color:var(--text-dim);line-height:1.5;margin:0 0 10px;">
          Sudah atur warnanya di tab Color? Kasih nama filter ini, lalu simpan. Filter buatanmu selalu gratis.
        </p>
        <input type="text" id="customFilterNameInput" placeholder="Nama filter, mis: Sunset Vibes" maxlength="40"
          style="width:100%;box-sizing:border-box;padding:11px 13px;margin-bottom:8px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font-size:13px;outline:none;">
        <div class="chip-row">
          <button class="chip" id="btnBackToColorAdjust"><i class="fa-solid fa-sliders"></i> Atur Warna Lagi</button>
          <button class="chip" id="btnCancelCreateFilterTab"><i class="fa-solid fa-xmark"></i> Batal</button>
        </div>
        <div class="chip-row" style="margin-top:8px;">
          <button class="chip" id="btnSaveCustomFilter"><i class="fa-solid fa-floppy-disk"></i> Simpan untuk Saya</button>
          <button class="chip" id="btnDownloadCustomFilter"><i class="fa-solid fa-download"></i> Download .ptlab</button>
        </div>
      ` : `
        <p style="font-size:11.5px;color:var(--text-dim);line-height:1.5;margin:0 0 10px;">
          Bikin filter dari nol: kamu akan diarahkan ke tab Color untuk mengatur Brightness, Contrast, Saturation, Vibrance, Temperature, Highlight, Shadow, Gamma &amp; Hue sendiri — baru dinamai dan disimpan.
        </p>
        <button class="chip" id="btnStartCreateFilter"><i class="fa-solid fa-plus"></i> Buat Filter Baru</button>
      `}
    </div>

    <div class="control-row" style="margin-top:2px;">
      <div class="control-label"><b><i class="fa-solid fa-file-import"></i> Pakai Filter Orang Lain</b></div>
      <p style="font-size:11.5px;color:var(--text-dim);line-height:1.5;margin:0 0 10px;">
        Punya file <b>.ptlab</b> dari teman atau kreator lain? Upload di sini untuk langsung memakainya.
      </p>
      <button class="chip" id="btnImportPtlab"><i class="fa-solid fa-upload"></i> Upload File .ptlab</button>
      <input type="file" id="ptlabFileInput" accept=".ptlab,application/json" style="display:none;">
    </div>

    <div class="control-row" style="margin-top:2px;">
      <div class="control-label"><b>Filter Custom Kamu</b></div>
    </div>
    <div class="preset-grid" id="customFilterGrid">
      ${customFilters.length ? customFilters.map(cf=>`
        <button class="preset-card ${S.settings.activeFilter==='custom:'+cf.id?'active':''}" data-custom="${cf.id}" style="position:relative;">
          <span data-edit="${cf.id}" style="position:absolute;top:6px;left:6px;color:var(--text-dim);padding:2px 5px;"><i class="fa-solid fa-pen"></i></span>
          <span data-del="${cf.id}" style="position:absolute;top:6px;right:6px;color:var(--text-dim);padding:2px 5px;"><i class="fa-solid fa-xmark"></i></span>
          <span data-dl="${cf.id}" style="position:absolute;bottom:6px;right:6px;color:var(--text-dim);padding:2px 5px;"><i class="fa-solid fa-download"></i></span>
          <b>${escHtml(cf.name)}</b><span>Custom</span>
        </button>`).join('') : '<p class="pe-layer-empty">Belum ada filter custom.</p>'}
    </div>
  `;
  sheetBody.querySelectorAll('#filterPresetGrid .preset-card').forEach(card=>{
    card.addEventListener('click',()=>{
      const k=card.dataset.filter;
      const p=filterPresets[k];
      COLOR_FIELDS.forEach(f=>{ S.settings[f]=p[f]; });
      S.settings.activeFilter=k;
      S.settings.activeFilterPremium=!!p.premium;
      S.settings.activePreset=null;
      renderFilterTab(); renderPreview(true); pushHistory(); haptic();
      toast(p.premium?`Filter "${k}" — fitur PRO, 1 credit terpakai saat export`:`Filter "${k}" diterapkan`);
    });
  });
  function currentFilterNameOrDefault(){
    const typed=($('customFilterNameInput').value||'').trim();
    return typed || 'Filter Saya '+(customFilters.length+1);
  }
  if(S.creatingCustomFilter){
    $('btnBackToColorAdjust').addEventListener('click',()=>{
      haptic(); openSheet('color');
    });
    $('btnCancelCreateFilterTab').addEventListener('click',()=>{
      S.creatingCustomFilter=false;
      renderFilterTab(); haptic();
    });
    $('btnSaveCustomFilter').addEventListener('click',()=>{
      if(!S.previewCanvas){ toast('Pilih foto dulu.'); return; }
      if(settingsAreDefaultColor()){ toast('Atur dulu warnanya di tab Color sebelum menyimpan filter.'); return; }
      const name=currentFilterNameOrDefault().slice(0,40);
      addCustomFilterFromCurrent(name);
      S.creatingCustomFilter=false;
      renderFilterTab(); haptic();
      toast(`Filter "${name}" disimpan di perangkat ini.`,'success');
    });
    $('btnDownloadCustomFilter').addEventListener('click',()=>{
      if(!S.previewCanvas){ toast('Pilih foto dulu.'); return; }
      if(settingsAreDefaultColor()){ toast('Atur dulu warnanya di tab Color sebelum mengunduh filter.'); return; }
      const name=currentFilterNameOrDefault().slice(0,40);
      const settings={}; COLOR_FIELDS.forEach(f=>{ settings[f]=S.settings[f]; });
      downloadFilterAsPtlab(name,settings);
      haptic();
      toast(`Mengunduh "${ptlabSafeFilename(name)}.ptlab"...`,'success');
    });
  }else{
    $('btnStartCreateFilter').addEventListener('click',()=>{
      if(!S.previewCanvas){ toast('Pilih foto dulu.'); return; }
      COLOR_FIELDS.forEach(f=>{ S.settings[f]=defaultSettings[f]; });
      S.settings.activeFilter=null; S.settings.activeFilterPremium=false; S.settings.activePreset=null;
      S.creatingCustomFilter=true;
      renderPreview(true); haptic();
      openSheet('color');
      toast('Foto direset ke Original — geser slider untuk membuat filter barumu.');
    });
  }
  $('btnImportPtlab').addEventListener('click',()=>{ $('ptlabFileInput').click(); });
  $('ptlabFileInput').addEventListener('change',(e)=>{
    const file=e.target.files[0];
    if(file) importPtlabFile(file);
    e.target.value='';
  });
  sheetBody.querySelectorAll('#customFilterGrid [data-custom]').forEach(card=>{
    card.addEventListener('click',(e)=>{
      if(e.target.closest('[data-del],[data-edit],[data-dl]')) return; // handled separately below
      const id=card.dataset.custom;
      const cf=customFilters.find(f=>f.id===id);
      if(!cf) return;
      COLOR_FIELDS.forEach(f=>{ S.settings[f]=cf.settings[f]||0; });
      S.settings.activeFilter='custom:'+id;
      S.settings.activeFilterPremium=false; // custom filters are always free
      S.settings.activePreset=null;
      renderFilterTab(); renderPreview(true); pushHistory(); haptic();
      toast(`Filter "${cf.name}" diterapkan`);
    });
  });
  sheetBody.querySelectorAll('#customFilterGrid [data-edit]').forEach(editBtn=>{
    editBtn.addEventListener('click',(e)=>{
      e.stopPropagation();
      if(!S.previewCanvas){ toast('Pilih foto dulu untuk mengedit filter.'); return; }
      const id=editBtn.dataset.edit;
      const cf=customFilters.find(f=>f.id===id);
      if(!cf) return;
      COLOR_FIELDS.forEach(f=>{ S.settings[f]=cf.settings[f]||0; });
      S.editingCustomFilterId=id;
      S.editingCustomFilterName=cf.name;
      renderPreview(true); haptic();
      openSheet('color');
      toast(`Mengedit "${cf.name}" — atur slider lalu tekan Update Filter.`);
    });
  });
  sheetBody.querySelectorAll('#customFilterGrid [data-dl]').forEach(dlBtn=>{
    dlBtn.addEventListener('click',(e)=>{
      e.stopPropagation();
      const id=dlBtn.dataset.dl;
      const cf=customFilters.find(f=>f.id===id);
      if(!cf) return;
      downloadFilterAsPtlab(cf.name,cf.settings);
      haptic();
      toast(`Mengunduh "${ptlabSafeFilename(cf.name)}.ptlab"...`,'success');
    });
  });
  sheetBody.querySelectorAll('#customFilterGrid [data-del]').forEach(delBtn=>{
    delBtn.addEventListener('click',(e)=>{
      e.stopPropagation();
      const id=delBtn.dataset.del;
      if(S.settings.activeFilter==='custom:'+id){ S.settings.activeFilter=null; }
      if(S.editingCustomFilterId===id){ S.editingCustomFilterId=null; S.editingCustomFilterName=null; }
      deleteCustomFilter(id);
      renderFilterTab(); haptic();
    });
  });
}

/* ---- FACE TAB (fully Premium) ---- */
function renderFaceTab(){
  sheetBody.innerHTML=`
    <div class="toggle-row">
      <div><b>Face Detail</b> ${premiumBadgeHtml()}<span>Penajaman &amp; noise reduction aman, diterapkan secara menyeluruh</span></div>
      <div class="switch ${S.settings.faceDetail?'on':''}" id="faceToggle"></div>
    </div>
    <p style="font-size:12px;color:var(--text-dim);line-height:1.6;margin-top:10px;">
      Fitur ini tidak menggunakan model AI/deteksi wajah — melainkan penyesuaian clarity ringan yang aman diterapkan pada keseluruhan gambar untuk membantu memperjelas detail kulit &amp; fitur wajah tanpa membuat foto terlihat kasar.
    </p>
    <p class="premium-hint"><i class="fa-solid fa-bolt"></i> Face Detail adalah fitur <b>PRO</b> — 1 credit terpakai saat export.</p>`;
  $('faceToggle').addEventListener('click',()=>{
    S.settings.faceDetail=!S.settings.faceDetail;
    renderFaceTab(); renderPreview(true); pushHistory(); haptic();
    if(S.settings.faceDetail) toast('Face Detail aktif — fitur PRO, 1 credit terpakai saat export');
  });
}

/* ---- EDIT TAB (Text & Mosaic) ---- */
function editLayerItemsHTML(){
  const items=[];
  S.textLayers.forEach((l,i)=>{
    items.push(`
      <div class="pe-layer-item" data-tid="${l.id}">
        <div class="pe-layer-row-top">
          <span class="pe-layer-name"><i class="fa-solid fa-font"></i> Teks ${i+1}</span>
          <div class="pe-layer-order"><button data-act="remove" class="pe-layer-remove"><i class="fa-solid fa-xmark"></i></button></div>
        </div>
        <input class="auth-input" data-prop="text" value="${l.text.replace(/"/g,'&quot;')}" maxlength="80" style="margin-bottom:6px;">
        <label>Ukuran <input type="range" min="5" max="100" value="${l.size}" data-prop="size"></label>
        <label>Posisi X <input type="range" min="0" max="100" value="${Math.round(l.x*100)}" data-prop="x"></label>
        <label>Posisi Y <input type="range" min="0" max="100" value="${Math.round(l.y*100)}" data-prop="y"></label>
        <label>Opacity <input type="range" min="10" max="100" value="${Math.round(l.opacity*100)}" data-prop="opacity"></label>
        <div class="pe-color-row" style="margin-top:6px;">
          <label style="margin:0;">Warna</label>
          <input type="color" value="${l.color}" data-prop="color">
        </div>
        <div class="chip-row" style="margin-top:8px;">
          <button class="chip ${l.bold?'active':''}" data-act="bold">Bold</button>
          <button class="chip ${l.stroke?'active':''}" data-act="stroke">Outline</button>
        </div>
      </div>`);
  });
  S.mosaicLayers.forEach((l,i)=>{
    items.push(`
      <div class="pe-layer-item" data-mid="${l.id}">
        <div class="pe-layer-row-top">
          <span class="pe-layer-name"><i class="fa-solid fa-table-cells"></i> Mosaic ${i+1}</span>
          <div class="pe-layer-order"><button data-act="remove" class="pe-layer-remove"><i class="fa-solid fa-xmark"></i></button></div>
        </div>
        <label>Posisi X <input type="range" min="0" max="100" value="${Math.round(l.x*100)}" data-prop="x"></label>
        <label>Posisi Y <input type="range" min="0" max="100" value="${Math.round(l.y*100)}" data-prop="y"></label>
        <label>Lebar <input type="range" min="5" max="100" value="${Math.round(l.w*100)}" data-prop="w"></label>
        <label>Tinggi <input type="range" min="5" max="100" value="${Math.round(l.h*100)}" data-prop="h"></label>
        <label>Intensitas <input type="range" min="5" max="100" value="${l.block}" data-prop="block"></label>
      </div>`);
  });
  S.stickerLayers.forEach((l,i)=>{
    items.push(`
      <div class="pe-layer-item" data-sid="${l.id}">
        <div class="pe-layer-row-top">
          <img class="pe-layer-thumb" src="${l.url}">
          <span class="pe-layer-name"><i class="fa-solid fa-icons"></i> Stiker ${i+1} ${l.premium?'<span class="premium-badge" style="margin-left:4px;"><i class="fa-solid fa-bolt"></i> PRO</span>':''}</span>
          <div class="pe-layer-order"><button data-act="remove" class="pe-layer-remove"><i class="fa-solid fa-xmark"></i></button></div>
        </div>
        <label>Posisi X <input type="range" min="0" max="100" value="${Math.round(l.x*100)}" data-prop="x"></label>
        <label>Posisi Y <input type="range" min="0" max="100" value="${Math.round(l.y*100)}" data-prop="y"></label>
        <label>Ukuran <input type="range" min="5" max="100" value="${Math.round(l.scale*100)}" data-prop="scale"></label>
        <label>Rotasi <input type="range" min="0" max="360" value="${Math.round(l.rotation)}" data-prop="rotation"></label>
        <label>Opacity <input type="range" min="10" max="100" value="${Math.round(l.opacity*100)}" data-prop="opacity"></label>
      </div>`);
  });
  return items.join('');
}

function renderEditTab(){
  sheetBody.innerHTML=`
    <div class="control-row">
      <div class="control-label"><b>Tambah Elemen</b></div>
      <div class="chip-row">
        <button class="chip" id="btnAddText"><i class="fa-solid fa-font"></i> Teks</button>
        <button class="chip" id="btnAddMosaic"><i class="fa-solid fa-table-cells"></i> Mosaic</button>
      </div>
      <p style="font-size:11.5px;color:var(--text-dim);line-height:1.5;margin:10px 2px 0;">
        Tambahkan teks atau area mosaic (sensor/pixelate) di atas foto. Atur posisi, ukuran &amp; tampilannya lewat slider di bawah.
      </p>
    </div>

    <div class="control-row">
      <div class="control-label"><b><i class="fa-solid fa-icons"></i> Stiker</b></div>
      <p style="font-size:11.5px;color:var(--text-dim);line-height:1.5;margin:0 0 10px;">
        Koleksi stiker resmi dari PhotoLab. Tap salah satu untuk memasangnya ke foto.
      </p>
      <div class="preset-grid" id="stickerPickerGrid">
        ${STICKERS.map(st=>`
          <button class="preset-card ${st.premium?'is-premium':''}" data-sticker="${st.id}" style="align-items:center;position:relative;">
            ${st.premium?premiumBadgeHtml():''}
            ${(S.isAdmin && st.fromFirestore)?`<span class="sticker-del-btn" data-del-sticker="${st.id}" title="Hapus stiker ini untuk semua orang"><i class="fa-solid fa-trash"></i></span>`:''}
            <img src="${st.url}" style="width:44px;height:44px;object-fit:contain;margin-bottom:6px;">
            <b>${escHtml(st.name)}</b><span>${st.premium?'PRO':'Gratis'}</span>
          </button>`).join('')}
      </div>
      ${S.isAdmin?stickerAdminPanelHTML():''}
    </div>

    <div id="editLayerList">${(S.textLayers.length||S.mosaicLayers.length||S.stickerLayers.length)?editLayerItemsHTML():'<p class="pe-layer-empty">Belum ada teks, mosaic, atau stiker. Tap tombol di atas untuk menambahkan.</p>'}</div>
  `;
  $('btnAddText').addEventListener('click',()=>{ addTextLayer(); renderEditTab(); renderLayerHandles(); });
  $('btnAddMosaic').addEventListener('click',()=>{ addMosaicLayer(); renderEditTab(); renderLayerHandles(); });
  sheetBody.querySelectorAll('#stickerPickerGrid [data-sticker]').forEach(card=>{
    card.addEventListener('click',()=>{
      const st=STICKERS.find(s=>s.id===card.dataset.sticker);
      if(!st) return;
      addStickerLayer(st);
      renderEditTab();
      renderLayerHandles();
    });
  });
  sheetBody.querySelectorAll('#stickerPickerGrid [data-del-sticker]').forEach(delBtn=>{
    delBtn.addEventListener('click',(e)=>{
      e.stopPropagation(); e.preventDefault();
      deleteStickerFromLibrary(delBtn.dataset.delSticker);
    });
  });
  if(S.isAdmin) wireStickerAdminPanel();

  const rerender=debounce(()=>renderPreview(true),40);

  sheetBody.querySelectorAll('.pe-layer-item[data-tid]').forEach(item=>{
    const id=item.dataset.tid;
    const layer=S.textLayers.find(l=>l.id===id);
    if(!layer) return;
    const textInput=item.querySelector('input[data-prop="text"]');
    textInput.addEventListener('input',()=>{ layer.text=textInput.value; rerender(); });
    textInput.addEventListener('change',()=>pushHistory());
    item.querySelectorAll('input[type=range]').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const prop=inp.dataset.prop, val=Number(inp.value);
        if(prop==='x'||prop==='y') layer[prop]=val/100;
        else if(prop==='opacity') layer.opacity=val/100;
        else layer[prop]=val;
        rerender(); haptic();
        positionLayerHandle('text',id);
      });
      inp.addEventListener('change',()=>pushHistory());
    });
    const colorInput=item.querySelector('input[type=color]');
    colorInput.addEventListener('input',()=>{ layer.color=colorInput.value; rerender(); });
    colorInput.addEventListener('change',()=>pushHistory());
    item.querySelectorAll('button[data-act]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const act=btn.dataset.act;
        if(act==='remove'){ removeTextLayer(id); renderEditTab(); renderLayerHandles(); return; }
        if(act==='bold') layer.bold=!layer.bold;
        if(act==='stroke') layer.stroke=!layer.stroke;
        renderPreview(true); pushHistory(); renderEditTab(); haptic();
      });
    });
  });

  sheetBody.querySelectorAll('.pe-layer-item[data-mid]').forEach(item=>{
    const id=item.dataset.mid;
    const layer=S.mosaicLayers.find(l=>l.id===id);
    if(!layer) return;
    item.querySelectorAll('input[type=range]').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const prop=inp.dataset.prop, val=Number(inp.value);
        if(prop==='x'||prop==='y'||prop==='w'||prop==='h') layer[prop]=val/100;
        else layer[prop]=val;
        rerender(); haptic();
        positionLayerHandle('mosaic',id);
      });
      inp.addEventListener('change',()=>pushHistory());
    });
    item.querySelectorAll('button[data-act="remove"]').forEach(btn=>{
      btn.addEventListener('click',()=>{ removeMosaicLayer(id); renderEditTab(); renderLayerHandles(); });
    });
  });

  sheetBody.querySelectorAll('.pe-layer-item[data-sid]').forEach(item=>{
    const id=item.dataset.sid;
    const layer=S.stickerLayers.find(l=>l.id===id);
    if(!layer) return;
    item.querySelectorAll('input[type=range]').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const prop=inp.dataset.prop, val=Number(inp.value);
        if(prop==='x'||prop==='y') layer[prop]=val/100;
        else if(prop==='scale') layer.scale=val/100;
        else if(prop==='opacity') layer.opacity=val/100;
        else layer[prop]=val;
        rerender(); haptic();
        positionLayerHandle('sticker',id);
      });
      inp.addEventListener('change',()=>pushHistory());
    });
    item.querySelectorAll('button[data-act="remove"]').forEach(btn=>{
      btn.addEventListener('click',()=>{ removeStickerLayer(id); renderEditTab(); renderLayerHandles(); });
    });
  });
}

/* ---- DRAGGABLE CANVAS HANDLES FOR MOSAIC & STICKER LAYERS --------------
   Lets the person move a mosaic or sticker layer directly with a
   finger/cursor on the photo itself, instead of only through the position
   sliders above. The sliders stay fully functional and in sync — dragging
   a handle updates the same layer.x/layer.y the sliders read from, and
   moving a slider repositions the handle too (positionLayerHandle). Only
   rendered while the Edit (Text & Mosaic) sheet is open. ------------------ */
function layerHandleIcon(type){
  if(type==='mosaic') return '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="7" height="7" rx="1.3" fill="currentColor" opacity="0.9"/><rect x="13" y="4" width="7" height="7" rx="1.3" fill="currentColor" opacity="0.55"/><rect x="4" y="13" width="7" height="7" rx="1.3" fill="currentColor" opacity="0.55"/><rect x="13" y="13" width="7" height="7" rx="1.3" fill="currentColor" opacity="0.9"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><path d="M12 8.5 8.5 12 12 15.5 15.5 12 12 8.5Z" fill="currentColor"/></svg>';
}
function renderLayerHandles(){
  if(!layerHandlesEl) return;
  layerHandlesEl.innerHTML='';
  if(!S.previewCanvas) return;

  S.mosaicLayers.forEach(layer=>{
    const box=document.createElement('div');
    box.className='layer-box';
    box.dataset.type='mosaic'; box.dataset.id=layer.id;
    layerHandlesEl.appendChild(box);

    const handle=document.createElement('div');
    handle.className='layer-handle is-mosaic';
    handle.dataset.type='mosaic'; handle.dataset.id=layer.id;
    handle.innerHTML=layerHandleIcon('mosaic');
    layerHandlesEl.appendChild(handle);

    positionLayerHandle('mosaic',layer.id);
    wireLayerHandleDrag(handle,'mosaic',layer.id);
  });

  S.stickerLayers.forEach(layer=>{
    const handle=document.createElement('div');
    handle.className='layer-handle is-sticker';
    handle.dataset.type='sticker'; handle.dataset.id=layer.id;
    handle.innerHTML=layerHandleIcon('sticker');
    layerHandlesEl.appendChild(handle);

    positionLayerHandle('sticker',layer.id);
    wireLayerHandleDrag(handle,'sticker',layer.id);
  });
}

function getLayerAndList(type,id){
  if(type==='mosaic') return S.mosaicLayers.find(l=>l.id===id);
  if(type==='sticker') return S.stickerLayers.find(l=>l.id===id);
  if(type==='text') return S.textLayers.find(l=>l.id===id);
  return null;
}

// Moves the existing DOM handle/box to match the layer's current x/y/w/h —
// used both after a drag AND after a slider edit, so the two stay in sync.
function positionLayerHandle(type,id){
  if(!layerHandlesEl) return;
  const layer=getLayerAndList(type,id);
  if(!layer) return;
  const handle=layerHandlesEl.querySelector(`.layer-handle[data-type="${type}"][data-id="${id}"]`);
  if(handle){
    handle.style.left=(layer.x*100)+'%';
    handle.style.top=(layer.y*100)+'%';
  }
  if(type==='mosaic'){
    const box=layerHandlesEl.querySelector(`.layer-box[data-type="mosaic"][data-id="${id}"]`);
    if(box){
      box.style.left=(layer.x*100)+'%';
      box.style.top=(layer.y*100)+'%';
      box.style.width=(layer.w*100)+'%';
      box.style.height=(layer.h*100)+'%';
    }
  }
}

function wireLayerHandleDrag(handle,type,id){
  const rerenderThrottled=debounce(()=>renderPreview(true),40);
  handle.addEventListener('pointerdown',(e)=>{
    e.preventDefault(); e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    S.draggingLayer={type,id};
    handle.classList.add('dragging');
    haptic();
  });
  handle.addEventListener('pointermove',(e)=>{
    if(!S.draggingLayer || S.draggingLayer.id!==id || S.draggingLayer.type!==type) return;
    e.preventDefault();
    const layer=getLayerAndList(type,id);
    if(!layer) return;
    const rect=canvasHolder.getBoundingClientRect();
    if(!rect.width || !rect.height) return;
    layer.x=clamp((e.clientX-rect.left)/rect.width,0,1);
    layer.y=clamp((e.clientY-rect.top)/rect.height,0,1);
    positionLayerHandle(type,id);
    rerenderThrottled();
    // Keep the open Edit sheet's sliders (if visible) numerically in sync.
    const sel = type==='mosaic' ? `[data-mid="${id}"]` : type==='sticker' ? `[data-sid="${id}"]` : `[data-tid="${id}"]`;
    const item=sheetBody.querySelector(`.pe-layer-item${sel}`);
    if(item){
      const xInp=item.querySelector('input[data-prop="x"]'), yInp=item.querySelector('input[data-prop="y"]');
      if(xInp) xInp.value=Math.round(layer.x*100);
      if(yInp) yInp.value=Math.round(layer.y*100);
    }
  });
  function endDrag(e){
    if(!S.draggingLayer || S.draggingLayer.id!==id || S.draggingLayer.type!==type) return;
    S.draggingLayer=null;
    handle.classList.remove('dragging');
    renderPreview(true);
    pushHistory();
  }
  handle.addEventListener('pointerup',endDrag);
  handle.addEventListener('pointercancel',endDrag);
}

/* ---- EXPORT TAB ---- */
function renderExportTab(){
  const q=S.exportQuality;
  sheetBody.innerHTML=`
    <div class="control-row"><div class="control-label"><b>Format</b></div>
      <div class="format-row">
        <button class="chip ${S.exportFormat==='jpeg'?'active':''}" data-fmt="jpeg">JPG</button>
        <button class="chip ${S.exportFormat==='png'?'active':''}" data-fmt="png">PNG</button>
        <button class="chip ${S.exportFormat==='webp'?'active':''}" data-fmt="webp">WEBP</button>
      </div>
    </div>
    <div class="control-row" id="qualityRow" style="${S.exportFormat==='png'?'display:none;':''}">
      <div class="control-label"><b>Quality</b><span class="val" id="val_quality">${qualityToPercent(q)}%</span></div>
      <input type="range" id="slider_quality" min="50" max="100" step="1" value="${qualityToPercent(q)}">
      <div class="quality-preset-row">
        <button class="chip ${q==='standard'?'active':''}" data-q="standard">Standard</button>
        <button class="chip ${q==='high'?'active':''}" data-q="high">High Quality</button>
        <button class="chip ${q==='max'?'active':''}" data-q="max">Maximum</button>
      </div>
    </div>
    <button class="export-btn" id="btnExport">
      <svg viewBox="0 0 24 24" fill="none"><path d="M12 4v11m0 0-4-4m4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Download Enhanced Photo
    </button>
    <div class="filename-preview" id="filenamePreview">${buildFilename()}</div>
  `;
  sheetBody.querySelectorAll('[data-fmt]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      S.exportFormat=btn.dataset.fmt;
      renderExportTab(); haptic();
    });
  });
  const qSlider=$('slider_quality');
  if(qSlider){
    qSlider.addEventListener('input',()=>{
      $('val_quality').textContent=qSlider.value+'%';
      S.exportQuality='custom_'+qSlider.value;
      sheetBody.querySelectorAll('[data-q]').forEach(b=>b.classList.remove('active'));
    });
  }
  sheetBody.querySelectorAll('[data-q]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      S.exportQuality=btn.dataset.q;
      renderExportTab(); haptic();
    });
  });
  $('btnExport').addEventListener('click',exportImage);
}
function qualityToPercent(q){
  if(typeof q==='string' && q.startsWith('custom_')) return parseInt(q.split('_')[1],10);
  if(q==='standard') return 65;
  if(q==='high') return 85;
  if(q==='max') return 100;
  return 85;
}
function buildFilename(){
  const ext=S.exportFormat==='jpeg'?'jpg':S.exportFormat;
  const scaleTag=S.settings.scale>1?`-${S.settings.scale}x`:'';
  const ratioTag=S.settings.aspectRatio?`-${S.settings.aspectRatio.width}x${S.settings.aspectRatio.height}`:'';
  return `photo-enhanced${scaleTag}${ratioTag}.${ext}`;
}

/* ==========================================================================
   11. UPSCALE + FULL-RES EXPORT with progress
   ========================================================================== */
function updateExportProgress(pct, statusText){
  const circumference = 2 * Math.PI * 42; // 263.89
  const offset = circumference - (pct/100) * circumference;
  progressCircle.style.strokeDashoffset = offset;
  progressPercent.textContent = Math.round(pct)+'%';
  progressFill.style.width = pct+'%';
  if(statusText) exportStatusText.innerHTML = statusText;
}

const MAX_CANVAS_DIM=8000;      // safe cross-browser/mobile canvas dimension limit
const MAX_CANVAS_PIXELS=40e6;   // safe total-pixel limit for getImageData/toBlob memory

function upscaleCanvasWithProgress(srcCanvas, factor, onProgress){
  if(factor<=1) return Promise.resolve(srcCanvas);

  // Compute the exact target size for the requested factor first (old code kept
  // doubling until it *passed* the factor, e.g. 5x silently became 8x and 10x
  // became 16x — those oversized canvases could exceed the browser's max
  // canvas size / available memory and make export fail).
  let targetW=Math.round(srcCanvas.width*factor);
  let targetH=Math.round(srcCanvas.height*factor);

  // Clamp to a safe size so export never crashes, while keeping the same
  // upscale options/UI exactly as they are.
  if(Math.max(targetW,targetH)>MAX_CANVAS_DIM){
    const s=MAX_CANVAS_DIM/Math.max(targetW,targetH);
    targetW=Math.round(targetW*s); targetH=Math.round(targetH*s);
  }
  if(targetW*targetH>MAX_CANVAS_PIXELS){
    const s=Math.sqrt(MAX_CANVAS_PIXELS/(targetW*targetH));
    targetW=Math.round(targetW*s); targetH=Math.round(targetH*s);
  }

  let cur=srcCanvas;
  let step=0;
  const totalSteps=Math.max(1, Math.ceil(Math.log2(Math.max(targetW/srcCanvas.width, targetH/srcCanvas.height, 1))));

  return new Promise((resolve)=>{
    function doStep(){
      if(S.exportCancelled){ resolve(null); return; }
      step++;
      const isLast=step>=totalSteps;
      const w=isLast?targetW:Math.min(targetW, Math.round(cur.width*2));
      const h=isLast?targetH:Math.min(targetH, Math.round(cur.height*2));
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      const cx=c.getContext('2d');
      cx.imageSmoothingEnabled=true; cx.imageSmoothingQuality='high';
      cx.drawImage(cur,0,0,w,h);
      cur=c;
      const progress = 20 + (step/totalSteps)*30;
      updateExportProgress(progress, `Mengupscale gambar... (${step}/${totalSteps})`);
      if(isLast){ resolve(cur); return; }
      setTimeout(doStep, 30);
    }
    doStep();
  });
}

async function buildFinalCanvasWithProgress(onProgress){
  // 1. Get base canvas with aspect ratio
  const srcW=S.origWidth, srcH=S.origHeight;
  let baseCanvas=S.originalCanvas;
  if(S.settings.aspectRatio){
    const ratioW=S.settings.aspectRatio.width;
    const ratioH=S.settings.aspectRatio.height;
    const targetRatio=ratioW/ratioH;
    const currentRatio=srcW/srcH;
    let canvasW=srcW, canvasH=srcH;
    if(targetRatio>currentRatio){
      canvasW=srcH*targetRatio;
      canvasH=srcH;
    }else{
      canvasW=srcW;
      canvasH=srcW/targetRatio;
    }
    const c=document.createElement('canvas');
    c.width=Math.round(canvasW); c.height=Math.round(canvasH);
    const cx=c.getContext('2d');
    cx.fillStyle='#000';
    cx.fillRect(0,0,c.width,c.height);
    const drawX=(c.width-srcW)/2, drawY=(c.height-srcH)/2;
    cx.drawImage(S.originalCanvas, drawX, drawY, srcW, srcH);
    baseCanvas=c;
  }

  // 2. Upscale
  updateExportProgress(5, 'Mempersiapkan gambar...');
  const scaled = await upscaleCanvasWithProgress(baseCanvas, S.settings.scale, onProgress);
  if(S.exportCancelled) return null;

  // 3. Apply enhancement pipeline
  updateExportProgress(60, 'Menerapkan enhancement...');
  const ctx=scaled.getContext('2d');
  let imgData=ctx.getImageData(0,0,scaled.width,scaled.height);

  const settingsForFinal={...S.settings};
  if(S.settings.scale>2){
    settingsForFinal.sharpen=clamp(settingsForFinal.sharpen+22,0,100);
    settingsForFinal.denoise=clamp(settingsForFinal.denoise+12,0,100);
  }

  if(S.exportCancelled) return null;
  const processed=await processWithWorker(imgData,settingsForFinal);
  if(S.exportCancelled) return null;
  ctx.putImageData(processed,0,0);

  // Bake community overlay layers + (if applicable) the creator watermark
  // directly into the exported pixels, so they survive sharing to other
  // apps. Runs before the file is compressed/downloaded.
  updateExportProgress(88, 'Menerapkan overlay & watermark...');
  await runOverlayHooks(ctx, scaled.width, scaled.height, true);

  updateExportProgress(90, 'Menyiapkan file...');
  return scaled;
}

/* ==========================================================================
   12. EXPORT / DOWNLOAD with modern progress
   ========================================================================== */
let exportCancelFn = null;

/* ---- PREMIUM DETECTION ----
   Everything runs on-device. A photo counts as "Premium" (costs 1 credit)
   if ANY of the currently-active edits are premium-tier. We check the
   effective values (not just preset names) so dragging a slider manually
   past the free range is still correctly detected as Premium. */
function isColorPremiumActive(){
  // When a Filter preset is active it drives these same fields, but its
  // premium status is already tracked separately via activeFilterPremium
  // (checked in isPremiumActive()) — skip the manual heuristic here so a
  // free filter's own field values don't get double-counted as premium.
  if(S.settings.activeFilter) return false;
  const p=S.settings.activePreset;
  if(p) return p!=='Natural';
  const s=S.settings;
  return s.saturation>15 || s.vibrance>15 || Math.abs(s.contrast)>15 ||
         Math.abs(s.temperature)>10 || Math.abs(s.highlights)>15 || Math.abs(s.shadows)>15;
}
function isPremiumActive(){
  const s=S.settings;
  if(s.scale>=PREMIUM_UPSCALE_MIN) return true;
  if(s.sharpen>45) return true;      // Soft(15)/Natural(35)=free, Sharp(60)/Ultra Sharp(85)=premium
  if(s.denoise>0) return true;       // Off=free, Low/Medium/High=premium
  if(s.faceDetail) return true;      // Face Detail is fully premium
  if(s.activeFilterPremium) return true;
  if(isColorPremiumActive()) return true;
  if(S.stickerLayers && S.stickerLayers.some(l=>l.premium)) return true; // PRO stickers
  return false;
}

/* ---- CREDIT CHARGING (client-side, on-device processing) ----
   Since there's no server doing the actual photo processing anymore, the
   credit deduction happens directly from the browser via a Firebase
   transaction — and only AFTER the export blob has been built successfully,
   never before. This avoids ever needing to "refund" a charge (which would
   require allowing self-increment writes, a much bigger security hole);
   the matching Firebase Rules only need to allow a self-write that's
   exactly "current - 1" and never negative, which can't be gamed into
   raising one's own balance. A technically-savvy user could still bypass
   the client-side isPremiumActive() check entirely (e.g. via devtools)
   since there's no server verifying the photo was actually processed —
   that's an inherent tradeoff of removing the cloud backend, but at worst
   it means a "free" Premium export, never a corrupted/negative balance or
   a self-inflated one. */
async function chargeCreditIfNeeded(){
  if(!S.uid){ toast('Login untuk menggunakan fitur PRO.'); return {ok:false}; }
  if(S.credits===null){ toast('Menunggu data akun. Coba lagi sebentar.','error'); return {ok:false}; }
  if(S.credits<=0){ openOutOfCreditModal(); return {ok:false}; }
  if(!firebaseDbRef){ toast('Database belum siap. Coba lagi sebentar.','error'); return {ok:false}; }
  try{
    const result=await firebaseDbRef.ref('users/'+S.uid+'/credits').transaction(current=>{
      const c=Number(current)||0;
      if(c<=0) return; // undefined return aborts the transaction
      return c-1;
    });
    if(!result.committed){ openOutOfCreditModal(); return {ok:false}; }
    return {ok:true};
  }catch(err){
    console.error('Charge credit failed', err);
    toast('Gagal menggunakan credit: '+((err&&(err.code||err.message))||'error'),'error');
    return {ok:false};
  }
}

async function exportImage(){
  if(!S.originalCanvas){ toast('Pilih foto terlebih dahulu.'); return; }

  const usesPremium=isPremiumActive();
  if(usesPremium){
    // Pre-check only (no charge yet) — avoids starting a long render just
    // to find out there's no credit.
    if(!S.uid){ toast('Login untuk menggunakan fitur PRO.'); return; }
    if(S.credits===null){ toast('Menunggu data akun. Coba lagi sebentar.','error'); return; }
    if(S.credits<=0){ openOutOfCreditModal(); return; }
  }else{
    const usage=getFreeUsage();
    if(usage.count>=CONFIG.FREE_DAILY_LIMIT){
      toast(`Batas FREE harian tercapai (${CONFIG.FREE_DAILY_LIMIT}/${CONFIG.FREE_DAILY_LIMIT}). Coba lagi besok atau gunakan fitur PRO.`,'error');
      return;
    }
  }

  S.exportCancelled = false;

  // Show export overlay — same loading animation (spinning ring + glow) as
  // the initial app loading screen, while keeping the % progress visible.
  exportOverlay.classList.add('active');
  startExportGlow();
  updateExportProgress(0, 'Memulai proses export...');

  try{
    const finalCanvas = await buildFinalCanvasWithProgress();
    if(S.exportCancelled || !finalCanvas){
      exportOverlay.classList.remove('active');
      toast('Export dibatalkan.');
      return;
    }

    const mime = S.exportFormat==='jpeg'?'image/jpeg':S.exportFormat==='png'?'image/png':'image/webp';
    const qualityValue = qualityToPercent(S.exportQuality)/100;

    updateExportProgress(95, 'Mengompresi file...');

    finalCanvas.toBlob(async (blob)=>{
      if(!blob){
        exportOverlay.classList.remove('active');
        toast('Gagal membuat file export.','error');
        return;
      }
      // Charge the credit only now that the export genuinely succeeded.
      if(usesPremium){
        const charge=await chargeCreditIfNeeded();
        if(!charge.ok){ exportOverlay.classList.remove('active'); return; }
      }
      exportOverlay.classList.remove('active');
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download=buildFilename();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
      if(!usesPremium){ incrementFreeUsage(); refreshFreeUsageUI(); }
      saveProjectRecord(finalCanvas, a.download);
      toast(usesPremium?'Foto PRO berhasil diunduh (1 credit terpakai)':'Foto berhasil diunduh','success');
    }, mime, S.exportFormat==='png'?undefined:qualityValue);

  }catch(err){
    console.error(err);
    exportOverlay.classList.remove('active');
    toast('Export gagal. Coba kurangi faktor upscale atau rasio aspek.','error');
  }
}

// Cancel export
$('exportCancelBtn').addEventListener('click',()=>{
  S.exportCancelled = true;
  exportOverlay.classList.remove('active');
  toast('Export dibatalkan.');
});

function showProcessing(show,label){
  processingOverlay.classList.toggle('active',show);
  if(label) processingOverlay.querySelector('span').textContent=label;
  else processingOverlay.querySelector('span').textContent='Processing…';
}

/* ==========================================================================
   13. HISTORY
   ========================================================================== */
const HISTORY_LIMIT=20;
const pushHistoryDebounced=debounce(()=>{
  S.history=S.history.slice(0,S.historyIndex+1);
  S.history.push(cloneSettings(S.settings));
  if(S.history.length>HISTORY_LIMIT) S.history.shift();
  S.historyIndex=S.history.length-1;
  updateUndoRedoButtons();
},120);
function pushHistory(){ pushHistoryDebounced(); }

function undo(){
  if(S.historyIndex<=0) return;
  S.historyIndex--;
  S.settings=cloneSettings(S.history[S.historyIndex]);
  renderPreview(true);
  recalcPreviewCanvas();
  refreshOpenSheet();
  updateUndoRedoButtons();
  haptic();
}
function redo(){
  if(S.historyIndex>=S.history.length-1) return;
  S.historyIndex++;
  S.settings=cloneSettings(S.history[S.historyIndex]);
  renderPreview(true);
  recalcPreviewCanvas();
  refreshOpenSheet();
  updateUndoRedoButtons();
  haptic();
}
function updateUndoRedoButtons(){
  $('btnUndo').classList.toggle('disabled',S.historyIndex<=0);
  $('btnRedo').classList.toggle('disabled',S.historyIndex>=S.history.length-1);
}
function refreshOpenSheet(){
  const activeTab=document.querySelector('.tab-btn.active');
  if(activeTab && toolSheet.classList.contains('active')){
    TABS[activeTab.dataset.tab].render();
    if(activeTab.dataset.tab==='edit') renderLayerHandles();
  }
}
$('btnUndo').addEventListener('click',undo);
$('btnRedo').addEventListener('click',redo);

function resetAll(){
  if(!S.previewCanvas){ toast('Belum ada foto untuk direset.'); return; }
  S.settings={...defaultSettings};
  renderPreview(true);
  pushHistory();
  refreshOpenSheet();
  toast('Pengaturan direset ke original');
  haptic();
}
$('btnReset').addEventListener('click',resetAll);

/* ==========================================================================
   14. EMPTY STATE / UPLOAD TRIGGERS
   ========================================================================== */
$('btnChoosePhoto').addEventListener('click',pickFile);

/* ==========================================================================
   15. SETTINGS MODAL
   ========================================================================== */
const settingsModal=$('settingsModal');
function openSettings(){ settingsModal.classList.add('active'); syncSettingsUI(); }
function closeSettings(){ settingsModal.classList.remove('active'); }
$('btnSettings').addEventListener('click',openSettings);
$('btnCloseSettings').addEventListener('click',closeSettings);
$('btnCloseSettings2').addEventListener('click',closeSettings);
settingsModal.addEventListener('click',(e)=>{ if(e.target===settingsModal) closeSettings(); });

function syncSettingsUI(){
  $('setPreviewQuality').value=S.prefs.previewQuality;
  $('setDefaultFormat').value=S.prefs.defaultFormat;
  $('setDefaultQuality').value=S.prefs.defaultQuality;
  $('setDefaultUpscale').value=String(S.prefs.defaultUpscale);
  ['autoOnLoad','hwAccel','useGpu','darkMode','haptic'].forEach(key=>{
    const el=document.querySelector(`.switch[data-key="${key}"]`);
    if(el) el.classList.toggle('on',!!S.prefs[key]);
  });
}
document.querySelectorAll('.switch[data-key]').forEach(sw=>{
  sw.addEventListener('click',()=>{
    const key=sw.dataset.key;
    S.prefs[key]=!S.prefs[key];
    sw.classList.toggle('on',S.prefs[key]);
    if(key==='darkMode') applyTheme();
    savePrefs();
    haptic();
  });
});
$('setPreviewQuality').addEventListener('change',(e)=>{ S.prefs.previewQuality=e.target.value; savePrefs(); });
$('setDefaultFormat').addEventListener('change',(e)=>{ S.prefs.defaultFormat=e.target.value; S.exportFormat=e.target.value; savePrefs(); });
$('setDefaultQuality').addEventListener('change',(e)=>{ S.prefs.defaultQuality=e.target.value; S.exportQuality=e.target.value; savePrefs(); });
$('setDefaultUpscale').addEventListener('change',(e)=>{ S.prefs.defaultUpscale=parseInt(e.target.value,10); savePrefs(); });

function applyTheme(){
  document.documentElement.setAttribute('data-theme', S.prefs.darkMode?'dark':'light');
}
function savePrefs(){
  try{ localStorage.setItem('photoEnhance.prefs', JSON.stringify(S.prefs)); }catch(err){}
}
function loadPrefs(){
  try{
    const raw=localStorage.getItem('photoEnhance.prefs');
    if(raw) Object.assign(S.prefs, JSON.parse(raw));
  }catch(err){}
  S.exportFormat=S.prefs.defaultFormat;
  S.exportQuality=S.prefs.defaultQuality;
  S.settings.scale=S.prefs.defaultUpscale||1;
  applyTheme();
}

/* ==========================================================================
   16. RESIZE HANDLING
   ========================================================================== */
window.addEventListener('resize',debounce(()=>{ if(S.previewCanvas) fitToScreen(); },150));

/* ==========================================================================
   17. LOADING SCREEN
   ========================================================================== */
// Shared "AI glow" animator — drives the same moving radial-gradient used by
// the initial app loading screen. Reused by the export overlay so both
// loading animations look and move identically.
function animateLoaderGlow(glowEl, isStillActive){
  if(!glowEl) return;
  let pos=0;
  const step=()=>{
    pos += 0.8;
    glowEl.style.background = `radial-gradient(ellipse at ${50 + Math.sin(pos/50)*25}% ${50 + Math.cos(pos/30)*25}%, rgba(255,176,32,0.3), transparent 60%)`;
    if(isStillActive()) requestAnimationFrame(step);
  };
  step();
}

function showLoadingScreen(){
  const loader=document.createElement('div');
  loader.id='appLoader';
  loader.innerHTML=`
    <div class="loader-container">
      <div class="loader-ring">
        <div class="loader-ring-inner"></div>
        <svg viewBox="0 0 24 24" fill="none" class="loader-icon">
          <path d="M4 8.5C4 7.12 5.12 6 6.5 6h1.2c.4 0 .77-.2.99-.53l.7-1.06A1.5 1.5 0 0 1 10.65 3.7h2.7c.5 0 .97.25 1.26.67l.7 1.06c.22.33.6.53.99.53h1.2C18.88 6 20 7.12 20 8.5v8c0 1.38-1.12 2.5-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-8Z" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="12" cy="12.2" r="3.4" stroke="currentColor" stroke-width="1.8"/>
        </svg>
      </div>
      <div class="loader-text">
        <span class="loader-title">Photo Enhance</span>
        <span class="loader-sub">Loading...</span>
      </div>
      <div class="loader-glow"></div>
    </div>
  `;
  document.body.prepend(loader);

  // Animate glow (shared animator)
  const glow=loader.querySelector('.loader-glow');
  animateLoaderGlow(glow, ()=>!!document.querySelector('#appLoader'));

  // Hide loading screen after app is ready
  const checkReady=()=>{
    if(document.getElementById('app')){
      setTimeout(()=>{
        const loader=document.getElementById('appLoader');
        if(loader){
          loader.classList.add('fade-out');
          setTimeout(()=>loader.remove(), 500);
        }
      }, 800);
    }else{
      setTimeout(checkReady, 100);
    }
  };
  setTimeout(checkReady, 300);
}

/* ==========================================================================
   17b. FEATURE-MODULE HOOKS — a tiny, explicit extension point so files
   loaded after this one (community.js + friends) can draw overlay layers
   and an export watermark on top of the editor's own render/export
   pipeline, and reset their own state when a new photo is loaded. This is
   purely additive: if no hook is ever registered, none of this does
   anything and the app behaves exactly as before.
   ========================================================================== */
const _overlayHooks=[];   // async fn(ctx2d, canvasWidth, canvasHeight, isExport)
const _newPhotoHooks=[];  // fn()
const _photoReadyHooks=[];// fn() — fires once a photo has fully finished loading/rendering
async function runOverlayHooks(ctx,w,h,isExport){
  for(const fn of _overlayHooks){
    try{ await fn(ctx,w,h,isExport); }catch(err){ console.error('overlay hook error',err); }
  }
}
function runNewPhotoHooks(){
  _newPhotoHooks.forEach(fn=>{ try{ fn(); }catch(err){ console.error('new-photo hook error',err); } });
}
function runPhotoReadyHooks(){
  _photoReadyHooks.forEach(fn=>{ try{ fn(); }catch(err){ console.error('photo-ready hook error',err); } });
}

/* ==========================================================================
   17c. TEXT & MOSAIC EDIT LAYERS — lightweight built-in editing tools
   (no login required). Text layers draw a text string; mosaic layers
   pixelate a rectangular region. Both are stored as fraction-of-canvas
   coordinates so they scale correctly between the interactive preview and
   the full-resolution export, and are baked in via the same overlay-hook
   extension point used by the community overlay engine. Registered here
   (early) so mosaic pixelation happens on the base photo before community
   stickers/overlays are drawn on top of it.
   ========================================================================== */
function px_applyMosaicRegion(ctx, rx, ry, rw, rh, blockPx){
  rx=Math.max(0,Math.round(rx)); ry=Math.max(0,Math.round(ry));
  rw=Math.max(1,Math.round(rw)); rh=Math.max(1,Math.round(rh));
  blockPx=Math.max(2,Math.round(blockPx));
  let imgData;
  try{ imgData=ctx.getImageData(rx,ry,rw,rh); }catch(err){ return; }
  const data=imgData.data;
  for(let by=0; by<rh; by+=blockPx){
    for(let bx=0; bx<rw; bx+=blockPx){
      const bw=Math.min(blockPx,rw-bx), bh=Math.min(blockPx,rh-by);
      let r=0,g=0,b=0,a=0,cnt=0;
      for(let y=0;y<bh;y++){
        for(let x=0;x<bw;x++){
          const idx=((by+y)*rw+(bx+x))*4;
          r+=data[idx]; g+=data[idx+1]; b+=data[idx+2]; a+=data[idx+3]; cnt++;
        }
      }
      r=Math.round(r/cnt); g=Math.round(g/cnt); b=Math.round(b/cnt); a=Math.round(a/cnt);
      for(let y=0;y<bh;y++){
        for(let x=0;x<bw;x++){
          const idx=((by+y)*rw+(bx+x))*4;
          data[idx]=r; data[idx+1]=g; data[idx+2]=b; data[idx+3]=a;
        }
      }
    }
  }
  ctx.putImageData(imgData, rx, ry);
}

function drawMosaicLayer(ctx,w,h,layer){
  const rw=w*layer.w, rh=h*layer.h;
  const rx=w*layer.x-rw/2, ry=h*layer.y-rh/2;
  const blockPx=Math.max(2, rw*(layer.block/100)*0.3);
  px_applyMosaicRegion(ctx, rx, ry, rw, rh, blockPx);
}

function drawTextLayer(ctx,w,h,layer){
  const fontPx=Math.max(8, Math.round(h*(layer.size/100)*0.12));
  ctx.save();
  ctx.globalAlpha=Math.max(0,Math.min(1,layer.opacity));
  ctx.font=`${layer.bold?'800':'600'} ${fontPx}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  ctx.translate(w*layer.x, h*layer.y);
  const lines=String(layer.text||'').split('\n');
  const lineH=fontPx*1.2;
  const startY=-((lines.length-1)*lineH)/2;
  if(layer.stroke){
    ctx.lineWidth=Math.max(1,fontPx*0.09);
    ctx.strokeStyle='rgba(0,0,0,0.65)';
    ctx.lineJoin='round';
    lines.forEach((ln,i)=>ctx.strokeText(ln,0,startY+i*lineH));
  }
  ctx.fillStyle=layer.color||'#ffffff';
  lines.forEach((ln,i)=>ctx.fillText(ln,0,startY+i*lineH));
  ctx.restore();
}

_overlayHooks.push(async (ctx,w,h)=>{
  if(S.mosaicLayers.length){
    [...S.mosaicLayers].sort((a,b)=>a.order-b.order).forEach(l=>drawMosaicLayer(ctx,w,h,l));
  }
  if(S.stickerLayers.length){
    const sorted=[...S.stickerLayers].sort((a,b)=>a.order-b.order);
    for(const l of sorted){ await drawStickerLayer(ctx,w,h,l); }
  }
  if(S.textLayers.length){
    [...S.textLayers].sort((a,b)=>a.order-b.order).forEach(l=>drawTextLayer(ctx,w,h,l));
  }
});

function addTextLayer(){
  if(!S.previewCanvas){ toast('Pilih foto dulu.'); return; }
  const layer={
    id:'t'+Date.now()+Math.random().toString(36).slice(2,6),
    text:'Teks Baru', x:0.5, y:0.5, size:40, color:'#ffffff',
    bold:true, stroke:true, opacity:1, order:S.textLayers.length+S.mosaicLayers.length
  };
  S.textLayers.push(layer);
  renderPreview(true); pushHistory(); haptic();
  return layer;
}
function addMosaicLayer(){
  if(!S.previewCanvas){ toast('Pilih foto dulu.'); return; }
  const layer={
    id:'m'+Date.now()+Math.random().toString(36).slice(2,6),
    x:0.5, y:0.5, w:0.35, h:0.35, block:45,
    order:S.textLayers.length+S.mosaicLayers.length
  };
  S.mosaicLayers.push(layer);
  renderPreview(true); pushHistory(); haptic();
  return layer;
}
function removeTextLayer(id){
  const i=S.textLayers.findIndex(l=>l.id===id);
  if(i!==-1){ S.textLayers.splice(i,1); renderPreview(true); pushHistory(); }
}
function removeMosaicLayer(id){
  const i=S.mosaicLayers.findIndex(l=>l.id===id);
  if(i!==-1){ S.mosaicLayers.splice(i,1); renderPreview(true); pushHistory(); }
}

/* ---- STICKERS ----------------------------------------------------------
   Sticker library backed by Firestore (collection "stickers"), so the
   admin (ADMIN_EMAILS, see section 3c) can add/remove stickers — and tag
   each one Free or PRO — right from inside the app, no code edits needed.

   Firestore schema — stickers/{stickerId}:
     name(string), url(ImgBB image url), premium(bool: true=PRO/1 credit,
     false=Free), addedBy(uid), addedByEmail, createdAt(serverTimestamp)

   REQUIRED Firestore Security Rules (set these in the Firebase console —
   client-side admin checks below only control what the UI *shows*; without
   matching rules any signed-in user could write to this collection):
     match /stickers/{id} {
       allow read: if request.auth != null;
       allow write: if request.auth != null &&
                    request.auth.token.email == 'opintar114@gmail.com';
     }
   (If email isn't already in the auth token, use a lookup against a trusted
   admins doc/custom claim instead — never trust request.data for this.)

   Until the admin has uploaded any stickers (or while offline/Firestore is
   unreachable), a small built-in placeholder set is shown so the picker
   isn't empty out of the box.
   ------------------------------------------------------------------------ */
function stickerPlaceholder(label,bg){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="36" fill="${bg}"/><text x="50%" y="56%" font-size="46" font-family="-apple-system,Segoe UI,sans-serif" font-weight="800" fill="#fff" text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
  return 'data:image/svg+xml,'+encodeURIComponent(svg);
}
const DEFAULT_STICKERS=[
  { id:'st_star',    name:'Star',     premium:false, url: stickerPlaceholder('★','#f5a623') },
  { id:'st_heart',   name:'Heart',    premium:false, url: stickerPlaceholder('♥','#ff5c7a') },
  { id:'st_fire',    name:'Fire',     premium:false, url: stickerPlaceholder('FIRE','#ff7a1a') },
  { id:'st_new',     name:'New',      premium:false, url: stickerPlaceholder('NEW','#2dd4bf') },
  { id:'st_crown',   name:'Crown',    premium:true,  url: stickerPlaceholder('♛','#ffd76a') },
  { id:'st_diamond', name:'Diamond',  premium:true,  url: stickerPlaceholder('◆','#5ac8ff') },
  { id:'st_verified',name:'Verified', premium:true,  url: stickerPlaceholder('✓','#4ade80') },
  { id:'st_bolt',    name:'Flash',    premium:true,  url: stickerPlaceholder('BOLT','#e69c1a') }
];
let STICKERS=DEFAULT_STICKERS.slice();
let stickersUnsub=null;

// Live Firestore listener — keeps STICKERS current the moment the admin
// uploads or deletes one, and re-renders the picker if it's open.
function subscribeStickers(){
  if(!firestoreDbRef || stickersUnsub) return;
  try{
    stickersUnsub=firestoreDbRef.collection('stickers').orderBy('createdAt','desc')
      .onSnapshot((snap)=>{
        const docs=snap.docs.map(d=>{
          const data=d.data()||{};
          return { id:d.id, name:data.name||'Stiker', premium:!!data.premium, url:data.url, fromFirestore:true };
        }).filter(s=>!!s.url);
        STICKERS = docs.length ? docs : DEFAULT_STICKERS.slice();
        if(sheetBody && sheetBody.querySelector('#stickerPickerGrid')) renderEditTab();
      },(err)=>{
        console.warn('Sticker listener error (check Firestore rules for "stickers")', err);
      });
  }catch(err){ console.warn('subscribeStickers failed', err); }
}

/* ---- STICKERS — admin-only upload/manage panel ----
   Only rendered/wired when S.isAdmin is true (email in ADMIN_EMAILS, set in
   handleAuthenticatedState). Uploads the image to ImgBB (same host already
   used for profile photos) then writes {name,url,premium} to Firestore —
   the live listener above (subscribeStickers) then pushes it to every user
   instantly, no reload needed. Real enforcement still depends on the
   Firestore rules documented above the DEFAULT_STICKERS/STICKERS block. */
function stickerAdminPanelHTML(){
  return `
    <div class="sticker-admin" id="stickerAdminBox">
      <button class="btn-ghost" id="btnToggleStickerUpload" type="button" style="width:100%;justify-content:center;">
        <i class="fa-solid fa-plus"></i> Upload Stiker Baru (Admin)
      </button>
      <div id="stickerUploadForm" style="display:none;margin-top:10px;">
        <div class="pe-thumb-pick pe-thumb-pick--sticker" id="stAdminPick">
          <span style="font-size:11px;">+ Gambar</span>
        </div>
        <input type="file" accept="image/png,image/webp,image/jpeg" id="stAdminFile" hidden>
        <input class="auth-input" id="stAdminName" placeholder="Nama stiker" maxlength="30" style="margin-top:10px;">
        <label class="admin-label" style="margin-top:10px;">Tag</label>
        <div class="chip-row">
          <button class="chip active" data-tier="free" type="button">Gratis</button>
          <button class="chip is-premium" data-tier="pro" type="button">PRO</button>
        </div>
        <button class="btn-primary" id="stAdminSubmit" style="width:100%;justify-content:center;margin-top:12px;">Unggah Stiker</button>
        <p class="admin-status" id="stAdminStatus"></p>
      </div>
    </div>`;
}

function wireStickerAdminPanel(){
  const toggleBtn=$('btnToggleStickerUpload');
  const formBox=$('stickerUploadForm');
  if(!toggleBtn || !formBox) return;

  toggleBtn.addEventListener('click',()=>{
    formBox.style.display = (formBox.style.display==='none') ? 'block' : 'none';
  });

  let file=null, tier='free';
  const pick=$('stAdminPick');
  const fileInputEl=$('stAdminFile');
  const nameInput=$('stAdminName');
  const submitBtn=$('stAdminSubmit');
  const statusEl=$('stAdminStatus');
  const setStatus=(msg,type)=>{ if(statusEl){ statusEl.textContent=msg||''; statusEl.className='admin-status'+(type?' '+type:''); } };

  pick.addEventListener('click',()=>fileInputEl.click());
  fileInputEl.addEventListener('change',(e)=>{
    const f=e.target.files[0]; if(!f) return;
    file=f;
    pick.innerHTML=`<img src="${URL.createObjectURL(f)}">`;
  });
  formBox.querySelectorAll('[data-tier]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      tier=btn.dataset.tier;
      formBox.querySelectorAll('[data-tier]').forEach(b=>b.classList.toggle('active', b===btn));
    });
  });

  submitBtn.addEventListener('click', async ()=>{
    if(!S.isAdmin){ setStatus('Hanya admin yang bisa mengunggah stiker.','error'); return; }
    const name=(nameInput.value||'').trim();
    if(!name){ setStatus('Nama stiker wajib diisi.','error'); return; }
    if(!file){ setStatus('Pilih gambar stiker dulu (PNG transparan disarankan).','error'); return; }
    if(!firestoreDbRef){ setStatus('Firestore belum siap, coba lagi sebentar.','error'); return; }
    submitBtn.disabled=true; submitBtn.textContent='Mengunggah...';
    setStatus('Mengunggah gambar...');
    try{
      const url=await uploadImageToImgbb(file);
      if(!url) throw new Error('Upload gambar gagal, coba lagi.');
      setStatus('Menyimpan stiker...');
      await firestoreDbRef.collection('stickers').add({
        name, url, premium: tier==='pro',
        addedBy: S.uid||null,
        addedByEmail: (S.userProfile && S.userProfile.email) || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      toast(`Stiker "${name}" (${tier==='pro'?'PRO':'Gratis'}) berhasil diunggah.`);
      file=null; nameInput.value=''; tier='free';
      pick.innerHTML='<span style="font-size:11px;">+ Gambar</span>';
      formBox.style.display='none';
      // subscribeStickers()'s onSnapshot will re-render the grid automatically.
    }catch(err){
      console.error('Sticker upload failed', err);
      setStatus('Gagal mengunggah: '+(err.message||'coba lagi'),'error');
    }finally{
      submitBtn.disabled=false; submitBtn.textContent='Unggah Stiker';
    }
  });
}

async function deleteStickerFromLibrary(id){
  if(!S.isAdmin){ toast('Hanya admin yang bisa menghapus stiker.'); return; }
  if(!firestoreDbRef){ toast('Firestore belum siap.'); return; }
  if(!confirm('Hapus stiker ini untuk semua pengguna?')) return;
  try{
    await firestoreDbRef.collection('stickers').doc(id).delete();
    toast('Stiker dihapus.');
    // subscribeStickers()'s onSnapshot will re-render the grid automatically.
  }catch(err){
    console.error('Sticker delete failed', err);
    toast('Gagal menghapus stiker.','error');
  }
}

const _stickerImgCache=new Map();
function loadStickerImg(url){
  if(_stickerImgCache.has(url)) return _stickerImgCache.get(url);
  const p=new Promise((resolve)=>{
    const img=new Image();
    img.crossOrigin='anonymous'; // required so ImgBB-hosted PNGs don't taint the export canvas
    img.onload=()=>resolve(img);
    img.onerror=()=>resolve(null);
    img.src=url;
  });
  _stickerImgCache.set(url,p);
  return p;
}
async function drawStickerLayer(ctx,w,h,layer){
  const img=await loadStickerImg(layer.url);
  if(!img) return;
  const drawW=w*layer.scale;
  const drawH=drawW*((img.naturalHeight/img.naturalWidth)||1);
  ctx.save();
  ctx.globalAlpha=Math.max(0,Math.min(1,layer.opacity));
  ctx.translate(w*layer.x, h*layer.y);
  ctx.rotate((layer.rotation||0)*Math.PI/180);
  ctx.drawImage(img, -drawW/2, -drawH/2, drawW, drawH);
  ctx.restore();
}
function addStickerLayer(sticker){
  if(!S.previewCanvas){ toast('Pilih foto dulu.'); return; }
  const layer={
    id:'s'+Date.now()+Math.random().toString(36).slice(2,6),
    url:sticker.url, premium:!!sticker.premium,
    x:0.5, y:0.5, scale:0.3, rotation:0, opacity:1,
    order:S.textLayers.length+S.mosaicLayers.length+S.stickerLayers.length
  };
  S.stickerLayers.push(layer);
  renderPreview(true); pushHistory(); haptic();
  toast(sticker.premium?`Stiker "${sticker.name}" — fitur PRO, 1 credit terpakai saat export`:`Stiker "${sticker.name}" ditambahkan`);
  return layer;
}
function removeStickerLayer(id){
  const i=S.stickerLayers.findIndex(l=>l.id===id);
  if(i!==-1){ S.stickerLayers.splice(i,1); renderPreview(true); pushHistory(); }
}

/* ==========================================================================
   18. INIT
   ========================================================================== */
window.addEventListener('online',()=>{ if(toolSheet.classList.contains('active')) refreshOpenSheet(); });
window.addEventListener('offline',()=>{
  if(toolSheet.classList.contains('active')) refreshOpenSheet();
  // Photo processing is fully on-device, so being offline doesn't block it.
  // Only login / credit sync needs a connection.
});

function init(){
  showLoadingScreen();
  loadPrefs();
  S.worker=buildWorker();
  if(!S.worker){ S.prefs.hwAccel=false; }
  updateUndoRedoButtons();
  refreshFreeUsageUI();
  updateCreditsUI();
  initFirebase();
}
init();

/* ==========================================================================
   19. BRIDGE — small, explicit surface exposed to separately-loaded feature
   modules (e.g. community.js). Everything else in this file stays private
   inside the closure. Values that change after load (uid, firestore ref,
   etc.) are exposed as getter functions so modules always read the current
   value instead of a stale snapshot taken at load time.
   ========================================================================== */
window.PEBridge = {
  $,
  state: S,
  toast,
  haptic,
  formatBytes,
  debounce,
  isValidUsername,
  uploadImageToImgbb,
  getFirebase: ()=> (typeof firebase!=='undefined' ? firebase : null),
  getFirestore: ()=> firestoreDbRef,
  getAuth: ()=> firebaseAuthRef,
  getUid: ()=> S.uid,
  getUserProfile: ()=> S.userProfile,
  goToPage,
  registerPage(name){
    if(PAGES.indexOf(name)===-1) PAGES.push(name);
  },

  // ---- Extension points for community.js + friends (see section 17b) ----
  registerOverlayHook(fn){ _overlayHooks.push(fn); },
  registerNewPhotoHook(fn){ _newPhotoHooks.push(fn); },
  registerPhotoReadyHook(fn){ _photoReadyHooks.push(fn); },
  pickFile,
  renderPreview,
  recalcPreviewCanvas,
  pushHistory,
  updateUndoRedoButtons,
  refreshOpenSheet,
  cloneSettings
};

})();