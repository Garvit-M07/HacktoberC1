# NET X

A voice-enabled index of everyone you meet in real life, powered by **Gemma 4** (Gemini API).

## Run it (no npm install needed)

```bash
node server.js          # Node 18+
# open http://localhost:3000  →  login: demo / demo
```

`.env` already contains your key and model. Use **Chrome or Edge** for voice (Web Speech API).
`npm run reset` wipes `data/db.json` and re-seeds the demo data.

## Features

| Feature | How it works |
|---|---|
| **Voice logging** | `● LOG MEETING` → speak → Gemma 4 extracts name, contact, place, tags, public facts, private notes, needs, who they know → you review → saved |
| **Public / private properties** | Public = business-card facts (visible on their profile). Private = only you, never shared |
| **Shadow profiles** | People not on the platform get a profile keyed by email/phone (hollow dots) |
| **Claim on join** | Registering with an indexed email/phone claims the shadow profile; **MY PROFILE** shows who met you and what they noted publicly |
| **Mesh** | Static black/red web. Distance from center = time since you last met (log scale, NOW → 3Y+). Recent = bigger/brighter, "in front" |
| **Lines** | People who know each other: explicit "knows", their own indexes (if on platform), or met at the same place on the same day |
| **Their mesh** | `VIEW THEIR MESH` on any platform user you know (they can turn it off) |
| **Similar networks** | Jaccard overlap of real-life networks + shared circles → suggestions to connect |
| **Close friends ping** | Mutual opt-in + location sharing. Within 500 m → beep, toast, notification, and the dot moves next to you with a pulse |
| **Agent (LINK)** | Bottom terminal. Ask anything ("who needs a frontend dev?", "what does Aisha want?"). Uses the selected person as context. Voice in (MIC) + voice out (VOICE: ON) |
| **Gemma insight** | Per person: wants, needs, how to help, conversation openers, next action |
| **Log convo** | Voice or text update for an existing person; Gemma re-derives their needs |

Offline fallbacks exist for every Gemma call so the demo never hard-fails.

## 2-minute demo script

1. Login `demo/demo`. Turn **LOC: ON** → Priya is ~100 m away → **PING**, her dot sits next to YOU.
2. Click Priya → pointers: public, private, needs, mutuals, conversations → **GEMMA INSIGHT**.
3. Ask the terminal: `who in my network could help Aisha?`
4. **● LOG MEETING**: *"Just met Rita Gomez at the Hacktober booth, she's a backend engineer at Stripe looking for a cofounder, she knows Sam, email rita@mail.com"* → review → save → new dot at the center, linked to Sam.
5. **SIMILAR NETWORKS** → Dev Patel (5 mutuals) → connect.
6. Click Priya → **VIEW THEIR MESH**.
7. Logout → register with `jordan@example.com` → shadow profile claimed, 3 people already know you.

## Sign in with Google

1. Google Cloud Console → APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → type **Web application**.
   (First time: set up the OAuth consent screen as *External*, add yourself as a test user.)
2. **Authorized JavaScript origins:** `http://localhost:3000` (plus your deployed URL later). No redirect URI needed.
3. Paste the client ID into `env.local`: `GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com`, restart.

The button appears on the login screen automatically. The server verifies the ID token with Google (audience, issuer, expiry, verified email),
then signs in the matching user, or creates one, and **claims any shadow profile indexed under that Gmail address**.

## Data storage

Everything lives in `data/db.json` (users, people, contacts/notes, sessions), written on every change.
Passwords are hashed with scrypt + per-user salt; Google users have no password. Sessions are random 48-char bearer tokens.
Fine for a hackathon demo, but swap for a real database before real users.

## Stack

- `server.js` – Node http server + JSON API, file DB (`data/db.json`), scrypt passwords, token sessions
- `lib/gemma.js` – Gemma 4 REST client (`gemma-4-26b-a4b-it`, falls back to `gemma-4-31b-it`)
- `lib/ai.js` – prompts: meeting parser, conversation digest, insight, agent
- `lib/seed.js` – demo data
- `public/` – vanilla JS canvas mesh, terminal UI, Web Speech API

## API

`POST /api/register|login` · `GET /api/mesh` · `GET /api/network/:personId` · `GET|POST /api/contacts` · `GET|PATCH|DELETE /api/contacts/:id` · `POST /api/contacts/:id/interactions` · `GET /api/contacts/:id/insight` · `POST /api/parse` · `POST /api/agent` · `POST /api/location` · `GET /api/nearby` · `GET /api/suggestions` · `POST /api/connect/:userId` · `GET|PATCH /api/profile`

## Security notes

- `.env` is gitignored — don't commit it. Rotate the key after the hackathon since it was shared in chat.
- Geolocation in browsers needs `localhost` or HTTPS. If denied, the app uses a simulated location so the ping still demos.
