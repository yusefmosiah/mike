#!/bin/sh
# Installs (or with `uninstall`, removes) the home-egress proxy and its tunnel
# as two per-user launchd agents. No admin rights or permission prompts: the
# agents run as this user, the proxy listens on loopback only, and the tunnel
# uses this user's existing ssh key for node-a (it must work without an agent:
# `ssh -o BatchMode=yes node-a true`).
set -eu

LABEL=com.mike.home-egress
DIR="$HOME/Library/Application Support/MikeHomeEgress"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/MikeHomeEgress"
NODE="${NODE:-$(command -v node)}"
SRC="$(cd "$(dirname "$0")" && pwd)"
UID_NUM="$(id -u)"

unload() {
    for part in proxy tunnel; do
        launchctl bootout "gui/$UID_NUM/$LABEL.$part" 2>/dev/null || true
        rm -f "$AGENTS/$LABEL.$part.plist"
    done
}

if [ "${1:-}" = uninstall ]; then
    unload
    rm -rf "$DIR"
    echo "removed"
    exit 0
fi

[ -x "$NODE" ] || { echo "node not found; set NODE=/path/to/node" >&2; exit 1; }
mkdir -p "$DIR" "$AGENTS" "$LOGS"
cp "$SRC/proxy.mjs" "$SRC/tunnel.sh" "$DIR/"
chmod 755 "$DIR/tunnel.sh"

plist() { # label, log name, program arguments as <string> elements
    cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$1</string>
    <key>ProgramArguments</key><array>$3</array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$LOGS/$2.log</string>
    <key>StandardErrorPath</key><string>$LOGS/$2.log</string>
</dict>
</plist>
EOF
}

unload
plist "$LABEL.proxy" proxy "<string>$NODE</string><string>$DIR/proxy.mjs</string>"
plist "$LABEL.tunnel" tunnel "<string>$DIR/tunnel.sh</string>"
for part in proxy tunnel; do
    launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$LABEL.$part.plist"
done
echo "installed; logs in $LOGS"
