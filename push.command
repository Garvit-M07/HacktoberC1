#!/bin/bash
# Double-click to commit and push NET X to GitHub.
cd "$(dirname "$0")"
exec > >(tee push.log) 2>&1
echo "== push $(date) =="
git add -A
git commit -m "NET X: Firebase auth + Firestore, onboarding + identity matching, voice fill, hosting configs" || echo "(nothing new to commit)"
git pull origin main --no-rebase --no-edit -X ours || { echo "PULL FAILED"; read -n1 -s; exit 1; }
if git push -u origin main; then echo; echo "PUSH OK"; else echo; echo "PUSH FAILED"; fi
git log --oneline -3
read -n 1 -s -r -p "Press any key to close"
