#!/bin/bash
# Double-click this file in Finder to start NET X.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then double-click start.command again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
echo "Node $(node -v)"
PORT=3000
if lsof -ti tcp:$PORT >/dev/null 2>&1; then
  echo "Port $PORT is busy - stopping the old process"; kill $(lsof -ti tcp:$PORT) 2>/dev/null; sleep 1
fi
(sleep 1.5 && open "http://localhost:$PORT") &
node server.js
read -n 1 -s -r -p "Server stopped. Press any key to close"
