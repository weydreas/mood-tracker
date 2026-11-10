#!/usr/bin/env bash
# Safe, opt-in service bootstrap on an already provisioned VDS.
# Does NOT modify DNS, interfaces, firewall, Nginx or existing services.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
for command_name in docker openssl curl ss ip; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 2
  }
done
docker compose version >/dev/null
if [[ ! -f .env ]]; then
  key="$(openssl rand -hex 32)"
  cat > .env <<ENV
# Local deployment secrets; never commit or upload to GitHub.
DATA_ENCRYPTION_KEY=$key
NODE_ENV=production
APP_ORIGIN=https://mood.biodata.health
DATA_CONTROLLER="ООО «Биодата Груп»"
PRIVACY_CONTACT=hello@biodata.health
# Loopback by default. Do NOT use 0.0.0.0.
MOOD_BIND_IP=127.0.0.1
# ONLY when the reverse proxy overwrites X-Real-IP and is the sole ingress.
TRUST_PROXY=1
ENV
  chmod 600 .env
  echo "Created protected .env with a new encryption key."
  echo "Back up DATA_ENCRYPTION_KEY securely OFF this host before using real data."
  echo "Verify the data-controller identity/contact against your legal documents."
else
  chmod 600 .env
  echo "Reusing existing .env, preserving the current encryption key."
fi

bind_ip="$(sed -n 's/^MOOD_BIND_IP=//p' .env | tail -n 1)"
bind_ip="${bind_ip:-127.0.0.1}"
if [[ "$bind_ip" == "0.0.0.0" || "$bind_ip" == "::" || "$bind_ip" == "*" ]]; then
  echo "Refusing wildcard binding. Use loopback or a verified private interface." >&2
  exit 3
fi
if [[ "$bind_ip" != "127.0.0.1" ]]; then
  if ! ip -4 -o addr show | grep -Fq " $bind_ip/"; then
    echo "Requested MOOD_BIND_IP is not assigned to this host: $bind_ip" >&2
    exit 3
  fi
  echo "WARNING: private-interface ingress selected. Verify firewall ACL: gateway only." >&2
fi
if ss -H -ltn '( sport = :3001 )' | grep -q .; then
  if [[ -z "$(docker compose ps -q mood-tracker)" ]]; then
    echo "TCP 3001 belongs to another listener. Refusing to disturb it." >&2
    exit 4
  fi
fi

docker compose config --quiet
docker compose up --build --detach mood-tracker
ok=0
for _ in $(seq 1 25); do
  if curl --noproxy '*' --fail --silent --max-time 2 "http://$bind_ip:3001/api/health" | grep -q '"ok":true'; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "$ok" != 1 ]]; then
  echo "Local health check FAILED. Check: docker compose logs --tail 80 mood-tracker" >&2
  exit 5
fi
echo "Local health OK: http://$bind_ip:3001/api/health"
echo "DNS/TLS have NOT been changed. See deploy/README.md for the public gateway."
