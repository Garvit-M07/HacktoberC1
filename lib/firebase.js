// Zero-dependency Firebase access over REST:
//  - Firestore (read/write documents) using a service-account OAuth token
//  - Firebase Auth ID-token verification (Google sign-in) using Google's public certs
import crypto from 'node:crypto';
import fs from 'node:fs';

// ---------------- config ----------------
export function loadServiceAccount(rootDir) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(txt);
  }
  const file = process.env.FIREBASE_SERVICE_ACCOUNT || `${rootDir}/firebase-service-account.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

export function projectId(sa) {
  return process.env.FIREBASE_PROJECT_ID || sa?.project_id || null;
}

const b64url = (b) => Buffer.from(b).toString('base64url');

// ---------------- service account -> access token ----------------
let tokenCache = { token: null, exp: 0 };
async function accessToken(sa) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60e3) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key).toString('base64url');
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Firebase auth failed: ' + (data.error_description || data.error || res.status));
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

// ---------------- Firestore value encoding ----------------
export function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}
export function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encode(v);
  return out;
}
export function decode(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
export function decodeFields(f) {
  const out = {};
  for (const [k, v] of Object.entries(f)) out[k] = decode(v);
  return out;
}

// ---------------- Firestore client ----------------
export function firestore(sa) {
  const pid = projectId(sa);
  const emu = process.env.FIRESTORE_EMULATOR_HOST; // e.g. localhost:8080 (no auth)
  const base = emu ? `http://${emu}/v1` : 'https://firestore.googleapis.com/v1';
  const root = `projects/${pid}/databases/(default)/documents`;
  const headers = async () => ({ 'content-type': 'application/json', ...(emu ? { authorization: 'Bearer owner' } : { authorization: 'Bearer ' + await accessToken(sa) }) });

  async function req(method, url, body) {
    const res = await fetch(url, { method, headers: await headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firestore ${method} ${res.status}: ${data.error?.message || res.statusText}`);
    return data;
  }

  return {
    projectId: pid,
    /** All docs in a collection -> [{id, data}] */
    async list(coll) {
      const out = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({ pageSize: '300', ...(pageToken ? { pageToken } : {}) });
        const data = await req('GET', `${base}/${root}/${coll}?${q}`);
        for (const d of data.documents || []) out.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields || {}) });
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    /** Atomic batch: ops = [{set:[coll,id,obj]} | {del:[coll,id]}], auto-split at 500 */
    async commit(ops) {
      for (let i = 0; i < ops.length; i += 500) {
        const writes = ops.slice(i, i + 500).map((op) => op.set
          ? { update: { name: `${root}/${op.set[0]}/${op.set[1]}`, fields: encodeFields(op.set[2]) } }
          : { delete: `${root}/${op.del[0]}/${op.del[1]}` });
        await req('POST', `${base}/${root}:commit`, { writes });
      }
    },
  };
}

// ---------------- Firebase Auth ID token verification ----------------
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { certs: null, exp: 0 };
async function googleCerts() {
  if (certCache.certs && Date.now() < certCache.exp) return certCache.certs;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Could not fetch Firebase signing certs');
  const maxAge = +((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  certCache = { certs: await res.json(), exp: Date.now() + maxAge * 1000 };
  return certCache.certs;
}

/** Verifies a Firebase Auth ID token (from signInWithPopup). Returns decoded claims. */
export async function verifyFirebaseIdToken(idToken, pid, { certs } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('Bad token algorithm');
  const pem = (certs || await googleCerts())[header.kid];
  if (!pem) throw new Error('Unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey(pem), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('Bad token signature');
  const now = Date.now() / 1000;
  if (claims.aud !== pid) throw new Error('Token is for a different Firebase project');
  if (claims.iss !== `https://securetoken.google.com/${pid}`) throw new Error('Bad token issuer');
  if (!(claims.exp > now) || !(claims.iat <= now + 300) || !(claims.auth_time <= now + 300)) throw new Error('Token expired');
  if (!claims.sub) throw new Error('Token has no subject');
  return claims;
}
