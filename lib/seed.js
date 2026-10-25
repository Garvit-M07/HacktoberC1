// Demo dataset: 1 main account (demo/demo), 4 other platform users, ~22 people
// spread over 3 years, plus a shadow profile you can claim by registering with
// jordan@example.com.
import crypto from 'node:crypto';

const DAY = 864e5;
const rid = () => crypto.randomBytes(6).toString('hex');

export function seed(hashPw) {
  const now = Date.now();
  const db = { users: [], persons: [], contacts: [], sessions: {} };

  const person = (name, email = null, phone = null) => {
    const p = { id: rid(), name, email, phone, claimedBy: null, createdAt: now };
    db.persons.push(p);
    return p;
  };
  const user = (handle, p, extra = {}) => {
    const salt = rid();
    const u = {
      id: rid(), handle, name: p.name, email: p.email, phone: p.phone, salt,
      passHash: hashPw('demo', salt), personId: p.id, headline: '', bio: '',
      shareLocation: true, publicNetwork: true, loc: null, createdAt: now, ...extra,
    };
    p.claimedBy = u.id;
    db.users.push(u);
    return u;
  };
  const contact = (owner, p, o) => {
    const metAt = now - o.met * DAY;
    const lastMet = now - (o.last ?? o.met) * DAY;
    const c = {
      id: rid(), ownerId: owner.id, personId: p.id, name: p.name,
      tags: o.tags || [], place: o.place || null, metAt, lastMet,
      public: o.pub || {}, private: o.priv || {}, needs: o.needs || [], knows: [],
      closeFriend: !!o.close, insight: null,
      interactions: (o.convos || []).map(([d, text, summary]) => ({ ts: now - d * DAY, text, summary: summary || text })),
    };
    if (!c.interactions.length) c.interactions.push({ ts: metAt, text: `Met ${p.name} at ${c.place || 'an event'}.`, summary: `First met at ${c.place || 'an event'}.` });
    db.contacts.push(c);
    return c;
  };

  // ---- people ----
  const P = {
    me: person('Alex Morgan', 'alex@demo.dev', '5550000001'),
    priya: person('Priya Raman', 'priya@demo.dev', '5550000002'),
    marcus: person('Marcus Chen', 'marcus@demo.dev', '5550000003'),
    aisha: person('Aisha Bello', 'aisha@demo.dev', '5550000004'),
    dev: person('Dev Patel', 'dev@demo.dev', '5550000005'),
    lena: person('Lena Park', 'lena@demo.dev', '5550000006'),
    jordan: person('Jordan Lee', 'jordan@example.com', null), // unclaimed shadow profile
    sam: person('Sam Okafor'), nina: person('Nina Volkova'), tomas: person('Tomás Rivera'),
    keiko: person('Keiko Tanaka'), omar: person('Omar Haddad'), grace: person('Grace Kim'),
    ben: person('Ben Wallace'), fatima: person('Fatima Noor'), leo: person('Leo Rossi'),
    hannah: person('Hannah Schmidt'), raj: person('Raj Iyer'), zoe: person('Zoe Martin'),
    ethan: person('Ethan Brooks'), mira: person('Mira Shah'), carlos: person('Carlos Mendez'),
    yuki: person('Yuki Sato'), ivy: person('Ivy Chen'),
  };

  const me = user('demo', P.me, { headline: 'Builder. Hackathon regular.', bio: 'Building NET X at Hacktober.' });
  const priya = user('priya', P.priya, { headline: 'Rust + ML infra', demoOffset: { n: 90, e: 60 } }); // ~110 m away -> ping
  const marcus = user('marcus', P.marcus, { headline: 'Product designer', demoOffset: { n: 1800, e: -900 } }); // ~2 km
  const aisha = user('aisha', P.aisha, { headline: 'Founder @ GreenLoop' });
  const dev = user('dev', P.dev, { headline: 'ML researcher' });
  const lena = user('lena', P.lena, { headline: 'Indie game dev' });

  // ---- Alex's index ----
  const k = {};
  k.priya = contact(me, P.priya, { met: 400, last: 0.1, tags: ['hackathon', 'ai'], place: 'Hacktober kickoff', close: true,
    pub: { role: 'ML infra engineer', skills: 'Rust, CUDA', school: 'State University' },
    priv: { birthday: 'March 14', note: 'Prefers texting over calls' },
    needs: ['a frontend teammate for this weekend', 'beta testers for her inference cache'],
    convos: [[400, 'Met Priya at last year\'s hackathon, she built a Rust inference server.', 'Met at last year\'s hackathon; built a Rust inference server.'],
      [0.1, 'Priya said she is still looking for a frontend teammate and wants beta testers for her inference cache project.', 'Looking for frontend teammate + beta testers for inference cache.']] });
  k.marcus = contact(me, P.marcus, { met: 700, last: 3, tags: ['design', 'work'], place: 'Design meetup', close: true,
    pub: { role: 'Product designer', company: 'Figment Labs' }, priv: { note: 'Going through a job switch, be supportive' },
    needs: ['intro to an AI startup hiring designers'],
    convos: [[3, 'Coffee with Marcus. He is interviewing and wants intros to AI startups that hire designers.', 'Wants intros to AI startups hiring designers.']] });
  k.aisha = contact(me, P.aisha, { met: 210, last: 12, tags: ['startup', 'climate'], place: 'Founder dinner',
    pub: { role: 'Founder', company: 'GreenLoop', focus: 'circular packaging' }, needs: ['seed investors', 'a technical cofounder'],
    convos: [[12, 'Aisha is raising a seed round for GreenLoop and needs a technical cofounder who knows logistics software.', 'Raising seed; needs technical cofounder.']] });
  k.jordan = contact(me, P.jordan, { met: 30, last: 6, tags: ['hackathon', 'ai'], place: 'Hacktober kickoff',
    pub: { role: 'Student', interests: 'LLM agents, climbing' }, needs: ['a summer internship'],
    convos: [[6, 'Jordan asked if I know anyone hiring interns for agent work. Climbs on weekends.', 'Wants an internship in agent work.']] });
  k.sam = contact(me, P.sam, { met: 2, tags: ['hackathon', 'ai'], place: 'Hacktober kickoff', pub: { role: 'Backend dev', skills: 'Go, Postgres' }, needs: ['team for the hackathon'] });
  k.nina = contact(me, P.nina, { met: 1, tags: ['hackathon', 'design'], place: 'Hacktober kickoff', pub: { role: 'UX student' }, priv: { note: 'Really good at Figma prototypes' } });
  k.tomas = contact(me, P.tomas, { met: 8, tags: ['gym'], place: 'Ironworks Gym', pub: { interests: 'powerlifting' } });
  k.keiko = contact(me, P.keiko, { met: 20, tags: ['music'], place: 'Jazz night', pub: { role: 'Pianist' }, needs: ['a venue for her trio'] });
  k.omar = contact(me, P.omar, { met: 45, tags: ['work'], place: 'Office', pub: { role: 'Engineering manager', company: 'Acme' }, needs: ['senior backend hires'] });
  k.grace = contact(me, P.grace, { met: 60, tags: ['college'], place: 'Alumni event', pub: { role: 'PhD student', field: 'HCI' } });
  k.ben = contact(me, P.ben, { met: 90, tags: ['gym'], place: 'Ironworks Gym', priv: { note: 'Owes me a spot on bench day' } });
  k.fatima = contact(me, P.fatima, { met: 120, tags: ['startup'], place: 'Founder dinner', pub: { role: 'Angel investor' }, needs: ['climate deals'] });
  k.leo = contact(me, P.leo, { met: 180, tags: ['music'], place: 'Jazz night', pub: { role: 'Sound engineer' } });
  k.hannah = contact(me, P.hannah, { met: 240, tags: ['work'], place: 'Office', pub: { role: 'Recruiter', company: 'Acme' } });
  k.raj = contact(me, P.raj, { met: 365, tags: ['college'], place: 'Campus', pub: { role: 'Data scientist' } });
  k.zoe = contact(me, P.zoe, { met: 420, tags: ['design'], place: 'Design meetup', pub: { role: 'Illustrator' } });
  k.ethan = contact(me, P.ethan, { met: 540, tags: ['college'], place: 'Campus', priv: { note: 'Roommate freshman year' } });
  k.mira = contact(me, P.mira, { met: 700, tags: ['family'], place: 'Cousin\'s wedding', pub: { relation: 'cousin\'s friend' } });
  k.carlos = contact(me, P.carlos, { met: 900, tags: ['work'], place: 'Old job', pub: { role: 'QA lead' } });
  k.yuki = contact(me, P.yuki, { met: 1050, tags: ['college'], place: 'Campus', pub: { role: 'Exchange student' } });

  // explicit "knows" links (who knows who in real life)
  const knows = (a, ...bs) => { for (const b of bs) a.knows.push(P[b].id); };
  knows(k.priya, 'sam', 'nina', 'jordan', 'marcus');
  knows(k.sam, 'nina', 'jordan');
  knows(k.aisha, 'fatima');
  knows(k.omar, 'hannah', 'carlos');
  knows(k.keiko, 'leo');
  knows(k.tomas, 'ben');
  knows(k.grace, 'raj', 'ethan', 'yuki');
  knows(k.marcus, 'zoe');

  // ---- other users' own indexes (creates cross-mesh edges + suggestions) ----
  const add = (owner, p, met, tags, place, extra = {}) => contact(owner, p, { met, tags, place, ...extra });
  add(priya, P.me, 400, ['hackathon'], 'Hacktober kickoff', { close: true, last: 0.1, pub: { role: 'Builder' } });
  add(priya, P.sam, 2, ['hackathon'], 'Hacktober kickoff');
  add(priya, P.dev, 50, ['ai'], 'ML reading group', { pub: { role: 'ML researcher' } });
  add(priya, P.jordan, 30, ['hackathon'], 'Hacktober kickoff');
  add(priya, P.nina, 1, ['hackathon'], 'Hacktober kickoff');
  add(marcus, P.me, 700, ['design'], 'Design meetup', { close: true, last: 3 });
  add(marcus, P.zoe, 400, ['design'], 'Design meetup');
  add(marcus, P.lena, 80, ['design'], 'Game jam');
  add(marcus, P.priya, 300, ['ai'], 'Hacktober kickoff');
  add(aisha, P.me, 210, ['startup'], 'Founder dinner');
  add(aisha, P.fatima, 300, ['startup'], 'Founder dinner');
  add(aisha, P.dev, 90, ['ai'], 'Climate x AI panel');
  add(dev, P.priya, 50, ['ai'], 'ML reading group');
  add(dev, P.sam, 40, ['ai'], 'ML reading group');
  add(dev, P.jordan, 25, ['ai'], 'ML reading group');
  add(dev, P.nina, 10, ['hackathon'], 'Hacktober kickoff');
  add(dev, P.aisha, 90, ['startup'], 'Climate x AI panel');
  add(lena, P.marcus, 80, ['design'], 'Game jam');
  add(lena, P.zoe, 120, ['design'], 'Game jam');
  add(lena, P.keiko, 60, ['music'], 'Jazz night');
  add(lena, P.leo, 60, ['music'], 'Jazz night');

  return db;
}
