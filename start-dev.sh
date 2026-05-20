#!/usr/bin/env bash
set -euo pipefail

if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "ollama is already running"
else
    echo "Starting ollama..."
    nohup ollama run qwen2.5-coder:32b --keepalive 5m > /tmp/ollama.log 2>&1 &
    echo "Waiting for ollama to be ready..."
    for i in $(seq 1 30); do
        if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
            echo "ollama is ready"
            break
        fi
        sleep 1
    done
fi

if curl -sf http://localhost:8787 > /dev/null 2>&1; then
    echo "opencode web is already running"
else
    echo "Starting opencode web..."
    nohup opencode web > /tmp/opencode-web.log 2>&1 &
    echo "opencode web starting on http://localhost:8787"
fi
