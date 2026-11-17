"""Nostr NIP-17 DM platform adapter (Hermes plugin).

Receives NIP-17 private DMs (NIP-59 gift wraps) addressed to the bot's
Nostr key over its relays, dispatches them into the standard Hermes
message loop, and replies with gift-wrapped kind-14 DMs. Outbound DMs
target the recipient's published inbox relays (kind 10050) per the
NIP-17 spec, falling back to NIP-65 (kind 10002) read relays and then
to NOSTR_DM_RELAYS.

The bot signs with NOSTR_DM_NSEC. Owner access requires the separate public
key in NOSTR_DM_OWNER_NPUB. Other senders need an explicit restricted role.

Incoming: kind 1059 gift wraps -> unwrap -> rumor kind 14 (text),
15 (file/media msg), 7 (reaction; e-tag = inner rumor id).
Outgoing: rumor -> seal -> gift wrap per recipient (+ self-wrap), all
through nostr-sdk 0.44.8 (pinned; see nip17-nostr-dm skill).
"""

import asyncio
import base64
import json
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
import hashlib
import re
from collections import OrderedDict
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from datetime import timedelta
from typing import Any, Dict, List, Optional

try:
    import nostr_sdk as ns
    NOSTR_SDK_AVAILABLE = True
    NOSTR_SDK_VERSION = "ok"
except Exception as _e:  # pragma: no cover
    NOSTR_SDK_AVAILABLE = False
    NOSTR_SDK_VERSION = f"import failed: {_e}"
    ns = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

from agent.secret_scope import UnscopedSecretError as _UnscopedSecretError
from agent.secret_scope import get_secret as _scoped_get_secret

try:
    from . import policy as _role_policy  # package-internal import
except Exception:  # flat import fallback (plugin run as loose module)
    try:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location(
            "nostr_dm_policy",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "policy.py"),
        )
        _role_policy = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_role_policy)
    except Exception:
        _role_policy = None

try:
    from . import groups as _groups_mod  # package-internal import
except Exception:  # flat import fallback
    try:
        import importlib.util as _ilu2
        _spec2 = _ilu2.spec_from_file_location(
            "nostr_dm_groups",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "groups.py"),
        )
        _groups_mod = _ilu2.module_from_spec(_spec2)
        _spec2.loader.exec_module(_groups_mod)
    except Exception:
        _groups_mod = None

try:
    from . import relay_pow as _relay_pow_mod  # package-internal import
except Exception:  # flat import fallback
    try:
        import importlib.util as _ilu4
        _spec4 = _ilu4.spec_from_file_location(
            "nostr_dm_relay_pow",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay_pow.py"),
        )
        _relay_pow_mod = _ilu4.module_from_spec(_spec4)
        _spec4.loader.exec_module(_relay_pow_mod)
    except Exception:
        _relay_pow_mod = None

# bot-to-bot loop guard (per-conversation dispatch budget)
if _groups_mod is not None:  # shares the package/flat import trick
    try:
        from . import loop_guard as _loop_guard_mod
    except Exception:
        try:
            import importlib.util as _ilu3
            _spec3 = _ilu3.spec_from_file_location(
                "nostr_dm_loop_guard",
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "loop_guard.py"),
            )
            _loop_guard_mod = _ilu3.module_from_spec(_spec3)
            _spec3.loader.exec_module(_loop_guard_mod)
        except Exception:
            _loop_guard_mod = None
else:
    _loop_guard_mod = None

try:
    from . import delivery_queue as _delivery_queue
    from . import network_policy as _network
    from . import taskify_commands as _taskify
except ImportError:  # adapter also loads as a loose module in older Hermes releases
    import importlib.util

    def _load_sibling(name):
        spec = importlib.util.spec_from_file_location(
            f"nostr_dm_{name}", os.path.join(os.path.dirname(__file__), f"{name}.py"),
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    _delivery_queue = _load_sibling("delivery_queue")
    _network = _load_sibling("network_policy")
    _taskify = _load_sibling("taskify_commands")

log = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 60000  # rumor content cap (generous; relays vary)

DEFAULT_RELAYS = [
    "wss://push.solife.me",
    "wss://relay.solife.me",
    "wss://nos.lol",
]

PLATFORM_NAME = "nostr"

# Outbound media (kind-15 file messages, 0xchat/Taskify wire format):
# per-file random 32B key + 16B IV, raw AES-GCM ciphertext uploaded as opaque
# `<sha256>.bin` to the Blossom server with a kind-24242 `Authorization: Nostr`
# header; kind-15 rumor carries file-type/encryption-algorithm/decryption-key/
# decryption-nonce (+x/size/dim/filename) with the blob URL as content.
# Sources: taskify-pwa/src/lib/messengerAttachmentCrypto.ts + useDmSend.ts.
BLOSSOM_SERVER = "https://blossom.solife.me"

# Voice-reply blobs are deleted from Blossom after this TTL by
# ~/.hermes/scripts/nostr_blossom_sweep.py. Blossom itself has no
# client-settable retention (see _record_expiring_blob).
AUDIO_BLOB_TTL_SECONDS = int(os.environ.get("NOSTR_AUDIO_BLOB_TTL", "86400"))

_MIME_BY_EXT = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
    ".md": "text/markdown", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/opus",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def _mimetype_for(path: str) -> str:
    import mimetypes
    known = _MIME_BY_EXT.get(os.path.splitext(path)[1].lower())
    return known or mimetypes.guess_type(path)[0] or "application/octet-stream"


def _is_image_mime(mt: str) -> bool:
    return mt.startswith("image/") and mt != "image/svg+xml"


def _is_audio_mime(mt: str) -> bool:
    """Voice/audio attachment? Taskify sends mic recordings as audio/* kind-15 files."""
    return (mt or "").strip().lower().startswith("audio/")


def _to_mp3(path: str, bitrate: str = "64k") -> Optional[str]:
    """Transcode a voice reply to mono 24 kHz mp3; None if ffmpeg is unavailable or fails.

    TTS output is uncompressed 24 kHz mono WAV (~48 KB/s), so a 50 s reply is ~2.4 MB on
    Blossom. mp3 at 64 kbps is ~8 KB/s, about 6x smaller, and any client that plays the WAV
    plays mp3. The temp filename keeps the original stem and an explicit ``.mp3`` suffix —
    ``_mimetype_for`` infers ``audio/mpeg`` from the extension, so a wrong suffix would get
    classified as a DOCUMENT and never reach the voice player.

    Best-effort by design: a failed transcode must degrade to sending the original file,
    never to dropping the reply. The caller owns cleanup of the returned temp directory.
    """
    stem = os.path.splitext(os.path.basename(path))[0] or "voice"
    try:
        tmpdir = tempfile.mkdtemp(prefix="nostr_mp3_")
        out = os.path.join(tmpdir, f"{stem}.mp3")
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", path,
             "-codec:a", "libmp3lame", "-b:a", bitrate,
             "-ar", "24000", "-ac", "1", out],
            capture_output=True, text=True, timeout=180,
        )
    except Exception as exc:
        log.warning("[nostr-dm] mp3 transcode failed, sending original: %s", exc)
        return None
    if proc.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        log.warning("[nostr-dm] mp3 transcode failed, sending original: %s",
                    (proc.stderr or "")[:200])
        try:
            os.unlink(out)
            os.rmdir(tmpdir)
        except OSError:
            pass
        return None
    return out


def _get_scoped_secret(name, default=None):
    """Scope-aware credential read (default-profile startup fallback)."""
    try:
        val = _scoped_get_secret(name)
        if val:
            return val
        return os.getenv(name, default)
    except _UnscopedSecretError:
        return os.getenv(name, default)


def _load_hermes_dotenv_once() -> None:
    """Best-effort .env loader for paths that run before/without the gateway.

    The gateway exports .env into os.environ; standalone tools (tests,
    cron scripts) may not. Idempotent, never overrides existing vars.
    """
    if getattr(_load_hermes_dotenv_once, "_done", False):
        return
    _load_hermes_dotenv_once._done = True
    try:
        path = os.path.join(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")), ".env")
        if not os.path.exists(path):
            return
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
        log.info("[nostr-dm] loaded %s for standalone use", path)
    except Exception:
        pass


_load_hermes_dotenv_once()


# ---------------------------------------------------------------------------
# nostr-sdk helpers (proven in /tmp/nip17_live_test.py + nip17-nostr-dm skill)
# ---------------------------------------------------------------------------

def _keys_from_secret(secret: str):
    s = secret.strip()
    if s.startswith("nsec"):
        return ns.Keys.parse(s)
    return ns.Keys.parse(s)  # nostr-sdk parses hex via same entry for Keys.parse? fallback below


def _pk(hex_or_npub: str):
    v = hex_or_npub.strip()
    if v.startswith("npub"):
        v = ns.Nip19.from_bech32(v)  # returns Nip19Profile/Event? use decode below
    return ns.PublicKey.parse(v)


def _normalize_pubkey_hex(v: str) -> str:
    """npub or hex -> lowercase hex. PublicKey.parse() accepts both (0.44.8)."""
    v = v.strip()
    if not v:
        return ""
    try:
        return ns.PublicKey.parse(v).to_hex()
    except Exception:
        return v.lower()


def _private_state_dir(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise OSError("Nostr state directory must be private")
    return path


async def _build_recipient_wrap(signer, recipient_hex, rumor, relays):
    recipient = ns.PublicKey.parse(recipient_hex)
    seal = await (await ns.EventBuilder.seal(signer, recipient, rumor)).sign(signer)
    difficulty = await asyncio.to_thread(_relay_pow_mod.nip11_min_pow, relays)
    return await _relay_pow_mod.pow_gift_wrap(ns, ns.Keys.generate(), recipient, seal, difficulty)


async def _publish_recipient_wrap(signer, recipient_hex, rumor, relays):
    """Return the wrap ID only after a relay acknowledges the recipient copy."""
    wrap = await _build_recipient_wrap(signer, recipient_hex, rumor, relays)
    return await _send_wrap(signer, wrap, relays)


async def _send_wrap(signer, wrap, relays):
    client = ns.Client(signer)
    try:
        for relay in relays:
            try:
                await client.add_relay(ns.RelayUrl.parse(relay))
            except Exception:
                log.debug("[nostr-dm] could not add delivery relay")
        await client.connect()
        delivery = await client.send_event(wrap)
        if not delivery.success:
            raise OSError("No relay accepted the recipient copy")
        return wrap.id().to_hex()
    finally:
        try:
            await client.shutdown()
        except Exception:
            log.debug("[nostr-dm] delivery relay client shutdown failed")



def _outbox_for(bot_pubkey):
    root = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    directory = _private_state_dir(root / f"nostr-outbox-{bot_pubkey}")
    return _delivery_queue.DeliveryQueue(directory / "deliveries.sqlite3")


async def _attempt_queued_delivery(queue, signer, key, relays):
    claim = await asyncio.to_thread(queue.claim, key)
    if claim is None:
        return await asyncio.to_thread(queue.acknowledged, key)
    event, attempts, lease = claim
    accepted = False
    try:
        wrap = ns.Event.from_json(event)
        await asyncio.wait_for(_send_wrap(signer, wrap, relays), timeout=45)
        accepted = True
    except Exception:
        log.info("[nostr-dm] recipient %.12s still pending relay acknowledgement", key[1])
    finally:
        await asyncio.to_thread(queue.finish, key, lease, attempts, accepted)
    return accepted


class _Handler(ns.HandleNotification):
    """Queues gift-wrap events; heavy work happens in the adapter task."""

    def __init__(self, queue: asyncio.Queue, my_hex: str):
        self._q = queue
        self._me = my_hex

    async def handle_msg(self, relay_url, msg) -> None:
        return None

    async def handle(self, relay_url, subscription_id, event) -> None:
        try:
            if event.kind().as_u16() == 1059:
                self._q.put_nowait(("event", event))
        except Exception:
            pass


class NostrDmAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        extra = getattr(config, "extra", {}) or {}
        self.extra = extra
        self._secret = _get_scoped_secret("NOSTR_DM_NSEC") or extra.get("nsec") or ""
        self._fallback_relays = [
            r.strip() for r in
            (_get_scoped_secret("NOSTR_DM_RELAYS") or extra.get("relays") or ",".join(DEFAULT_RELAYS)).split(",")
            if r.strip()
        ]
        peer_relays = _get_scoped_secret("NOSTR_DM_PEER_RELAYS") or extra.get("peer_relays") or ""
        self._peer_relays = [r.strip() for r in peer_relays.split(",") if r.strip()]
        media_origins = (
            _get_scoped_secret("NOSTR_DM_ATTACHMENT_ORIGINS") or extra.get("attachment_origins") or ""
        )
        self._attachment_origins = _network.attachment_origins(
            url.strip() for url in media_origins.split(",") if url.strip()
        )
        owner_origins = _get_scoped_secret("NOSTR_DM_OWNER_PRIVATE_ATTACHMENT_ORIGINS") or extra.get(
            "owner_private_attachment_origins", ""
        )
        self._owner_private_origins = _network.attachment_origins(
            (url.strip() for url in owner_origins.split(",") if url.strip()), defaults=(),
        )
        self._owner_attachment_bytes = int(
            _get_scoped_secret("NOSTR_DM_OWNER_ATTACHMENT_MAX_MIB")
            or extra.get("owner_attachment_max_mib")
            or _network.DEFAULT_OWNER_ATTACHMENT_MIB
        ) * 1024 * 1024
        if self._owner_attachment_bytes <= 0:
            raise ValueError("NOSTR_DM_OWNER_ATTACHMENT_MAX_MIB must be positive")
        configured_owner = _get_scoped_secret("NOSTR_DM_OWNER_NPUB") or extra.get("owner_npub") or ""
        self._configured_owner = ""
        if configured_owner:
            try:
                self._configured_owner = ns.PublicKey.parse(configured_owner.strip()).to_hex()
            except Exception as exc:
                raise ValueError("NOSTR_DM_OWNER_NPUB must identify a Nostr public key") from exc
        for key in ("NOSTR_DM_ALLOW_ALL_USERS", "NOSTR_DM_AUTO_CLAIM"):
            if str(_get_scoped_secret(key) or "").strip().lower() in ("1", "true", "yes"):
                log.warning("[nostr-dm] %s is ignored. Configure an owner explicitly.", key)

        self._keys = None
        self._my_hex = None
        self._signer = None
        self._client = None
        self._relays_client = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._tasks: List[asyncio.Task] = []
        self._taskify_menus = _taskify.PickerMenus()
        self._taskify_requests = OrderedDict()
        self._dedup_lock = None  # created lazily inside the running loop (py3.11)
        self._processed_rumor_ids: set = set()
        self._seen_wrap_ids: set = set()
        self._inbox_relay_cache: Dict[str, List[str]] = {}
        self._inbox_cache_ts: Dict[str, float] = {}
        self._boot_ts = int(time.time())
        super().__init__(config, Platform(PLATFORM_NAME))
        if not NOSTR_SDK_AVAILABLE:
            raise RuntimeError(f"nostr_sdk unavailable: {NOSTR_SDK_VERSION}")
        # ---- per-user roles (policy.py) --------------------------------
        self._roles = None
        if _role_policy is not None:
            try:
                self._roles = _role_policy._store()
                # seed from env pairs "npub1...=family,npub2...=friend" (idempotent)
                env_roles = _get_scoped_secret("NOSTR_DM_ROLES") or extra.get("roles") or ""
                for pair in env_roles.split(","):
                    pair = pair.strip()
                    if "=" in pair:
                        pk, role = pair.split("=", 1)
                        self._roles.set(_normalize_pubkey_hex(pk), role.strip().lower())
                log.info("[nostr-dm] role policy active (%d restricted users)", len(self._roles.all_non_owner()))
            except Exception as e:
                log.warning("[nostr-dm] role policy disabled: %s", e)
                self._roles = None
        # ---- group chat state (groups.py) -------------------------------
        self._groups = None
        # Latest message text per sender: an owner-approval page shows WHAT was
        # asked, and after an approval the blocked turn is resumed from it.
        self._last_prompt: Dict[str, str] = {}
        if _groups_mod is None:
            log.info("[nostr-dm] groups module unavailable; group support off")
        # ---- bot-to-bot loop guard (loop_guard.py) ----------------------
        self._loop_guard = None
        if _loop_guard_mod is not None:
            gs = _loop_guard_mod.parse_settings(extra)
            self._loop_guard = _loop_guard_mod.LoopGuard(**gs)
            if gs["enabled"]:
                log.info(
                    "[nostr-dm] loop guard active: %d events/%ds window, %ds cooldown",
                    gs["max_events"], gs["window_sec"], gs["cooldown_sec"],
                )
        else:
            log.info("[nostr-dm] loop guard module unavailable; budget off")

    # ------------------------------------------------------------------
    # platform plumbing
    # ------------------------------------------------------------------
    # Gateway-facing authz surface (own-policy adapter contract).
    #
    # The gateway re-checks authorization for every message the adapter
    # forwards (gateway/authz_mixin._is_user_authorized). Its default path
    # only knows the env allowlist, so role-assigned users (family/friend
    # from nostr_roles.json) passed the pump gate but died at the gateway
    # with "Unauthorized user ... (None)". Declaring own-policy access lets
    # the gateway trust this adapter's intake decision:
    #   - DMs: the gateway re-checks via _is_dm_allowed() — roles-aware below.
    #   - Groups: intake rubber-stamp under "allowlist" policy — the pump's
    #     roles-aware gate already admitted the sender before dispatch.
    # ------------------------------------------------------------------
    enforces_own_access_policy = True

    @property
    def _dm_policy(self) -> str:
        return "allowlist"

    @property
    def _group_policy(self) -> str:
        return "allowlist"

    def _sender_role(self, sender_hex: str) -> Optional[str]:
        if not sender_hex:
            return None
        if sender_hex == self._owner_hex():
            return "owner"
        if self._roles is None or _role_policy is None or not _role_policy.hook_registered():
            return None
        try:
            return self._roles.get(sender_hex)
        except _role_policy.RoleStoreUnavailable:
            return None

    def _roles_authorized(self, sender_hex: str) -> bool:
        return self._sender_role(sender_hex) is not None

    def _is_dm_allowed(self, user_id: str) -> bool:
        """Gateway-facing DM allowlist re-check (#34515 contract)."""
        try:
            return self._roles_authorized(_normalize_pubkey_hex(user_id or ""))
        except Exception:
            return False

    def resolved_allowlist_user_ids(self) -> set:
        """Return only explicitly authorized owners and users assigned a healthy role."""
        owner = self._owner_hex()
        ids = {owner} if owner else set()
        if self._roles is not None and _role_policy is not None and _role_policy.hook_registered():
            try:
                ids.update(self._roles.all_non_owner())
            except _role_policy.RoleStoreUnavailable:
                log.warning("[nostr-dm] restricted-user admission paused because the role store is unavailable")
        return ids

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        try:
            self._keys = _keys_from_secret(self._secret)
            self._my_hex = self._keys.public_key().to_hex()
            self._signer = ns.NostrSigner.keys(self._keys)
        except Exception as e:
            log.error("[nostr-dm] bad NOSTR_DM_NSEC: %s", e)
            return False

        if self._owner_hex() is None:
            log.error("[nostr-dm] no owner configured. Set NOSTR_DM_OWNER_NPUB before enabling this adapter.")
            return False
        state_root = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
        self._media_dir = _private_state_dir((state_root / f"nostr-media-{self._my_hex}").absolute())
        self._delivery_queue = await asyncio.to_thread(_outbox_for, self._my_hex)
        await asyncio.to_thread(self._expire_attachments)
        relays = list(dict.fromkeys(self._fallback_relays)) or DEFAULT_RELAYS
        self._client = ns.Client(self._signer)
        for r in relays:
            try:
                await self._client.add_relay(ns.RelayUrl.parse(r))
            except Exception:
                pass
        await self._client.connect()
        # subscribe to gift wraps addressed to me
        f = ns.Filter().kind(ns.Kind(1059)).pubkey(ns.PublicKey.parse(self._my_hex))
        await self._client.subscribe(f)
        self._notif_handler_cb = _Handler(self._queue, self._my_hex)
        notif_task = asyncio.create_task(self._client.handle_notifications(self._notif_handler_cb))
        pump = asyncio.create_task(self._pump())
        self._tasks = [
            notif_task, pump, asyncio.create_task(self._publish_taskify_commands()),
            asyncio.create_task(self._attachment_janitor()),
            asyncio.create_task(self._retry_pending_deliveries()),
        ]
        # group state needs the bot pubkey — available now
        if _groups_mod is not None and self._groups is None:
            try:
                self._groups = _groups_mod.GroupState(
                    self._my_hex, display_name=str(
                        (_get_scoped_secret("NOSTR_DM_BOT_NAME") or "Hermes")
                    ),
                )
                log.info("[nostr-dm] group support active (mention+reply trigger)")
            except Exception as e:
                log.warning("[nostr-dm] group init failed: %s", e)
                self._groups = None
        # bind the approval-DM bridge (agent thread -> adapter loop -> owner DM);
        # when the blocked action came from a GROUP room, also post the ask there
        if _role_policy is not None and self._roles is not None:
            try:
                loop = asyncio.get_running_loop()
                def _post_group(room_id: str, text: str):
                    return self.send_group(room_id, text[:MAX_MESSAGE_LENGTH])
                def _is_known_room(cid: str):
                    return self._groups.rooms.get(cid) if self._groups else None
                _role_policy.APPROVALS.bind(
                    loop,
                    lambda chat_id, text: self.send(chat_id, text[:MAX_MESSAGE_LENGTH]),
                    self._owner_hex,
                    group_fn=lambda rid, text: _post_group(rid, text) if _is_known_room(rid) else None,
                    prompt_fn=self._last_prompt.get,
                    resume_fn=self._resume_family_request,
                )
            except Exception as e:
                log.warning("[nostr-dm] approval proxy not bound: %s", e)
        log.info("[nostr-dm] connected as %s on %s", self._my_hex[:12], relays)
        return True

    async def _publish_taskify_commands(self) -> None:
        """Publish the public catalog using the same key that answers Taskify DMs."""
        client = None
        try:
            from hermes_cli.commands import COMMAND_REGISTRY, _is_gateway_available
            tags = _taskify.command_tags(COMMAND_REGISTRY, _is_gateway_available)
            if not any(tag[0] == "command" for tag in tags):
                return
            relays = list(dict.fromkeys([*(await self._target_relays(self._my_hex)),
                                         *_taskify.DISCOVERY_RELAYS]))
            client = ns.Client(self._signer)
            for relay in relays:
                try:
                    await client.add_relay(ns.RelayUrl.parse(relay))
                except Exception as exc:
                    log.debug("[nostr-dm] could not add command-list relay: %s", exc)
            await client.connect()
            difficulty = await asyncio.to_thread(_relay_pow_mod.nip11_min_pow, relays)
            builder = ns.EventBuilder(ns.Kind(30078), "").tags([ns.Tag.parse(t) for t in tags])
            if difficulty:
                builder = builder.pow(difficulty)
            event = await asyncio.to_thread(builder.sign_with_keys, self._keys)
            result = await client.send_event(event)
            if not result.success:
                log.warning("[nostr-dm] no relay accepted the Taskify command list")
        except Exception as exc:
            log.warning("[nostr-dm] could not publish Taskify commands: %s", exc)
        finally:
            if client is not None:
                try:
                    await client.shutdown()
                except Exception as exc:
                    log.debug("[nostr-dm] command-list relay shutdown failed: %s", exc)

    async def disconnect(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        try:
            await self._client.shutdown()
        except Exception:
            pass

    def get_chat_info(self, chat_id: str) -> dict:
        return {"name": f"nostr:{chat_id[:12]}", "type": "dm", "chat_id": chat_id}

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None  # no typing concept over gift wraps

    # ------------------------------------------------------------------
    # inbound pump
    # ------------------------------------------------------------------
    async def _pump(self) -> None:
        while True:
            _, event = await self._queue.get()
            try:
                await self._dispatch_wrap(event)
            except Exception:
                log.exception("[nostr-dm] a message failed during dispatch")

    async def _dispatch_wrap(self, ev) -> None:
        try:
            ug = await ns.UnwrappedGift.from_gift_wrap(self._signer, ev)
        except Exception as e:
            log.warning("[nostr-dm] unwrap failed: %s", e)
            return
        rumor = ug.rumor()
        sender = ug.sender().to_hex()
        rid = rumor.id().to_hex()
        # Atomically claim this rumor id — same DM published on N relays
        # arrives once per relay, and only the first claim dispatches.
        if self._dedup_lock is None:
            self._dedup_lock = asyncio.Lock()
        async with self._dedup_lock:
            if rid in self._processed_rumor_ids:
                return
            self._processed_rumor_ids.add(rid)
        k = rumor.kind().as_u16()
        content = rumor.content()
        e_tag_ids: List[str] = []
        try:
            for tag in rumor.tags().to_vec():
                vec = tag.as_vec()
                if vec and vec[0] == "e" and len(vec) > 1:
                    e_tag_ids.append(vec[1])
        except Exception:
            pass
        subject = ""
        try:
            for tag in rumor.tags().to_vec():
                vec = tag.as_vec()
                if vec and vec[0] == "subject" and len(vec) > 1:
                    subject = vec[1]
                    break
        except Exception:
            pass
        if k == 7:
            # reaction: map to a text line for the agent
            content = f"[reaction {content}]"
        elif k not in (14, 15):
            return
        if sender == self._my_hex:
            return  # self-wrap echo
        # freshness gate: relays replay old wraps on reconnect; we only
        # dispatch DMs newer than our boot minus a small clock skew
        rumor_ts = rumor.created_at().as_secs()
        if rumor_ts < self._boot_ts - 120:
            log.info("[nostr-dm] skipping stale wrap (age %ds) from %s…", int(time.time()) - rumor_ts, sender[:12])
            return
        role = self._sender_role(sender)
        if role is None:
            log.debug("[nostr-dm] unauthorized sender ignored")
            return
        # ---------------- group path (NIP-17 multi-p-tag rooms) --------
        group_room_id = None
        if _groups_mod is not None:
            try:
                recipient_hexes: List[str] = []
                for tag in rumor.tags().to_vec():
                    vec = tag.as_vec()
                    if vec and vec[0] == "p" and len(vec) > 1:
                        recipient_hexes.append(vec[1])
                # 0xchat semantics: p-tags span ALL members (sender, other
                # humans, and us). Members = p-tags + sender. Do NOT strip
                # our own tag — the bot belongs to the room (verified live:
                # stripping it produced a bot-less room id and orphaned the
                # reply into a phantom room with the owner and requester).
                others = recipient_hexes
                if _groups_mod.is_group_rumor(sender, others):
                    if self._groups is None or self._my_hex not in others:
                        return
                    group_room_id = self._groups.classify(sender, others)
            except Exception:
                log.exception("[nostr-dm] room classification failed")
                return

        if group_room_id is not None:
            await self._handle_group_message(
                ev, rumor, k, sender, rid, content, e_tag_ids,
                subject, group_room_id,
            )
            return
        actions = []
        if k == 14:
            actions = [
                tag.as_vec() for tag in rumor.tags().to_vec() if tag.as_vec()[:1] == [_taskify.ACTION_TAG]
            ]
            if actions:
                action_error = self._taskify_menus.validate(sender, actions, e_tag_ids, content)
                if action_error:
                    await self.send(sender, action_error, reply_to=rid, link_reply=True)
                    return
        if _role_policy is not None and self._roles is not None and k == 14:
            role_reply = _role_policy.parse_role_command(content, sender, self._owner_hex())
            if role_reply is not None:
                await self.send(sender, role_reply[:MAX_MESSAGE_LENGTH])
                return
            approval_reply = _role_policy.parse_approval_command(content, sender, self._owner_hex())
            if approval_reply is not None:
                await self.send(sender, approval_reply[:MAX_MESSAGE_LENGTH])
                return
        if not self._check_loop_guard(sender, sender, is_group=False):
            return
        if role == "friend":
            await self._reply_as_friend(sender, "[Attachment received]" if k == 15 else content)
            return
        if role == "family":
            if k == 14 and not _role_policy.family_slash_allowed(content):
                await self.send(sender, "This command is available to the Nostr bot owner.")
                return
            self._last_prompt[sender] = content
        caption, media_urls, mtype, media_types = (
            await asyncio.to_thread(self._process_file_rumor, rumor, content, rid, role == "owner")
            if k == 15 else ("", [], MessageType.TEXT, [])
        )
        if k == 15:
            content = caption
        request_kind = None
        if k == 14 and content.strip().lower() in ("/sessions", "/resume"):
            request_kind = "sessions"
        elif actions and e_tag_ids:
            request_kind = "action"
        if request_kind:
            self._taskify_requests[(sender, rid)] = request_kind
            if len(self._taskify_requests) > 128:
                self._taskify_requests.popitem(last=False)
        if k == 14 and content.startswith("/"):
            mtype = MessageType.COMMAND
        ev_obj = MessageEvent(
            text=content,
            message_type=mtype,
            user_id=sender,
            user_name=f"npub…{sender[-8:]}",
            source=self.build_source(
                chat_id=sender,
                chat_name=f"nostr {sender[:8]}…",
                chat_type="dm",
                user_id=sender,
            ),
            raw_message=ev,
            message_id=rid,
            media_urls=media_urls,
            media_types=media_types,
        )
        await self._dispatch_as_sender(ev_obj, sender)

    async def _dispatch_as_sender(self, event, sender):
        token = (_role_policy.set_actor(sender, owner=self._owner_hex(), conversation=event.source.chat_id)
                 if _role_policy is not None else None)
        try:
            await self.handle_message(event)
        finally:
            if token is not None:
                _role_policy.reset_actor(token)

    async def _reply_as_friend(self, sender, content, room_id=None, reply_to=None):
        token = _role_policy.set_actor(sender, owner=self._owner_hex())
        try:
            reply = await asyncio.to_thread(_role_policy.run_friend_turn, content, sender)
        finally:
            _role_policy.reset_actor(token)
        reply = reply or "(no reply)"
        if room_id:
            await self.send_group(room_id, reply, reply_to=reply_to)
        else:
            for offset in range(0, len(reply), MAX_MESSAGE_LENGTH):
                await self.send(sender, reply[offset:offset + MAX_MESSAGE_LENGTH])

    def _process_file_rumor(self, rumor, content: str, rumor_id: str, is_owner: bool = False):
        """Stream verified media to a private file before exposing it to Hermes."""
        path = None
        try:
            tags = {tag[0]: tag[1] for tag in (t.as_vec() for t in rumor.tags().to_vec())
                    if len(tag) > 1}
            is_url = content.startswith(("https://", "http://"))
            url = content if is_url else tags.get("url", "")
            name = os.path.basename(tags.get("filename") or "attachment.bin")
            mime = (tags.get("file-type") or _mimetype_for(name)).strip().lower()
            text_caption = (tags.get("caption") or tags.get("alt") or "") if is_url else content
            enc = (tags.get("encryption-algorithm") or "").lower()
            key, nonce = b"", b""
            if enc:
                if enc != "aes-gcm":
                    raise ValueError("Unsupported attachment encryption")
                key = bytes.fromhex(tags.get("decryption-key", ""))
                nonce = bytes.fromhex(tags.get("decryption-nonce", ""))
                if len(key) not in (16, 24, 32) or not 8 <= len(nonce) <= 128:
                    raise ValueError("Invalid attachment decryption parameters")

            is_audio = _is_audio_mime(mime)
            is_image = _is_image_mime(mime)
            label = "audio" if is_audio else ("image" if is_image else "file")
            suffix = os.path.splitext(name)[1]
            if not re.fullmatch(r"\.[A-Za-z0-9]{1,16}", suffix):
                suffix = ".bin"
            private_origins = self._owner_private_origins if is_owner else frozenset()
            origins = self._attachment_origins | private_origins
            limit = (self._owner_attachment_bytes if is_owner
                     else _network.DEFAULT_RESTRICTED_ATTACHMENT_MIB * 1024 * 1024)
            expected_size = int(tags["size"]) if tags.get("size") else None
            if expected_size is not None and not 0 < expected_size <= limit:
                raise ValueError("Invalid attachment size")

            digest = hashlib.sha256()
            tail = b""
            decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).decryptor() if enc else None
            with tempfile.NamedTemporaryFile(prefix="nostr-k15-", suffix=suffix,
                                             dir=self._media_dir, delete=False) as file:
                path = file.name

                def write(chunk):
                    nonlocal tail
                    digest.update(chunk)
                    if decryptor is None:
                        file.write(chunk)
                    else:
                        buffered = tail + chunk
                        if len(buffered) > 16:
                            file.write(decryptor.update(buffered[:-16]))
                        tail = buffered[-16:]

                _network.stream_https(
                    url, write, origins=origins, limit=limit + (16 if enc else 0),
                    timeout=300 if is_owner else 60, private_origins=private_origins,
                )
                if tags.get("x") and digest.hexdigest() != tags["x"].lower():
                    raise ValueError("Attachment checksum mismatch")
                if decryptor is not None:
                    file.write(decryptor.finalize_with_tag(tail))
                if expected_size is not None and expected_size != file.tell():
                    raise ValueError("Attachment size mismatch")
            kind = MessageType.VOICE if is_audio else (MessageType.PHOTO if is_image else MessageType.DOCUMENT)
            return f"[{label}: {name}] {text_caption}".strip(), [path], kind, [mime]
        except Exception:
            if path is not None:
                self._remove_attachment(path)
            log.info("[nostr-dm] attachment %.12s could not be downloaded or verified", rumor_id)
            return "[Attachment unavailable]", [], MessageType.TEXT, []

    def _remove_attachment(self, value):
        path = Path(value)
        if path.parent == self._media_dir and path.name.startswith("nostr-k15-"):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                log.warning("[nostr-dm] could not remove a staged attachment")

    async def on_processing_complete(self, event, outcome):
        if str(getattr(outcome, "value", outcome)).lower() != "cancelled":
            for path in event.media_urls or ():
                self._remove_attachment(path)
        await super().on_processing_complete(event, outcome)

    def _expire_attachments(self):
        cutoff = time.time() - 24 * 3600
        for path in self._media_dir.glob("nostr-k15-*"):
            try:
                if path.lstat().st_mtime < cutoff:
                    self._remove_attachment(path)
            except FileNotFoundError:
                pass

    async def _attachment_janitor(self):
        while True:
            await asyncio.sleep(1800)
            try:
                await asyncio.to_thread(self._expire_attachments)
            except OSError:
                log.warning("[nostr-dm] attachment cleanup could not complete")

    def _owner_hex(self) -> Optional[str]:
        return self._configured_owner or None

    # ------------------------------------------------------------------
    # bot-to-bot loop guard (per-conversation dispatch budget)
    # ------------------------------------------------------------------
    def _check_loop_guard(self, key: str, sender: str, is_group: bool) -> bool:
        """True when this dispatch may proceed. Budgets non-owner traffic per
        conversation; on the transition into cooldown, DMs the owner once via
        the approval-proxy channel. Never raises — a guard bug must not take
        message intake down with it."""
        if self._loop_guard is None:
            return True
        try:
            owner = self._owner_hex() or ""
            allowed, entered, reason = self._loop_guard.check(key, is_owner=sender == owner)
            if allowed:
                return True
            what = "group" if is_group else "DM"
            log.warning(
                "[nostr-dm] loop guard: suppressed %s dispatch from %s… (%s)",
                what, sender[:12], reason,
            )
            if entered and _role_policy is not None:
                _role_policy.APPROVALS.notify_owner(
                    f"🛑 Bot loop guard: {self._loop_guard.max_events} messages in "
                    f"{self._loop_guard.window_sec}s from …{sender[-12:]} in a "
                    f"{'group' if is_group else 'DM'} — dispatch paused "
                    f"{self._loop_guard.cooldown_sec}s. (Replying to another bot? "
                    f"Tell me to pause it or remove its access.)",
                )
            return False
        except Exception as e:
            log.warning("[nostr-dm] loop guard check failed (fail-open): %s", e)
            return True

    # ------------------------------------------------------------------
    # group chat handling (NIP-17 multi-p-tag rooms, Taskify-compatible)
    # ------------------------------------------------------------------
    async def _handle_group_message(
        self, ev, rumor, kind_u16: int, sender: str, rumor_id: str,
        content: str, e_tag_ids: List[str], subject: str,
        room_id: str,
    ) -> None:
        role = self._sender_role(sender)
        if role is None:
            return
        room = self._groups.rooms[room_id]
        backlog = room["backlog"]
        if subject and room.get("subject") != subject:
            room["subject"] = subject
        sender_name = f"npub…{sender[-8:]}"
        is_from_bot = sender == self._my_hex
        # Taskify metadata-only messages (subject change, empty content): update
        # room name, record nothing.
        if kind_u16 == 14 and not (content or "").strip():
            return
        backlog.add(sender, sender_name, "[attachment]" if kind_u16 == 15 else content,
                    rumor_id=rumor_id, is_bot=is_from_bot)

        # trigger gate: mention + reply-to-bot only (v1)
        try:
            triggered = self._groups.gate.should_dispatch(content, e_tag_ids, backlog)
        except Exception:
            triggered = False
        if not triggered:
            log.debug("[nostr-dm] group %s: %s… not addressed; backlog only", room_id[:12], sender[:10])
            return
        dispatch_text = "[attachment]" if kind_u16 == 15 else self._groups.gate.strip_leading_mention(content)
        context_block = backlog.render(self_name="Hermes")
        group_discipline = (
            "[Group chat mode — you are 'Hermes', a participant in this Nostr group. "
            "Respond with exactly ONE final message per request: no progress "
            "narration, no thinking out loud, no interim updates. Do all the work "
            "silently, then post the single complete answer. If an action needs "
            "the owner's approval, say 'Owner, do you approve X' in this chat — a "
            "copy was also DM'd to him. Address other members by their handle.]\n\n"
        )
        full_text = dispatch_text
        if context_block:
            full_text = (
                f"[Group conversation context — treat earlier lines as what has "
                f"already been said.]\n{context_block}\n\n"
                f"[Message addressed to you from {sender_name}:]\n{dispatch_text}\n\n"
                + group_discipline
            )
        else:
            full_text = f"{dispatch_text}\n\n{group_discipline}"
        # member cap (Taskify max 17)
        members = room["members"]
        if len(members) > _groups_mod.MAX_GROUP_MEMBERS:
            log.info("[nostr-dm] group %s exceeds max members; ignoring", room_id[:12])
            return
        if not self._check_loop_guard(room_id, sender, is_group=True):
            return
        if role == "friend":
            await self._reply_as_friend(sender, full_text, room_id=room_id, reply_to=rumor_id)
            return
        if role == "family":
            if kind_u16 == 14 and not _role_policy.family_slash_allowed(dispatch_text):
                await self.send_group(room_id, "This command is available to the Nostr bot owner.", reply_to=rumor_id)
                return
            self._last_prompt[sender] = dispatch_text
        caption, media_urls, mtype, media_types = (
            await asyncio.to_thread(self._process_file_rumor, rumor, content, rumor_id, role == "owner")
            if kind_u16 == 15 else ("", [], MessageType.TEXT, [])
        )
        if kind_u16 == 15:
            full_text += f"\n\n{caption}"
        ev_obj = MessageEvent(
            text=full_text,
            message_type=mtype,
            user_id=sender,
            user_name=sender_name,
            source=self.build_source(
                chat_id=room_id,
                chat_name=f"group {room.get('subject') or room_id[:8]}",
                chat_type="group",
                user_id=sender,
            ),
            raw_message=ev,
            message_id=rumor_id,
            media_urls=media_urls,
            media_types=media_types,
        )
        await self._dispatch_as_sender(ev_obj, sender)

    async def _resume_family_request(self, rec: dict) -> None:
        """Retry an owner-approved operation only in the original conversation."""
        actor = str(rec.get("actor") or "").strip().lower()
        prompt = str(rec.get("prompt") or "").strip()
        if not actor or not prompt or self._sender_role(actor) != "family":
            return
        tool = str(rec.get("tool") or "")
        room_id = str(rec.get("room_id") or "").strip().lower()
        in_room = bool(room_id) and self._groups is not None and room_id in self._groups.rooms
        if room_id and not in_room:
            return
        # the grant is the authority, not the request: read its live budget
        grant = next((g for g in _role_policy._approval_store().grants()
                      if str(g.get("id")) == str(rec.get("id"))), {})
        if not grant:
            return
        note = (
            f"[Owner approved one exact '{tool}' operation ({rec.get('id')}). "
            "Retry the original request using the same arguments. Changed arguments require a new approval.]"
        )
        if in_room:
            room = self._groups.rooms[room_id]
            source = self.build_source(
                chat_id=room_id,
                chat_name=f"group {room.get('subject') or room_id[:8]}",
                chat_type="group", user_id=actor,
            )
        else:
            source = self.build_source(
                chat_id=actor, chat_name=f"nostr {actor[:8]}…",
                chat_type="dm", user_id=actor,
            )
        if not self._check_loop_guard(source.chat_id, actor, is_group=in_room):
            return
        event = MessageEvent(
            text=f"{note}\n\nEarlier request from this user:\n{prompt}",
            message_type=MessageType.TEXT,
            user_id=actor,
            user_name=f"npub…{actor[-8:]}",
            source=source,
            raw_message=None,
            message_id=f"approval-{rec.get('id')}",
            media_urls=[],
            media_types=[],
        )
        log.info("[nostr-dm] resuming approved request %s (%s) for …%s in %s",
                 rec.get("id"), tool, actor[-8:], "room" if in_room else "DM")
        try:
            await self._dispatch_as_sender(event, actor)
        except Exception as e:
            log.warning("[nostr-dm] resume of %s failed: %s", rec.get("id"), e)

    # ------------------------------------------------------------------
    # relay discovery (NIP-17: kind 10050; NIP-65: kind 10002)
    # ------------------------------------------------------------------
    async def _target_relays(self, recipient_hex: str) -> List[str]:
        now = time.time()
        cached = self._inbox_relay_cache.get(recipient_hex)
        if cached and now - self._inbox_cache_ts.get(recipient_hex, 0) < 3600:
            return cached
        found: List[str] = []
        probe = self._relays_client or self._client
        timeout = timedelta(seconds=10)
        try:
            events = await probe.fetch_events(
                ns.Filter().kind(ns.Kind(10050)).author(ns.PublicKey.parse(recipient_hex)).limit(1),
                timeout,
            )
            for ev in (events if isinstance(events, list) else events.to_vec()):
                if ev.author().to_hex() != recipient_hex or ev.kind().as_u16() != 10050 or not ev.verify():
                    continue
                for tag in ev.tags().to_vec():
                    vec = tag.as_vec()
                    if vec and vec[0] == "relay" and len(vec) > 1:
                        found.append(vec[1].strip())
                break
        except Exception as e:
            log.debug("[nostr-dm] 10050 lookup failed for %s: %s", recipient_hex[:10], e)
        # NIP-65 fallback
        if not found:
            try:
                events = await probe.fetch_events(
                    ns.Filter().kind(ns.Kind(10002)).author(ns.PublicKey.parse(recipient_hex)).limit(1),
                    timeout,
                )
                evs = events if isinstance(events, list) else events.to_vec()
                evs = sorted(evs, key=lambda e: e.created_at().as_secs(), reverse=True)
                for ev in evs:
                    if ev.author().to_hex() != recipient_hex or ev.kind().as_u16() != 10002 or not ev.verify():
                        continue
                    for tag in ev.tags().to_vec():
                        vec = tag.as_vec()
                        if vec and vec[0] == "relay" and len(vec) > 1:
                            # NIP-65: relay/perm; perm optional. write/read both acceptable for DM delivery
                            url = vec[1].strip()
                            if url not in found:
                                found.append(url)
                    break
            except Exception as e:
                log.warning("[nostr-dm] 10002 lookup failed: %s", e)
        fallback = self._fallback_relays or DEFAULT_RELAYS
        approved = [*fallback, *self._peer_relays, *_taskify.DISCOVERY_RELAYS]
        discovered = _network.approved_peer_relays(found, approved)
        out = list(dict.fromkeys(discovered + fallback))
        self._inbox_relay_cache[recipient_hex] = out
        self._inbox_cache_ts[recipient_hex] = now
        return out

    # ------------------------------------------------------------------
    # send
    # ------------------------------------------------------------------
    async def send_model_picker(
        self, chat_id, providers, current_model, current_provider, session_key,
        on_model_selected, metadata=None,
    ) -> SendResult:
        """Use Hermes's authenticated provider list; selections re-enter the gateway as /model."""
        if self._groups is not None and chat_id in self._groups.rooms:
            return SendResult(success=False, error="Picker unavailable in group chats.")
        content, options = _taskify.model_listing(
            providers, current_model, current_provider, MAX_MESSAGE_LENGTH,
        )
        if not options:
            return SendResult(success=False, error="No models available.")
        return await self.send(chat_id, content, metadata=metadata, picker=("model", options))

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None, *, picker=None,
                   link_reply: bool = False) -> SendResult:
        # group room chat_id (64-hex sha256, not a pubkey) -> group fanout
        if _groups_mod is not None and self._groups is not None:
            cid = (chat_id or "").strip().lower()
            if (len(cid) == 64 and all(c in "0123456789abcdef" for c in cid)
                    and cid in self._groups.rooms):
                return await self.send_group(cid, content, reply_to=reply_to, metadata=metadata)
        try:
            rp_hex = _normalize_pubkey_hex(chat_id)
            rp = ns.PublicKey.parse(rp_hex)
            sh = self._my_hex
            text = content[:MAX_MESSAGE_LENGTH]
            request = (rp_hex, reply_to)
            request_kind = self._taskify_requests.get(request)
            if picker is None and request_kind == "sessions":
                options = _taskify.session_options(text)
                if options:
                    picker = ("sessions", options)
            tags = []
            if picker:
                tags.append(ns.Tag.parse([_taskify.MENU_TAG, _taskify.VERSION, picker[0]]))
            if (link_reply or picker or request_kind == "action") and reply_to and _taskify.RUMOR_ID.fullmatch(reply_to):
                tags.append(ns.Tag.parse(["e", reply_to]))
            unsigned = (
                ns.EventBuilder.private_msg_rumor(rp, text)
                .tags(tags)
                .custom_created_at(ns.Timestamp.from_secs(int(time.time())))
                .build(ns.PublicKey.parse(sh))
            )
            rumor_id = unsigned.id().to_hex()
            relays = await self._target_relays(rp_hex)
            if picker:
                # Picker state lives in this gateway process. Report immediate delivery so
                # the gateway can fall back to a readable listing if a menu cannot be sent.
                await _publish_recipient_wrap(self._signer, rp_hex, unsigned, relays)
                self._taskify_menus.remember(rp_hex, picker[0], rumor_id, picker[1])
                await self._publish_sender_copy(unsigned)
            else:
                failure = await self._publish_multiple_recipients(unsigned, [rp_hex], {rp_hex: relays})
                if failure:
                    self._taskify_requests.pop(request, None)
                    return SendResult(success=False, message_id=rumor_id, error=failure)
            self._taskify_requests.pop(request, None)
            return SendResult(success=True, message_id=rumor_id)
        except Exception as e:
            log.error("[nostr-dm] send failed: %s", e)
            return SendResult(success=False, error=str(e))

    async def _publish_sender_copy(self, rumor):
        """A failed sender copy does not invalidate confirmed recipient delivery."""
        try:
            relays = self._fallback_relays or DEFAULT_RELAYS
            wrap = await _build_recipient_wrap(self._signer, self._my_hex, rumor, relays)
            result = await self._client.send_event(wrap)
            if not result.success:
                log.warning("[nostr-dm] no relay accepted the sender copy")
        except Exception:
            log.warning("[nostr-dm] could not publish the sender copy")

    async def _publish_multiple_recipients(self, rumor, recipients, routes=None) -> Optional[str]:
        """Persist all recipient copies before sending, then report immediate acknowledgements."""
        if not recipients:
            return "There are no remote recipients for this message"
        routes = dict(routes or {})
        rumor_id = rumor.id().to_hex()
        wraps = []
        for recipient in recipients:
            if recipient not in routes:
                routes[recipient] = await self._target_relays(recipient)
            if await asyncio.to_thread(self._delivery_queue.acknowledged, (rumor_id, recipient)):
                continue
            wrap = await _build_recipient_wrap(self._signer, recipient, rumor, routes[recipient])
            wraps.append((recipient, wrap.as_json()))
        await asyncio.to_thread(self._delivery_queue.enqueue, rumor_id, wraps)
        pending = 0
        for recipient in recipients:
            if not await _attempt_queued_delivery(
                self._delivery_queue, self._signer, (rumor_id, recipient), routes[recipient],
            ):
                pending += 1
        if pending < len(recipients):
            await self._publish_sender_copy(rumor)
        if pending:
            return f"{pending} of {len(recipients)} recipient copies are queued for retry"
        return None

    async def _retry_pending_deliveries(self):
        while True:
            try:
                keys = await asyncio.to_thread(self._delivery_queue.ready)
                for key in keys:
                    relays = await self._target_relays(key[1])
                    await _attempt_queued_delivery(self._delivery_queue, self._signer, key, relays)
            except Exception:
                log.exception("[nostr-dm] delivery retry sweep failed")
            await asyncio.sleep(5)

    async def send_image(self, chat_id: str, image_url: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata=None) -> SendResult:
        # send_image takes a URL: pass it through as a kind-14 text rumor
        # (Taskify renders links); local files go through send_image_file.
        text = (caption + "\n" if caption else "") + image_url
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    # ------------------------------------------------------------------
    # outbound media (kind-15 file messages, Taskify/0xchat-compatible)
    # ------------------------------------------------------------------
    async def _upload_blossom(self, ct: bytes, ct_sha256: str, timeout: int = 120) -> str:
        """PUT raw AES-GCM ciphertext to the Blossom server; returns the blob URL."""
        auth_tags = [["t", "upload"], ["x", ct_sha256],
                     ["expiration", str(int(time.time()) + 86400)]]
        unsigned = (ns.EventBuilder(ns.Kind(24242), "Upload Blob")
                    .tags([ns.Tag.parse(t) for t in auth_tags])
                    .custom_created_at(ns.Timestamp.from_secs(int(time.time()))))
        signed = await unsigned.sign(self._signer)
        auth_event = {
            "id": signed.id().to_hex(),
            "pubkey": self._my_hex,
            "created_at": signed.created_at().as_secs(),
            "kind": signed.kind().as_u16(),
            "tags": [t.as_vec() for t in signed.tags().to_vec()],
            "content": signed.content(),
            "sig": signed.signature(),
        }
        b64 = base64.urlsafe_b64encode(
            json.dumps(auth_event, separators=(",", ":")).encode()).decode().rstrip("=")
        # Use the configured Blossom endpoint without publishing peer-supplied locations.
        proc = await asyncio.to_thread(
            subprocess.run,
            ["curl", "--disable", "--silent", "--show-error", "--fail", "-X", "PUT",
             f"{BLOSSOM_SERVER}/upload", "-H", f"Authorization: Nostr {b64}",
             "-H", "Content-Type: application/octet-stream", "--data-binary", "@-",
             "--max-time", str(timeout)],
            input=ct, capture_output=True, timeout=timeout + 10, check=True,
        )
        resp = proc.stdout
        j = json.loads(resp)
        url = j.get("url") or ""
        srv_hash = (j.get("sha256") or "").lower()
        if srv_hash and srv_hash != ct_sha256:
            raise ValueError(f"blossom hash mismatch: server={srv_hash[:12]} local={ct_sha256[:12]}")
        url.encode("ascii")  # force non-ASCII garbage to fail here, not at wrap time
        return url

    def _record_expiring_blob(self, ct_sha256: str) -> None:
        """Append an uploaded audio blob to the local expiry ledger.

        Blossom offers no client-settable retention: a kind-24242 ``expiration`` tag expires the
        AUTH TOKEN only (BUD-11), server retention is a policy the server merely advertises via
        an optional ``Sunset`` header (BUD-01), and blossom.solife.me does not implement
        ``/list`` (verified 404), so an uploaded voice blob is otherwise unreachable forever.
        ``DELETE /<sha256>`` IS supported (verified 204), so the sweeper replays these hashes.
        Best-effort: a ledger write failure must never fail the send.
        """
        ledger = os.path.join(
            os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")),
            "nostr_audio_blobs.jsonl",
        )
        try:
            os.makedirs(os.path.dirname(ledger), exist_ok=True)
            with open(ledger, "a") as fh:
                fh.write(json.dumps({"sha": ct_sha256, "uploaded": int(time.time())}) + "\n")
        except Exception as e:
            log.warning("[nostr-dm] could not ledger audio blob %s for expiry: %s",
                        ct_sha256[:12], e)

    def _k15_tags(self, path: str, mime: str, key: bytes, iv: bytes,
                  ct_sha256: str, pt_len: int) -> List[List[str]]:
        tags = [
            ["file-type", mime],
            ["encryption-algorithm", "aes-gcm"],
            ["decryption-key", key.hex()],
            ["decryption-nonce", iv.hex()],
            ["x", ct_sha256],
            ["size", str(pt_len)],
            ["filename", os.path.basename(path)],
        ]
        if _is_image_mime(mime):
            try:
                from PIL import Image as _Image
                with _Image.open(path) as im:
                    tags.append(["dim", f"{im.width}x{im.height}"])
            except Exception:
                pass
        return tags

    async def _send_file_msg(self, chat_id: str, path: str, caption: Optional[str],
                             reply_to: Optional[str], group: bool,
                             file_name: Optional[str] = None,
                             expire_after_ttl: bool = False) -> SendResult:
        """Shared kind-15 file-message sender (DM or group fanout)."""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _GCM
        try:
            if group:
                cid = (chat_id or "").strip().lower()
                if self._groups is None or cid not in self._groups.rooms:
                    return SendResult(success=False, error=f"unknown group room {cid[:12]}")
                room = self._groups.rooms[cid]
                members = sorted(set(room["members"]) | {self._my_hex})
            else:
                rp_hex = _normalize_pubkey_hex(chat_id)
                members = [rp_hex]

            with open(path, "rb") as fh:
                pt = fh.read()
            if not pt:
                return SendResult(success=False, error=f"empty file: {os.path.basename(path)}")
            key, iv = os.urandom(32), os.urandom(16)
            ct = _GCM(key).encrypt(iv, pt, None)
            ct_sha = hashlib.sha256(ct).hexdigest()
            url = await self._upload_blossom(ct, ct_sha)
            mime = _mimetype_for(file_name or path)
            fname = file_name or os.path.basename(path)
            # Blossom has no client-requestable retention (the kind-24242 `expiration` tag is
            # only the auth-token TTL), and this server does not implement /list, so an uploaded
            # voice blob is unreachable forever once sent. Only TTS voice replies opt into the
            # expiry ledger: photos, documents and any audio sent as a FILE are left to the
            # server's own retention policy.
            if expire_after_ttl and _is_audio_mime(mime):
                self._record_expiring_blob(ct_sha)
            extra_tags = self._k15_tags(path, mime, key, iv, ct_sha, len(pt))
            extra_tags[6][1] = fname  # honour caller-provided file_name
            if caption:
                extra_tags.extend([["caption", caption], ["alt", caption]])

            tag_list = [["p", m] for m in members] + list(extra_tags)
            subject = (room.get("subject") if group else None)
            if subject:
                tag_list.append(["subject", subject])
            if reply_to:
                tag_list.append(["e", reply_to])
            # generic builder: private_msg_rumor() is hard-wired to kind 14 in
            # nostr-sdk 0.44.8; kind-15 rumors need EventBuilder(Kind(15), ...)
            unsigned = (ns.EventBuilder(ns.Kind(15), url)
                        .tags([ns.Tag.parse(t) for t in tag_list])
                        .custom_created_at(ns.Timestamp.from_secs(int(time.time())))
                        .build(ns.PublicKey.parse(self._my_hex)))
            rumor_id = unsigned.id().to_hex()

            recipients = [member for member in members if member != self._my_hex]
            failure = await self._publish_multiple_recipients(unsigned, recipients)
            if failure:
                return SendResult(success=False, message_id=rumor_id, error=failure)
            if group:
                room["backlog"].add(self._my_hex, "Hermes", f"[file] {fname}",
                                    rumor_id=rumor_id, is_bot=True)
            log.info("[nostr-dm] kind-15 sent: %s -> %s (%d ct bytes, rumor %s)",
                     fname, chat_id[:12], len(ct), rumor_id[:12])
            return SendResult(success=True, message_id=rumor_id)
        except Exception as e:
            log.error("[nostr-dm] kind-15 send failed for %s: %s",
                      os.path.basename(path), e)
            return SendResult(success=False, error=str(e))

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None,
                              metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        mt = _mimetype_for(image_path)
        if _is_image_mime(mt):
            return await self._send_file_msg(chat_id, image_path, caption, reply_to, group=False)
        return await self.send_document(
            chat_id, image_path, caption=caption, reply_to=reply_to, metadata=metadata)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None,
                         metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file_msg(chat_id, video_path, caption, reply_to, group=False)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None,
                         metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        """Voice reply: ship the audio as a Taskify kind-15 encrypted attachment.

        Nostr has no native voice-bubble concept, so a spoken reply is just an audio/*
        file message that Taskify renders with its player. Both gateway auto-TTS paths
        converge here: ``play_tts()`` defaults to ``send_voice()`` (voice input), and the
        runner's ``_deliver_voice_reply()`` calls it directly (``/voice all``).
        """
        is_group = False
        if _groups_mod is not None and self._groups is not None:
            cid = (chat_id or "").strip().lower()
            if (len(cid) == 64 and all(c in "0123456789abcdef" for c in cid)
                    and cid in self._groups.rooms):
                is_group = True
        # expire_after_ttl: TTS voice replies are the ONLY uploads that get swept. Everything
        # else (photos, documents, audio sent as a file) keeps the server's own retention.
        # Ship mp3, not the raw 24 kHz WAV: ~6x smaller on Blossom for no audible loss on speech.
        mp3_path = _to_mp3(audio_path)
        try:
            return await self._send_file_msg(chat_id, mp3_path or audio_path, caption, reply_to,
                                             group=is_group, expire_after_ttl=True)
        finally:
            if mp3_path:
                try:
                    os.unlink(mp3_path)
                    os.rmdir(os.path.dirname(mp3_path))
                except OSError:
                    pass

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return await self._send_file_msg(chat_id, file_path, caption, reply_to, group=False,
                                         file_name=file_name)

    async def send_group(self, room_id: str, content: str, reply_to: Optional[str] = None,
                         metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        """Send a group message: 0xchat-style rumor with ALL members as p-tags
        (Taskify useDmSend convention), gift-wrapped to every member minus self,
        plus a self-wrap. reply_to adds an e-tag to the parent rumor id."""
        try:
            if self._groups is None or room_id not in self._groups.rooms:
                return SendResult(success=False, error=f"unknown group room {room_id[:12]}")
            room = self._groups.rooms[room_id]
            members = sorted(set(room["members"]) | {self._my_hex})
            sh = self._my_hex
            # build rumor tags: p-tags for ALL members (incl. self), e-tag, subject
            # (private_msg_rumor produces kind-14; text_note would be kind-1,
            # which Taskify group UI ignores — root cause of the silent reply bug)
            tag_list: List[List[str]] = [[ "p", m] for m in members]
            if reply_to:
                tag_list.append(["e", reply_to])
            if room.get("subject"):
                tag_list.append(["subject", room["subject"]])
            unsigned = (ns.EventBuilder
                        .private_msg_rumor(ns.PublicKey.parse(members[0] if members[0] != sh else members[1] if len(members) > 1 else sh),
                                           content[:MAX_MESSAGE_LENGTH])
                        .tags([ns.Tag.parse(t) for t in tag_list])
                        .custom_created_at(ns.Timestamp.from_secs(int(time.time())))
                        .build(ns.PublicKey.parse(sh)))
            rumor_id = unsigned.id().to_hex()
            recipients = [member for member in members if member != sh]
            failure = await self._publish_multiple_recipients(unsigned, recipients)
            if failure:
                return SendResult(success=False, message_id=rumor_id, error=failure)
            # record our own reply in the room backlog for context + reply-gating
            room["backlog"].add(sh, "Hermes", content, rumor_id=rumor_id, is_bot=True)
            return SendResult(success=True, message_id=rumor_id)
        except Exception as e:
            log.error("[nostr-dm] group send failed: %s", e)
            return SendResult(success=False, error=str(e))


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------

def check_requirements() -> bool:
    if not NOSTR_SDK_AVAILABLE:
        log.warning("[nostr-dm] nostr-sdk import failed: %s", NOSTR_SDK_VERSION)
        return False
    return True


def _env_enablement() -> Optional[dict]:
    if not os.getenv("NOSTR_DM_NSEC"):
        return None
    return {"enabled": True}


def _standalone_send(pconfig=None, chat_id: str = "", message: str = "", **kwargs) -> dict:
    """Out-of-process cron delivery: open a one-shot client and send."""
    try:
        secret = _get_scoped_secret("NOSTR_DM_NSEC")
        if not secret:
            return {"error": "NOSTR_DM_NSEC not set"}
        keys = _keys_from_secret(secret)
        signer = ns.NostrSigner.keys(keys)
        rp = ns.PublicKey.parse(_normalize_pubkey_hex(chat_id))
        unsigned = ns.EventBuilder.private_msg_rumor(rp, message[:MAX_MESSAGE_LENGTH]) \
            .custom_created_at(ns.Timestamp.from_secs(int(time.time()))) \
            .build(ns.PublicKey.parse(keys.public_key().to_hex()))
        relays_env = _get_scoped_secret("NOSTR_DM_RELAYS") or ",".join(DEFAULT_RELAYS)
        relays = [r.strip() for r in relays_env.split(",") if r.strip()]

        async def deliver():
            queue = await asyncio.to_thread(_outbox_for, keys.public_key().to_hex())
            rumor_id = unsigned.id().to_hex()
            recipient = rp.to_hex()
            wrap = await _build_recipient_wrap(signer, recipient, unsigned, relays)
            await asyncio.to_thread(queue.enqueue, rumor_id, [(recipient, wrap.as_json())])
            if await _attempt_queued_delivery(queue, signer, (rumor_id, recipient), relays):
                return {"success": True, "message_id": rumor_id}
            return {"error": "The message is queued for relay retry", "message_id": rumor_id}

        return asyncio.run(deliver())
    except Exception as e:
        return {"error": f"nostr standalone send failed: {e}"}


def register(ctx) -> None:
    # register the role-policy pre_tool_call hook once (module-level callback
    # receives the authenticated sender and adapter owner from the dispatch context.
    if _role_policy is not None:
        _role_policy.set_hook_registered(False)
        try:
            registered = ctx.register_hook("pre_tool_call", _role_policy._module_level_pre_tool_call)
            if registered is False:
                raise RuntimeError("Hermes rejected the role hook")
        except Exception:
            log.exception("[nostr-dm] role hook registration failed. Restricted senders will be refused.")
        else:
            _role_policy.set_hook_registered(True)
    # Audiobook requests: friends get this ONE narrow tool instead of terminal.
    # It validates the attachment and queues it; a cron worker renders and sends
    # the m4b back as a kind-15 file message (see ~/.hermes/scripts/
    # friend_audiobook_worker.py and the friend-audiobook-requests skill).
    try:
        from .audiobook_requests import register_audiobook_tool
        register_audiobook_tool(ctx)
    except Exception as e:
        log.warning("[nostr-dm] audiobook_request tool not registered: %s", e)
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Nostr (NIP-17 DM)",
        adapter_factory=lambda cfg: NostrDmAdapter(cfg),
        check_fn=check_requirements,
        required_env=["NOSTR_DM_NSEC", "NOSTR_DM_OWNER_NPUB"],
        install_hint="pip install 'nostr-sdk==0.44.8'",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="NOSTR_DM_HOME_CHANNEL",
        allowed_users_env="NOSTR_DM_OWNER_NPUB",
        standalone_sender_fn=_standalone_send,
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="🦩",
        platform_hint=(
            "You are communicating via encrypted Nostr NIP-17 direct messages "
            "(Taskify app). Markdown renders as plain text — keep formatting "
            "simple: plain prose, short lists, no tables. Links are fine. "
            "Keep replies reasonably concise."
        ),
    )