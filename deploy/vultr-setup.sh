#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 Vultr instance. Run as root:
#   DOMAIN=labs.example.com bash vultr-setup.sh
# Point the domain's A record at the server IP first (HTTPS is required for camera/mic).
set -euo pipefail
: "${DOMAIN:?set DOMAIN=your.domain}"
REPO=https://github.com/ryan-mai/als-clinician-labs.git   # private: use a deploy key or a PAT in the URL
APP=/opt/clinician_labs

apt-get update -y && apt-get install -y curl git debian-keyring debian-archive-keyring apt-transport-https ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy.list
sed -i 's#^deb #deb [signed-by=/usr/share/keyrings/caddy.gpg] #' /etc/apt/sources.list.d/caddy.list
apt-get update -y && apt-get install -y caddy

[ -d $APP/.git ] && git -C $APP pull || git clone $REPO $APP
cd $APP && npm ci --omit=dev
[ -f .env ] || { cp .env.example .env; echo ">>> Edit $APP/.env (API keys, ACCESS_TOKEN) then: systemctl restart clinician-labs"; }

cat > /etc/systemd/system/clinician-labs.service <<UNIT
[Unit]
Description=Clinician labs console
After=network.target
[Service]
WorkingDirectory=$APP
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=8780 HOST=127.0.0.1
[Install]
WantedBy=multi-user.target
UNIT

echo "$DOMAIN { reverse_proxy 127.0.0.1:8780 }" > /etc/caddy/Caddyfile
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw --force enable
systemctl daemon-reload && systemctl enable --now clinician-labs && systemctl restart caddy
echo "Live at https://$DOMAIN (set ACCESS_TOKEN in .env and open once with ?key=TOKEN)"
