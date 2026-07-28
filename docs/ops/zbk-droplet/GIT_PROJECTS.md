# Relay-hosted git projects on zbk-droplet

How this deployment uses Buzz's git hosting (NIP-34 + smart HTTP), what was
required to make pushes work, the privacy posture, and where agents stand.
Companion to `SETUP.md` and `AGENT_COMMUNICATION.md`. First repo hosted:
`buzz-tui` (2026-07-28).

## What a project is here

- The relay serves git smart HTTP at
  `https://zbk-droplet.tail741ee0.ts.net/git/{owner}/{repo}` where `{owner}`
  is a 64-char lower-hex pubkey. Repo data lives in the `buzz-git-data`
  Docker volume.
- The portable metadata is a NIP-34 repo announcement (kind 30617, `d` tag =
  repo id) published by the owner: `buzz repos create --id <id> --name ...
  --clone <url>`. Members discover it via `buzz repos list --owner <hex>`.
- Branch/tag protection rules are managed with `buzz repos protect` and
  enforced by the relay at the transport layer.

## Push/pull auth (NIP-98 credential helper)

Git authenticates by signing a NIP-98 event per request via
`git-credential-nostr` (a sprig personality; symlink it from
`/root/.local/share/sprig/sprig` into `~/.local/bin`).

Repo-local configuration that MUST be present:

```bash
git config credential.helper "/root/.local/bin/git-credential-nostr"
git config credential.useHttpPath true   # helper hard-fails without it
git config nostr.keyfile /root/.buzz/owner.nsec
```

Gotchas discovered on this box:

1. **git >= 2.46 required.** The helper uses the credential `authtype`
   capability; Ubuntu 24.04's stock git 2.43 silently falls back to a
   username prompt (`could not read Username`). Fixed by upgrading to git
   2.54 via `ppa:git-core/ppa`.
2. **Keyfile must be a bare key.** `nostr.keyfile` wants a file containing
   only the nsec/hex key at 0600 (`/root/.buzz/owner.nsec`) — NOT
   `owner.key`, which is a multi-line `public=/secret=` file.
3. `credential.useHttpPath=true` is mandatory — the signed event binds to
   the repo path; the helper errors explicitly if unset.

## The buzz-tui project

- Working tree: `/root/buzz-tui` (remote `origin` = the relay URL above,
  owner = the workspace owner pubkey).
- Announcement event kind 30617, id/`d`-tag `buzz-tui`.
- Round-trip verified 2026-07-28: push accepted, fresh authenticated clone
  returns the commit.

## Privacy posture (verified)

- Unauthenticated `info/refs` returns **401 even from inside the tailnet** —
  git access requires a member-signed NIP-98 credential.
- The relay is unreachable from the public internet (loopback publish +
  tailscale serve, funnel off) — see `TAILSCALE_SERVE.md`.
- The announcement is an event on this relay only. Nothing references
  GitHub or public Nostr; `--nostr-relay` discovery hints were deliberately
  not set.

## Agents and projects: current state

The buzz-acp base prompt gives agents the discovery surface but not the
push workflow:

- Covered: `buzz repos` (create/get/list) and `buzz pr`
  (open/update/get/list/status) in the CLI table, plus general git
  hygiene rules (verify HEAD before claiming results, respect repo-local
  identity/trailers).
- Not covered: `buzz patches`, `buzz issues`, `repos protect`, the
  `/git/{owner}/{repo}` URL scheme, and the credential-helper recipe above.
- **Neither agent can push today.** `BUZZ_AUTH_TAG` (NIP-OA owner
  attestation) is not set for claude or sol, so owner-inherited access does
  not apply; they would authenticate as their own pubkeys, which are not in
  any `push-allowed` rule. This is the intended default for two
  bypassPermissions root agents.

To enable agent contributions later (deliberate steps, in order):

1. Add a paragraph to `BUZZ_ACP_TEAM_INSTRUCTIONS` on each harness: repo
   URL, credential-helper recipe using the agent's own keyfile
   (`/root/.buzz/agent-<name>.key` secret extracted to a bare 0600 file),
   and the rule "feature branches + `buzz pr` only — never push main".
2. `buzz repos protect` on `buzz-tui`: allow the agent pubkeys on
   non-main branches; keep `main` push restricted to the owner so merges
   stay owner-signed.
3. Optionally wire NIP-OA (`BUZZ_AUTH_TAG`) instead, so agent access
   follows owner membership automatically — revisit when the desktop's
   managed-agent flow can mint attestations for externally-run harnesses.

## Operations

- Clone (any member, after helper setup):
  `git clone https://zbk-droplet.tail741ee0.ts.net/git/<owner-hex>/buzz-tui`
- List projects: `buzz repos list --owner <owner-hex>`
- The desktop app's Projects view reads the same kind-30617 announcements.
- Backup: repo objects are inside the `buzz-prod_buzz-git-data` volume —
  include it in any relay backup plan alongside Postgres.
