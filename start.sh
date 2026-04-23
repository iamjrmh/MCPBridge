#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Roblox Ollama MCP Bridge — Startup Script
# ─────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/mcp-server"

echo "========================================"
echo "  Roblox Ollama MCP Bridge"
echo "========================================"
echo ""

# 1. Check Node.js
if ! command -v node &>/dev/null; then
    echo "❌ Node.js not found. Install from https://nodejs.org"
    exit 1
fi
echo "✅ Node.js $(node --version)"

# 2. Check Ollama
if ! command -v ollama &>/dev/null; then
    echo "⚠️  ollama CLI not found in PATH — make sure Ollama is running"
else
    echo "✅ Ollama found: $(ollama --version 2>/dev/null || echo 'version unknown')"
fi

# 3. Install dependencies if needed
if [ ! -d "$SERVER_DIR/node_modules" ]; then
    echo ""
    echo "📦 Installing npm dependencies..."
    cd "$SERVER_DIR" && npm install
fi

# 4. Print config instructions
echo ""
echo "─────────────────────────────────────────"
echo " Claude Code MCP config (add this to"
echo " ~/.claude.json  OR  .claude/mcp.json):"
echo "─────────────────────────────────────────"
cat <<EOF
{
  "mcpServers": {
    "roblox-ollama": {
      "command": "node",
      "args": ["$SERVER_DIR/index.js"]
    }
  }
}
EOF
echo ""
echo "─────────────────────────────────────────"
echo " HTTP bridge will run on: http://127.0.0.1:7842"
echo " Roblox plugin polls: /poll"
echo " Model: minimax-m2.5:cloud"
echo "─────────────────────────────────────────"
echo ""
echo "Starting MCP server (stdio + HTTP bridge)..."
echo "(Claude Code connects to this via stdio — run this via your MCP config)"
echo ""

# 5. Start
cd "$SERVER_DIR"
exec node index.js
