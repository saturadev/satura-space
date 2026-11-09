# Satura Remote (early access)

Satura Remote is a phone companion for Satura Space, in two parts. The phone app is a static site:
the pairing page at `/m/`, the phone app of one desktop at `/h/<host id>/` and the list of the
phone's desktops at `/h/all/`. The hosted one is at [remote.saturaspace.com](https://remote.saturaspace.com),
built by public CI from this repository and served as immutable files by Cloudflare Pages. The relay
in `relay/` connects a phone to the desktop app; the hosted one is at `wss://relay.saturaspace.com/ws`
and serves no code. One phone can pair with several desktops; the Home Screen app reopens the last
desktop when it is online and the list otherwise. Satura Remote is only a web app: on a phone it
runs in the browser or as a Home Screen app (PWA).

The hosted relay is free for a phone on the same network as its desktop and needs a Satura Remote
subscription over the internet, managed at [app.saturaspace.com](https://app.saturaspace.com). Hosts prove a key they generate themselves to
the relay. Phones pair with a one-time code, and everything between a phone and the desktop is
end-to-end encrypted and authenticated, so the relay only routes, rate-limits and meters opaque
frames and holds no keys. The design, what the relay still sees and the remaining risks (mainly
who can change the phone site) are in
[`SECURITY.md`](../../SECURITY.md#satura-remote-end-to-end-encryption).

The code is here so the work can happen in the open. The relay needs Node 24. It has no automated
test suite; CI installs it and syntax-checks its sources:

```bash
cd relay
corepack pnpm@10.34.9 install
for f in src/*.mjs; do node --check "$f"; done
```

Check relay changes end to end on a dev instance with app handles
([`apps/orchestrator/DEV-INSTANCE.md`](../../apps/orchestrator/DEV-INSTANCE.md)).

The phone site comes from `apps/orchestrator` (`vite.remote.config.ts`). The relay image carries no
copy of it (`SATURA_RELAY_APP=off`). A relay you run yourself, or one on your LAN for development,
can serve it too: build it into `relay/m/app` (it needs the app's dependencies,
`corepack pnpm@10.34.9 install` in `apps/orchestrator`):

```bash
cd relay
corepack pnpm@10.34.9 run build:app
```

A relay with a site folder serves it the way Cloudflare Pages does: files by path, a folder's
`index.html`, `<name>.html` for `<name>`, the site's `_redirects` (rewrites with status 200 and
redirects, `:name` and `*` placeholders), its `404.html` for anything else, never dotfiles or the
`_` files at its root. It answers `/phone-config.json` itself with
`{"relay":"<ws or wss>://<the request's host>/ws","account":null}`, so the pages it serves connect
back to it and sign in nowhere. Without a site folder the relay has no page routes: `/` redirects to
`SATURA_RELAY_PUBLIC_WEB` when that is set, everything else but the socket, `/presence`, `/health`
and `/net/probe` is a 404.

## The phone site

`phone-site/m` holds the pairing and sign-in page; the rest of the site is the phone app built from
`apps/orchestrator`. One command builds the whole static site into `phone-site/dist`:

```bash
node phone-site/build.mjs
```

It writes `m/` (pairing, QR scan, sign-in), `app/` (the phone app and its desktops home, the media
service worker and the report frame runtime), `_redirects` (`/h/<host id>/*` and `/h/all/` rewrite
to `app/` with status 200, so each desktop keeps its own service worker scope `/h/<host id>/`),
`_headers` (the Content-Security-Policy, framing, opener, referrer and permissions policies, and
cache headers: immutable for hashed assets, `no-cache` for the rest), `404.html`,
`phone-config.json` and `phone-app.json`. `phone-config.json` tells the app where its relay and its
account site are: `SATURA_PHONE_RELAY` (default `wss://relay.saturaspace.com/ws`) and
`SATURA_PHONE_ACCOUNT` (default `https://app.saturaspace.com`, empty for none) change both it and the
Content-Security-Policy, and `SATURA_PHONE_OUT` the output folder. With `"account": null` the app
signs in nowhere and sends no ticket.

`phone-app.json` is `{"commit": "<git sha>", "files": {"<path>": "<sha256 hex>"}}` for every file
the site serves (all but `_headers`, `_redirects` and itself). The build has no timestamps or random
ids, so building one commit twice gives the same bytes; CI checks that on every deploy. To check a
live site, and that it equals your own build of the same commit:

```bash
node scripts/verify-phone-app.mjs https://remote.saturaspace.com --dist phone-site/dist --repo saturadev/satura-space
```

It downloads every listed file and compares its hash, and checks that `/m/`, `/h/all/`, `/h/<id>/`,
the service worker and the report frame route to the right files with the headers in the local
`_headers`. `--repo` asks the GitHub API
(`/repos/<owner>/<name>/attestations/sha256:<hash of the live phone-app.json>`) for its build
attestations and needs one that is SLSA provenance v1 from `.github/workflows/phone-site.yml` on
`refs/heads/main` of that repo (workflow repository, path and ref, and builder id) with that hash
among its subjects; every live file's hash must then be among its subjects too. That trusts GitHub's API
over TLS. `gh attestation verify phone-app.json --repo saturadev/satura-space` on a downloaded
`phone-app.json` also checks the attestation's Sigstore signature.

The [`phone-site`](../../.github/workflows/phone-site.yml) workflow runs by hand on `main`: it builds
twice and compares, attests every file with `actions/attest-build-provenance`, deploys to the
Cloudflare Pages project `satura-remote` with the `phone-deploy` environment's
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and checks the live site against that
attestation. It makes no GitHub release.

The phone signs in with an account ticket. `/remote/connect?next=<path>` on the account site sends it
back to `/m/#ticket=<ticket>&next=<path>`; the page keeps the ticket in IndexedDB, drops the fragment
from history at once and opens `next` only when it is a path on this site. The app renews a ticket
with fewer than 15 days left at `/api/remote/ticket`, and goes back to the account site when the relay
answers `signin`. A Home Screen app has its own storage, and a link to another site opens outside it,
so there the sign-in page adds a one-time `claim` to the connect link and asks
`/api/remote/ticket/claim` for the ticket every 3 s, for at most 10 minutes, until the person
connects on the account site.

The phone app and the desktop each send a protocol number (`apps/orchestrator/src/shared/remote-version.ts`).
When they don't fit, the relay refuses the phone with an update code and the phone shows an update
screen; `/presence?h=<ids>&protocol=<n>&minHost=<n>` says the same per desktop. A local relay
started with `SATURA_RELAY_DEV=1` and no `relay/m/app` serves `apps/orchestrator/out/remote`, the
build the dev app keeps fresh; `SATURA_RELAY_APP=<dir>` picks any other build and `off` none. Its `/dev/*` routes
answer only requests that carry `x-satura-dev-token` (from `SATURA_RELAY_DEV_TOKEN`, or the random
one it prints at startup), come from an allowed origin and send JSON. The phone app needs a secure
context for WebCrypto, so open it at `http://localhost:<port>` or over HTTPS, not at a LAN address
over plain HTTP.

## Running a relay

On its own the relay has no accounts, no quota and no admin pages: it forwards between desktops and
phones, serves the phone site when it has one, and gives the game stream the ICE servers in
`SATURA_RELAY_ICE_SERVERS` (a JSON list like `[{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"c"}]`),
or STUN only.

`SATURA_RELAY_AUTH_URL` turns on a sign-in gate. The phone gets an account ticket from the account
site and sends it as `ticket` in its socket's `hello` and as `Authorization: Bearer <ticket>` on
`/presence`. A ticket is `v1.<payload>.<sig>`: the payload is base64url JSON
`{"aud":"satura-remote","sub":…,"email":…,"ver":…,"iat":…,"exp":…}` and the signature is Ed25519
over the ASCII of `v1.<payload>`, base64url. With `SATURA_RELAY_TICKET_KEY` (the account site's public
key, the raw 32 bytes in base64url) the relay checks the signature, the audience and the expiry
itself and refuses a bad ticket without asking anyone. Then it asks `SATURA_RELAY_AUTH_URL` with the
ticket as a bearer token and lets the phone in when it answers `{"user":{"email":…}}` (401 or 403 means
sign in again). Answers are cached by the ticket's SHA-256 for `SATURA_RELAY_AUTH_TTL_MS` (30 s), and a
network asks at most `SATURA_RELAY_AUTH_LOOKUPS_PER_MIN` (30) times a minute. A phone without a good
ticket gets `{"t":"reject","code":"signin"}`. `SATURA_RELAY_ALLOW_EMAILS` narrows the gate to a list.
A ticket only lets a phone use the relay; it grants nothing on a desktop, which admits a phone by its
pairing alone. Without `SATURA_RELAY_AUTH_URL` the gate is off and phones send no ticket.

Behind a proxy, `SATURA_RELAY_TRUST_PROXY=1` makes the relay read the client address from
`cf-connecting-ip`, but only when the request comes from an address in `SATURA_RELAY_PROXY_PEERS`
(private ranges by default) and the hop before that proxy is a Cloudflare address (`src/proxy.mjs`,
or a list in `SATURA_RELAY_CF_IPS_FILE`). Browsers may open the socket only from
`SATURA_RELAY_PUBLIC_WEB`, `SATURA_RELAY_ORIGINS`, or the relay's own host when that host is
loopback or this machine's own name or address (so a DNS-rebinding name can't). A relay on a
public name lists that name in `SATURA_RELAY_ORIGINS` or `SATURA_RELAY_PUBLIC_WEB`. `/presence`
answers cross-origin reads only for an origin that is exactly one of those two (with
`Vary: Origin`, a preflight that allows the `authorization` header and never credentials).
`SATURA_RELAY_PUBLIC_WEB` is also the phone site the relay names to desktops (`welcome.web`); their
pairing QR codes open it. The desktop ignores it for the hosted relay and always uses
`https://remote.saturaspace.com` there.
`SATURA_RELAY_OWNERS_FILE` keeps, across restarts, which accounts each desktop let in, so other accounts
don't learn whether a desktop is online.

Notifications on the phone go out as Web Push signed with the relay's VAPID key.
`SATURA_RELAY_VAPID_PRIVATE` is that key (the base64url 32-byte P-256 private key; the public key
is derived from it, and `SATURA_RELAY_VAPID_PUBLIC`, when set, must match), or
`SATURA_RELAY_VAPID_FILE` points at a JSON file holding it as `private`. `SATURA_RELAY_VAPID_SUBJECT`
is the contact the push services see (`mailto:` or `https:`; default `SATURA_RELAY_PUBLIC_WEB`).
Without a key the relay sends no notifications; a dev relay makes one and keeps it in
`SATURA_RELAY_VAPID_FILE` or the temp folder. Keep the key stable: a new key makes every phone sign up
for notifications again. The desktop encrypts each notification for the phone twice (with the phone's
push subscription keys and with a key only the phone and the desktop hold), so the relay only signs and
forwards opaque bytes to the push service. It sends only to Apple, Google, Mozilla and Microsoft push
services (plus the hosts in `SATURA_RELAY_PUSH_HOSTS`, and plain http to them only on a dev relay), only to addresses a phone of that desktop signed
up through it, and at most `SATURA_RELAY_PUSH_PER_MIN` (120) per desktop and
`SATURA_RELAY_PUSH_PER_ENDPOINT_PER_MIN` (40) per phone a minute.

## Plugins

`SATURA_RELAY_PLUGIN=<path to a module>` loads one plugin at startup. Its default export (or
`createPlugin`) gets `{ env, log, logLimited, devMode, isLoopback, status, core }`, where `core` has
`createGate`, `GATE_REASONS`, `ticketVerifier`, `bearerOf`, `createLimiter`, `ipKey` and `staticIce`,
and returns its hooks, all optional. `createGate({ authUrl, allowEmails, ticketKey, ttlMs, interpret })`
is the built-in gate: `check(ticket, mayAsk)` verifies a ticket against `ticketKey` and then asks
`authUrl`, `checkToken(token, mayAsk)` asks `authUrl` with any bearer token, and both return the
shape `authorize` returns. `ticketVerifier(key)` returns `(ticket) => { ok, claims } | { ok: false, why }`
(`why` is `malformed`, `signature`, `audience` or `expired`), and `bearerOf(req)` reads the bearer token
of a request.

| Hook | Called | Returns |
|---|---|---|
| `authorize({ req, ip, ipKey, what, mayAsk, ticket })` | for each phone socket (`what: 'phone'`) and `/presence` request (`what: 'presence'`); `ticket` is the phone's account ticket as sent, `''` when it sent none | `{ state: 'ok' \| 'signin' \| 'denied' \| 'error', gated, email?, plan?, throttled?, why? }`; replaces the built-in gate |
| `onUsage(account, kind, bytes)` | per frame; `kind` is `wsIn` or `wsOut`; frames are counted as sent, which for calls is ciphertext | nothing |
| `onTurnUsage(account, { tx, rx, egress })` | when a desktop reports TURN bytes | nothing |
| `phoneAccess(account, { hostId, sameNetwork, plan })` | when a signed-in phone connects to a desktop that is online, and again when that desktop's networks change; `plan` is what `authorize` returned | `{ scope: 'any' }`, `{ scope: 'local' }` (only on the desktop's network) or `{ code, reason }` to refuse; without this hook every phone gets `any` |
| `iceFor(account, { cid, hostId, policy, scope })` | on each game-stream ask (`video-ask`) | `{ iceServers, source }`, or `null` for the relay's own |
| `canUse(account, 'video', { scope })` | on each game-stream ask, before the relay grants the desktop ICE servers (`video-grant`); the desktop doesn't start a stream without a grant | `{ ok: true }` or `{ ok: false, code, reason, resetAt? }` |
| `allowance(account)` | while a phone is connected | an allowance object or `null` (wire format `RemoteAllowance` in `apps/orchestrator/src/shared/remote-protocol.ts`) |
| `route(url, req, res, { ip, ipKey })` | for each HTTP request after `/health` | `true` when it answered |
| `status()` | for the plugin's own pages | a plain object |
| `close()` | on drain and exit | nothing |

`authorize`, `iceFor`, `route` and `close` may be async and time out after 6 s; the others run in
place. A hook that throws or times out is logged and treated as absent, except `authorize`, which
then refuses with `error` rather than letting the phone in, and `phoneAccess`, which then refuses
the phone.

## Same network

`sameNetwork` is what the relay saw, never what a phone or desktop says. A desktop's network is the
address its socket comes from (an IPv4 address, or the /64 of an IPv6 one, from `cf-connecting-ip`
behind Cloudflare). Right after a desktop connects, and every `SATURA_RELAY_NET_REPROBE_MS`
(10 minutes), the relay hands it a one-time token, and the desktop fetches `/net/probe?t=<token>`
once over IPv4 and once over IPv6, so a dual-stack desktop counts with both of its addresses. A token
works for 30 s, from the desktop's country only, and a desktop keeps at most four networks; the ones
a probe found expire when later probes stop finding them. A phone is on the desktop's network when
its own socket's address falls in one of them. A phone with `scope: 'local'` gets no TURN servers
for the game stream (the relay strips them whatever `iceFor` returns) and no allowance, and the
relay refuses it, with the plugin's reason, when the desktop reconnects from another network. A phone
that connects within 3 s of its desktop waits for that desktop's probes before the relay decides.

`SATURA_RELAY_TEST_IPS=127.0.0.1=203.0.113.10,::1=2001:db8:1:1::10` lets a local test relay
pretend that loopback clients come from other addresses, and a `satura-test-ip` cookie picks the
address of one browser. It only works with `SATURA_RELAY_DEV=1`, without
`SATURA_RELAY_TRUST_PROXY`, outside `NODE_ENV=production` and for loopback peers; a relay started
with it anywhere else refuses to start. On such a relay `POST /dev/test-ips` with `{"map":{"::1":"…"}}`
changes that map, and `POST /dev/drop` cuts the phones' sockets (the desktops' with `{"hosts":true}`)
the way a network change does.

## License

This folder is under the [Elastic License 2.0](LICENSE), not the repository's Apache-2.0. You can
use, change and run the relay for yourself; you can't offer it to others as a hosted or managed
service. The phone app it serves is built from `apps/orchestrator`, which stays Apache-2.0, and
`phone-site/m/vendor` keeps jsQR's own Apache-2.0 license.
