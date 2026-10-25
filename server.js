// NET X server - zero npm dependencies (Node 18+). Run: node server.js
// Storage: Firebase Firestore when configured, else data/db.json. Auth: password, Firebase Auth (Google), or Google Identity.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

const { seed } = await import('./lib/seed.js');
const ai = await import('./lib/ai.js');
const { status: gemmaStatus } = await import('./lib/gemma.js');
const { createStore } = await import('./lib/store.js');
const { verifyFirebaseIdToken, loadServiceAccount, projectId: fbProjectId } = await import('./lib/firebase.js');
const match = await import('./lib/match.js');

const PORT = +process.env.PORT || 3000;
const NEARBY_M = +process.env.NEARBY_METERS || 500;
const LOC_TTL = 10 * 60e3; // location older than 10 min is ignored
const DAY = 864e5;

// ---------------- storage ----------------
const rid = () => crypto.randomBytes(6).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const store = await createStore(ROOT, () => seed(hashPw));
const db = store.db;
let saveTimer;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.save(), 250); }
const FB_PROJECT = fbProjectId(loadServiceAccount(ROOT));

const normEmail = (e) => (e ? String(e).trim().toLowerCase() || null : null);
const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : null; };
const userById = (id) => db.users.find((u) => u.id === id);
const personById = (id) => db.persons.find((p) => p.id === id);
const userOfPerson = (pid) => db.users.find((u) => u.personId === pid);
const contactsOf = (uid) => db.contacts.filter((c) => c.ownerId === uid);
const publicUser = (u) => u && ({ id: u.id, handle: u.handle, name: u.name, headline: u.headline, bio: u.bio, personId: u.personId });

function findOrCreatePerson({ name, email, phone }) {
  const e = normEmail(email), p = normPhone(phone);
  let person = db.persons.find((x) => (e && x.email === e) || (p && x.phone === p));
  if (!person) {
    person = { id: rid(), name: name || 'Unknown', email: e, phone: p, claimedBy: null, createdAt: Date.now() };
    db.persons.push(person);
  } else {
    person.email ||= e; person.phone ||= p;
  }
  return person;
}

function resolveKnows(ownerId, names = []) {
  const mine = contactsOf(ownerId);
  const ids = [];
  for (const n of names) {
    const q = String(n).toLowerCase().trim();
    if (!q) continue;
    const hit = mine.find((c) => c.name.toLowerCase() === q) || mine.find((c) => c.name.toLowerCase().split(' ')[0] === q.split(' ')[0]);
    if (hit) ids.push(hit.personId);
  }
  return ids;
}

// ---------------- geo / proximity ----------------
function meters(a, b) {
  const R = 6371e3, t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function offset(loc, { n, e }) {
  return { lat: loc.lat + n / 111320, lng: loc.lng + e / (111320 * Math.cos(loc.lat * Math.PI / 180)), ts: Date.now() };
}
const fresh = (loc) => loc && Date.now() - loc.ts < LOC_TTL;

// Close-friend proximity is MUTUAL opt-in: both sides marked each other as close
// friends and both have location sharing on.
function closeFriendsStatus(uid) {
  const me = userById(uid);
  return contactsOf(uid).filter((c) => c.closeFriend).map((c) => {
    const them = userOfPerson(c.personId);
    const back = them && contactsOf(them.id).find((x) => x.personId === me.personId && x.closeFriend);
    const mutual = !!back;
    let dist = null;
    if (mutual && me.shareLocation && them.shareLocation && fresh(me.loc) && fresh(them.loc)) dist = Math.round(meters(me.loc, them.loc));
    return {
      contactId: c.id, personId: c.personId, name: c.name, onPlatform: !!them, mutual,
      sharing: !!them?.shareLocation, meters: dist, nearby: dist !== null && dist <= NEARBY_M,
    };
  });
}

// ---------------- mesh ----------------
function edgesFor(ownerId, personSet) {
  const edges = new Map();
  const add = (a, b, kind) => {
    if (!a || !b || a === b || !personSet.has(a) || !personSet.has(b)) return;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (!edges.has(key)) edges.set(key, { a, b, kind });
  };
  const mine = contactsOf(ownerId);
  // 1. explicit "knows" recorded by the owner
  for (const c of mine) for (const k of c.knows || []) add(c.personId, k, 'knows');
  // 2. people in the mesh who are on the platform: their own index reveals who they know
  for (const pid of personSet) {
    const u = userOfPerson(pid);
    if (!u || u.publicNetwork === false) continue;
    for (const c of contactsOf(u.id)) add(pid, c.personId, 'network');
  }
  // 3. met together: same place, within 2 days
  for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
    const a = mine[i], b = mine[j];
    if (a.place && b.place && a.place.toLowerCase() === b.place.toLowerCase() && Math.abs(a.metAt - b.metAt) < 2 * DAY) add(a.personId, b.personId, 'met-together');
  }
  return [...edges.values()];
}

function buildMesh(ownerId, viewerId = ownerId) {
  const owner = userById(ownerId);
  const own = ownerId === viewerId;
  const contacts = contactsOf(ownerId).filter((c) => c.personId !== owner.personId);
  const personSet = new Set(contacts.map((c) => c.personId));
  const viewerPersons = new Set(contactsOf(viewerId).map((c) => c.personId));
  const near = own ? Object.fromEntries(closeFriendsStatus(ownerId).map((s) => [s.personId, s])) : {};
  const nodes = contacts.map((c) => {
    const u = userOfPerson(c.personId);
    const base = { personId: c.personId, name: c.name, lastMet: c.lastMet, metAt: c.metAt, tags: c.tags, onPlatform: !!u };
    if (!own) return { ...base, youKnow: viewerPersons.has(c.personId) || userById(viewerId).personId === c.personId };
    return { ...base, contactId: c.id, closeFriend: c.closeFriend, place: c.place, meters: near[c.personId]?.meters ?? null, nearby: !!near[c.personId]?.nearby };
  });
  return { owner: publicUser(owner), own, nodes, edges: edgesFor(ownerId, personSet), nearbyRadius: NEARBY_M };
}

// ---------------- suggestions: people on similar networks ----------------
function suggestions(uid) {
  const me = userById(uid);
  const mine = new Set(contactsOf(uid).map((c) => c.personId));
  const myTags = new Set(contactsOf(uid).flatMap((c) => c.tags));
  const out = [];
  for (const u of db.users) {
    if (u.id === uid || mine.has(u.personId)) continue;
    const theirs = new Set(contactsOf(u.id).map((c) => c.personId));
    const mutual = [...theirs].filter((p) => mine.has(p));
    const profHit = me.profile && u.profile && match.scoreCandidate({ ...me.profile, name: '' }, match.evidenceFor(db, u.personId)).score >= 15;
    if (!mutual.length && !theirs.has(me.personId) && !profHit) continue;
    const union = new Set([...mine, ...theirs]).size || 1;
    const sharedTags = [...new Set(contactsOf(u.id).flatMap((c) => c.tags))].filter((t) => myTags.has(t));
    const prof = me.profile && u.profile ? match.scoreCandidate({ ...me.profile, name: '' }, match.evidenceFor(db, u.personId)) : { score: 0, reasons: [] };
    const score = mutual.length / union + (theirs.has(me.personId) ? 0.3 : 0) + sharedTags.length * 0.02 + prof.score / 200;
    out.push({
      user: publicUser(u), score: +score.toFixed(3), knowsYou: theirs.has(me.personId),
      mutual: mutual.map((p) => personById(p)?.name).filter(Boolean), sharedTags,
      profileOverlap: me.profile && u.profile ? match.scoreCandidate({ ...me.profile, name: '' }, match.evidenceFor(db, u.personId)).reasons : [],
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

// ---------------- http plumbing ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const must = (cond, code, msg) => { if (!cond) throw new HttpError(code, msg); };

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const ch of req) { size += ch.length; if (size > 1e6) throw new HttpError(413, 'Body too large'); chunks.push(ch); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });

function session(token) {
  const uid = db.sessions[token];
  return uid && userById(uid);
}
function newSession(u) { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = u.id; persist(); return t; }
function myContact(uid, id) { const c = db.contacts.find((x) => x.id === id && x.ownerId === uid); must(c, 404, 'Contact not found'); return c; }

// ---------------- routes ----------------
route('GET', '/api/config', false, () => ({
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  // Firebase web config is public by design (it identifies the project, it is not a secret)
  firebase: FB_PROJECT && process.env.FIREBASE_API_KEY ? {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${FB_PROJECT}.firebaseapp.com`,
    projectId: FB_PROJECT,
    appId: process.env.FIREBASE_APP_ID || undefined,
  } : null,
}));

// Shared by every Google-based sign-in: find the user, or create one + claim a shadow profile by email.
function signInWithIdentity({ provider, sub, email, name, picture }) {
  const subKey = provider === 'firebase' ? 'firebaseUid' : 'googleSub';
  let u = db.users.find((x) => x[subKey] === sub) || (email && db.users.find((x) => x.email && x.email === email));
  let isNew = false, claimed = false;
  if (u) {
    u[subKey] ||= sub; if (picture) u.picture = picture;
  } else {
    isNew = true;
    let person = email && db.persons.find((p) => !p.claimedBy && !p.mergedInto && p.email === email);
    claimed = !!person;
    if (!person) person = findOrCreatePerson({ name, email });
    must(!person.claimedBy, 409, 'That email already belongs to an account');
    const base = (email || name || 'user').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18) || 'user';
    let handle = base, n = 1;
    while (db.users.some((x) => x.handle === handle)) handle = base + ++n;
    u = { id: rid(), handle, name, email, phone: null, salt: null, passHash: null, [subKey]: sub, picture,
      personId: person.id, headline: '', bio: '', shareLocation: false, publicNetwork: true, loc: null,
      profile: null, needsOnboarding: true, dismissedMatches: [], createdAt: Date.now() };
    person.claimedBy = u.id; person.name = u.name;
    db.users.push(u);
  }
  persist();
  const indexedBy = db.contacts.filter((c) => c.personId === u.personId && c.ownerId !== u.id).length;
  return { token: newSession(u), user: publicUser(u), isNew, claimed, indexedBy, needsOnboarding: !!u.needsOnboarding };
}

// ---- Firebase Authentication (Google provider) ----
route('POST', '/api/auth/firebase', false, async ({ body }) => {
  must(FB_PROJECT, 500, 'Firebase is not configured on the server');
  let c;
  try { c = await verifyFirebaseIdToken(body.idToken, FB_PROJECT); } catch (e) { throw new HttpError(401, 'Firebase sign-in rejected: ' + e.message); }
  const email = c.email && c.email_verified ? normEmail(c.email) : null;
  return signInWithIdentity({ provider: 'firebase', sub: c.sub, email, name: c.name || (c.email || 'New user').split('@')[0], picture: c.picture || null });
});

// ---- Sign in with Google: verify the ID token with Google, then find/create the user ----
async function verifyGoogleToken(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  must(clientId, 500, 'GOOGLE_CLIENT_ID is not set on the server');
  must(typeof credential === 'string' && credential.length < 4096, 400, 'Missing Google credential');
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { signal: AbortSignal.timeout(10000) });
  const t = await res.json().catch(() => ({}));
  must(res.ok, 401, 'Google rejected the sign-in token');
  must(t.aud === clientId, 401, 'Token was issued for a different app');
  must(['accounts.google.com', 'https://accounts.google.com'].includes(t.iss), 401, 'Bad token issuer');
  must(+t.exp * 1000 > Date.now(), 401, 'Google token expired');
  must(t.email && String(t.email_verified) === 'true', 401, 'Google email not verified');
  return { sub: t.sub, email: normEmail(t.email), name: t.name || t.email.split('@')[0], picture: t.picture || null };
}

route('POST', '/api/auth/google', false, async ({ body }) => {
  const g = await verifyGoogleToken(body.credential);
  return signInWithIdentity({ provider: 'google', sub: g.sub, email: g.email, name: g.name, picture: g.picture });
});

route('GET', '/api/health', false, () => ({ ok: true, storage: store.mode, storageError: store.lastError || null, gemma: gemmaStatus, hasKey: !!process.env.GEMMA_API_KEY, model: process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it' }));

route('POST', '/api/register', false, ({ body }) => {
  const handle = String(body.handle || '').trim().toLowerCase();
  must(/^[a-z0-9_]{2,24}$/.test(handle), 400, 'Handle: 2-24 chars, a-z 0-9 _');
  must(String(body.password || '').length >= 4, 400, 'Password: min 4 chars');
  must(!db.users.some((u) => u.handle === handle), 409, 'Handle taken');
  const email = normEmail(body.email), phone = normPhone(body.phone);
  must(body.name, 400, 'Name required');
  // claim a shadow profile if someone already indexed this email/phone
  let person = db.persons.find((p) => !p.claimedBy && ((email && p.email === email) || (phone && p.phone === phone)));
  const claimed = !!person;
  if (!person) person = findOrCreatePerson({ name: body.name, email, phone });
  must(!person.claimedBy, 409, 'That email/phone already belongs to an account');
  const salt = rid();
  const u = { id: rid(), handle, name: String(body.name).trim(), email, phone, salt, passHash: hashPw(body.password, salt), personId: person.id,
    headline: '', bio: '', shareLocation: false, publicNetwork: true, loc: null,
    profile: null, needsOnboarding: true, dismissedMatches: [], createdAt: Date.now() };
  person.claimedBy = u.id; person.name = u.name;
  db.users.push(u);
  const indexedBy = db.contacts.filter((c) => c.personId === person.id).length;
  return { token: newSession(u), user: publicUser(u), claimed, indexedBy, needsOnboarding: true };
});

route('POST', '/api/login', false, ({ body }) => {
  const u = db.users.find((x) => x.handle === String(body.handle || '').trim().toLowerCase());
  must(u && u.passHash && hashPw(body.password, u.salt) === u.passHash, 401, u && !u.passHash ? 'This account uses Sign in with Google' : 'Bad handle or password');
  return { token: newSession(u), user: publicUser(u) };
});

route('POST', '/api/logout', true, ({ token }) => { delete db.sessions[token]; persist(); return { ok: true }; });

route('GET', '/api/me', true, ({ user }) => ({
  user: { ...publicUser(user), email: user.email, phone: user.phone, shareLocation: user.shareLocation, publicNetwork: user.publicNetwork,
    picture: user.picture || null, needsOnboarding: !!user.needsOnboarding, profile: user.profile || null },
  stats: { contacts: contactsOf(user.id).length, indexedBy: db.contacts.filter((c) => c.personId === user.personId).length },
}));

// Your own social profile: what people who met you have recorded PUBLICLY about you.
route('GET', '/api/profile', true, ({ user }) => {
  const about = db.contacts.filter((c) => c.personId === user.personId && c.ownerId !== user.id).map((c) => {
    const owner = userById(c.ownerId);
    return { by: publicUser(owner), metAt: c.metAt, lastMet: c.lastMet, place: c.place, tags: c.tags, public: c.public };
  });
  const facts = {};
  for (const a of about) for (const [k, v] of Object.entries(a.public)) (facts[k] ||= new Set()).add(String(v));
  return {
    user: { ...publicUser(user), shareLocation: user.shareLocation, publicNetwork: user.publicNetwork },
    metYou: about.sort((a, b) => b.lastMet - a.lastMet),
    publicFacts: Object.fromEntries(Object.entries(facts).map(([k, s]) => [k, [...s]])),
  };
});

route('PATCH', '/api/profile', true, ({ user, body }) => {
  for (const k of ['headline', 'bio']) if (typeof body[k] === 'string') user[k] = body[k].slice(0, 280);
  for (const k of ['shareLocation', 'publicNetwork']) if (typeof body[k] === 'boolean') user[k] = body[k];
  if (body.shareLocation === false) user.loc = null;
  persist();
  return { ok: true };
});

// ---------------- onboarding + identity matching ----------------
function matchProfile(user) {
  const p = user.profile || {};
  return { ...p, name: user.name, email: user.email, phone: user.phone };
}
async function computeMatches(user, { verify = true } = {}) {
  const profile = matchProfile(user);
  let you = match.findIdentityMatches(db, user, profile);
  if (verify) you = await ai.verifyMatches(profile, you);
  return { you, similar: match.findSimilarUsers(db, user, profile) };
}

route('POST', '/api/onboarding', true, async ({ user, body }) => {
  if (typeof body.name === 'string' && body.name.trim()) { user.name = body.name.trim().slice(0, 80); personById(user.personId).name = user.name; }
  if (body.phone) {
    const ph = normPhone(body.phone);
    if (ph && !db.persons.some((p) => p.phone === ph && p.id !== user.personId && p.claimedBy)) { user.phone = ph; personById(user.personId).phone ||= ph; }
  }
  user.profile = match.cleanProfile(body);
  user.needsOnboarding = false;
  // auto headline from what they told us
  if (!user.headline) user.headline = [user.profile.role, user.profile.workplace && '@ ' + user.profile.workplace].filter(Boolean).join(' ') || user.profile.school || '';
  persist();
  return { ok: true, ...(await computeMatches(user)) };
});

route('GET', '/api/matches', true, async ({ user }) => computeMatches(user));

// Speak or type "about me" -> Gemma fills the onboarding form
route('POST', '/api/onboarding/parse', true, async ({ body }) => {
  must(typeof body.text === 'string' && body.text.trim(), 400, 'Say or type something about yourself');
  return ai.parseProfile(body.text.slice(0, 4000), { fast: !!body.fast });
});

// "That's me" - merge a shadow profile into this account.
route('POST', '/api/claim/:pid', true, async ({ user, params }) => {
  const target = personById(params.pid);
  must(target && !target.claimedBy && !target.mergedInto, 404, 'That profile is not available to claim');
  // only allow claiming something the matcher actually proposed for this user
  const ok = match.findIdentityMatches(db, user, matchProfile(user), { limit: 50 }).some((m) => m.personId === target.id);
  must(ok, 403, 'Your profile details do not match that person closely enough');
  const n = mergePerson(user, target);
  persist();
  return { ok: true, merged: n, indexedBy: db.contacts.filter((c) => c.personId === user.personId && c.ownerId !== user.id).length };
});

route('POST', '/api/matches/:pid/dismiss', true, ({ user, params }) => {
  user.dismissedMatches = [...new Set([...(user.dismissedMatches || []), params.pid])];
  persist();
  return { ok: true };
});

function mergePerson(user, target) {
  const mine = user.personId;
  let moved = 0;
  for (const c of [...db.contacts]) {
    if (c.personId !== target.id) continue;
    if (c.ownerId === user.id) { db.contacts.splice(db.contacts.indexOf(c), 1); continue; } // you had indexed "yourself"
    const dup = db.contacts.find((x) => x.ownerId === c.ownerId && x.personId === mine);
    if (dup) { // owner already had you indexed under your account - fold the notes together
      Object.assign(dup.public, c.public); Object.assign(dup.private, c.private);
      dup.needs = [...new Set([...(dup.needs || []), ...(c.needs || [])])];
      dup.tags = [...new Set([...dup.tags, ...c.tags])];
      dup.knows = [...new Set([...(dup.knows || []), ...(c.knows || [])])];
      dup.interactions = [...dup.interactions, ...c.interactions].sort((a, b) => a.ts - b.ts);
      dup.metAt = Math.min(dup.metAt, c.metAt); dup.lastMet = Math.max(dup.lastMet, c.lastMet);
      db.contacts.splice(db.contacts.indexOf(c), 1);
    } else c.personId = mine;
    moved++;
  }
  for (const c of db.contacts) if (c.knows?.includes(target.id)) c.knows = [...new Set(c.knows.map((k) => (k === target.id ? mine : k)))];
  const me = personById(mine);
  me.email ||= target.email; me.phone ||= target.phone;
  Object.assign(target, { mergedInto: mine, claimedBy: user.id });
  return moved;
}

route('GET', '/api/mesh', true, ({ user }) => buildMesh(user.id));

// View someone else's mesh: only if they're in your index, on the platform, and their network is public.
route('GET', '/api/network/:pid', true, ({ user, params }) => {
  const u = userOfPerson(params.pid);
  must(u, 404, 'That person has not joined yet - shadow profiles have no mesh');
  must(contactsOf(user.id).some((c) => c.personId === params.pid), 403, 'You can only open meshes of people you know');
  must(u.publicNetwork !== false, 403, `${u.name} keeps their network private`);
  return buildMesh(u.id, user.id);
});

route('GET', '/api/contacts', true, ({ user }) => contactsOf(user.id).sort((a, b) => b.lastMet - a.lastMet));

route('GET', '/api/contacts/:id', true, ({ user, params }) => {
  const c = myContact(user.id, params.id);
  const them = userOfPerson(c.personId);
  const mesh = edgesFor(user.id, new Set(contactsOf(user.id).map((x) => x.personId)));
  const mutualIds = mesh.filter((e) => e.a === c.personId || e.b === c.personId).map((e) => (e.a === c.personId ? e.b : e.a));
  const cf = closeFriendsStatus(user.id).find((s) => s.contactId === c.id) || null;
  return {
    ...c, onPlatform: !!them, platform: publicUser(them), closeStatus: cf,
    mutuals: mutualIds.map((pid) => ({ personId: pid, name: personById(pid)?.name })),
  };
});

route('POST', '/api/contacts', true, ({ user, body }) => {
  must(body.name, 400, 'Name required');
  const person = findOrCreatePerson(body);
  must(person.id !== user.personId, 400, "That's you");
  let c = contactsOf(user.id).find((x) => x.personId === person.id);
  const now = Date.now();
  const metAt = body.metAt ? Date.parse(body.metAt) || now : now;
  if (c) { // already indexed -> merge as a new meeting
    Object.assign(c.public, body.public || {}); Object.assign(c.private, body.private || {});
    c.needs = [...new Set([...(c.needs || []), ...(body.needs || [])])];
    c.tags = [...new Set([...c.tags, ...(body.tags || [])])];
    c.lastMet = Math.max(c.lastMet, metAt);
  } else {
    c = { id: rid(), ownerId: user.id, personId: person.id, name: body.name.trim(), tags: (body.tags || []).map((t) => String(t).toLowerCase()),
      place: body.place || null, metAt, lastMet: metAt, public: body.public || {}, private: body.private || {}, needs: body.needs || [],
      knows: [], closeFriend: !!body.closeFriend, insight: null, interactions: [] };
    db.contacts.push(c);
  }
  c.knows = [...new Set([...(c.knows || []), ...resolveKnows(user.id, body.knows)])];
  c.interactions.push({ ts: metAt, text: body.transcript || body.summary || `Met at ${c.place || 'unknown place'}`, summary: body.summary || '' });
  persist();
  return { contact: c, shadow: !userOfPerson(person.id) };
});

route('PATCH', '/api/contacts/:id', true, ({ user, params, body }) => {
  const c = myContact(user.id, params.id);
  for (const k of ['name', 'place']) if (typeof body[k] === 'string') c[k] = body[k];
  for (const k of ['public', 'private']) if (body[k] && typeof body[k] === 'object') c[k] = body[k];
  for (const k of ['tags', 'needs']) if (Array.isArray(body[k])) c[k] = body[k];
  if (typeof body.closeFriend === 'boolean') c.closeFriend = body.closeFriend;
  if (body.knows) c.knows = [...new Set([...(c.knows || []), ...resolveKnows(user.id, body.knows)])];
  if (body.touch) c.lastMet = Date.now();
  persist();
  return c;
});

route('DELETE', '/api/contacts/:id', true, ({ user, params }) => {
  const c = myContact(user.id, params.id);
  db.contacts = db.contacts.filter((x) => x !== c);
  persist();
  return { ok: true };
});

route('POST', '/api/contacts/:id/interactions', true, async ({ user, params, body }) => {
  const c = myContact(user.id, params.id);
  must(body.text, 400, 'text required');
  const d = await ai.digestInteraction(c, body.text);
  c.interactions.push({ ts: Date.now(), text: body.text, summary: d.summary || '' });
  c.lastMet = Date.now();
  if (Array.isArray(d.needs)) c.needs = d.needs;
  Object.assign(c.public, d.public_add || {}); Object.assign(c.private, d.private_add || {});
  c.tags = [...new Set([...c.tags, ...(d.tags_add || []).map((t) => String(t).toLowerCase())])];
  if (d.place) c.place ||= d.place;
  c.insight = null;
  persist();
  return { contact: c, source: d.source };
});

route('GET', '/api/contacts/:id/insight', true, async ({ user, params, query }) => {
  const c = myContact(user.id, params.id);
  if (c.insight && !query.get('refresh') && c.insight.source === 'gemma') return c.insight;
  const mesh = edgesFor(user.id, new Set(contactsOf(user.id).map((x) => x.personId)));
  const mutual = mesh.filter((e) => e.a === c.personId || e.b === c.personId).map((e) => personById(e.a === c.personId ? e.b : e.a)?.name);
  c.insight = await ai.insight(c, mutual);
  persist();
  return c.insight;
});

route('POST', '/api/parse', true, async ({ user, body }) => {
  must(body.transcript, 400, 'transcript required');
  return ai.parseMeeting(String(body.transcript).slice(0, 6000), contactsOf(user.id).map((c) => c.name));
});

route('POST', '/api/agent', true, async ({ user, body }) => {
  must(body.message, 400, 'message required');
  const contacts = contactsOf(user.id);
  const focus = body.contactId ? contacts.find((c) => c.id === body.contactId) : null;
  return ai.agent({ me: user, contacts, focus, history: Array.isArray(body.history) ? body.history : [], message: String(body.message).slice(0, 4000) });
});

route('POST', '/api/location', true, ({ user, body }) => {
  must(Number.isFinite(body.lat) && Number.isFinite(body.lng), 400, 'lat/lng required');
  must(user.shareLocation, 403, 'Location sharing is off');
  user.loc = { lat: body.lat, lng: body.lng, ts: Date.now() };
  // demo bots (seeded close friends) hover around whoever is sharing, so pings can be demoed
  for (const b of db.users) if (b.demoOffset && b.id !== user.id) b.loc = offset(user.loc, b.demoOffset);
  persist();
  return { ok: true, closeFriends: closeFriendsStatus(user.id) };
});

route('GET', '/api/nearby', true, ({ user }) => ({ radius: NEARBY_M, closeFriends: closeFriendsStatus(user.id) }));

route('GET', '/api/suggestions', true, ({ user }) => suggestions(user.id));

// Add a suggested platform user to your index
route('POST', '/api/connect/:uid', true, ({ user, params }) => {
  const u = userById(params.uid);
  must(u && u.id !== user.id, 404, 'User not found');
  const p = personById(u.personId);
  let c = contactsOf(user.id).find((x) => x.personId === p.id);
  if (!c) {
    const now = Date.now();
    c = { id: rid(), ownerId: user.id, personId: p.id, name: u.name, tags: ['suggested'], place: 'NET X', metAt: now, lastMet: now,
      public: u.headline ? { headline: u.headline } : {}, private: {}, needs: [], knows: [], closeFriend: false, insight: null,
      interactions: [{ ts: now, text: `Connected with ${u.name} via shared network.`, summary: 'Connected via shared network.' }] };
    db.contacts.push(c);
    persist();
  }
  return c;
});

// ---------------- server ----------------
// Request handler - used by the standalone server below AND by the Firebase Cloud Function (functions.js)
export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      must(r, 404, 'No such endpoint');
      const ctx = { params: url.pathname.match(r.re).groups || {}, query: url.searchParams, body: ['POST', 'PATCH', 'PUT'].includes(req.method) ? (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : await readBody(req)) : {} };
      if (r.auth) {
        ctx.token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        ctx.user = session(ctx.token);
        must(ctx.user, 401, 'Not logged in');
      }
      const out = await r.fn(ctx);
      // write changes before replying (Cloud Functions may pause the CPU right after the response)
      if (req.method !== 'GET') { clearTimeout(saveTimer); await store.save(); }
      return send(res, 200, out);
    }
    // static files
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(ROOT, 'public', rel));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.code || 500, { error: e.message || 'Server error' });
  }
}

if (!process.env.NETX_NO_LISTEN) {
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { clearTimeout(saveTimer); await store.flush(); process.exit(0); });

http.createServer(handler).listen(PORT, () => {
  console.log(`\n  NET X  →  http://localhost:${PORT}`);
  console.log(`  model: ${process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it'}   key: ${process.env.GEMMA_API_KEY ? 'loaded' : 'MISSING (.env)'}`);
  console.log(`  storage: ${store.mode}`);
  console.log(`  firebase auth: ${FB_PROJECT && process.env.FIREBASE_API_KEY ? 'on (' + FB_PROJECT + ')' : 'off'}`);
  console.log('  demo login: demo / demo\n');
});
}

function loadEnv() {
  for (const name of ['.env', 'env.local']) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* file missing */ }
  }
}
