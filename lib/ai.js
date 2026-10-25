// All Gemma-powered features + offline fallbacks so the demo never hard-fails.
import { gemma, gemmaJSON } from './gemma.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (ts) => Math.max(0, Math.round((Date.now() - ts) / 864e5));

// ---------- 1. Voice transcript -> structured contact ----------
export async function parseMeeting(transcript, knownNames = []) {
  const prompt = `You extract structured data about a person the user just met in real life.
Today is ${today()}. The user's existing contacts: ${knownNames.slice(0, 80).join(', ') || 'none'}.

Transcript (spoken by the user, may contain speech-to-text errors):
"""${transcript}"""

Return ONLY a JSON object, no prose:
{
  "name": "full name or best guess",
  "email": "string or null",
  "phone": "digits or null",
  "place": "where they met, or null",
  "metAt": "YYYY-MM-DD if a date/time is mentioned (resolve 'yesterday', 'last week'), else null",
  "tags": ["2-4 short lowercase tags, first tag = main context e.g. hackathon, work, college, gym, music, family"],
  "public": {"key": "value"},   // business-card facts they'd happily share: role, company, school, skills, interests, city, socials
  "private": {"key": "value"},  // user's personal observations, sensitive info, opinions, reminders - never shown to anyone else
  "needs": ["what this person wants or needs, inferred from the conversation"],
  "knows": ["names of other people mentioned as knowing / being with this person"],
  "summary": "one sentence summary of the conversation"
}
Use short snake_case keys. Omit facts that were not mentioned. Do not invent details.`;
  try {
    const out = await gemmaJSON(prompt);
    return { ...blankDraft(), ...out, source: 'gemma' };
  } catch (e) {
    return { ...heuristicParse(transcript), source: 'fallback', error: e.message };
  }
}

function blankDraft() {
  return { name: '', email: null, phone: null, place: null, metAt: null, tags: [], public: {}, private: {}, needs: [], knows: [], summary: '' };
}

function heuristicParse(t) {
  const d = blankDraft();
  const name = t.match(/(?:met|meet|with|named|called|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  d.name = name ? name[1] : 'Unknown';
  d.email = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [null])[0];
  const ph = t.replace(/[^\d+]/g, ' ').match(/\+?\d[\d ]{8,}\d/);
  d.phone = ph ? ph[0].replace(/\D/g, '') : null;
  const place = t.match(/\bat (?:the )?([A-Za-z0-9' ]{3,40}?)(?:[,.]| and | who | she | he | they |$)/i);
  d.place = place ? place[1].trim() : null;
  const works = t.match(/works? (?:at|for) ([A-Z][\w&.]*(?: [A-Z][\w&.]*)*)/);
  if (works) d.public.company = works[1].trim();
  const role = t.match(/(?:is an?|she's an?|he's an?|they're an?) ([a-z ]{3,30}?)(?:[,.]| at | who |$)/i);
  if (role) d.public.role = role[1].trim();
  const need = t.match(/(?:looking for|wants?|needs?) ([^.,]{3,80})/i);
  if (need) d.needs.push(need[1].trim());
  d.tags = [/hack/i.test(t) ? 'hackathon' : 'met'];
  d.summary = t.slice(0, 160);
  return d;
}

// ---------- 2. New conversation with existing contact ----------
export async function digestInteraction(contact, text) {
  const prompt = `You maintain a personal CRM note about ${contact.name}.
Current notes: ${JSON.stringify({ public: contact.public, private: contact.private, needs: contact.needs, tags: contact.tags })}
The user just had this conversation with them (spoken, may have STT errors):
"""${text}"""
Return ONLY JSON:
{"summary":"one sentence","needs":["full updated list of what they want/need - merge old + new, drop resolved"],
 "public_add":{"key":"value"}, "private_add":{"key":"value"}, "tags_add":["tag"], "place": "where, or null"}`;
  try {
    return { ...(await gemmaJSON(prompt)), source: 'gemma' };
  } catch (e) {
    return { summary: text.slice(0, 160), needs: contact.needs, public_add: {}, private_add: {}, tags_add: [], source: 'fallback', error: e.message };
  }
}

// ---------- 3. Insight card for a contact ----------
export async function insight(contact, mutualNames) {
  const prompt = `Analyse this person from the user's real-life network and help the user understand them.
${serializeContact(contact, true)}
Mutual connections: ${mutualNames.join(', ') || 'none'}
Return ONLY JSON:
{"wants":["what they want, short"],"needs":["what they need / pain points"],"how_to_help":["concrete ways the user can help or add value"],
 "openers":["2-3 natural conversation openers for next time"],"follow_up":"single best next action","vibe":"3-6 word read on the relationship"}`;
  try {
    return { ...(await gemmaJSON(prompt)), source: 'gemma', at: Date.now() };
  } catch (e) {
    return {
      wants: contact.needs.slice(0, 3), needs: [], how_to_help: [],
      openers: [`Ask how ${contact.name.split(' ')[0]} is doing since ${contact.place || 'you last met'}`],
      follow_up: `Reconnect - last met ${daysAgo(contact.lastMet)} days ago`, vibe: 'offline estimate',
      source: 'fallback', error: e.message, at: Date.now(),
    };
  }
}

// ---------- 4. Network agent (chat) ----------
export async function agent({ me, contacts, focus, history, message }) {
  const index = contacts.map((c) => serializeContact(c, c.id === focus?.id)).join('\n');
  const preamble = `You are LINK, the network agent inside NET X - a private index of people ${me.name} has met in real life.
Today is ${today()}. Answer ONLY from the index below; if something isn't recorded, say so.
Infer what people want or need from their conversations and cite when (e.g. "on 2026-10-20 she said...").
Be concise and direct, plain text, use short "- " bullet points when listing. Never reveal one contact's private notes as if they were public.
${focus ? `The user currently has ${focus.name} selected - "they/he/she" probably refers to them.\n` : ''}
=== NETWORK INDEX (${contacts.length} people) ===
${index}
=== END INDEX ===`;
  const contents = [
    { role: 'user', parts: [{ text: preamble + '\n\nAcknowledge with OK.' }] },
    { role: 'model', parts: [{ text: 'OK' }] },
    ...history.slice(-10).map((h) => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  try {
    return { reply: await gemma(contents, { temperature: 0.5 }), source: 'gemma' };
  } catch (e) {
    return { reply: localAnswer(message, contacts, focus) + `\n(gemma offline: ${e.message})`, source: 'fallback' };
  }
}

function localAnswer(msg, contacts, focus) {
  const m = msg.toLowerCase();
  const hit = contacts.find((c) => m.includes(c.name.toLowerCase().split(' ')[0])) || focus;
  if (hit) {
    return [`${hit.name} - last met ${daysAgo(hit.lastMet)}d ago${hit.place ? ' at ' + hit.place : ''}.`,
      ...Object.entries(hit.public).map(([k, v]) => `- ${k}: ${v}`),
      ...hit.needs.map((n) => `- needs: ${n}`)].join('\n');
  }
  const recent = [...contacts].sort((a, b) => b.lastMet - a.lastMet).slice(0, 5);
  return 'Most recent people:\n' + recent.map((c) => `- ${c.name} (${daysAgo(c.lastMet)}d ago)`).join('\n');
}

export function serializeContact(c, full = false) {
  const lines = [
    `## ${c.name} | tags: ${c.tags.join(', ')} | first met ${new Date(c.metAt).toISOString().slice(0, 10)}${c.place ? ' @ ' + c.place : ''} | last met ${daysAgo(c.lastMet)}d ago${c.closeFriend ? ' | CLOSE FRIEND' : ''}`,
    `  public: ${JSON.stringify(c.public)}`,
    `  private: ${JSON.stringify(c.private)}`,
    `  needs: ${JSON.stringify(c.needs)}`,
  ];
  const convos = full ? c.interactions : c.interactions.slice(-3);
  for (const i of convos) lines.push(`  [${new Date(i.ts).toISOString().slice(0, 10)}] ${full ? i.text : i.summary || i.text}`);
  return lines.join('\n');
}
