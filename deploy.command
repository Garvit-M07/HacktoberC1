#!/bin/bash
# Double-click to deploy NET X to Firebase Hosting + Cloud Functions (project netx-b1da2).
cd "$(dirname "$0")"
LOG="deploy.log"
exec > >(tee "$LOG") 2>&1
echo "== NET X deploy $(date) =="
if ! command -v node >/dev/null; then echo "Node.js missing - install from nodejs.org"; read -n1 -s; exit 1; fi
if command -v firebase >/dev/null; then FB="firebase"; else FB="npx -y firebase-tools@latest"; fi
echo "using: $FB"
[ -f firebase-service-account.json ] || echo "WARNING: firebase-service-account.json missing"
[ -f env.local ] || echo "WARNING: env.local missing"
if ! $FB login:list 2>/dev/null | grep -q "@"; then
  echo ">> You need to log in to Firebase once - a browser window will open."
  $FB login
fi
echo ">> npm install"
npm install --no-audit --no-fund || { echo "DEPLOY FAILED (npm install)"; read -n1 -s; exit 1; }
echo ">> firebase deploy"
if $FB deploy --project netx-b1da2 --only hosting,functions,firestore:rules --force --non-interactive; then
  echo; echo "DEPLOY OK -> https://netx-b1da2.web.app"
  open "https://netx-b1da2.web.app"
else
  echo; echo "DEPLOY FAILED - see messages above"
fi
read -n 1 -s -r -p "Press any key to close"
