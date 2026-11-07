# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead:

- through GitHub's private vulnerability reporting:
  [github.com/saturadev/satura-space/security/advisories/new](https://github.com/saturadev/satura-space/security/advisories/new)
- or by email to [support@saturaspace.com](mailto:support@saturaspace.com)

Tell us the Satura Space version, your OS, what an attacker gains and how to reproduce it. We'll
confirm we got the report and keep you posted on the fix.

## Supported versions

Only the latest release gets security fixes. The app updates itself from GitHub Releases, so a
restart is usually all it takes to get the fix.

## Scope

In scope: the desktop app (`apps/orchestrator`), the Unity engine package (`packages/saturaspace-engine`),
the MCP server (`packages/mcp`) and Satura Remote
(`packages/companion-app`, the relay and the phone web app).

In Satura Remote, everything between the phone and the desktop is end-to-end
encrypted and authenticated (below), so the relay and Cloudflare in front of it only route bytes.
The relay serves no code: the phone app is a static site that public CI builds from this repository
and Cloudflare Pages serves; see the residual risks. Reading, changing, replaying or injecting phone
traffic, pairing a phone or a desktop through the relay without the pairing code, or getting other
code onto the phone app's origin, is in scope.

## Satura Remote end-to-end encryption

### Origins

- **Phone app:** `https://remote.saturaspace.com`, static files on Cloudflare Pages. GitHub Actions
  builds them from a public commit of this repository and deploys them with a Pages deploy token. No
  server we run answers on that origin and no other site shares it.
- **Relay:** `wss://relay.saturaspace.com/ws`. It routes end-to-end encrypted frames, meters and
  rate-limits them and answers which of a phone's desktops are online. Its image carries no phone app.
- **Account site:** `https://app.saturaspace.com`, where people sign in and pay. It shares no cookie
  or storage with the phone app.

The desktop puts `https://remote.saturaspace.com` in the pairing QR code for the hosted relay
whatever the relay says, so a relay can't send a new pairing, and the code in its link, to another
origin.

### Account tickets

The relay needs to know which account a phone pays with, and the phone app can't read the account
site's cookie. When the phone signs in, the account site signs a ticket
`v1.<payload>.<signature>`: the payload is base64url JSON with the audience `satura-remote`, the
account id, the lowercased email, a version and the issue and expiry times (30 days); the signature
is Ed25519 over the ASCII of `v1.<payload>`. The phone keeps the ticket, sends it in its first socket
message and as a bearer token on `/presence`, and renews it at the account site. The relay checks
the signature with the account site's public key, the audience and the expiry, refuses a bad ticket
without asking anyone, then asks the account site for the plan with it and caches that answer for
30 seconds by the ticket's hash.

The ticket reaches the phone in a link fragment (`/m/#ticket=…`), which never goes to a server; the
phone page removes it from history at once, keeps the ticket in IndexedDB and follows the link's
`next` only to a path on its own site. A Home Screen app can't receive that link, because a link to
the account site opens outside the app and its storage. There the phone makes a claim, 256 random
bits, puts it in the connect link and asks the account site for the ticket with it until the person
confirms on the account site. The account site keeps only the claim's hash, for 10 minutes, and hands
the ticket out once. Whoever learns a claim in those minutes could fetch that ticket first, so the
claim is as sensitive as the ticket while it lives.

A ticket only pays for the hosted relay. It grants nothing on a desktop: the desktop admits a phone by
its pairing and pinned key alone, and a phone with someone else's ticket still can't pair without the
code shown on that desktop. A stolen ticket lets its holder use the relay on that account until it
expires, and the email the relay reports to the desktop's Allow dialog comes from it.

### Threat model

The relay operator, Cloudflare and anyone on the network are untrusted for confidentiality and
integrity. They can read, drop, delay, reorder, replay, change and inject any frame, swap keys
during pairing and impersonate either side, and they choose the TURN servers. A paired phone can
drive the desktop's terminals, so the goal is that only a phone the person paired and allowed on the
desktop can send calls, and only that desktop can answer. Denial of service by the relay is out of scope:
it can always stop forwarding.

### Keys

- **Phone:** one ECDSA P-256 key per paired desktop, made with WebCrypto as non-extractable and kept
  as a `CryptoKey` in IndexedDB (`satura-remote` / `keys`, `identity:<host id>` next to the pinned
  desktop key in `pairing:<host id>`). Script on the page can use it but can't read it. The phone id is
  the first 96 bits of SHA-256 of its public key, so each install (a Safari tab and the Home Screen
  app on iOS have separate storage) is its own device on the desktop, and one phone shows a different
  phone id to each of its desktops, so two desktops, or the relay, can't link them by key. The page
  asks for persistent storage after pairing; if the browser clears it anyway, the phone says it must pair again.
- **Desktop:** an ECDSA P-256 key in `remote-host.json` (mode 0600) next to the Ed25519 key it already
  proves to the relay. The two keys are separate; the relay never sees the end-to-end key's
  private half and needs neither for routing. The file is encrypted with AES-256-GCM under a key
  derived from this computer's hardware id (IOPlatformUUID, Windows MachineGuid, /etc/machine-id)
  and the home folder, so a copy taken off the computer, from a backup or a synced folder, is
  useless. It does not stop code running as the user on the same computer, which can derive the
  same key. Settings > Mobile > Make new keys
  gives the desktop new keys and a new host id and unpairs every phone.
- **Algorithms:** P-256 ECDSA and ECDH, HKDF-SHA-256, HMAC-SHA-256 and AES-256-GCM, because iOS
  Safari and Android Chrome support all of them for non-extractable keys. X25519 and Ed25519 are
  not used. The phone checks for a secure context, `crypto.subtle` and IndexedDB and says plainly
  when one is missing. The desktop uses `node:crypto`; there are no third-party crypto libraries.

### Pairing

The desktop shows a one-time code `<host id>:<64-bit secret>` (10 minutes, one live code) and a QR code
whose link is `/m/#pair=<host id>:<secret>:<commitment>`, where the commitment is 128 bits of
SHA-256 of the desktop's public key. The code sits in the URL fragment, so it never reaches the relay
in a request. The phone never sends the code: both sides derive `k = HKDF(secret, salt = host id)`.

1. The phone sends its public key, an ephemeral ECDH key, a nonce and `HMAC(k, those values)`.
2. The desktop checks that MAC against its live code (three wrong proofs burn the code; a matching one
   burns it at once), then answers with its public key, its ephemeral key, a nonce, its name, an
   ECDSA signature over the transcript hash, a finished MAC and `HMAC(k, transcript)`.
3. The phone checks the desktop's code MAC, the commitment when it came from a QR code, the signature
   and the finished MAC, then signs the transcript and sends its own finished MAC.
4. The desktop checks both and asks the person to allow the phone. Only then does it pin the phone's
   public key.

A relay that swaps either public key can't produce the code MAC that covers it. Offline guessing
of the 64-bit secret from one captured MAC would have to finish while the code is still live and
before the real pairing burns it. That is why a code-keyed MAC is enough here and no PAKE is used: a
PAKE matters for short, low-entropy codes, which Satura doesn't use. The QR commitment additionally
pins the desktop's key without trusting the code alone.

### Sessions

Every connection runs the same signed Diffie-Hellman handshake as pairing, without the code MACs
(SIGMA-style, like TLS 1.3 with mutual signatures): fresh P-256 ECDH keys on both sides, a
transcript hash over the host id, mode, phone id, both public keys, both ephemeral keys, both
nonces and the desktop's name, ECDSA signatures from both pinned keys over it, and finished MACs. The
desktop sends nothing to the phone and runs none of its calls until the phone's signature checks out.
Keys come from `HKDF(ECDH secret, salt = transcript hash)`, one per direction, so a stolen
long-term key doesn't open recorded sessions.

### Framing and replay protection

After the handshake every call, reply, event and ack on the relay is a binary WebSocket frame:
a magic byte, a flags byte, a 64-bit counter and AES-256-GCM ciphertext. The nonce is the counter
and the associated data binds the direction, the counter and the flags. Each side accepts only the
next counter: a replayed, reordered, dropped, altered or injected frame fails, and the receiver
closes the session (the desktop kicks the phone with close code 4009, the phone reconnects) and logs
why. Plaintext calls from the relay are ignored and logged once. The relay inserts and strips an
8-character connection id in front of the frame so it can route without reading it.

### Key rotation and session lifetime

Each direction ratchets its key (`next = HKDF(secret, "next")`, old key wiped) after 65,536 frames,
256 MB or 20 minutes, flagged in the frame header, and the receiver refuses an epoch past 131,072
frames. The phone reconnects for fresh Diffie-Hellman keys after 12 hours; the desktop drops a session
older than 24 hours.

### The game stream

Video, terminal fast paths, game input and media go over WebRTC data channels, which are DTLS. The
SDP offer, answer and candidates travel as end-to-end encrypted calls, so the DTLS fingerprints
each side checks come from the other side, not from the relay, and a changed fingerprint makes the
DTLS handshake fail. The relay only grants the stream: the phone asks it (`video-ask`), it checks
the account and rate limits and sends the desktop `video-grant` with the ICE servers, and the desktop waits
for both the encrypted hello and the grant. TURN servers see only DTLS.

### Notifications

A phone that turns notifications on subscribes to Web Push with the relay's VAPID public key, asks
the relay for a token that binds that push address to its desktop (an HMAC under a key derived from the
relay's VAPID key, so the relay keeps no list), makes a random 256-bit key, keeps it in IndexedDB as a
non-extractable AES-GCM key and sends the address, the subscription keys, the token and its key to
the desktop inside the end-to-end session. The desktop seals each notification (title, text, tag and where a
tap leads) with AES-256-GCM under that key, then encrypts the result for the push subscription
(RFC 8291, `aes128gcm`) and pads it to 256-byte steps. The relay checks the token, signs the request
with VAPID and posts the ciphertext to the push service. The service worker decrypts it with the key
in IndexedDB; when it can't, it shows a fixed "Something on your desktop may need you" notice and never
text from the push. Each desktop has its own service worker scope (`/h/<host id>/`), push subscription
and notification key, so a worker decrypts only its own desktop's notifications. It adds that desktop's name,
which the page keeps in IndexedDB, to what it shows. A tap stores where to go in IndexedDB under
that desktop and the page of that desktop opens it after it reconnects; when the app shows another desktop, the
worker asks that page to switch to the desktop the notification came from first.
The relay sees the push address (which names the push service), the size, which is padded, the time,
urgency, an opaque topic and the push service's answer; it doesn't see the text. The push service
(Apple, Google, Mozilla, Microsoft) sees the same. Removing the phone on the desktop deletes its push
address and key.

### Revocation and versions

Removing a phone on the desktop deletes its pinned key and closes its sessions; its key can't start a
session again and it must pair anew. The remote protocol is 4, and a phone and a desktop work together
only on the same protocol; on any other pair the relay shows the phone the update screen.

### Several desktops

A phone can pair with several desktops. Each desktop's key, pinned key, notification key and push
subscription stay separate (above), and switching to another desktop loads that desktop's page, so no
session, socket or in-memory state crosses over. What the phone shows about a desktop it isn't
connected to (name, a rename made on the phone, when it was last seen, the projects and Unity state
from the last visit) stays in the phone's local storage; unread counts come from that desktop's
notifications on the phone. The desktops home (`/h/all/`) asks the relay which of the phone's desktops are
online (`/presence` on the relay, at most 16 host ids, with the phone's ticket as a bearer token and
read cross-origin only by the phone app's origin). It answers only for desktops that let that account
in and says what the phone shows when it connects: online, not responding or offline, and whether the
desktop's protocol fits.
Inside the end-to-end session each desktop also tells the phone what kind of computer it is: the
OS, the form (laptop, all-in-one, small box, tower or desktop) and a model name such as "MacBook Pro",
read from `system_profiler` on macOS, WMI on Windows and DMI on Linux. The phone keeps it with that
desktop in local storage to pick the desktop's picture; the relay's hello and presence answers don't
carry it.

### What the relay still sees

Host ids, connection ids, phone ids (in handshakes), account tickets, account emails and IP addresses it already
knows (including the desktop's IPv4 and IPv6 addresses, which the desktop shows it with a network
check so the relay can tell whether a phone shares the desktop's network), the desktop's name and the public handshake values, frame sizes, counts and timing, when the
game stream starts, which ICE servers it handed out, the pairing flag and the phone app's console
lines from before the session is up. It doesn't see calls, replies, terminal data, file contents,
the pairing code or the session keys.

### Residual risks

- **Whoever can change the phone site can drive what the phone does.** The relay no longer serves
  code, so the trust moves to what can put files on `remote.saturaspace.com`: a commit that reaches
  the deploying branch, the GitHub Actions workflow and its secrets, the Cloudflare Pages deploy
  token, and Cloudflare itself. A changed site can serve a page that does whatever the person taps
  through it while it is open, or that phishes a new pairing code. The phone's key is
  non-extractable, so it can't be copied off the phone, and a rogue page can't pair without a code
  shown on the desktop. The site sends a strict Content-Security-Policy, `X-Frame-Options` and
  `Cross-Origin-Opener-Policy`, which stop injected scripts and framing by other sites but not the
  origin itself. A service worker that pins the app shell would only move the problem: the browser
  refetches the worker from the same origin, so whoever controls the origin controls the update.
- **Checking the live phone app.** Every deploy publishes `phone-app.json` (the commit and the
  SHA-256 of every file) on the site, and CI attaches the same file to the GitHub release
  `phone-<short sha>` of this repository. `node packages/companion-app/scripts/verify-phone-app.mjs`
  checks the live site against it from any computer. The desktop runs a tripwire too: while Remote is
  on with the hosted relay it fetches the live manifest at most every 4 hours, compares it with the
  release of its commit, and hashes the html files, the pages phones open (`/m/`, `/h/all/`, its own
  `/h/<host id>/`) and the scripts and styles they load. A difference, a live commit without a
  release after 30 minutes, or a missing manifest is logged as `PHONE APP MISMATCH` and shown in
  Settings > Mobile; an unreachable site or GitHub only makes the result unknown. It is a tripwire,
  not a guarantee: it sees what one desktop gets from its network, so a site that serves other files
  to one phone, or changes only chunks loaded later, can pass it, and the release itself is only as
  good as the commit and the CI run that made it (rebuild that commit to check). It also means
  nothing on that hostname may rewrite pages (Cloudflare Email Obfuscation, Rocket Loader, injected
  analytics), or every check fails.
- **A self-hosted relay serves its own phone site.** A relay with a site folder serves the phone app
  from its own origin and a `/phone-config.json` that points the phone back at itself; whoever runs
  that relay controls that code, as before.
- **Allow on the desktop shows relay-reported facts.** The device name, user agent, IP, place and email
  in the Allow dialog come from the relay and the phone and aren't authenticated; the code is what
  proves the phone was in front of the person.
- **Host ids are 64 bits** of the hash of the relay key. A colliding id could at most take a desktop's
  slot on the relay (the relay refuses a second key for an id it has seen); phones pin the desktop's
  end-to-end key and refuse it.

Open only projects you trust. Adding a folder to Satura runs the code it carries: dashboard alerts
start right away, widgets and reports run when shown, report actions run on a click, and the Unity
editor runs the project's editor scripts. A project that makes Satura run its code is not a
vulnerability. Escaping the report frame, the phone allowlist or a project's folder is.
