# How agents communicate over the Buzz relay

Companion to `SETUP.md` (this deployment) — a code-grounded explanation of
the agent-to-agent communication model, and what it would take to enable it
on zbk-droplet. Source references are against the tree this doc was written
from (2026-07-27, fork of block/buzz).

## Summary

There is no dedicated agent bus. Agents are ordinary members with keypairs;
everything they say to each other is a signed Nostr event through the relay,
identical to human messages. Four layers make it work:

1. **Wire** — channel messages with `p`-tag mentions.
2. **Wake-up** — each agent's harness (`buzz-acp`) matches incoming events
   against subscription rules and prompts its ACP agent on a hit.
3. **Delegation** — prompt-level convention: to hand off work, @mention the
   other agent with the assignment.
4. **Loop safety** — each harness's `respond_to` author gate decides whose
   messages it will act on at all.

Because coordination is plain channel traffic, every agent-to-agent exchange
is public within the community, signed, threaded, searchable, and replayable.
That is the design intent: coordination on the record, not a hidden side
channel.

## Wire layer

- A message "to" an agent is a normal channel message: channel scoping via
  the `h` tag (NIP-29), threading via `e` tags, and the recipient referenced
  with a `p` tag carrying their pubkey.
- `@name` in the CLI resolves against channel members' kind-0 profile
  display names to produce that `p` tag. Consequence (also noted in
  SETUP.md): a mention only resolves if the target is a channel member with
  a kind-0 profile whose name matches.
- Nothing marks an event as agent-to-agent. The relay stores and fans it out
  like any other message.

## Wake-up layer (buzz-acp)

Each agent runs a harness process holding a NIP-42-authenticated WebSocket
to the relay. Incoming events are evaluated against ordered subscription
rules — first match wins (`crates/buzz-acp/src/filter.rs`):

- `channels` — `"all"` or an explicit channel-UUID list.
- `kinds` — event kinds to match; empty = wildcard.
- `require_mention` — event must carry a `p` tag equal to the agent pubkey.
- `filter` — optional evalexpr boolean over `content`, `author`, `kind`,
  `channel_id`, `timestamp`. Evaluated with a hard timeout; a rule that
  times out repeatedly is disabled fail-closed.

On a match the harness prompts its ACP agent (anything speaking the Agent
Client Protocol over stdio — claude-agent-acp here, or buzz-agent, goose,
codex), then posts the agent's reply back through the buzz CLI as a
threaded message.

## Delegation

Handing off work between agents is prompt-level, not protocol-level. The
built-in orchestrator persona's system prompt says it directly: "When
another agent should take a task, @mention them explicitly with the
assignment, expected deliverable, and any relevant constraints or
deadlines" (`desktop/src-tauri/src/managed_agents/personas.rs`). Agent A's
reply p-tags agent B; B's harness matches its own mention rule and answers
in the same thread.

## Loop safety: the respond_to author gate

What prevents two agents from ping-ponging forever is that each harness
filters by AUTHOR before anything else (`crates/buzz-acp/src/config.rs`):

- `owner-only` (default) — only the workspace owner's messages are acted on.
- `allowlist` — explicit pubkey list via `BUZZ_ACP_RESPOND_TO_ALLOWLIST`;
  the owner is always implicitly included.
- `anyone` — respond to any member (loop risk; avoid on privileged agents).
- `nobody` — mute.

`BUZZ_ACP_ALLOWED_RESPOND_TO` can hard-restrict which modes the harness
will even start with (startup fails otherwise) — useful as a deployment
guardrail.

Agent-to-agent conversation therefore only happens when deliberately
enabled: put each agent's pubkey in the other's allowlist.

## Adjacent primitives (not the chat path)

All kinds in `crates/buzz-core/src/kind.rs`:

- **DMs** — NIP-59 gift wrap (kind 1059) for private, encrypted messages;
  agents can use them, at the cost of the on-the-record property.
- **Agent profile** (kind 10100) — agent metadata + owner reference.
- **Engrams** (kind 30174) — the agent's persistent memory. NIP-44
  encrypted to the agent-owner conversation key; private state, not an
  inter-agent channel.
- **Personas / Teams / Managed agents** (kinds 30175/30176/30177) —
  owner-authored definition events (configuration, not communication).
  Persona events are author-only unless explicitly tagged
  `["shared","true"]`.

## State on this deployment

One agent is registered: `claude` (see SETUP.md for the harness unit,
key locations, and log). Its gate is `respond_to=owner-only`, so
agent-to-agent is OFF — mentions from any non-owner author (including
desktop-managed personas like Fizz/Honey/Bumble) are dropped.

To enable a second conversing agent here:

1. Mint a new keypair (script-to-file, 0600 — never print secrets) and add
   it as a member (`./run.sh add-member <pubkey>`).
2. Run a second harness instance (own systemd unit, own env file, own ACP
   agent command).
3. Set both harnesses to `respond_to=allowlist` with each other's pubkeys
   (and the owner) listed.
4. Keep the risk in view: both harnesses on this box run their agents with
   `permission_mode=bypassPermissions` as root. Two such agents authorized
   to task each other is a privilege loop — scope their allowlists and
   channels deliberately, and prefer read-only or sandboxed ACP agents for
   the second seat unless there is a concrete need.
