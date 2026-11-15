# Mood Atlas — publication using the verified Mood Nginx Proxy Manager ingress

**Target:** `https://mood.biodata.health`  
**Source:** `weydreas/mood-tracker`, reviewed `main`  
**VDS code directory:** `/opt/mood-tracker` on `srv-prod`  
**Backend:** `http://192.168.31.20:3001` (Docker internal TCP/3000)  
**Public DNS:** REG.RU, `mood A 62.152.38.69`  
**Public ingress:** `62.152.38.69:443`  
**Shared reverse proxy:** Nginx Proxy Manager `192.168.31.11` (admin UI port `81`; existing Mood proxy host)  
**Persistence:** Docker volume `mood-tracker_mood-data`.

## Live recovery: origin mismatch (2026-11-15)

Observed through operator: `mood-tracker-mood-tracker-1` is `running` and
`healthy`, at `/opt/mood-tracker`, with a working `192.168.31.20:3001/api/health`.
The actual container reports `APP_ORIGIN=http://192.168.31.20:3001`,
`NODE_ENV=development`, `TRUST_PROXY=0`; browser HTTPS register/login POST
returns 403 `Запрос отклонён`, matching the server exact-Origin write guard.
The repository's Compose already specifies production, so installed Compose
and/or runtime configuration has **drifted**. Merge is not a host deployment.

Before changing the running app, operator must independently read the actual
`/opt/mood-tracker` checkout SHA, effective `docker compose config` and
existing `.env` **without printing secrets**; check backup of `.env` and
persisted `mood-tracker_mood-data` volume, and verify any current user activity.
Use only the installed canonical source/config with `APP_ORIGIN=https://mood.biodata.health`,
`NODE_ENV=production` and existing `DATA_ENCRYPTION_KEY` unchanged. Verify
`DATA_CONTROLLER` and `PRIVACY_CONTACT` before production restart. Recreate
**only** the `mood-tracker` service using its existing Compose project, with
no `down -v`, no second checkout, no new volume and no unrelated bot restart.
Then independently read back the effective container environment (only the
non-secret variables), healthy API, and a synthetic registration/login flow.
Do not treat CI merge or a 200 health-check alone as registration acceptance.

## Authority, evidence, and boundaries

Based on the **CURRENT_OPERATIONAL_KNOWLEDGE / USER_VERIFIED_LIVE** record:
[biodata-kb-public-web-service-reverse-proxy-kailash-pattern-20261110-r2.md](https://drive.google.com/file/d/19VsfWgYUojuxdG5pXkskv487P1rYaHqg/view).
The record reports that public `https://kailas.biodata.health/` was confirmed live
by the owner and support: `kailas A 62.152.38.223` -> private reverse proxy
`192.168.31.23` -> `192.168.31.20:8787`.
This is **historical Kailash-only** evidence, not the active Mood ingress.

That is stronger operational evidence than Kailash Weather's older repository
README, which described only VPN access. It does **not** independently confirm
the reverse proxy software, access policy, NAT, or current state of all routes.
Reconfirm DNS, ingress and TLS before new publication.

**This is a publication contract, not proof of completed VDS/DNS/proxy work.**
An engineer must create the additional host/SNI rule on the **existing**
`192.168.31.11` Nginx Proxy Manager. Do NOT run
`deploy/publish-samehost-nginx.sh` on `192.168.31.20`: that historical
same-host installer targets a different topology. Do NOT install a new proxy,
change Kailash, or expose TCP/3001 through public NAT.

Mood journals contain sensitive mental-health records. The application is an
MVP, **not authorised to hold real patient data** before approved privacy
notice, controller identity, infrastructure/data-residency review, backups and
independent security review. Use synthetic test accounts for acceptance.

## Target route

```text
User browser (HTTPS)
    |
    | DNS: mood.biodata.health A 62.152.38.69
    v
62.152.38.69:443       public edge / ingress
    |
    v
192.168.31.11           existing Nginx Proxy Manager HTTPS reverse proxy
    |                   existing SNI/Host rule mood.biodata.health
    |                   TLS certificate for mood.biodata.health
    v
192.168.31.20:3001      Mood Tracker backend on srv-prod
    |
    v
Docker container :3000  encrypted SQLite journal volume
```

Kailash remains `192.168.31.20:8787`; no port/address changes there.

## 1. VDS preflight (read-only)

On `srv-prod`:

```bash
hostname
ip -br -4 addr
sudo ss -ltnp | grep -E ':(3001|8787)[[:space:]]' || true
docker --version
docker compose version
df -h /opt /var/lib/docker
sudo ufw status
```

Confirm `192.168.31.20` is assigned locally and 3001 is free. Do not stop
an unrelated process. Check the existing firewall policies. No new IP
alias, NAT, or change to the Kailash service is required.

## 2. Prepare code and start only the Mood service

```bash
sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/mood-tracker
git clone https://github.com/weydreas/mood-tracker.git /opt/mood-tracker
cd /opt/mood-tracker
bash deploy/bootstrap.sh
docker compose ps
curl --noproxy '*' -fsS http://192.168.31.20:3001/api/health
```

The bootstrap creates an encrypted-data key in local `.env` if missing,
binds host TCP/3001 only on `192.168.31.20`, tests for conflicting
listeners, builds the container, and checks backend health. It does not
modify REG.RU, reverse proxy, network/firewall rules, or existing services.

**Operator responsibilities:** confirm the legal identity/contact in
`.env`; securely back up the encryption key *separately* from encrypted
journal backups. Never push `.env` to GitHub. The source code directory
is separate from the persistent Docker volume. If cloning into an existing
non-empty folder, use an approved fast-forward update instead of blindly
overwriting it.

### Private ingress access control

Before any external patient-facing launch, the infrastructure team must
confirm TCP/3001 is accessible only from the approved reverse proxy
`192.168.31.11` plus explicitly authorized local diagnostics, and **not**
through public NAT or unrestricted LAN access. Docker's published ports can
bypass simple UFW INPUT rules: verify the actual Docker/firewall forwarding
policy (for example approved DOCKER-USER/edge filtering), and test reachability
from both the proxy and an unauthorized source. Keep this rule scoped to the
one service; do not alter a global firewall default.

If a local .env already exists from the older loopback-only draft, preserve its
DATA_ENCRYPTION_KEY, but set MOOD_BIND_IP=192.168.31.20 and TRUST_PROXY=0
before rerunning the bootstrap. The bootstrap never overwrites .env.

The app defaults to `TRUST_PROXY=0` for the private multi-host route,
rather than trusting a spoofable `X-Real-IP` from arbitrary clients. This
conservatively rate-limits the shared proxy IP; high-volume onboarding
needs an independently reviewed, gateway-bound client-IP policy.

## 3. Verify the existing Nginx Proxy Manager Mood host

The Mood reverse proxy is **`192.168.31.11`**, running Nginx Proxy Manager
(admin UI `http://192.168.31.11:81`). This is distinct from the Kailash
reverse proxy `192.168.31.23`; do not migrate or edit Kailash as part of Mood.

If operator support is needed, use the
[publication verification request](SUPPORT_REQUEST.md).

The operator has already added a **separate** Mood host/SNI rule, without
modifying the independent Kailash route, with:

| Setting | Exact requested value |
|---|---|
| Public hostname | `mood.biodata.health` |
| Public ingress | `62.152.38.69:443` |
| Existing reverse proxy | `192.168.31.11` |
| Private backend | `192.168.31.20` |
| Backend protocol | `http` |
| Backend TCP port | `3001` |
| Backend health | `GET /api/health` -> `{"ok":true}` |
| TLS certificate | valid for `mood.biodata.health` |
| Redirect | HTTP/80 to HTTPS, if HTTP is enabled |
| Allowed backend source | only `192.168.31.11` (plus approved checks) |
| Public authentication | application registration and session login |

Gateway must preserve the requested `Host`, keep redirects/cookies and
`Origin` correct, override forwarded client-IP headers rather than pass
untrusted values, and avoid logging sensitive request bodies. A remote
HTTPS-only Nginx **location snippet** is available as an example in
`deploy/nginx.remote-gateway.conf.example` *if* the actual gateway uses
Nginx; do not install it on the backend host.

## 4. Add the REG.RU DNS record

In the existing **biodata.health** DNS zone at **REG.RU**:

| Type | Host/Name | Value | TTL |
|---|---|---|---|
| **A** | **mood** | **62.152.38.69** | **300 seconds** |

Do not create a CNAME to `app.biodata.health`, whose observed IPv4
`62.152.38.222` belongs to a different route. Do not use private
`192.168.31.20` or `192.168.31.11` in public A records.
Do not change NS for the domain, apex DNS, or Kailash DNS.
Do not add an AAAA until IPv6 ingress is verified.

After saving:

```bash
dig +short A mood.biodata.health @1.1.1.1
dig +short A mood.biodata.health @8.8.8.8
```

Both should show `62.152.38.69` after propagation.
DNS alone **does not** configure the reverse proxy or TLS.

## 5. Acceptance — from *outside* the corporate network

First verify backend from an approved private source (or the proxy host):

```bash
curl --noproxy '*' -fsS --max-time 5 http://192.168.31.20:3001/api/health
```

Then from public internet (ideally a phone on mobile data, VPN off):

```bash
curl --fail --show-error --silent https://mood.biodata.health/api/health
curl --fail --show-error --silent -o /dev/null -w '%{http_code}\n' https://mood.biodata.health/
curl --fail --show-error --silent https://mood.biodata.health/api/me
```

Expected: health `{"ok":true}`, homepage HTTP 200, anonymous
`/api/me` response with `user:null`. Confirm HTTPS certificate hostname
and expiry. Register a **synthetic** account, add/edit an entry, export,
log out, log back in, and delete that account on both desktop and mobile.

If public URL times out while private health works: inspect ingress/NAT/
gateway. If public returns **502**: inspect gateway's connection to
`192.168.31.20:3001` and firewall/port. A default Nginx/OpenResty page
means hostname did not match the correct proxy host rule. For certificate
warnings: inspect SNI, TLS issuance and chain. Do not rebuild the app to
fix a proxy routing problem.

## 6. Rollback and data safety

```bash
cd /opt/mood-tracker
docker compose stop mood-tracker
```

This affects only the Mood service; coordinate DNS/proxy reversal with
its owner. **Never run `docker compose down -v`**, which deletes the
persistent database volume. Protect encrypted DB backups and the key in
separate secure stores; perform a restore drill before real patient data.

**Publication status observed 2026-11-15:** DNS A `62.152.38.69`, NPM
HTTP route and backend health were verified. HTTPS page appeared in the
browser, but write requests failed; TLS certificate and external security
acceptance remain separate checks. Do not claim public registration accepted.
