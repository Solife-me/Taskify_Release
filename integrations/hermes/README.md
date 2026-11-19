# nostr-dm-platform

Hermes Agent **platform plugin** implementing NIP-17 Nostr DMs.

Subscribes to kind-1059 gift wraps addressed to the bot key, decrypts
(NIP-44/NIP-59), dispatches to the agent, and replies with a fresh gift wrap.
Sends follow the NIP-17 relay-discovery rule (kind-10050 inbox list, NIP-65
fallback) over operator-approved routes, with configurable fallback relays.

## Layout

| File | Purpose |
|---|---|
| `__init__.py` | Entry point; exports `register` |
| `plugin.yaml` | Plugin manifest: kind, version, deps, env schema |
| `adapter.py` | The platform adapter (connect, receive loop, send, media, groups) |
| `policy.py` | Role/tool gating (owner / family / friend), secret-key redaction |
| `groups.py` | Group-chat (Taskify room) handling |
| `loop_guard.py` | Prevents agent-to-agent reply loops |
| `network_policy.py` | Approved relay routes and pinned HTTPS downloads |
| `delivery_queue.py` | Durable per-recipient relay acknowledgements and retries |
| `relay_pow.py` | NIP-13 proof-of-work for relays that require it |
| `audiobook_requests.py` | Audiobook-request DM flow |
| `taskify_commands.py` | Published command catalog and encrypted picker action binding |
| `tests/` | Plugin regression suite |

## Install

1. Copy (or symlink) this directory to `~/.hermes/plugins/nostr-dm-platform`.
2. `python_dependencies` is declared in `plugin.yaml`:
   `nostr-sdk>=0.45.2,<0.46` (skipped on Android: no wheels).
   Install through Hermes' package manager, not raw pip.
3. Set the options you need in `~/.hermes/.env`. Use [the environment template](.env.example) as a starting point.
   - `NOSTR_DM_NSEC` — bot private key (nsec or hex). **Required.**
   - `NOSTR_DM_RELAYS` — comma-separated fallback `wss://` relays.
   - `NOSTR_DM_OWNER_NPUB` — your personal Nostr public key, as npub or hex. **Required.**
     If your old `NOSTR_DM_ALLOWED_NPUBS` contains your personal key, use that key here.
     The bot no longer claims an owner from the first message or reads the old auto-claim file.
   - `NOSTR_DM_PEER_RELAYS` — extra operator-approved `wss://` routes for peer inbox discovery.
   - `NOSTR_DM_ATTACHMENT_ORIGINS` — extra approved HTTPS origins for file downloads.
     Taskify's default Originless and Blossom origins are included.
   - `NOSTR_DM_OWNER_ATTACHMENT_MAX_MIB` — maximum incoming attachment size for the owner.
     Defaults to 512 MiB. For example, set it to `1024` for 1 GiB.
     Non-owner downloads retain a 64 MiB limit. Downloads stream to disk and require HTTPS.
   - `NOSTR_DM_OWNER_PRIVATE_ATTACHMENT_ORIGINS` — optional owner-only HTTPS origins for trusted
     internal services. For example, `https://files.home.example`. Configure the full origin,
     including any non-default port. The endpoint needs a trusted TLS certificate for its hostname.
     Public download origins still reject private IPs. Redirects remain disabled.
   - `NOSTR_DM_HOME_CHANNEL` / `NOSTR_DM_HOME_CHANNEL_NAME` — cron delivery target.
   - `NOSTR_DM_ROLES` — `npub=family,npub=friend` seed roles (persisted to
     `~/.hermes/nostr_roles.json`; `/role` DM commands update that file).
4. Restart the gateway so the platform loads.

Assign additional senders the `family` or `friend` role. Restricted senders are refused if role
enforcement is unavailable. Family members can use read-only slash commands, known read-only
tools, and the existing approval flow for gated tools. The owner retains full command access.

## Approval, delivery, and attachments

Use `/pending <id>` to review the complete operation, then `/approve <id>` to authorize
one call with the same arguments in the original conversation. Credential fields are masked
in the review and still bound to the approval. Older pending approvals and grants need to
be recreated. Explicit standing `/role allow` grants retain their existing meaning.

Ordinary DMs, group replies, file messages, and scheduled sends persist a signed,
encrypted wrap for each recipient before trying delivery. The gateway retries only copies
without a relay acknowledgement, with exponential backoff and seven days of retention.
If the gateway is down when a scheduled send fails, pending copies wait for its next startup.
Interactive picker listings remain immediate so the gateway can fall back to readable text.
A relay acknowledgement records acceptance by the relay.

Inbound plaintext is staged privately. It becomes available to Hermes only after the
checksum and encryption authentication checks succeed. Completed turns remove their staged
files, and an automatic sweep removes abandoned files after 24 hours.

## Taskify command menu

On gateway startup the adapter publishes a signed kind-30078
`taskify-bot-commands` list to its inbox and Taskify's discovery relays. The
list contains public command names and descriptions from the Hermes gateway
registry. The existing Nostr allowlist, role policy, and Hermes gateway still
decide who can run a command.

Open a direct chat with the bot in Taskify. Use the commands button or type
`/`. `/model` uses the gateway's provider catalog to show model buttons.
`/sessions` uses the gateway's named-session reply with stable session IDs.
Both replies can be read as ordinary text in other Nostr clients.

Taskify clients that support encrypted picker actions bind each picker tap to its original encrypted reply.
Hermes checks the sender and the options it offered before passing the command
through its ordinary gateway handlers. Open the picker again after a gateway
restart, once the menu expires, or after opening a newer menu of the same type.

## Tests

Run from the plugin directory using Python from a Hermes Agent environment with
the plugin dependencies installed. Set `HERMES_AGENT_DIR` to the Hermes source
checkout. The gateway admission test discovers the plugin, so point
`HERMES_HOME` at an isolated test profile with this plugin installed.

```sh
PYTHONPATH="$HERMES_AGENT_DIR${PYTHONPATH:+:$PYTHONPATH}" python -m unittest discover -s tests
```

The command, delivery queue, and network policy tests also run with Python’s
standard library alone. The gateway admission test uses Hermes’s real authorization mixin.

## Build a standalone ZIP

Run from the Taskify checkout after committing the plugin version in `plugin.yaml`.
Set `version` to the manifest version and `ref` to the commit to package.

```sh
version=0.1.2
ref=HEAD
git archive --format=zip --prefix=nostr-dm-platform/ \
  --output="/tmp/nostr-dm-platform-${version}.zip" \
  "${ref}:integrations/hermes" -- README.md plugin.yaml .env.example ':(glob)*.py'
```

The ZIP has one `nostr-dm-platform/` directory ready to extract to `~/.hermes/plugins/`.
Publish it to Blossom as a separate Hermes release. Keep live configuration, keys,
delivery queues, and decrypted attachments in the Hermes environment.
