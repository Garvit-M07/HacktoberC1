# NET X

A voice-enabled index of everyone you meet in real life, powered by **Gemma 4**, with **Firebase** for storage and Google sign-in.

## Run it locally

Double-click `start.command` (macOS), or run:

```bash
node server.js          # Node 18+, no npm install needed
# open http://localhost:3000  →  login: demo / demo
```

Settings live in `env.local` (gitignored). With no Firebase settings, data is saved to `data/db.json`.

## Where Gemma 4 is used

All calls go to Google's **Gemini API** (`generativelanguage.googleapis.com`, `generateContent`) with the model
`gemma-4-26b-a4b-it`, falling back to `gemma-4-31b-it`. The code is in `lib/gemma.js` (client) and `lib/ai.js` (prompts).

| # | Feature | Where in the app | What Gemma does |
|---|---|---|---|
| 1 | **Voice → contact** | ● LOG MEETING | Turns a spoken description into structured data: name, email/phone, place, date, tags, public facts, private notes, needs, who they know |
| 2 | **Conversation digest** | ● LOG CONVO on a person | Reads a new conversation, re-derives what the person wants/needs, adds new facts and tags |
| 3 | **Insight card** | GEMMA INSIGHT on a person | Wants, needs, how you can help, conversation openers, best next action |
| 4 | **LINK agent** | Bottom terminal (type or MIC) | Multi-turn chat over your whole network index, citing past conversations |
| 5 | **Identity verification** | Onboarding "Is this you?" | Reads the rule-based match evidence and decides same / maybe / different person, removing false positives |
| 6 | **Speak-to-fill profile** | Onboarding ● SPEAK / FILL FORM | Turns a spoken or typed "about me" into the profile fields (DOB, school, work, languages…) |

Voice input/output uses the browser's Web Speech API. Gemma receives the transcribed text.
Every Gemma feature has an offline fallback, so the app keeps working if the API is down.

## Firebase setup (≈10 min)

1. **Create a project** at console.firebase.google.com.
2. **Firestore:** Build → Firestore Database → Create database (production mode, any region).
   Set the rules to deny everything. Only the server (service account) touches the data:
   ```
   rules_version = '2';
   service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }
   ```
3. **Service account (server → Firestore):** Project settings → Service accounts → *Generate new private key*.
   Save it as `firebase-service-account.json` in the project folder. It is gitignored, so never commit it.
4. **Google sign-in (Firebase Auth):** Build → Authentication → Get started → Sign-in method → **Google** → Enable.
5. **Web app config:** Project settings → General → Your apps → **</>** (add web app). Copy `apiKey`, `authDomain`, `appId`.
6. Fill in `env.local`:
   ```
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_API_KEY=AIza...
   FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
   FIREBASE_APP_ID=1:123:web:abc
   ```
7. Restart. The terminal shows `storage: firebase firestore (...)` and `firebase auth: on`.
   On the first start an empty Firestore is filled from your existing `data/db.json` (or the demo data).

**Firestore collections:** `users`, `persons` (everyone known, including shadow profiles), `contacts` (what each user recorded about each person), `sessions`.

## Onboarding + identity matching

New users (password, Google, or Firebase sign-in) see **WHO ARE YOU?**, which asks for name, date of birth, city, school, field, what they do,
workplace, languages, interests and socials. Date of birth and phone are private and only used for matching.

Then **SCAN THE NETWORK** runs:
1. **Rule-based matcher** (`lib/match.js`) scores every unclaimed shadow profile using only the *public* facts other users recorded:
   name similarity, email/phone, school, workplace, role, field, city, birthday, languages, interests.
   A name or hard identifier is required, so "same school" alone never counts as "you".
2. **Gemma 4** double-checks the candidates (see table above).
3. **IS THIS YOU?** → *THAT'S ME* merges the shadow profile into the account. Every note others kept is re-pointed to you,
   duplicates are folded together, and "who knows who" links are updated. The server re-runs the matcher before allowing a claim,
   so you can't claim an arbitrary profile.
4. **PEOPLE LIKE YOU** lists existing users with overlapping profiles to connect with.

Private notes are never used for matching and never shown to anyone except their author.

Demo: register as **Sam Okafor**, studying at Purdue, backend developer, West Lafayette, speaks English and Yoruba. You'll get a ~90% match
on the shadow profile that Alex, Priya and Dev created.

## Hosting on Firebase (Hosting + Cloud Functions)

The pages in `public/` are served by **Firebase Hosting**. Every `/api/**` request goes to a **Cloud Function** (`functions.js`)
running the same server code, with data in Firestore. Config: `firebase.json`, `.firebaserc` (project `netx-b1da2`), `firestore.rules`.

One-time setup:
1. Firebase console → ⚙️ → **Usage and billing** → upgrade to **Blaze** (pay-as-you-go). Cloud Functions require it.
   Hackathon traffic stays inside the free quota, but Google needs a card on file. Set a budget alert (e.g. $5) while you're there.
2. `firebase-service-account.json` and `env.local` must be in the project folder (they're deployed with the function and never committed to git).

Deploy (from the project folder):
```bash
npm install          # installs firebase-functions for the deploy step
firebase deploy --only hosting,functions,firestore:rules
```
Your app is then live at **https://netx-b1da2.web.app**. Google sign-in works there automatically, because Firebase pre-authorizes that domain.
Re-run the deploy command after every change.

## Alternative: Render (free, no card)

`render.yaml` is included: render.com → New + → Blueprint → pick the repo, then set `GEMMA_API_KEY`, `FIREBASE_PROJECT_ID`,
`FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` (paste the whole key file).
Add the `.onrender.com` domain to Firebase → Authentication → Settings → Authorized domains.

## Other features

Mesh (recent = center, 3y+ = edge), public/private notes, shadow profiles, close-friend proximity pings, similar networks,
viewing other people's meshes. See the demo script below.

### 2-minute demo script

1. Login `demo/demo`. Turn **LOC: ON** → Priya is ~100 m away → **PING**, her dot sits next to YOU.
2. Click Priya → public, private, needs, mutuals, conversations → **GEMMA INSIGHT**.
3. Ask the terminal: `who in my network could help Aisha?`
4. **● LOG MEETING**: *"Just met Rita Gomez at the Hacktober booth, she's a backend engineer at Stripe looking for a cofounder, she knows Sam, email rita@mail.com"*.
5. EXIT → **CONTINUE WITH GOOGLE** or register as Sam Okafor → onboarding → **IS THIS YOU?** → claim → 3 people already know you.

## Stack

- `server.js`: Node http server + JSON API (no npm dependencies)
- `lib/store.js`: in-memory data, persisted to Firestore (per-document diff writes) or `data/db.json`
- `lib/firebase.js`: Firestore REST client + Firebase Auth ID-token verification (service-account JWT, Google certs)
- `lib/match.js`: identity matching
- `lib/gemma.js`, `lib/ai.js`: Gemma 4 client and prompts
- `public/`: vanilla JS canvas mesh, terminal UI, onboarding, Firebase Auth web SDK, Web Speech API
