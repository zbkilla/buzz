# Mac client onboarding for the zbk-droplet relay (as performed 2026-07-26/27)

Record of connecting the owner's Mac (`zbk-air`, Apple Silicon, on the tailnet) to the relay with the Buzz desktop app — the steps that worked, the onboarding UI traps in v0.4.26, and the two relay-side incidents that had to be fixed mid-flight (CORS allowlist; A3 probe boot deadlock). Companion to `SETUP.md` (deployment record) and `TAILSCALE_SERVE.md` (tailnet front) in this directory.

## Result

- `/Applications/Buzz.app` v0.4.26 (aarch64 OSS release build), Gatekeeper quarantine stripped, connected as **owner** to `wss://zbk-droplet.tail741ee0.ts.net`.
- No key material persists on the Mac outside the app's keyring: the transferred `owner.nsec` copy was deleted after import and the clipboard cleared.
- Relay `.env` gained the desktop app's webview origins in `BUZZ_CORS_ORIGINS` (see Incident 1) — this is now a **required** setting for any Buzz desktop client of this relay.

## Install (Mac side)

```bash
# Apple Silicon confirmed with: uname -m  -> arm64
curl -sL -o /tmp/Buzz_0.4.26_aarch64.dmg \
  https://github.com/block/buzz/releases/download/v0.4.26/Buzz_0.4.26_aarch64.dmg
hdiutil attach -nobrowse /tmp/Buzz_0.4.26_aarch64.dmg
ditto /Volumes/Buzz/Buzz.app /Applications/Buzz.app
hdiutil detach /Volumes/Buzz
xattr -dr com.apple.quarantine /Applications/Buzz.app   # OSS builds are not Block-signed
open /Applications/Buzz.app
```

Pre-flight checks worth keeping: `curl -s -o /dev/null -w '%{http_code}' https://zbk-droplet.tail741ee0.ts.net/` from the Mac returns `200` when the tailnet path is up, and the GitHub API confirms the latest release tag before downloading (releases are near-daily; the asset name embeds the version).

## Key transfer and verification

- Transfer: `scp do-droplet:/root/.buzz/owner.nsec ~/Downloads/` (the `do-droplet` ssh_config alias carries port 2222 and the right key). File landed 0600, 64 bytes.
- **Pre-import verification without a GUI:** the npub was derived locally from the key file with a ~100-line pure-Python script (bech32 decode of the nsec, secp256k1 scalar-mult, bech32 encode of the x-only pubkey) that prints ONLY the public key. Derived npub matched the anchor `npub1406j4ythklh6qqs4mexfus36q5lafrrmfsa2clryd7tkrse2hussq4fe3y` exactly, proving the right key made the trip before it was ever pasted into anything.
- **Drag-and-drop of the `.nsec` file onto the import form did NOT work in v0.4.26** (SETUP.md's desktop section assumed key-file drops are accepted). Working route: load the clipboard without displaying the key, then paste:

```bash
tr -d '\n\r ' < ~/Downloads/owner.nsec | pbcopy   # 63 chars = correct nsec length
# paste into the "Use an existing key" field, confirm npub preview ends ...q4fe3y
```

- Cleanup after successful import (the app keeps the key in its own keyring; the droplet keeps the canonical copy):

```bash
pbcopy < /dev/null      # clear clipboard
rm ~/Downloads/owner.nsec
```

- Caveat: while the key is on the clipboard it is visible to clipboard-history managers and Universal Clipboard (Handoff to iPhone/iPad). Keep that window short.

## Onboarding path in v0.4.26 — the buttons that matter

The onboarding wizard has three traps for a self-hosted relay. Verified against the v0.4.26 source (`desktop/src/features/communities/ui/WelcomeSetup.tsx`, `desktop/src/features/onboarding/ui/InviteRedeemForm.tsx`).

1. **"Set up your agent harnesses" screen: Skip for now.** This wires Buzz to a *Mac-local* CLI harness via an ACP adapter. The `@claude` agent for this community lives droplet-side (`buzz-acp-claude.service`) and is reached over the relay, so no local harness is needed. The adapter can be added later from settings if a second, Mac-local agent is ever wanted.
2. **"Join or create a community" -> "I already have a community", then on "Reconnect to your community" pick "I'm a member or admin" — NOT "I own the community".** The owner button is hardwired to Builderlab's hosted-relay sign-in (`existing-choice-owner` -> `HostedCommunityOnboarding`; email login, "Builderlab hosts the relay for this account"). It has no self-hosted path at all. Ownership of this relay is a role attached to the pubkey on the relay itself, and the member/admin path's screen says exactly that: "Your role will be restored when you connect." The owner lands as owner.
3. **The "Invite link or community URL" field accepts a bare relay URL.** Enter `wss://zbk-droplet.tail741ee0.ts.net` — `normalizeRelayUrl` (`relayProbe.ts`) takes `ws(s)://` as-is and converts `http(s)://` to `ws(s)://`, and the form then connects rather than treating the input as an invite code. No invite code is involved for the owner pubkey.

## Incident 1: onboarding stalls on "Load failed" (relay CORS)

**Symptom:** URL entered, Next appears to do nothing; faint red "Load failed" under the field.

**Mechanism:** before connecting, the form calls `getJoinPolicy(relayWsUrl)` which does a browser `fetch` of `https://<relay-host>/api/join-policy` (`desktop/src/shared/api/invites.ts`). A 404 is tolerated ("relay predates join-policy support"), and this relay answers `200 {}` — but the desktop app's webview runs on origin `tauri://localhost`, and the relay's CORS layer only allowed `https://zbk-droplet.tail741ee0.ts.net`. WebKit kills the cross-origin response and surfaces its generic fetch error, "Load failed", which the form displays; the submit handler treats it as fatal.

**Diagnosis from the Mac** (the tell: `vary: origin` present but no `access-control-allow-origin` echoed for any origin):

```bash
curl -sk -H "Origin: tauri://localhost" -o /dev/null -D - \
  https://zbk-droplet.tail741ee0.ts.net/api/join-policy | grep -i "^HTTP\|access-control"
```

**Root cause:** `BUZZ_CORS_ORIGINS` in `/root/buzz/deploy/compose/.env` listed only the web origin. The relay's `build_cors_layer` (`crates/buzz-relay/src/router.rs`) does exact-match `AllowOrigin::list`; unset would be permissive, but a set-but-incomplete list silently blocks the desktop app.

**Fix (droplet):**

```bash
cd /root/buzz/deploy/compose
cp .env .env.bak-$(date +%Y%m%d-%H%M%S)    # actual backup: .env.bak-20260727-030348
# BUZZ_CORS_ORIGINS=https://zbk-droplet.tail741ee0.ts.net,tauri://localhost,http://tauri.localhost
docker compose --env-file .env -f compose.yml up -d relay   # restart alone does NOT re-read .env
```

`tauri://localhost` is the macOS/Linux Tauri webview origin; `http://tauri.localhost` is the Windows flavor, included pre-emptively.

**Verified from the consumer side** (the Mac, not the server): the same curl now returns `access-control-allow-origin: tauri://localhost`, and the web origin still echoes correctly.

## Incident 2: relay hung at boot after the recreate (A3 probe deadlock)

**Symptom:** after the CORS recreate, the tailnet front served `502` for 8+ minutes; container health went `starting` -> `unhealthy` with **zero restarts**.

**Evidence chain:**

- Last log line ever: `running git object-store conformance probe (A3 gate)` (`race_width=32, race_rounds=3`); nothing after, and the listener on `:3000` never came up ("Media storage connected" against the *same* MinIO endpoint succeeded 3 ms earlier, so endpoint/DNS/creds were fine).
- Socket table for the relay process: ESTAB to postgres and redis only — **no connection to MinIO at all**, so the probe was not waiting on the backend.
- `strace -f` for 4 s: 3 threads, 3 `epoll_wait` calls, zero network/futex activity — the process was parked, not retrying. A classic async deadlock, not a slow or refusing backend.
- Red herrings ruled out: disk at 96% (MinIO answered fine), and "new code from the image pull" (the image is `main@95fdf97`, pulled ~7 h before the recreate, but `crates/buzz-relay/src/{main,state}.rs`, `api/git/store.rs`, and the entire `Cargo.lock` are byte-identical to the `v0.4.26` tag — the tag was cut at effectively this commit).

**Conclusion:** nondeterministic startup deadlock in the relay's git object-store conformance probe. SETUP.md's "startup WARN noise is expected, look for `A3 conformance probe passed`" gotcha has a darker sibling: sometimes the probe never returns at all.

**Resolution:** `docker restart buzz-prod-relay-1` — the next boot went probe -> `buzz-relay TCP listening` in under a second.

**If it recurs:** escape hatch `BUZZ_GIT_CONFORMANCE_PROBE=false` in `.env` skips the gate (the probe is a fail-closed deployment self-test, not a runtime dependency; MinIO RELEASE.2025-09 supports the conditional writes it checks). Tuning knobs exist too: `BUZZ_GIT_PROBE_WRITERS` / `BUZZ_GIT_PROBE_ROUNDS`. Candidate upstream bug report for block/buzz.

**Operational hazard worth repeating:** the compose file uses the floating `ghcr.io/block/buzz:main` tag, so any `docker compose up -d` after a background pull silently changes the running code version. Tonight that was benign (identical code); it will not always be. Pin a digest or release tag once available (already noted in SETUP.md operations).

## Post-incident checks

- Relay bounces drop the droplet-side agent harness connection: after any relay restart, confirm `@claude` still answers in the `agents` channel, and if not check `systemctl status buzz-acp-claude` / `journalctl -u buzz-acp-claude -f`.
- End-to-end confirmation for this setup: owner completed onboarding from the Mac and landed in the community with the owner role, no invite code, immediately after the two fixes above.
