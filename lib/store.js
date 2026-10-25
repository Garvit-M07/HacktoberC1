// Storage backend. Data is held in memory for speed and persisted to:
//   - Firebase Firestore, when a service account is configured (production / hosting)
//   - data/db.json otherwise (local dev, zero setup)
// Only changed documents are written to Firestore (per-document diff).
import fs from 'node:fs';
import path from 'node:path';
import { firestore, loadServiceAccount, projectId } from './firebase.js';

const COLLECTIONS = ['users', 'persons', 'contacts'];

export async function createStore(rootDir, seedFn) {
  const sa = loadServiceAccount(rootDir);
  const file = path.join(rootDir, 'data', 'db.json');
  const useFirestore = !!(sa || process.env.FIRESTORE_EMULATOR_HOST) && !!projectId(sa);
  return useFirestore ? firestoreStore(sa, file, seedFn) : fileStore(file, seedFn);
}

function fileStore(file, seedFn) {
  let db;
  if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
  else db = seedFn();
  const write = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); };
  write();
  return { mode: 'local file (data/db.json)', db, save: async () => write(), flush: async () => write() };
}

async function firestoreStore(sa, localFile, seedFn) {
  const fsdb = firestore(sa);
  const db = { users: [], persons: [], contacts: [], sessions: {} };
  const snapshot = { users: new Map(), persons: new Map(), contacts: new Map(), sessions: new Map() };

  for (const c of COLLECTIONS) {
    for (const d of await fsdb.list(c)) { db[c].push({ ...d.data, id: d.id }); snapshot[c].set(d.id, JSON.stringify(d.data)); }
  }
  for (const d of await fsdb.list('sessions')) { db.sessions[d.id] = d.data.uid; snapshot.sessions.set(d.id, JSON.stringify({ uid: d.data.uid })); }

  let migrated = null;
  if (!db.users.length && !db.persons.length) {
    // empty project: import the local db.json if there is one, else seed demo data
    const src = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : seedFn();
    migrated = fs.existsSync(localFile) ? 'imported data/db.json' : 'seeded demo data';
    Object.assign(db, src);
  }

  let chain = Promise.resolve();
  let lastError = null;
  async function sync() {
    const ops = [];
    const diff = (coll, items) => {
      const seen = new Set();
      for (const [id, data] of items) {
        seen.add(id);
        const json = JSON.stringify(data);
        if (snapshot[coll].get(id) !== json) { ops.push({ set: [coll, id, data] }); snapshot[coll].set(id, json); }
      }
      for (const id of [...snapshot[coll].keys()]) if (!seen.has(id)) { ops.push({ del: [coll, id] }); snapshot[coll].delete(id); }
    };
    for (const c of COLLECTIONS) diff(c, db[c].map((x) => { const { id, ...rest } = x; return [id, { ...rest, id }]; }));
    diff('sessions', Object.entries(db.sessions).map(([t, uid]) => [t, { uid }]));
    if (ops.length) {
      try { await fsdb.commit(ops); lastError = null; }
      catch (e) {
        lastError = e.message; console.error('[firestore]', e.message);
        // forget the snapshot entries so the next save retries them
        for (const op of ops) snapshot[(op.set || op.del)[0]].delete((op.set || op.del)[1]);
      }
    }
  }
  const save = () => (chain = chain.then(sync));
  await save();
  return {
    mode: `firebase firestore (${fsdb.projectId})${migrated ? ' - ' + migrated : ''}`,
    db, save, flush: save,
    get lastError() { return lastError; },
  };
}
