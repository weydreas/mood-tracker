#!/usr/bin/env bash
# Operator-invoked same-host HTTPS route. Never auto-run on clone/CI.
# Requires approved ingress ownership and correct public DNS.
set -Eeuo pipefail
[[ "${EUID}" -eq 0 ]] || { echo "Run with sudo on the existing HTTPS gateway." >&2; exit 2; }
[[ "${CONFIRM_SAME_HOST_GATEWAY:-}" == "mood.biodata.health" ]] || {
  echo "Confirm this host owns public HTTPS ingress: CONFIRM_SAME_HOST_GATEWAY=mood.biodata.health" >&2
  exit 2
}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="mood.biodata.health"
for bin in nginx certbot curl; do
  command -v "$bin" >/dev/null || { echo "Missing $bin; no gateway changes." >&2; exit 3; }
done
[[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]] || {
  echo "No standard nginx sites-available/sites-enabled layout. Adapt manually." >&2; exit 3;
}
if ! curl --noproxy '*' --fail --silent --max-time 5 http://127.0.0.1:3001/api/health | grep -q '"ok":true'; then
  echo "Local Mood Tracker backend not ready. Aborting gateway changes." >&2
  exit 4
fi
nginx -t
if nginx -T 2>&1 | grep -Eq 'server_name[[:space:]]+mood\.biodata\.health([[:space:];]|$)'; then
  echo "A vhost for $DOMAIN already exists. Refusing to replace it." >&2
  exit 5
fi
target="/etc/nginx/sites-available/$DOMAIN"
link="/etc/nginx/sites-enabled/$DOMAIN"
[[ ! -e "$target" && ! -e "$link" && ! -L "$link" ]] || {
  echo "Existing Nginx entry at $target or $link. Refusing overwrite." >&2
  exit 5
}
install -d -m 0755 /var/www/mood-tracker-acme
install -m 0644 "$ROOT/deploy/nginx.samehost.conf" "$target"
ln -s "$target" "$link"
if ! nginx -t; then
  rm "$link" "$target"
  echo "Nginx config invalid; newly installed files removed." >&2
  exit 6
fi
systemctl reload nginx
acme_email="${ACME_EMAIL:-hello@biodata.health}"
if ! certbot certonly --webroot --webroot-path /var/www/mood-tracker-acme \
  -d "$DOMAIN" --agree-tos --non-interactive --email "$acme_email"; then
  echo "Certificate issuance failed. Only ACME HTTP challenge/404 is live." >&2
  echo "Fix public A/CNAME and inbound TCP/80, then rerun certbot manually." >&2
  exit 7
fi
cp "$target" "$target.acme-only.bak"
install -m 0644 "$ROOT/deploy/nginx.samehost.tls.conf" "$target"
if ! nginx -t; then
  cp "$target.acme-only.bak" "$target"
  nginx -t && systemctl reload nginx
  echo "TLS vhost invalid. Reverted to ACME-only HTTP host." >&2
  exit 8
fi
systemctl reload nginx
curl --fail --show-error --silent --max-time 10 "https://$DOMAIN/api/health"
echo
echo "HTTPS route active. Verify from an external browser and check renewals."
