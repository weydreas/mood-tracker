# Mood Tracker: operational publication runbook

Target URL: **https://mood.biodata.health**  
Code directory: **/opt/mood-tracker**  
Public browser port: **443/TCP, via the authorised HTTPS gateway**  
App port inside Docker: **3000/TCP**  
Host-side port: **3001/TCP** (loopback only by default)  
Persistent data: Docker volume **mood-tracker_mood-data**.

**Status:** application deployment materials are prepared. DNS, gateway/TLS
configuration and VDS runtime deployment are NOT performed by this repository.
Do not put real patient information into the service until privacy, backups,
data location, access controls and independent security checks are approved.

## Source of this pattern

The previous Kailash Weather project used a separate directory and service on
the existing VDS. Its public DNS/HTTPS publishing was NOT verified as live.
We deliberately do NOT reuse its port, alter existing network interfaces,
or infer that a private IPv4 address is a public DNS destination.

## 1. Read-only VDS preflight

Run on the actual target host:

    hostname
    ip -br -4 addr
    sudo ss -ltnp | grep -E ':(80|443|3001|8787)[[:space:]]' || true
    docker --version
    docker compose version
    df -h /opt /var/lib/docker
    sudo ufw status

Check that existing services and the ingress owner are known. If port 3001 is
already owned by another application, stop; do not terminate or reconfigure it.
Do not assume this host owns the public 80/443 ports or the public-facing IP.

## 2. Allocate code directory and synchronise

Use an operator account with appropriate permissions. Example:

    sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/mood-tracker
    git clone https://github.com/weydreas/mood-tracker.git /opt/mood-tracker
    cd /opt/mood-tracker

If the directory already exists from a prior checkout, confirm it is the
expected repository and use git pull --ff-only; don't overwrite user files.
Deploy a reviewed tagged or exact-SHA release rather than an unreviewed branch.

## 3. Bootstrap (does not change Nginx, DNS or firewall)

    cd /opt/mood-tracker
    bash deploy/bootstrap.sh

The script checks for required commands, creates .env only if absent, generates
a 256-bit random encryption key, checks the host bind IP and TCP/3001 ownership,
builds and starts Docker Compose, then verifies /api/health locally. It will not
replace an existing key. The default .env uses:
- APP_ORIGIN=https://mood.biodata.health
- DATA_CONTROLLER=ООО «Биодата Груп»
- PRIVACY_CONTACT=hello@biodata.health
- MOOD_BIND_IP=127.0.0.1
- TRUST_PROXY=1

These contact/operator defaults originate from publicly available Biodata site
material, not from approval of a new service-specific privacy notice. Confirm
them before inviting patients. Securely back up the encryption key separately:
without it, journal contents in backups are irrecoverable.

Verify:

    docker compose ps
    curl --noproxy '*' -fsS http://127.0.0.1:3001/api/health
    docker compose logs --tail 40 mood-tracker

## 4. Find the approved PUBLIC HTTPS ingress before editing DNS

This is a mandatory read-only discovery; the VDS internal IP does not prove its
Internet ingress identity. On the DNS / gateway side, identify:
- which system currently handles public biodata.health HTTPS;
- the verified inbound public IPv4, or the existing gateway DNS name;
- whether TLS is Nginx, Caddy, Traefik, a CDN, or a separate load balancer;
- whether that gateway runs on the same host as /opt/mood-tracker;
- whether the site's data residency and privacy architecture permits this VDS
  to store sensitive mood journal records.

Do NOT copy any historical monitoring IP into the new DNS A record without
checking current inbound ownership.

### Variant A — gateway and Docker share a host

Keep MOOD_BIND_IP=127.0.0.1; reverse proxy can access the container locally.
For an **existing Nginx** gateway, the repository includes an explicit,
gated installer. It uses a temporary HTTP-only ACME challenge vhost (returns
404 for all non-challenge paths), obtains a Let's Encrypt certificate, and
only then activates the HTTPS reverse proxy. No passwords or journal data
are served over HTTP. Run **after confirming the public DNS points at the
same HTTPS gateway and TCP/80 and TCP/443 reach it**:

    cd /opt/mood-tracker
    sudo env CONFIRM_SAME_HOST_GATEWAY=mood.biodata.health \
      ACME_EMAIL=hello@biodata.health \
      bash deploy/publish-samehost-nginx.sh

This operation intentionally modifies the existing gateway's Nginx config;
use only with the infrastructure owner's approval, after read-only preflight.
It will reject a duplicate mood.biodata.health vhost and never replace an
unrelated route. The ACME contact is the published company contact and must
be verified by the operator. Once active:

    sudo certbot renew --dry-run
    curl -fsS https://mood.biodata.health/api/health

If the approved gateway is Caddy/Traefik/another platform, use its existing
routing and TLS mechanism instead; do not install a competing Nginx.

### Variant B — gateway on a different host

Default 127.0.0.1:3001 is **unreachable** from a remote gateway. Set
MOOD_BIND_IP to the VDS's **verified private interface IPv4** in its private
.env and run bash deploy/bootstrap.sh again. NEVER set it to 0.0.0.0.
Restrict port 3001 in the existing firewall/NAT so only the gateway's
**verified private source address** can reach it. Do not weaken existing
firewall defaults. The proxy should then target:

    http://<verified-private-app-ip>:3001

Adapt deploy/nginx.remote-gateway.conf.example on the gateway (not on the app
host), or an equivalent route in its real HTTPS gateway stack.

## 5. DNS for mood.biodata.health

In the **existing authoritative DNS zone** for biodata.health:

| Type | Name/Host | Target | TTL |
|---|---|---|---|
| A | mood | VERIFIED PUBLIC HTTPS GATEWAY IPv4 | 300 s |

Alternative only if the existing HTTPS gateway has a stable DNS name AND
explicitly accepts mood.biodata.health: use CNAME mood to that gateway name
instead of an A record (never both for the same name).

Do not change domain nameservers, apex records or unrelated subdomains. Do not
point public A/AAAA records to private RFC1918 addresses. Create an AAAA record
only when IPv6 routing and TLS are actually configured.

Check the DNS answer from more than one resolver:

    dig +short A mood.biodata.health @1.1.1.1
    dig +short A mood.biodata.health @8.8.8.8

DNS alone never sets up HTTP reverse-proxy routing; the gateway must route by
Host/SNI and hold a valid certificate.

## 6. HTTPS certificate and separate gateways

For Variant A, publish-samehost-nginx.sh provisions ACME HTTP-01 with Certbot
webroot and activates the TLS vhost. Verify automatic renewal with
sudo certbot renew --dry-run. In case certificate issuance fails, the staged
HTTP server serves only ACME challenges and 404, not patient content.

For Variant B, configure the **existing gateway owner-approved HTTPS
terminator** with a valid certificate, host/SNI mood.biodata.health and
private upstream routing. A TLS-only Nginx location snippet is provided in
deploy/nginx.remote-gateway.conf.example. Its placeholder must be replaced
with an approved private backend route; it is not a complete vhost and does
not by itself create a certificate. Never expose HTTP application traffic
publicly while awaiting certificates.

## 7. Final acceptance

    curl --fail --show-error --silent https://mood.biodata.health/api/health
    curl --fail --show-error --silent -o /dev/null -w '%{http_code}\n' https://mood.biodata.health/
    curl --fail --show-error --silent -o /dev/null -w '%{http_code}\n' https://mood.biodata.health/api/me

Expected: health JSON ok=true; homepage 200; unauthenticated /api/me
responds 200 with user=null. Then register a **synthetic test account**, save,
edit, export, log out, log in, delete the test account. Repeat on a phone and a
desktop browser; verify valid HTTPS and no mixed content.

Backups: protect Docker volume, encrypted backup copies and .env key in
separate secure locations; perform a restoration drill before real users.
Only collect real data after applicable privacy and data-location approvals.

## Reversal / safe stop

    cd /opt/mood-tracker
    docker compose stop mood-tracker

This stops only the Mood Tracker service. DO NOT run docker compose down -v:
it permanently destroys the persistent data volume. Reverting a gateway
virtual host is a separate controlled operation by its owner.
