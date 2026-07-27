# Tailscale front for the Buzz relay (zbk-droplet)

How the relay at `127.0.0.1:3000` is published to the tailnet, and why there
is deliberately no public exposure. Companion to `/root/buzz/docs/ops/zbk-droplet/SETUP.md`.

## Topology

```
Mac / iPhone (tailnet)
        |
        v  HTTPS / WSS, tailnet-only, real certs
https://zbk-droplet.tail741ee0.ts.net
        |
        v  tailscale serve reverse proxy (on-node)
http://127.0.0.1:3000  (buzz-prod relay container, loopback publish)
```

- Node: `zbk-droplet` (100.85.140.50), tailnet suffix `tail741ee0.ts.net`,
  MagicDNS enabled tailnet-wide.
- Tailscale v1.98.4 at setup time.

## Active config

```bash
tailscale serve status
# https://zbk-droplet.tail741ee0.ts.net (tailnet only)
# |-- / proxy http://127.0.0.1:3000
```

Set with:

```bash
tailscale serve --bg 3000
```

Serve config persists across reboots (stored in the tailscaled state); no
systemd unit is needed.

One-time prerequisite: the Serve feature had to be enabled for this node in
the Tailscale admin console (the CLI prints an enable link
`https://login.tailscale.com/f/serve?node=...` and polls until approved).
This was approved 2026-07-27. HTTPS certificates for `*.ts.net` are
provisioned automatically by Tailscale on first use.

## Why this shape

- `iptables` DOCKER-USER on this box is a plain RETURN and UFW is inactive, so
  any `0.0.0.0` compose publish is reachable on the public IP
  (134.209.37.34). Docker published ports bypass host INPUT rules. Binding
  the container to loopback and fronting with serve keeps the relay reachable
  only from the tailnet, with valid TLS, and zero open public ports.
- The `.env` URLs (`RELAY_URL=wss://zbk-droplet.tail741ee0.ts.net`,
  `BUZZ_MEDIA_BASE_URL=https://zbk-droplet.tail741ee0.ts.net/media`,
  `BUZZ_CORS_ORIGINS=https://zbk-droplet.tail741ee0.ts.net`) match this front
  exactly, and the relay derives its deployment community host from
  `RELAY_URL` — so serve, TLS, Host-based tenant binding, and client URLs all
  agree by construction.

## Verification

```bash
curl -fsS https://zbk-droplet.tail741ee0.ts.net/_liveness        # -> ok
curl -fsS -H "Accept: application/nostr+json" \
  https://zbk-droplet.tail741ee0.ts.net/ | head -c 200           # NIP-11 doc
curl --http1.1 -s -o /dev/null -w "%{http_code}" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://zbk-droplet.tail741ee0.ts.net/                          # -> 101
```

Gotcha: without `--http1.1`, curl negotiates HTTP/2 over TLS and the
`Upgrade` header is silently ignored (a 200 comes back instead of 101). Real
WS clients dial HTTP/1.1 and are unaffected. Serve proxies WebSocket fine.

The proxy preserves the original `Host` header
(`zbk-droplet.tail741ee0.ts.net`), which is exactly what the relay's
fail-closed community binding requires; requests that arrive with any other
host get a generic 404.

## Management

```bash
tailscale serve status              # inspect
tailscale serve --https=443 off     # tear down the front (relay stays up on loopback)
tailscale serve --bg 3000           # re-enable
```

Do not add a public `tailscale funnel` for this relay without a deliberate
decision — funnel would expose it to the internet, undoing the loopback-bind
rationale above.
