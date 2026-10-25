// Identity matching: when someone joins and fills in their profile (DOB, school,
// work, languages...), find the shadow profiles other users already created for
// them, plus existing platform users who look like the same / similar person.
//
// Only PUBLIC facts other users recorded are compared. Private notes are never
// used for matching and never shown.

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9@+ ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'of', 'at', 'a', 'an', 'and', 'in', 'for', 'university', 'college', 'school', 'inc', 'llc', 'ltd', 'co', 'company']);
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t));
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;/|]| and /)).map((x) => norm(x)).filter(Boolean);

// Which public-fact keys mean what
const KEYS = {
  school: ['school', 'college', 'university', 'uni', 'education', 'studies', 'alma_mater', 'campus'],
  field: ['field', 'major', 'course', 'degree', 'program', 'study'],
  workplace: ['company', 'workplace', 'employer', 'org', 'organization', 'works_at', 'startup', 'lab'],
  role: ['role', 'occupation', 'job', 'title', 'position', 'profession', 'what_they_do'],
  city: ['city', 'location', 'based', 'hometown', 'lives', 'town'],
  languages: ['languages', 'language', 'speaks'],
  interests: ['interests', 'skills', 'hobbies', 'likes', 'focus'],
  dob: ['birthday', 'dob', 'born', 'birth_date', 'date_of_birth'],
};
const kind = (key) => {
  const k = norm(key).replace(/ /g, '_');
  for (const [name, keys] of Object.entries(KEYS)) if (keys.some((x) => k === x || k.includes(x))) return name;
  return null;
};

// Similarity between two phrases, 0..1 (token overlap, tolerant of "State Univ" vs "State University")
function sim(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  if (norm(a) === norm(b)) return 1;
  let hit = 0;
  for (const t of A) if (B.some((u) => u === t || (t.length > 3 && (u.startsWith(t) || t.startsWith(u))))) hit++;
  return hit / Math.max(A.length, B.length);
}

function nameScore(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  if (norm(a) === norm(b)) return 1;
  const firstEq = A[0] === B[0], lastEq = A.at(-1) === B.at(-1);
  if (firstEq && lastEq) return 0.95;
  if (firstEq && A.length > 1 && B.length > 1 && A.at(-1)[0] === B.at(-1)[0]) return 0.7; // "Sam O." vs "Sam Okafor"
  if (firstEq) return 0.45;
  if (lastEq) return 0.25;
  return 0;
}

/** Collect everything the network publicly knows about one person. */
export function evidenceFor(db, personId) {
  const person = db.persons.find((p) => p.id === personId);
  const about = db.contacts.filter((c) => c.personId === personId);
  const ev = { names: new Set(person ? [person.name] : []), email: person?.email || null, phone: person?.phone || null, facts: {}, tags: new Set(), places: new Set(), by: new Set() };
  for (const c of about) {
    ev.names.add(c.name);
    c.tags?.forEach((t) => ev.tags.add(t));
    if (c.place) ev.places.add(c.place);
    ev.by.add(c.ownerId);
    for (const [k, v] of Object.entries(c.public || {})) {
      const kd = kind(k);
      if (kd) (ev.facts[kd] ||= new Set()).add(String(v));
    }
  }
  // a platform user's own self-declared profile counts as evidence too
  const owner = db.users.find((u) => u.personId === personId);
  if (owner?.profile) {
    const p = owner.profile;
    for (const k of ['school', 'field', 'workplace', 'role', 'city']) if (p[k]) (ev.facts[k] ||= new Set()).add(p[k]);
    for (const k of ['languages', 'interests']) for (const x of p[k] || []) (ev.facts[k] ||= new Set()).add(x);
  }
  return ev;
}

/**
 * Score one candidate against the joining user's profile.
 * profile = {name, email, phone, school, field, workplace, role, city, languages[], interests[]}
 */
export function scoreCandidate(profile, ev) {
  const reasons = [];
  let score = 0;

  if (profile.email && ev.email && profile.email === ev.email) { score += 70; reasons.push('same email'); }
  if (profile.phone && ev.phone && profile.phone === ev.phone) { score += 70; reasons.push('same phone number'); }

  let best = 0, bestName = '';
  for (const n of ev.names) { const s = nameScore(profile.name, n); if (s > best) { best = s; bestName = n; } }
  if (best) { score += Math.round(best * 35); reasons.push(best >= 0.95 ? `name "${bestName}"` : `similar name "${bestName}"`); }

  const facts = (k) => [...(ev.facts[k] || [])];
  const one = (k, label, weight) => {
    if (!profile[k]) return;
    let s = 0, hit = '';
    for (const v of facts(k)) { const x = sim(profile[k], v); if (x > s) { s = x; hit = v; } }
    if (s >= 0.5) { score += Math.round(s * weight); reasons.push(`${label}: ${hit}`); }
  };
  one('school', 'studies at', 22);
  one('workplace', 'works at', 22);
  one('role', 'role', 12);
  one('field', 'field', 8);
  one('city', 'city', 8);

  const many = (k, label, each, cap) => {
    const theirs = facts(k).flatMap(list);
    const shared = [...new Set((profile[k] || []).map(norm))].filter((x) => theirs.some((t) => t === x || sim(t, x) >= 0.6));
    if (shared.length) { score += Math.min(cap, shared.length * each); reasons.push(`${label}: ${shared.join(', ')}`); }
  };
  if (profile.dob) {
    const [, m, d] = profile.dob.split('-').map(Number);
    for (const v of facts('dob')) {
      const t = Date.parse(/\d{4}/.test(v) ? v : `${v} 2000`);
      if (!Number.isNaN(t)) {
        const x = new Date(t);
        if (x.getMonth() + 1 === m && x.getDate() === d) { score += 15; reasons.push(`birthday ${v}`); break; }
      }
    }
  }
  many('languages', 'speaks', 5, 10);
  many('interests', 'interests', 3, 9);

  // the profile's own interests vs tags people used ("hackathon", "ai", ...)
  const tagHits = (profile.interests || []).map(norm).filter((x) => ev.tags.has(x));
  if (tagHits.length) { score += Math.min(6, tagHits.length * 2); }

  // need a name signal OR a hard identifier, otherwise it's just "similar person", not "you"
  const identity = best >= 0.45 || reasons.some((r) => r.startsWith('same '));
  return { score: Math.min(100, score), reasons, identity };
}

/** Shadow profiles (people indexed by others, not yet claimed) that might be this user. */
export function findIdentityMatches(db, user, profile, { min = 40, limit = 6 } = {}) {
  const dismissed = new Set(user.dismissedMatches || []);
  const out = [];
  for (const p of db.persons) {
    if (p.claimedBy || p.mergedInto || p.id === user.personId || dismissed.has(p.id)) continue;
    const ev = evidenceFor(db, p.id);
    if (!ev.by.size) continue; // nobody indexed them
    const s = scoreCandidate(profile, ev);
    if (!s.identity || s.score < min) continue;
    out.push({
      personId: p.id, name: p.name, confidence: s.score, reasons: s.reasons,
      indexedBy: [...ev.by].map((id) => db.users.find((u) => u.id === id)?.name).filter(Boolean),
      metAt: [...ev.places].slice(0, 3),
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

/** Existing platform users with an overlapping profile (same school, company, languages...). */
export function findSimilarUsers(db, user, profile, { limit = 8 } = {}) {
  const out = [];
  for (const u of db.users) {
    if (u.id === user.id || !u.profile) continue;
    const ev = evidenceFor(db, u.personId);
    const s = scoreCandidate({ ...profile, name: '', email: null, phone: null }, ev);
    if (s.score < 15) continue;
    out.push({ user: { id: u.id, handle: u.handle, name: u.name, headline: u.headline }, score: s.score, reasons: s.reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Normalise the onboarding form. */
export function cleanProfile(body) {
  const str = (v, n = 120) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
  const dob = str(body.dob, 10);
  return {
    dob: /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : '',
    school: str(body.school), field: str(body.field), workplace: str(body.workplace), role: str(body.role),
    city: str(body.city), languages: arr(body.languages), interests: arr(body.interests),
    socials: { linkedin: str(body.linkedin, 200), github: str(body.github, 200), instagram: str(body.instagram, 200) },
  };
}
