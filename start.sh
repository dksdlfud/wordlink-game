#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
node -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)" || {
  echo "Node.js 22 or newer is required. Node.js 26 LTS is recommended."
  exit 1
}
if [ ! -f node_modules/socket.io/package.json ]; then npm install; fi
npm start
