#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  music-slfbot — Termux Setup Script
#  Run once after cloning:  bash setup_termux.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "╔══════════════════════════════════════╗"
echo "║   music-slfbot  —  Termux Setup      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Update Termux packages and install Python + SSL certs ─────────────────
echo "[1/4] Installing system packages..."
pkg update -y
pkg install -y python openssl ca-certificates

# ── 2. Set SSL certificate path so aiohttp can verify HTTPS connections ───────
echo "[2/4] Configuring SSL certificates..."
export SSL_CERT_FILE="$PREFIX/etc/ssl/certs/ca-certificates.crt"
export REQUESTS_CA_BUNDLE="$PREFIX/etc/ssl/certs/ca-certificates.crt"

# Persist SSL env vars for future sessions
PROFILE="$HOME/.bashrc"
if ! grep -q "SSL_CERT_FILE" "$PROFILE" 2>/dev/null; then
    echo "" >> "$PROFILE"
    echo "# music-slfbot: SSL certificates for Termux" >> "$PROFILE"
    echo "export SSL_CERT_FILE=\"\$PREFIX/etc/ssl/certs/ca-certificates.crt\"" >> "$PROFILE"
    echo "export REQUESTS_CA_BUNDLE=\"\$PREFIX/etc/ssl/certs/ca-certificates.crt\"" >> "$PROFILE"
    echo "  → Added SSL_CERT_FILE to $PROFILE"
fi

# ── 3. Install Python dependencies ───────────────────────────────────────────
echo "[3/4] Installing Python dependencies..."
pip install --upgrade pip

# orjson is optional (Rust-based, may not build on all ARM devices).
# The bot automatically falls back to stdlib json if orjson is unavailable.
echo "  Trying orjson (optional, for speed)..."
pip install "orjson>=3.10.0" --prefer-binary 2>/dev/null \
    && echo "  ✓ orjson installed" \
    || echo "  ✗ orjson not available — using stdlib json (slightly slower, fully compatible)"

# PyYAML is optional. The bot uses config.json (no deps) when PyYAML is absent.
echo "  Trying PyYAML (optional, for config.yaml support)..."
pip install "PyYAML>=6.0" --prefer-binary 2>/dev/null \
    && echo "  ✓ PyYAML installed" \
    || echo "  ✗ PyYAML not available — use config.json instead of config.yaml"

# Core dependencies (always install these)
pip install -r requirements-termux.txt
echo "  ✓ Core dependencies installed"

# ── 4. Set up config file ─────────────────────────────────────────────────────
echo "[4/4] Setting up config..."
if [ ! -f config.yaml ] && [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "  → config.json created from template"
    echo "  ⚠  Edit config.json and fill in your Discord token(s) and owner_id!"
elif [ -f config.yaml ]; then
    echo "  → config.yaml already exists (will be used if PyYAML is installed)"
else
    echo "  → config.json already exists"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Setup complete!                                         ║"
echo "║                                                          ║"
echo "║  Next steps:                                             ║"
echo "║    1. Edit config.json with your tokens & owner_id       ║"
echo "║    2. Run:  python main.py                               ║"
echo "║       Or (sniper only):  python sniper.py                ║"
echo "╚══════════════════════════════════════════════════════════╝"
