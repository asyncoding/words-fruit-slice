#!/bin/bash
PORT=${1:-3000}
DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if port is in use
while lsof -i :$PORT >/dev/null 2>&1; do
  echo "⚠️  Port $PORT is in use, trying next port..."
  PORT=$((PORT + 1))
done

echo "🚀 切西瓜大作战 — http://localhost:$PORT"
cd "$DIR" && npx serve . -l "$PORT" --no-clipboard 2>/dev/null || python3 -m http.server "$PORT" --bind 127.0.0.1
