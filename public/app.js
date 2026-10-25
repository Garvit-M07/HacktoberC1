// NET X client - vanilla JS, no build step.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const ago = (ts) => {
  const d = (Date.now() - ts) / DAY;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return Math.round(d * 24) + 'h ago';
  if (d < 30) return Math.round(d) + 'd ago';
  if (d < 365) return Math.round(d / 30) + 'mo ago';
  return (d / 365).toFixed(1) + 'y ago';
};
const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);
const fmtM = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

const S = {
  token: localStorage.getItem('ni_token'),
  me: null, mesh: null, view: { kind: 'mine' }, selected: null, hover: null,
  zoom: 1, pan: { x: 0, y: 0 }, history: [], tts: false, nearbySeen: new Set(), locWatch: null,
  findQ: '',
};

// ---------------- api ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && !path.includes('login')) { logout(true); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------- terminal ----------------
function print(text, cls = 'sys') {
  const el = document.createElement('div');
  el.className = 'l ' + cls;
  el.textContent = text;
  $('#log').append(el);
  $('#log').scrollTop = 1e9;
  return el;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.value = 0.05;
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.12); o.stop(ctx.currentTime + i * 0.12 + 0.09);
    });
  } catch {}
}
function speak(text) {
  if (!S.tts || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[-*#>]/g, ' '));
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

// ---------------- voice (Web Speech API) ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen({ onInterim, onFinal, button }) {
  if (!SR) { print('Voice input needs Chrome or Edge (Web Speech API). Type instead.', 'err'); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true; rec.interimResults = true;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    onInterim?.((finalText + interim).trim());
  };
  rec.onerror = (e) => print('mic: ' + e.error, 'err');
  rec.onend = () => {
    button?.classList.remove('live');
    rec = null;
    if (finalText.trim()) onFinal(finalText.trim());
  };
  button?.classList.add('live');
  rec.start();
}

// ---------------- auth ----------------
let authMode = 'login';
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  authMode = b.dataset.mode;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#authForm').classList.toggle('register', authMode === 'register');
});
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#authErr').textContent = '';
  try { await afterAuth(await api('/api/' + authMode, { body: f })); }
  catch (err) { $('#authErr').textContent = err.message; }
};

async function afterAuth(r) {
  S.token = r.token; localStorage.setItem('ni_token', r.token);
  S.justJoined = r;
  await boot();
}

// ---- Google sign-in: Firebase Authentication (preferred) or Google Identity Services ----
const FB_SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
async function initGoogle() {
  const cfg = await api('/api/config').catch(() => ({}));
  if (cfg.firebase) {
    try {
      const { initializeApp } = await import(`${FB_SDK}/firebase-app.js`);
      const fbAuth = await import(`${FB_SDK}/firebase-auth.js`);
      const auth = fbAuth.getAuth(initializeApp(cfg.firebase));
      const provider = new fbAuth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      S.fbSignOut = () => fbAuth.signOut(auth);
      const btn = $('#btnFirebaseGoogle');
      btn.hidden = false; $('#gsiWrap').hidden = false;
      btn.onclick = async () => {
        $('#authErr').textContent = '';
        btn.textContent = 'CONNECTING…';
        try {
          const cred = await fbAuth.signInWithPopup(auth, provider);
          const idToken = await cred.user.getIdToken();
          await afterAuth(await api('/api/auth/firebase', { body: { idToken } }));
        } catch (err) {
          $('#authErr').textContent = err.code === 'auth/popup-closed-by-user' ? '' : (err.code === 'auth/unauthorized-domain'
            ? `Add ${location.hostname} to Firebase → Authentication → Settings → Authorized domains` : err.message);
        } finally { btn.innerHTML = '<span class="g">G</span> CONTINUE WITH GOOGLE'; }
      };
      return;
    } catch (e) { console.warn('firebase sdk failed', e); }
  }
  if (!cfg.googleClientId) return;
  await new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = ok; sc.onerror = fail;
    document.head.append(sc);
  }).catch(() => { $('#authErr').textContent = 'Could not load Google sign-in'; });
  if (!window.google?.accounts?.id) return;
  google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogleCredential });
  google.accounts.id.renderButton($('#gsiBtn'), { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', width: 300 });
  $('#gsiWrap').hidden = false;
}
async function onGoogleCredential({ credential }) {
  $('#authErr').textContent = '';
  try { await afterAuth(await api('/api/auth/google', { body: { credential } })); }
  catch (err) { $('#authErr').textContent = err.message; }
}

// ---------------- onboarding: who are you? -> is this you? ----------------
function showOnboarding(prefill = {}) {
  $('#auth').hidden = true; $('#app').hidden = true; $('#onboard').hidden = false;
  $('#obForm').hidden = false; $('#obScan').hidden = true; $('#obResults').hidden = true;
  const f = $('#obForm');
  const p = prefill.profile || {};
  const set = (n, v) => { if (f.elements[n]) f.elements[n].value = v ?? ''; };
  set('name', prefill.name); set('phone', prefill.phone || '');
  for (const k of ['dob', 'city', 'school', 'field', 'role', 'workplace']) set(k, p[k]);
  set('languages', (p.languages || []).join(', ')); set('interests', (p.interests || []).join(', '));
  for (const k of ['linkedin', 'github', 'instagram']) set(k, p.socials?.[k]);
  $('#obSkip').hidden = !!prefill.editing;
  f.elements.name.focus();
}
// voice / free-text -> form
$('#obMic').onclick = () => listen({
  button: $('#obMic'),
  onInterim: (t) => { $('#obAbout').value = t; },
  onFinal: (t) => { $('#obAbout').value = t; $('#obFill').click(); },
});
$('#obFill').onclick = async () => {
  if (rec) rec.stop();
  const text = $('#obAbout').value.trim();
  if (!text) { $('#obFillStatus').textContent = 'say or type something first'; return; }
  const f = $('#obForm');
  const touched = new Set(); // fields the person edited by hand while Gemma was thinking
  f.querySelectorAll('.grid2 input, .grid3 input, label > input').forEach((el) => { el.oninput = () => touched.add(el.name); });
  const fill = (p) => {
    let n = 0;
    for (const k of ['name', 'dob', 'city', 'phone', 'school', 'field', 'role', 'workplace', 'languages', 'interests', 'linkedin', 'github', 'instagram']) {
      const el = f.elements[k], v = p[k];
      if (!el || touched.has(k) || v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      const val = Array.isArray(v) ? v.join(', ') : v;
      if (el.value === val) continue;
      el.value = val; el.classList.remove('filled'); void el.offsetWidth; el.classList.add('filled'); n++;
    }
    return n;
  };
  const seq = (S.fillSeq = (S.fillSeq || 0) + 1);
  try {
    // 1) instant rough fill
    const quick = await api('/api/onboarding/parse', { body: { text, fast: true } });
    fill(quick);
    $('#obFillStatus').innerHTML = '<span class="loading">gemma is refining… (~30s)</span> you can keep editing meanwhile';
    // 2) Gemma's careful read replaces it
    const p = await api('/api/onboarding/parse', { body: { text } });
    if (seq !== S.fillSeq) return;
    const n = fill(p);
    $('#obFillStatus').textContent = p.source === 'gemma' ? `gemma updated ${n} field${n === 1 ? '' : 's'} - check them, then scan.` : 'gemma unavailable, kept the quick fill - check the fields.';
  } catch (err) { $('#obFillStatus').textContent = err.message; }
};
$('#obSkip').onclick = async () => {
  await api('/api/onboarding', { body: { name: S.me.name } }).catch(() => {});
  enterApp();
};
$('#obForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('#obErr').textContent = '';
  $('#obForm').hidden = true; $('#obScan').hidden = false;
  const log = $('#obScanLog'); log.innerHTML = '';
  const line = (t, red) => { const d = document.createElement('div'); if (red) d.className = 'r'; d.textContent = t; log.append(d); };
  const steps = ['> indexing your profile…', '> scanning shadow profiles created by people you may have met…',
    `> comparing name, school${f.workplace ? ', workplace' : ''}${f.languages ? ', languages' : ''}…`, '> asking gemma 4 to double-check candidates…'];
  let i = 0; const tick = setInterval(() => { if (i < steps.length) line(steps[i++]); }, 450);
  try {
    const [r] = await Promise.all([api('/api/onboarding', { body: f }), new Promise((ok) => setTimeout(ok, 1900))]);
    clearInterval(tick); while (i < steps.length) line(steps[i++]);
    line(`> ${r.you.length} possible match${r.you.length === 1 ? '' : 'es'} · ${r.similar.length} people like you`, true);
    await new Promise((ok) => setTimeout(ok, 500));
    S.me = { ...S.me, name: f.name };
    renderMatches(r);
  } catch (err) {
    clearInterval(tick); $('#obScan').hidden = true; $('#obForm').hidden = false; $('#obErr').textContent = err.message;
  }
};

function renderMatches(r) {
  $('#obScan').hidden = true; $('#obResults').hidden = false;
  $('#obYou').innerHTML = r.you.length ? r.you.map((m) => `
    <div class="match ${m.verdict === 'same' ? 'same' : ''}" data-p="${m.personId}">
      <div class="pct">${m.confidence}%<small>${m.verdict === 'same' ? 'LIKELY YOU' : 'MAYBE'}</small></div>
      <div>
        <div class="nm">${esc(m.name)}</div>
        <div class="why">indexed by ${esc(m.indexedBy.join(', ') || 'someone')}${m.metAt.length ? ' · met at ' + esc(m.metAt.join(', ')) : ''}</div>
        <div class="why">matched on: ${esc(m.reasons.join(' · '))}</div>
        ${m.why ? `<div class="why">gemma: ${esc(m.why)}</div>` : ''}
      </div>
      <div class="acts"><button class="btn primary" data-claim>THAT'S ME</button><button class="btn" data-dismiss>NOT ME</button></div>
    </div>`).join('') : '<p class="dim">No existing profiles matched. Nobody has indexed you yet, so you\'re starting fresh.</p>';
  $('#obSimilar').innerHTML = r.similar.length ? r.similar.map((s) => `
    <div class="match" data-u="${s.user.id}">
      <div class="pct">${s.score}<small>OVERLAP</small></div>
      <div><div class="nm">${esc(s.user.name)} <span class="dim">@${esc(s.user.handle)}</span></div>
        <div class="why">${esc(s.user.headline || '')}</div><div class="why">${esc(s.reasons.join(' · '))}</div></div>
      <div class="acts"><button class="btn" data-connect>+ CONNECT</button></div>
    </div>`).join('') : '<p class="dim">Nobody with an overlapping profile yet.</p>';
  $('#obYou').querySelectorAll('.match').forEach((el) => {
    const pid = el.dataset.p;
    el.querySelector('[data-claim]').onclick = async (ev) => {
      ev.target.textContent = 'CLAIMING…';
      try {
        const res = await api('/api/claim/' + pid, { method: 'POST' });
        el.classList.add('done'); el.querySelector('.acts').innerHTML = `<span class="badge solid">CLAIMED · ${res.merged} records</span>`;
        S.claimedCount = (S.claimedCount || 0) + res.merged;
      } catch (err) { ev.target.textContent = "THAT'S ME"; toast(err.message); }
    };
    el.querySelector('[data-dismiss]').onclick = async () => {
      await api(`/api/matches/${pid}/dismiss`, { method: 'POST' }).catch(() => {});
      el.remove();
    };
  });
  $('#obSimilar').querySelectorAll('.match').forEach((el) => {
    el.querySelector('[data-connect]').onclick = async (ev) => {
      await api('/api/connect/' + el.dataset.u, { method: 'POST' });
      ev.target.textContent = '✓ ADDED'; ev.target.disabled = true;
    };
  });
}
$('#obEnter').onclick = () => enterApp();

async function logout(silent) {
  if (!silent) await api('/api/logout', { method: 'POST' }).catch(() => {});
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch {}
  try { await S.fbSignOut?.(); } catch {}
  localStorage.removeItem('ni_token'); S.token = null;
  if (S.locWatch) navigator.geolocation.clearWatch(S.locWatch);
  location.reload();
}
$('#btnLogout').onclick = () => logout();

async function boot() {
  const r = await api('/api/me');
  S.me = r.user;
  if (S.me.needsOnboarding) return showOnboarding(S.me);
  await enterApp(r);
}

let appStarted = false;
async function enterApp(meResp) {
  const r = meResp || await api('/api/me');
  S.me = r.user;
  $('#auth').hidden = true; $('#onboard').hidden = true; $('#app').hidden = false;
  if (appStarted) { await loadMesh(); return; }
  appStarted = true;
  print(`NET X online. user=${S.me.handle} · ${r.stats.contacts} people indexed · ${r.stats.indexedBy} people indexed you`);
  const j = S.justJoined; S.justJoined = null;
  if (j?.claimed || S.claimedCount) {
    print(`SHADOW PROFILE CLAIMED. ${r.stats.indexedBy} people had already indexed you before you joined.`, 'alert');
    toast(`Welcome! ${r.stats.indexedBy} people already know you here. Open MY PROFILE.`);
  } else if (j?.isNew) print(`Welcome @${S.me.handle}. Hit ● LOG MEETING to index the first person you meet.`);
  print('Type a question for the agent, or /help. Click any dot to inspect.');
  api('/api/health').then((h) => setStatus(h)).catch(() => {});
  setLocButton();
  if (S.me.shareLocation) startLocation();
  await loadMesh();
  pollNearby();
  setInterval(pollNearby, 15000);
}
function setStatus(h) {
  $('#status').textContent = `${h.model} · key ${h.hasKey ? 'ok' : 'MISSING'}${h.gemma?.ok === false ? ' · gemma err' : ''} · ${/firestore/.test(h.storage) ? 'firebase' : 'local db'}${h.storageError ? ' · DB ERR' : ''}`;
}

// ---------------- mesh data + layout ----------------
const cv = $('#mesh'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = window.devicePixelRatio || 1;
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resize).observe(cv);

const MAX_DAYS = 1095; // 3 years = outer edge
const RINGS = [[0, 'NOW'], [7, '1W'], [30, '1M'], [180, '6M'], [365, '1Y'], [730, '2Y'], [1095, '3Y+']];
const depthOf = (days) => Math.min(1, Math.log1p(Math.max(0, days)) / Math.log1p(MAX_DAYS)); // 0 front .. 1 back
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; }

async function loadMesh() {
  const data = S.view.kind === 'mine' ? await api('/api/mesh') : await api('/api/network/' + S.view.pid);
  layout(data);
  S.mesh = data;
  $('#viewBanner').hidden = S.view.kind === 'mine';
  if (S.view.kind !== 'mine') $('#viewBanner').textContent = `VIEWING ${data.owner.name.toUpperCase()}'S MESH · read-only · click / ESC to return`;
}

// Static layout: angle = sector by main tag (stable hash inside), radius = time since last met.
function layout(data) {
  const groups = {};
  for (const n of data.nodes) (groups[n.tags?.[0] || 'other'] ||= []).push(n);
  const names = Object.keys(groups).sort();
  const total = data.nodes.length || 1;
  let start = -Math.PI / 2;
  data.sectors = [];
  for (const g of names) {
    const list = groups[g].sort((a, b) => hash(a.personId) - hash(b.personId));
    const span = (Math.PI * 2 * list.length) / total;
    list.forEach((n, i) => {
      n.angle = start + span * ((i + 0.5) / list.length) + (hash(n.personId + 'j') - 0.5) * span * 0.25 / list.length;
      n.days = (Date.now() - n.lastMet) / DAY;
      n.depth = depthOf(n.days);
    });
    data.sectors.push({ name: g, start, span });
    start += span;
  }
}

function geom() {
  const cx = W / 2 + S.pan.x, cy = H / 2 + S.pan.y;
  const R = Math.min(W, H) * 0.46 * S.zoom;
  const r0 = R * 0.18;
  return { cx, cy, R, r0 };
}
function nodePos(n, g) {
  // nearby close friends get pulled right next to you
  // nearby close friends sit INSIDE the 'now' ring, right next to you (closer = nearer)
  const r = n.nearby ? g.r0 * (0.62 + 0.3 * Math.min(1, (n.meters || 0) / (S.mesh.nearbyRadius || 500))) : g.r0 + (g.R - g.r0) * n.depth;
  return { x: g.cx + Math.cos(n.angle) * r, y: g.cy + Math.sin(n.angle) * r, r };
}

// ---------------- render ----------------
function draw(time) {
  requestAnimationFrame(draw);
  if (!S.mesh || !W) return;
  const g = geom();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

  // background web: spokes + rings
  ctx.lineWidth = 1;
  for (let a = 0; a < 48; a++) {
    const ang = (a / 48) * Math.PI * 2;
    ctx.strokeStyle = a % 4 ? 'rgba(255,31,61,0.05)' : 'rgba(255,31,61,0.1)';
    ctx.beginPath(); ctx.moveTo(g.cx, g.cy); ctx.lineTo(g.cx + Math.cos(ang) * g.R * 1.06, g.cy + Math.sin(ang) * g.R * 1.06); ctx.stroke();
  }
  ctx.font = '11px JetBrains Mono, monospace';
  for (const [d, label] of RINGS) {
    const r = g.r0 + (g.R - g.r0) * depthOf(d);
    ctx.strokeStyle = d === 0 ? 'rgba(255,31,61,0.25)' : 'rgba(255,31,61,0.16)';
    ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.arc(g.cx, g.cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    if (d) { ctx.fillStyle = 'rgba(255,31,61,0.55)'; ctx.fillText(label, g.cx + 4, g.cy - r - 3); }
  }
  // sector labels
  ctx.fillStyle = 'rgba(242,242,242,0.28)';
  ctx.font = '600 10px JetBrains Mono, monospace';
  for (const s of S.mesh.sectors) {
    const a = s.start + s.span / 2, r = g.R * 1.1;
    ctx.textAlign = 'center';
    ctx.fillText(s.name.toUpperCase(), g.cx + Math.cos(a) * r, g.cy + Math.sin(a) * r);
  }
  ctx.textAlign = 'left';

  const pos = new Map(S.mesh.nodes.map((n) => [n.personId, nodePos(n, g)]));
  const focus = S.hover || S.selected;
  const focusId = focus?.personId;
  const neighbors = new Set();
  if (focusId) for (const e of S.mesh.edges) { if (e.a === focusId) neighbors.add(e.b); if (e.b === focusId) neighbors.add(e.a); }

  // spokes from you
  for (const n of S.mesh.nodes) {
    const p = pos.get(n.personId);
    ctx.strokeStyle = n.nearby ? 'rgba(255,255,255,0.5)' : `rgba(255,31,61,${0.04 + (1 - n.depth) * 0.08})`;
    ctx.beginPath(); ctx.moveTo(g.cx, g.cy); ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  // edges: people who know each other
  for (const e of S.mesh.edges) {
    const a = pos.get(e.a), b = pos.get(e.b);
    if (!a || !b) continue;
    const hot = focusId && (e.a === focusId || e.b === focusId);
    const na = S.mesh.nodes.find((n) => n.personId === e.a), nb = S.mesh.nodes.find((n) => n.personId === e.b);
    const alpha = 0.2 + (1 - (na.depth + nb.depth) / 2) * 0.45;
    ctx.strokeStyle = hot ? 'rgba(242,242,242,0.95)' : focusId ? `rgba(255,31,61,${alpha * 0.35})` : `rgba(255,31,61,${alpha})`;
    ctx.lineWidth = hot ? 1.6 : 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.lineWidth = 1;

  // nodes back-to-front so recent ones sit "in front"
  const q = S.findQ.toLowerCase();
  const sorted = [...S.mesh.nodes].sort((a, b) => b.depth - a.depth);
  for (const n of sorted) {
    const p = pos.get(n.personId);
    const front = 1 - n.depth;
    const size = n.nearby ? 7 : (3 + front * 8) * Math.min(1.6, Math.max(0.8, S.zoom));
    p.size = size;
    const dimmed = (focusId && n.personId !== focusId && !neighbors.has(n.personId)) || (q && !n.name.toLowerCase().includes(q));
    const alpha = dimmed ? 0.18 : 0.35 + front * 0.65;

    if (n.nearby) { // pulse ring (dot itself doesn't move)
      const ph = (time / 1200) % 1;
      ctx.strokeStyle = `rgba(255,31,61,${1 - ph})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, size + 4 + ph * 26, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    if (n.onPlatform || n.nearby) { ctx.fillStyle = n.nearby ? '#f2f2f2' : `rgba(255,31,61,${alpha})`; ctx.fill(); }
    else { ctx.fillStyle = '#000'; ctx.fill(); ctx.strokeStyle = `rgba(255,31,61,${alpha})`; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
    if (n.closeFriend) { ctx.strokeStyle = `rgba(242,242,242,${alpha})`; ctx.beginPath(); ctx.arc(p.x, p.y, size + 3, 0, Math.PI * 2); ctx.stroke(); }
    if (n.youKnow) { ctx.strokeStyle = '#f2f2f2'; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(p.x, p.y, size + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    if (n === S.selected || n.personId === S.selected?.personId) {
      ctx.strokeStyle = '#f2f2f2'; ctx.strokeRect(p.x - size - 6, p.y - size - 6, (size + 6) * 2, (size + 6) * 2);
    }
    // labels: front nodes, focused, neighbors, zoomed in
    const showLabel = !dimmed && (front > 0.45 || S.zoom > 1.6 || n.personId === focusId || neighbors.has(n.personId) || n.nearby || (q && n.name.toLowerCase().includes(q)));
    if (showLabel) {
      ctx.font = `${n.personId === focusId ? 600 : 400} ${10 + front * 3}px JetBrains Mono, monospace`;
      ctx.fillStyle = n.personId === focusId || n.nearby ? '#f2f2f2' : `rgba(242,242,242,${0.4 + front * 0.6})`;
      const lx = n.nearby && Math.cos(n.angle) < 0 ? p.x - size - 5 - ctx.measureText(n.name).width : p.x + size + 5;
      ctx.fillText(n.name, lx, p.y + 4);
      if (n.nearby) { ctx.fillStyle = '#ff1f3d'; ctx.font = '600 11px JetBrains Mono, monospace'; ctx.fillText(`◉ ${fmtM(n.meters)} away`, lx, p.y + 18); }
    }
  }

  // you / owner at center
  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath(); ctx.arc(g.cx, g.cy, 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ff1f3d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(g.cx, g.cy, 12, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
  ctx.font = '600 12px JetBrains Mono, monospace'; ctx.fillStyle = '#f2f2f2';
  ctx.textAlign = 'center';
  ctx.fillText(S.view.kind === 'mine' ? 'YOU' : S.mesh.owner.name.toUpperCase(), g.cx, g.cy - 20);
  ctx.textAlign = 'left';

  // hover tooltip
  if (S.hover) {
    const p = pos.get(S.hover.personId);
    const lines = [S.hover.name, `last met ${ago(S.hover.lastMet)}`, S.hover.onPlatform ? 'on network' : 'shadow profile'];
    if (S.hover.place) lines.push('@ ' + S.hover.place);
    ctx.font = '11px JetBrains Mono, monospace';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    let x = p.x + 14, y = p.y - 10 - lines.length * 15;
    if (x + w > W) x = p.x - w - 14; if (y < 4) y = p.y + 14;
    ctx.fillStyle = 'rgba(0,0,0,0.92)'; ctx.fillRect(x, y, w, lines.length * 15 + 10);
    ctx.strokeStyle = '#ff1f3d'; ctx.strokeRect(x, y, w, lines.length * 15 + 10);
    lines.forEach((l, i) => { ctx.fillStyle = i ? '#8a8a8a' : '#f2f2f2'; ctx.fillText(l, x + 8, y + 18 + i * 15); });
  }
  S._pos = pos;
}
requestAnimationFrame(draw);

// ---------------- interaction ----------------
function hit(x, y) {
  if (!S._pos) return null;
  let best = null, bd = Infinity;
  for (const n of S.mesh.nodes) {
    const p = S._pos.get(n.personId);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < Math.max(10, (p.size || 5) + 5) && d < bd) { bd = d; best = n; }
  }
  return best;
}
let drag = null;
cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, px: S.pan.x, py: S.pan.y, moved: false }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => {
  const r = cv.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { S.pan.x = drag.px + dx; S.pan.y = drag.py + dy; return; }
  }
  S.hover = hit(e.clientX - r.left, e.clientY - r.top);
  cv.style.cursor = S.hover ? 'pointer' : 'crosshair';
});
cv.addEventListener('pointerup', (e) => {
  const r = cv.getBoundingClientRect();
  const wasDrag = drag?.moved; drag = null;
  if (wasDrag) return;
  const n = hit(e.clientX - r.left, e.clientY - r.top);
  if (n) select(n); else if (S.view.kind === 'mine') closePanel();
});
cv.addEventListener('pointerleave', () => { S.hover = null; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0015);
  S.zoom = Math.min(5, Math.max(0.4, S.zoom * f));
}, { passive: false });
$('#viewBanner').onclick = () => backToMine();
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else if (S.view.kind !== 'mine') backToMine(); else closePanel(); }
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); $('#find').hidden = false; $('#find').focus(); }
  if (e.key === '0') { S.zoom = 1; S.pan = { x: 0, y: 0 }; }
});
$('#find').oninput = (e) => { S.findQ = e.target.value; };
$('#find').onkeydown = (e) => {
  if (e.key === 'Enter') { const n = S.mesh.nodes.find((x) => x.name.toLowerCase().includes(S.findQ.toLowerCase())); if (n) select(n); }
  if (e.key === 'Escape') { S.findQ = ''; e.target.value = ''; e.target.hidden = true; }
};

async function backToMine() { S.view = { kind: 'mine' }; S.selected = null; closePanel(); S.zoom = 1; S.pan = { x: 0, y: 0 }; await loadMesh(); }

// ---------------- side panel: everything about a person, in pointers ----------------
function closePanel() { $('#panel').hidden = true; S.selected = null; }
const li = (k, v, cls = '') => `<li class="${cls}">${k ? `<span class="k">${esc(k)}:</span> ` : ''}${esc(v)}</li>`;

async function select(n) {
  S.selected = n;
  const panel = $('#panel');
  panel.hidden = false;
  if (S.view.kind !== 'mine') { // someone else's mesh: public info only
    panel.innerHTML = `<button class="btn x" data-a="close">ESC</button><h2>${esc(n.name)}</h2>
      <div>${n.onPlatform ? '<span class="badge solid">ON NETWORK</span>' : '<span class="badge">SHADOW</span>'}${n.youKnow ? '<span class="badge w">YOU KNOW THEM</span>' : ''}</div>
      <h3>IN ${esc(S.mesh.owner.name.toUpperCase())}'S NETWORK</h3>
      <ul class="ptr">${li('context', (n.tags || []).join(', ') || '—')}${li('last met them', ago(n.lastMet))}</ul>
      <p class="dim small">Private notes are never shared. Ask ${esc(S.mesh.owner.name.split(' ')[0])} for an intro.</p>`;
    panel.querySelector('[data-a=close]').onclick = closePanel;
    return;
  }
  panel.innerHTML = '<p class="loading">LOADING…</p>';
  const c = await api('/api/contacts/' + n.contactId);
  renderContact(c);
}

function renderContact(c) {
  const panel = $('#panel');
  const cs = c.closeStatus;
  const pub = Object.entries(c.public || {}), priv = Object.entries(c.private || {});
  panel.innerHTML = `
    <button class="btn x" data-a="close">ESC</button>
    <h2>${esc(c.name)}</h2>
    <div>${c.onPlatform ? `<span class="badge solid">ON NETWORK @${esc(c.platform.handle)}</span>` : '<span class="badge">SHADOW PROFILE</span>'}
      ${c.closeFriend ? '<span class="badge w">CLOSE FRIEND</span>' : ''}${(c.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>
    <h3>OVERVIEW</h3>
    <ul class="ptr">
      ${li('first met', `${fmtDate(c.metAt)}${c.place ? ' @ ' + c.place : ''}`)}
      ${li('last met', ago(c.lastMet))}
      ${li('conversations', c.interactions.length)}
      ${c.onPlatform && c.platform.headline ? li('their headline', c.platform.headline) : ''}
      ${cs ? (cs.nearby ? li('distance', `${fmtM(cs.meters)} — NEARBY NOW`, 'near') : cs.meters != null ? li('distance', fmtM(cs.meters)) :
        li('proximity', !cs.onPlatform ? 'not on network yet' : !cs.mutual ? "waiting for them to add you as close friend" : 'location unavailable')) : ''}
    </ul>
    <h3>PUBLIC</h3>
    <ul class="ptr">${pub.length ? pub.map(([k, v]) => li(k, v)).join('') : '<li class="dim">nothing yet</li>'}</ul>
    <h3>PRIVATE · ONLY YOU</h3>
    <ul class="ptr">${priv.length ? priv.map(([k, v]) => li(k, v, 'private')).join('') : '<li class="dim private">nothing yet</li>'}</ul>
    <h3>WANTS / NEEDS</h3>
    <ul class="ptr">${(c.needs || []).length ? c.needs.map((x) => li('', x)).join('') : '<li class="dim">unknown — log a conversation</li>'}</ul>
    <div id="insight"></div>
    <h3>KNOWS (IN YOUR MESH)</h3>
    <ul class="ptr">${c.mutuals.length ? c.mutuals.map((m) => `<li><a href="#" data-p="${m.personId}" style="color:inherit">${esc(m.name)}</a></li>`).join('') : '<li class="dim">no links yet</li>'}</ul>
    <h3>CONVERSATIONS</h3>
    ${[...c.interactions].reverse().map((i) => `<div class="convo"><div class="d">${fmtDate(i.ts)}</div>${esc(i.summary || i.text)}</div>`).join('')}
    <h3>ACTIONS</h3>
    <div class="actions">
      <button class="btn rec" data-a="voice">● LOG CONVO</button>
      <button class="btn" data-a="type">+ NOTE</button>
      <button class="btn" data-a="insight">GEMMA INSIGHT</button>
      <button class="btn" data-a="ask">ASK AGENT</button>
      <button class="btn ${c.closeFriend ? 'on' : ''}" data-a="close-friend">${c.closeFriend ? '★ CLOSE FRIEND' : '☆ CLOSE FRIEND'}</button>
      ${c.onPlatform ? '<button class="btn" data-a="mesh">VIEW THEIR MESH</button>' : ''}
      <button class="btn" data-a="edit">EDIT</button>
      <button class="btn" data-a="delete">DELETE</button>
    </div>`;
  if (c.insight) renderInsight(c.insight);
  panel.querySelectorAll('[data-p]').forEach((a) => a.onclick = (e) => { e.preventDefault(); const n = S.mesh.nodes.find((x) => x.personId === a.dataset.p); if (n) select(n); });
  const act = (a, fn) => { const b = panel.querySelector(`[data-a="${a}"]`); if (b) b.onclick = fn; };
  act('close', closePanel);
  act('insight', () => loadInsight(c, true));
  act('ask', () => { $('#cmdInput').value = `What does ${c.name.split(' ')[0]} want or need, and how can I help?`; $('#cmdInput').focus(); });
  act('close-friend', async () => {
    await api('/api/contacts/' + c.id, { method: 'PATCH', body: { closeFriend: !c.closeFriend } });
    print(`${c.name} ${c.closeFriend ? 'removed from' : 'added to'} close friends.${!c.closeFriend && c.onPlatform ? ' Pings work once they add you back.' : ''}`);
    await loadMesh(); select(S.mesh.nodes.find((n) => n.contactId === c.id));
  });
  act('mesh', async () => { S.view = { kind: 'other', pid: c.personId }; closePanel(); try { await loadMesh(); } catch (e) { print(e.message, 'err'); S.view = { kind: 'mine' }; await loadMesh(); } });
  act('edit', () => openContactForm({ ...c, transcript: '' }, c.id));
  act('delete', async () => { if (!confirm(`Delete ${c.name} from your index?`)) return; await api('/api/contacts/' + c.id, { method: 'DELETE' }); closePanel(); await loadMesh(); print(`${c.name} deleted.`); });
  act('voice', () => logConversation(c, true));
  act('type', () => logConversation(c, false));
}

async function loadInsight(c, refresh) {
  const box = $('#insight');
  box.innerHTML = '<h3>GEMMA INSIGHT</h3><p class="loading">thinking…</p>';
  try { renderInsight(await api(`/api/contacts/${c.id}/insight${refresh ? '?refresh=1' : ''}`)); }
  catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function renderInsight(i) {
  const box = $('#insight'); if (!box) return;
  const sec = (t, arr) => arr?.length ? `<ul class="ptr">${arr.map((x) => li(t, x)).join('')}</ul>` : '';
  box.innerHTML = `<h3>GEMMA INSIGHT ${i.source === 'fallback' ? '<span class="dim">(offline)</span>' : ''}</h3>
    ${i.vibe ? `<p class="dim">${esc(i.vibe)}</p>` : ''}
    ${sec('wants', i.wants)}${sec('needs', i.needs)}${sec('help', i.how_to_help)}${sec('opener', i.openers)}
    ${i.follow_up ? `<ul class="ptr">${li('next', i.follow_up, 'near')}</ul>` : ''}`;
}

function logConversation(c, voice) {
  openModal(`<h2>CONVERSATION · ${esc(c.name)}</h2>
    <p class="dim small">${voice ? 'Speak what you talked about. Gemma updates their needs + profile.' : 'Type what you talked about.'}</p>
    <textarea id="convoText" placeholder="e.g. Ran into Priya at the cafe, she found a frontend dev but still needs GPU credits…"></textarea>
    <div class="row"><button class="btn" data-a="cancel">CANCEL</button>${voice ? '<button class="btn rec" data-a="rec">● REC</button>' : ''}<button class="btn primary" data-a="save">SAVE</button></div>`);
  const box = $('.modal-box');
  box.querySelector('[data-a=cancel]').onclick = closeModal;
  const ta = $('#convoText');
  if (voice) {
    const b = box.querySelector('[data-a=rec]');
    b.onclick = () => listen({ button: b, onInterim: (t) => ta.value = t, onFinal: (t) => ta.value = t });
    b.click();
  }
  box.querySelector('[data-a=save]').onclick = async () => {
    if (rec) rec.stop();
    const text = ta.value.trim(); if (!text) return;
    box.querySelector('[data-a=save]').textContent = 'GEMMA…';
    try {
      const r = await api(`/api/contacts/${c.id}/interactions`, { body: { text } });
      closeModal(); print(`Logged conversation with ${c.name} (${r.source}).`);
      await loadMesh(); renderContact(await api('/api/contacts/' + c.id));
    } catch (e) { print(e.message, 'err'); closeModal(); }
  };
}

// ---------------- modal + log-meeting flow ----------------
function openModal(html) { $('.modal-box').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { if (rec) rec.stop(); $('#modal').hidden = true; }
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

const kvToText = (o) => Object.entries(o || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const textToKv = (t) => Object.fromEntries(t.split('\n').map((l) => l.split(/:(.*)/s)).filter((p) => p[0].trim() && p[1]?.trim()).map((p) => [p[0].trim().replace(/\s+/g, '_').toLowerCase(), p[1].trim()]));
const splitList = (t) => t.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function startVoiceLog() {
  openModal(`<h2>● LOG MEETING</h2>
    <p class="dim small">Speak naturally: who you met, where, what they do, what they need, their contact, who they know.<br>
    e.g. "Just met Sam Okafor at the Hacktober kickoff, backend dev, knows Go, looking for a team, he knows Nina, his email is sam@mail.com"</p>
    <div class="transcript" id="tr">listening…</div>
    <textarea id="trEdit" placeholder="…or type it here" hidden></textarea>
    <div class="row"><button class="btn" data-a="cancel">CANCEL</button><button class="btn" data-a="type">TYPE INSTEAD</button>
    <button class="btn rec" data-a="rec">● REC</button><button class="btn primary" data-a="go">PARSE WITH GEMMA</button></div>`);
  const box = $('.modal-box'), tr = $('#tr'), ta = $('#trEdit');
  let text = '';
  const recBtn = box.querySelector('[data-a=rec]');
  const start = () => listen({ button: recBtn, onInterim: (t) => { text = t; tr.textContent = t; ta.value = t; }, onFinal: (t) => { text = t; tr.textContent = t; ta.value = t; } });
  recBtn.onclick = start;
  box.querySelector('[data-a=cancel]').onclick = closeModal;
  box.querySelector('[data-a=type]').onclick = () => { if (rec) rec.stop(); tr.hidden = true; ta.hidden = false; ta.focus(); };
  box.querySelector('[data-a=go]').onclick = async () => {
    if (rec) rec.stop();
    const t = (ta.hidden ? text : ta.value).trim();
    if (!t) return;
    await parseAndReview(t);
  };
  if (SR) start(); else box.querySelector('[data-a=type]').click();
}

async function parseAndReview(transcript) {
  openModal('<h2>GEMMA</h2><p class="loading">extracting person…</p>');
  try {
    const d = await api('/api/parse', { body: { transcript } });
    if (d.source === 'fallback') print(`Gemma unavailable (${d.error}) — used offline parser.`, 'err');
    openContactForm({ ...d, transcript });
  } catch (e) { closeModal(); print(e.message, 'err'); }
}

function openContactForm(d, editId) {
  openModal(`<h2>${editId ? 'EDIT' : 'REVIEW'} · ${esc(d.name || 'NEW PERSON')}</h2>
    ${d.transcript ? `<div class="transcript">${esc(d.transcript)}</div>` : ''}
    <form id="cform">
      <div class="grid2">
        <label>name<input name="name" value="${esc(d.name)}" required></label>
        <label>place met<input name="place" value="${esc(d.place || '')}"></label>
        ${editId ? '' : `<label>email<input name="email" value="${esc(d.email || '')}"></label>
        <label>phone<input name="phone" value="${esc(d.phone || '')}"></label>
        <label>date met<input name="metAt" type="date" value="${esc(d.metAt || new Date().toISOString().slice(0, 10))}"></label>`}
        <label>tags (first = context)<input name="tags" value="${esc((d.tags || []).join(', '))}"></label>
      </div>
      <label>public · key: value per line<textarea name="public">${esc(kvToText(d.public))}</textarea></label>
      <label>private · only you<textarea name="private">${esc(kvToText(d.private))}</textarea></label>
      <label>wants / needs (one per line)<textarea name="needs">${esc((d.needs || []).join('\n'))}</textarea></label>
      <label>knows (names in your index)<input name="knows" value="${esc((d.knows || []).filter((x) => typeof x === 'string').join(', '))}"></label>
      ${editId ? '' : `<label class="check"><input type="checkbox" name="closeFriend" ${d.closeFriend ? 'checked' : ''}> close friend (proximity pings if mutual)</label>`}
      <div class="row"><button type="button" class="btn" data-a="cancel">CANCEL</button><button class="btn primary">SAVE TO INDEX</button></div>
    </form>`);
  $('[data-a=cancel]').onclick = closeModal;
  $('#cform').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = {
      name: f.name.trim(), place: f.place || null, tags: splitList(f.tags || '').map((t) => t.toLowerCase()),
      public: textToKv(f.public || ''), private: textToKv(f.private || ''), needs: (f.needs || '').split('\n').map((s) => s.trim()).filter(Boolean),
      knows: splitList(f.knows || ''),
    };
    try {
      if (editId) {
        await api('/api/contacts/' + editId, { method: 'PATCH', body });
        closeModal(); await loadMesh(); renderContact(await api('/api/contacts/' + editId));
      } else {
        const r = await api('/api/contacts', { body: { ...body, email: f.email, phone: f.phone, metAt: f.metAt, closeFriend: !!f.closeFriend, transcript: d.transcript, summary: d.summary } });
        closeModal();
        print(`+ ${r.contact.name} indexed${r.shadow ? ' as a SHADOW PROFILE (they can claim it when they join)' : ' — they are on the network'}.`);
        await loadMesh();
        const n = S.mesh.nodes.find((x) => x.contactId === r.contact.id); if (n) select(n);
      }
    } catch (err) { print(err.message, 'err'); }
  };
}

$('#btnLog').onclick = startVoiceLog;
$('#btnAdd').onclick = () => openContactForm({ name: '', tags: [], public: {}, private: {}, needs: [], knows: [] });

// ---------------- suggestions / close friends / profile ----------------
$('#btnSuggest').onclick = async () => {
  openModal('<h2>SIMILAR NETWORKS</h2><p class="loading">scanning meshes…</p>');
  const list = await api('/api/suggestions');
  $('.modal-box').innerHTML = `<h2>SIMILAR NETWORKS</h2><p class="dim small">People on the platform whose real-life network overlaps yours.</p>
    ${list.length ? list.map((s) => `<div class="list-row"><div class="t">${esc(s.user.name)} <span class="dim">@${esc(s.user.handle)}</span></div>
      <ul class="ptr">${s.user.headline ? li('', s.user.headline) : ''}${li('overlap', Math.round(s.score * 100) + '%')}
      ${s.mutual.length ? li('mutual', s.mutual.join(', ')) : ''}${s.sharedTags.length ? li('shared circles', s.sharedTags.join(', ')) : ''}
      ${s.knowsYou ? li('', 'already has you in their index', 'near') : ''}</ul>
      <div class="actions"><button class="btn" data-u="${s.user.id}">+ CONNECT</button></div></div>`).join('') : '<p class="dim">No overlaps yet — index more people.</p>'}
    <div class="row"><button class="btn" data-a="cancel">CLOSE</button></div>`;
  $('[data-a=cancel]').onclick = closeModal;
  document.querySelectorAll('[data-u]').forEach((b) => b.onclick = async () => {
    const c = await api('/api/connect/' + b.dataset.u, { method: 'POST' });
    b.textContent = '✓ ADDED'; b.disabled = true; print(`+ ${c.name} added to your index.`); loadMesh();
  });
};

$('#btnClose').onclick = async () => {
  const r = await api('/api/nearby');
  openModal(`<h2>CLOSE FRIENDS</h2><p class="dim small">Pings are mutual opt-in: both of you mark each other as close friend and share location. Radius ${r.radius} m.</p>
    ${r.closeFriends.length ? `<ul class="ptr">${r.closeFriends.map((f) => li(f.name,
      f.nearby ? `NEARBY · ${fmtM(f.meters)}` : f.meters != null ? fmtM(f.meters) : !f.onPlatform ? 'not on network' : !f.mutual ? 'not mutual yet' : !f.sharing ? 'not sharing location' : 'location unknown',
      f.nearby ? 'near' : '')).join('')}</ul>` : '<p class="dim">Mark someone as ★ close friend from their panel.</p>'}
    ${S.me.shareLocation ? '' : '<p class="err">Your location sharing is OFF — turn on LOC in the top bar.</p>'}
    <div class="row"><button class="btn" data-a="notif">ENABLE NOTIFICATIONS</button><button class="btn" data-a="cancel">CLOSE</button></div>`);
  $('[data-a=cancel]').onclick = closeModal;
  $('[data-a=notif]').onclick = async () => { if ('Notification' in window) print('notifications: ' + await Notification.requestPermission()); };
};

$('#btnProfile').onclick = async () => {
  const p = await api('/api/profile');
  const facts = Object.entries(p.publicFacts);
  openModal(`<h2>@${esc(p.user.handle)}</h2>
    <form id="pform">
      <label>headline<input name="headline" value="${esc(p.user.headline)}"></label>
      <label>bio<textarea name="bio">${esc(p.user.bio)}</textarea></label>
      <div class="actions" style="margin:10px 0 4px"><button type="button" class="btn" data-a="details">EDIT IDENTITY DETAILS</button><button type="button" class="btn" data-a="findme">FIND PROFILES OF ME</button></div>
      <label class="check"><input type="checkbox" name="publicNetwork" ${p.user.publicNetwork ? 'checked' : ''}> let people I know open my mesh</label>
      <label class="check"><input type="checkbox" name="shareLocation" ${p.user.shareLocation ? 'checked' : ''}> share location with mutual close friends</label>
      <div class="row"><button class="btn primary">SAVE</button></div>
    </form>
    <h3 style="color:var(--red);font-size:11px;letter-spacing:.12em;margin-top:18px">YOUR SOCIAL PROFILE · WHAT PEOPLE WHO MET YOU NOTED PUBLICLY</h3>
    ${facts.length ? `<ul class="ptr">${facts.map(([k, v]) => li(k, v.join(' · '))).join('')}</ul>` : '<p class="dim">Nobody has indexed public facts about you yet.</p>'}
    <h3 style="color:var(--red);font-size:11px;letter-spacing:.12em;margin-top:18px">PEOPLE WHO MET YOU (${p.metYou.length})</h3>
    ${p.metYou.length ? `<ul class="ptr">${p.metYou.map((m) => li(m.by.name, `${m.place || 'somewhere'} · ${ago(m.lastMet)}`)).join('')}</ul>` : '<p class="dim">—</p>'}
    <p class="dim small">Private notes others keep about you are never visible to anyone but them.</p>
    <div class="row"><button class="btn" data-a="cancel">CLOSE</button></div>`);
  $('[data-a=cancel]').onclick = closeModal;
  $('[data-a=details]').onclick = async () => { closeModal(); const me = (await api('/api/me')).user; showOnboarding({ ...me, editing: true }); };
  $('[data-a=findme]').onclick = async () => {
    closeModal(); $('#app').hidden = true; $('#onboard').hidden = false; $('#obForm').hidden = true;
    $('#obScan').hidden = false; $('#obScanLog').textContent = '> scanning the network for profiles of you…';
    renderMatches(await api('/api/matches'));
  };
  $('#pform').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { headline: f.get('headline'), bio: f.get('bio'), publicNetwork: f.has('publicNetwork'), shareLocation: f.has('shareLocation') };
    await api('/api/profile', { method: 'PATCH', body });
    S.me = { ...S.me, ...body }; setLocButton();
    body.shareLocation ? startLocation() : stopLocation();
    closeModal(); print('Profile saved.');
  };
};

// ---------------- location + proximity pings ----------------
function setLocButton() { $('#btnLoc').textContent = 'LOC: ' + (S.me.shareLocation ? 'ON' : 'OFF'); $('#btnLoc').classList.toggle('on', !!S.me.shareLocation); }
$('#btnLoc').onclick = async () => {
  const v = !S.me.shareLocation;
  await api('/api/profile', { method: 'PATCH', body: { shareLocation: v } });
  S.me.shareLocation = v; setLocButton();
  v ? startLocation() : stopLocation();
  print(v ? 'Location sharing ON (mutual close friends only).' : 'Location sharing OFF.');
};
let lastSent = 0;
function startLocation() {
  if (!navigator.geolocation) return useSimulated();
  if (S.locWatch) return;
  S.locWatch = navigator.geolocation.watchPosition(
    (p) => sendLoc(p.coords.latitude, p.coords.longitude),
    (err) => { print(`geolocation: ${err.message} — using simulated location for demo.`, 'err'); useSimulated(); },
    { enableHighAccuracy: true, maximumAge: 15000 });
}
function stopLocation() { if (S.locWatch) navigator.geolocation.clearWatch(S.locWatch); S.locWatch = null; clearInterval(S.simTimer); }
function useSimulated() { clearInterval(S.simTimer); const go = () => sendLoc(37.7749, -122.4194, true); go(); S.simTimer = setInterval(go, 20000); }
async function sendLoc(lat, lng, force) {
  if (!force && Date.now() - lastSent < 10000) return;
  lastSent = Date.now();
  try { const r = await api('/api/location', { body: { lat, lng } }); handleNearby(r.closeFriends); } catch {}
}
async function pollNearby() {
  if (!S.token) return;
  try { const r = await api('/api/nearby'); handleNearby(r.closeFriends); } catch {}
}
function handleNearby(list = []) {
  let changed = false;
  for (const f of list) {
    const was = S.nearbySeen.has(f.personId);
    if (f.nearby && !was) {
      S.nearbySeen.add(f.personId); changed = true;
      beep();
      const msg = `PING ◉ ${f.name} is ${fmtM(f.meters)} away`;
      print(msg, 'alert'); toast(msg); speak(`${f.name} is nearby`);
      if ('Notification' in window && Notification.permission === 'granted') new Notification('NET X', { body: msg });
    } else if (!f.nearby && was) { S.nearbySeen.delete(f.personId); changed = true; }
  }
  // keep mesh distances fresh
  if (S.mesh && S.view.kind === 'mine') {
    for (const f of list) {
      const n = S.mesh.nodes.find((x) => x.personId === f.personId);
      if (n && (n.nearby !== f.nearby || n.meters !== f.meters)) { n.nearby = f.nearby; n.meters = f.meters; changed = true; }
    }
  }
  return changed;
}

// ---------------- command line + agent ----------------
const HELP = `commands:
  <question>        ask LINK, the network agent (uses selected person as context)
  /log <text>       log a meeting from text (same as ● LOG MEETING)
  /find <name>      select a person on the mesh
  /near             close-friend proximity status
  /similar          people on similar networks
  /recent           last 10 people you met
  /clear            clear terminal
  keys: F find · 0 reset view · ESC close`;

$('#cmd').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#cmdInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  print(text, 'you');
  const [cmd, ...rest] = text.split(' ');
  const arg = rest.join(' ');
  switch (cmd) {
    case '/help': return print(HELP);
    case '/clear': $('#log').innerHTML = ''; return;
    case '/log': return arg ? parseAndReview(arg) : startVoiceLog();
    case '/near': return $('#btnClose').click();
    case '/similar': return $('#btnSuggest').click();
    case '/find': { const n = S.mesh.nodes.find((x) => x.name.toLowerCase().includes(arg.toLowerCase())); return n ? select(n) : print('not found', 'err'); }
    case '/recent': return print([...S.mesh.nodes].sort((a, b) => b.lastMet - a.lastMet).slice(0, 10).map((n) => `  ${n.name.padEnd(18)} ${ago(n.lastMet)}`).join('\n'));
  }
  if (cmd.startsWith('/')) return print('unknown command — /help', 'err');
  await askAgent(text);
};

async function askAgent(message) {
  const wait = print('…', 'bot loading');
  try {
    const contactId = S.view.kind === 'mine' ? S.selected?.contactId : undefined;
    const r = await api('/api/agent', { body: { message, history: S.history, contactId } });
    wait.remove();
    print(r.reply, 'bot');
    speak(r.reply);
    S.history.push({ role: 'user', text: message }, { role: 'model', text: r.reply });
    S.history = S.history.slice(-12);
  } catch (e) { wait.remove(); print(e.message, 'err'); }
}

$('#btnMic').onclick = () => listen({
  button: $('#btnMic'),
  onInterim: (t) => { $('#cmdInput').value = t; },
  onFinal: (t) => { $('#cmdInput').value = t; $('#cmd').requestSubmit(); },
});
$('#btnTts').onclick = () => { S.tts = !S.tts; $('#btnTts').textContent = 'VOICE: ' + (S.tts ? 'ON' : 'OFF'); $('#btnTts').classList.toggle('on', S.tts); };

// ---------------- start ----------------
if (S.token) boot().catch(() => logout(true));
else initGoogle();
