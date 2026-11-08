#!/usr/bin/env bash
# NeuroMotion: one-shot setup for a fresh Ubuntu 22.04 / 24.04 Vultr server. Run as root:
#     bash setup-vultr.sh                     (HTTPS address like 203-0-113-7.sslip.io, no domain needed)
#     DOMAIN=myapp.example.com bash setup-vultr.sh   (if you own a domain whose A record already points at this server)
# Expects two files in /root: app.tgz (the app, without node_modules or .env) and app.env (your .env).
# What it installs: Node 22 (NodeSource), Caddy (official repo, gives automatic HTTPS), a systemd service for the app, a firewall allowing SSH/HTTP/HTTPS.
set -euo pipefail

APP_USER=neuromotion
APP_DIR=/opt/neuromotion
TARBALL="${TARBALL:-/root/app.tgz}"
ENVFILE="${ENVFILE:-/root/app.env}"

[ "$(id -u)" = 0 ] || { echo "Run this as root (ssh root@YOUR_SERVER_IP)."; exit 1; }
[ -f "$TARBALL" ] || { echo "Missing $TARBALL. Upload the app first (see the instructions)."; exit 1; }
[ -f "$ENVFILE" ] || { echo "Missing $ENVFILE. Upload your .env as /root/app.env."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/6 System packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https ufw

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "   installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "   installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

echo "== 2/6 App user and files"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/app"
tar -xzf "$TARBALL" -C "$APP_DIR/app"
install -m 600 "$ENVFILE" "$APP_DIR/app/.env"

# The site is public on the internet, so it must have an access key. Reuse the one in .env or make one.
if grep -q '^ACCESS_TOKEN=.\+' "$APP_DIR/app/.env"; then
  TOKEN="$(grep '^ACCESS_TOKEN=' "$APP_DIR/app/.env" | head -1 | cut -d= -f2-)"
else
  TOKEN="$(openssl rand -hex 12)"
  printf '\nACCESS_TOKEN=%s\n' "$TOKEN" >> "$APP_DIR/app/.env"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/app/.env"

echo "== 3/6 App dependencies"
cd "$APP_DIR/app"
if [ -f package-lock.json ]; then runuser -u "$APP_USER" -- npm ci --omit=dev; else runuser -u "$APP_USER" -- npm install --omit=dev; fi

echo "== 4/6 Service"
cat > /etc/systemd/system/neuromotion.service <<'UNIT'
[Unit]
Description=NeuroMotion app
After=network-online.target
Wants=network-online.target

[Service]
User=neuromotion
WorkingDirectory=/opt/neuromotion/app
Environment=PORT=8780
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now neuromotion
systemctl restart neuromotion

echo "== 5/6 HTTPS (Caddy)"
if [ -n "${DOMAIN:-}" ]; then
  HOSTNAME_="$DOMAIN"
else
  IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)"
  HOSTNAME_="$(echo "$IP" | tr . -).sslip.io"
fi
cat > /etc/caddy/Caddyfile <<CADDY
$HOSTNAME_ {
	encode gzip
	reverse_proxy 127.0.0.1:8780
}
CADDY
systemctl enable caddy
systemctl restart caddy

echo "== 6/6 Firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 5
echo
echo "App service: $(systemctl is-active neuromotion)    Caddy: $(systemctl is-active caddy)"
echo "Recent app log:"; journalctl -u neuromotion -n 6 --no-pager | sed 's/^/   /'
echo
echo "Done. Open this on your phone (the first HTTPS load can take up to a minute while the certificate is issued):"
echo "   https://$HOSTNAME_/k/$TOKEN"
echo "Keep that link private: the key in it unlocks the app."
