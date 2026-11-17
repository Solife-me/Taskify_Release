"""Per-user role policy for the nostr-dm adapter.

Roles (stored in ~/.hermes/nostr_roles.json, managed via owner DM commands):
  owner  — full access (the configured owner key). Manages roles.
  family — trusted household member: same main agent, can read anything,
           but state-changing tools are blocked with a notification DM to
           the owner (approve-by-proxy: the owner acts on the request).
  friend — isolated assistant: chat + web-search/extract ONLY. No terminal,
           no file access, no Nextcloud, no memory/cron/skills/delegation.

Tool enforcement runs in a plugin pre_tool_call hook. The acting user's
pubkey is resolved at message-dispatch time (adapter) into a ContextVar,
which asyncio.to_thread propagates into the tool-call thread where hooks run.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import logging
import os
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Dict, Optional

log = logging.getLogger(__name__)

ROLES_DIR = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
ROLES_FILE = os.path.join(ROLES_DIR, "nostr_roles.json")

ROLES = ("owner", "family", "friend")

# Per-user tool allowances: granted with `/role allow <npub> <tool>` by the
# owner. A family user with an allowance for a gated tool gets to use it
# WITHOUT the owner-approval handshake (owner pre-approval by explicit grant).
# Everything else in FAMILY_APPROVAL_REQUIRED still needs an approval request.
ALLOWANCE_FILE = os.path.join(ROLES_DIR, "nostr_allowances.json")

# Bind the acting sender and this adapter's explicit owner to the same turn.
_actor_context: ContextVar[tuple[Optional[str], Optional[str], str]] = ContextVar(
    "nostr_actor_context", default=(None, None, "")
)


def set_actor(hex_pk: Optional[str], *, owner: Optional[str] = None, conversation: str = "") -> object:
    return _actor_context.set((hex_pk, owner, conversation))


def reset_actor(token) -> None:
    _actor_context.reset(token)


def get_actor() -> Optional[str]:
    return _actor_context.get()[0]


def restricted_role(hex_pk: Optional[str]) -> Optional[str]:
    """The stored restricted role of a pubkey, or None (owner/unknown)."""
    if not hex_pk:
        return None
    return _store().get(hex_pk)


class RoleStoreUnavailable(RuntimeError):
    """Role assignments could not be read reliably."""


class RoleStore:
    """JSON-backed pubkey-to-role map with atomic writes."""

    def __init__(self, path: str = ROLES_FILE):
        self.path = path
        self._cache: Dict[str, str] = {}
        self._version = None
        self._lock = threading.Lock()

    def _load(self) -> None:
        try:
            stat = os.stat(self.path)
        except FileNotFoundError as exc:
            if self._version is not None:
                raise RoleStoreUnavailable("The role file disappeared") from exc
            return
        except OSError as exc:
            raise RoleStoreUnavailable("The role file is unavailable") from exc
        version = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        if version == self._version:
            return
        try:
            with open(self.path) as file:
                data = json.load(file)
            if not isinstance(data, dict) or any(
                not re.fullmatch(r"[0-9a-fA-F]{64}", key) or role not in ("family", "friend")
                for key, role in data.items()
            ):
                raise ValueError("Invalid role assignments")
        except (ValueError, OSError) as exc:
            raise RoleStoreUnavailable("The role file could not be read") from exc
        self._cache = {key.lower(): role for key, role in data.items()}
        self._version = version

    def get(self, hex_pk: str) -> Optional[str]:
        with self._lock:
            self._load()
            return self._cache.get(hex_pk.strip().lower())

    def all_non_owner(self) -> Dict[str, str]:
        with self._lock:
            self._load()
            return dict(self._cache)

    def set(self, hex_pk: str, role: str) -> bool:
        hex_pk = hex_pk.strip().lower()
        if role not in ROLES or not re.fullmatch(r"[0-9a-f]{64}", hex_pk):
            return False
        with self._lock:
            self._load()
            data = dict(self._cache)
            if role == "owner":
                data.pop(hex_pk, None)
            else:
                data[hex_pk] = role
            parent = os.path.dirname(self.path) or "."
            with tempfile.NamedTemporaryFile(mode="w", dir=parent, prefix=".nostr-roles-", delete=False) as tmp:
                try:
                    json.dump(data, tmp, indent=1)
                    tmp.close()
                    os.replace(tmp.name, self.path)
                finally:
                    if os.path.exists(tmp.name):
                        os.unlink(tmp.name)
            self._load()
        return True

    def remove(self, hex_pk: str) -> bool:
        return self.set(hex_pk, "owner")  # remove the restricted assignment


class Allowances:
    """JSON-backed per-user tool allowances: {pubkey_hex: [tool, ...]}.
    Granted by the owner with `/role allow <npub> <tool>`; revoked with
    `/role deny <npub> <tool>`. Same mtime-checked re-read as RoleStore."""

    def __init__(self, path: str = ALLOWANCE_FILE):
        self.path = path
        self._cache: Dict[str, set] = {}
        self._mtime: float = -1.0
        self._lock = threading.Lock()

    def _load(self) -> None:
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            self._cache, self._mtime = {}, -1.0
            return
        if mtime == self._mtime:
            return
        try:
            with open(self.path) as f:
                raw = json.load(f)
            allow = {}
            for pk, tools in (raw or {}).items():
                pk = str(pk).strip().lower()
                if pk and isinstance(tools, list):
                    names = {str(t).strip().lower() for t in tools if str(t).strip()}
                    if names:
                        allow[pk] = names
            self._cache, self._mtime = allow, mtime
        except Exception:
            pass  # keep last-good cache on parse error

    def has(self, hex_pk: str, tool_name: str) -> bool:
        with self._lock:
            self._load()
            return tool_name.lower() in self._cache.get(hex_pk.strip().lower(), ())

    def all(self) -> Dict[str, set]:
        with self._lock:
            self._load()
            return {pk: set(t) for pk, t in self._cache.items()}

    def set(self, hex_pk: str, tool_name: str, granted: bool) -> bool:
        hex_pk = hex_pk.strip().lower()
        tool_name = tool_name.strip().lower()
        if not hex_pk or not tool_name:
            return False
        with self._lock:
            self._load()
            data = {}
            try:
                with open(self.path) as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}
            hex_pk = hex_pk.strip().lower()
            tool_name = tool_name.strip().lower()
            tools = set(data.get(hex_pk) or [])
            if granted:
                tools.add(tool_name)
            else:
                tools.discard(tool_name)
            if tools:
                data[hex_pk] = sorted(tools)
            else:
                data.pop(hex_pk, None)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, indent=1)
            os.replace(tmp, self.path)
            self._mtime = -1.0
            self._load()
        return True


_ALLOWANCES: Optional[Allowances] = None


def _allowances() -> Allowances:
    global _ALLOWANCES
    if _ALLOWANCES is None:
        _ALLOWANCES = Allowances()
    return _ALLOWANCES


# ---------------------------------------------------------------------------
# owner approvals for blocked family-role tool calls
#
# A family sender's gated call is blocked, and the owner is paged. Before this
# store existed the page was inert: nothing could be approved, so every gated
# request died whether the owner answered or not. A page now carries a request
# id plus WHAT was attempted, the owner answers /approve <id> or /deny <id> from
# the same DM, and an approval mints a short-lived grant that lets that one
# tool through for that one sender on the retry.
# ---------------------------------------------------------------------------

PENDING_FILE = os.path.join(ROLES_DIR, "nostr_pending_approvals.json")

# A bare DM word (no slash) answers an open request — but only while one IS open,
# so an ordinary "yes"/"no" in conversation is never swallowed.
_APPROVE_WORDS = {"approve", "approved", "yes", "ok", "allow"}
_DENY_WORDS = {"deny", "denied", "no", "ignore", "decline", "reject", "refuse"}

APPROVAL_TTL_SEC = 900     # an approval stays usable this long after the decision
APPROVAL_MAX_USES = 1
_PENDING_KEEP = 40         # decided requests retained for context (newest win)

# Args are summarised for the owner's page, never dumped raw: anything keyed like
# a credential is masked before it leaves the process.
_SECRET_KEY_HINTS = (
    "password", "passwd", "secret", "token", "nsec", "private", "api_key",
    "apikey", "credential", "card", "cvc", "otp", "recovery",
)


def _operation(actor, tool, args, conversation):
    """Return a digest of the exact JSON call and a review copy with credential fields masked."""
    def mask(value):
        if isinstance(value, dict):
            return {
                key: "[redacted]" if any(hint in str(key).lower() for hint in _SECRET_KEY_HINTS) else mask(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [mask(item) for item in value]
        return value

    args = {} if args is None else args
    if not isinstance(args, dict):
        raise ValueError("Expected a tool argument object")
    canonical = json.dumps([actor, tool, conversation, args], sort_keys=True,
                           ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    review = json.dumps(mask(args), sort_keys=True, ensure_ascii=True)
    if len(review) > 40_000:
        raise ValueError("This operation is too large to review in one message")
    return hashlib.sha256(canonical.encode()).hexdigest(), review


class ApprovalStore:
    """Pending approvals + the short-lived grants they mint (one small JSON file)."""

    def __init__(self, path: str = PENDING_FILE):
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> dict:
        try:
            with open(self.path) as file:
                raw = json.load(file)
        except FileNotFoundError:
            return {"seq": 0, "requests": [], "grants": []}
        if not isinstance(raw, dict):
            raise ValueError("Invalid approval state")
        return {
            "seq": int(raw.get("seq") or 0),
            "requests": [r for r in (raw.get("requests") or []) if isinstance(r, dict)],
            "grants": [g for g in (raw.get("grants") or []) if isinstance(g, dict)],
        }

    @contextmanager
    def _transaction(self):
        parent = os.path.dirname(self.path) or "."
        os.makedirs(parent, exist_ok=True)
        with self._lock:
            fd = os.open(self.path + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                yield

    def _write(self, data: dict) -> None:
        parent = os.path.dirname(self.path) or "."
        with tempfile.NamedTemporaryFile(mode="w", dir=parent, prefix=".nostr-approval-", delete=False) as tmp:
            try:
                json.dump(data, tmp, indent=1)
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp.close()
                os.replace(tmp.name, self.path)
            finally:
                if os.path.exists(tmp.name):
                    os.unlink(tmp.name)

    @staticmethod
    def _prune(data: dict, now: float) -> None:
        data["requests"] = [
            r for r in data["requests"]
            if r.get("status") == "pending"
            or now - float(r.get("decided_at") or r.get("created_at") or 0) < 86400
        ][-_PENDING_KEEP:]
        data["grants"] = [
            g for g in data["grants"]
            if float(g.get("expires_at") or 0) > now and int(g.get("remaining") or 0) > 0
        ]

    def create(self, actor: str, tool: str, action: str = "", args=None,
               room_id: str = "", prompt: str = "", conversation: str = "") -> dict:
        now = time.time()
        actor = actor.strip().lower()
        if not actor or not conversation:
            raise ValueError("The sender and conversation must be known")
        fingerprint, review = _operation(actor, tool, args, conversation)
        with self._transaction():
            data = self._read()
            self._prune(data, now)
            data["seq"] = int(data.get("seq") or 0) + 1
            rec = {
                "id": f"{data['seq']:04x}",
                "actor": (actor or "").strip().lower(),
                "tool": tool,
                "action": action,
                "args": review,
                "operation": fingerprint,
                "conversation": conversation,
                "prompt": (prompt or "").strip()[:2000],
                "room_id": room_id or "",
                "created_at": now,
                "decided_at": 0,
                "status": "pending",
            }
            data["requests"].append(rec)
            self._write(data)
            return rec

    def pending(self) -> list:
        with self._transaction():
            data = self._read()
            return [r for r in data["requests"] if r.get("status") == "pending"]

    def find(self, request_id: str) -> Optional[dict]:
        rid = (request_id or "").strip().lower().lstrip("#")
        with self._transaction():
            for r in self._read()["requests"]:
                if r.get("id") == rid and r.get("status") == "pending":
                    return dict(r)
        return None

    def decide(self, request_id: str, approve: bool, minutes: Optional[float] = None):
        """(request, grant|None): mark the request and mint a grant when approved."""
        now = time.time()
        if minutes is not None and (not math.isfinite(minutes) or not 0 < minutes <= 1440):
            raise ValueError("Approval duration must be between 0 and 1440 minutes")
        ttl = APPROVAL_TTL_SEC if minutes is None else max(1.0, minutes * 60)
        rid = (request_id or "").strip().lower().lstrip("#")
        with self._transaction():
            data = self._read()
            rec = next((r for r in data["requests"]
                        if r.get("id") == rid and r.get("status") == "pending"), None)
            if rec is None:
                return None, None
            if approve and not (rec.get("operation") and rec.get("conversation")):
                raise ValueError("This older request needs to be submitted again for exact review")
            rec["status"] = "approved" if approve else "denied"
            rec["decided_at"] = now
            grant = None
            if approve:
                grant = {
                    "id": rec["id"],
                    "actor": rec.get("actor", ""),
                    "tool": rec.get("tool", ""),
                    "expires_at": now + ttl,
                    "operation": rec["operation"],
                    "remaining": APPROVAL_MAX_USES,
                }
                data["grants"].append(grant)
            self._prune(data, now)
            self._write(data)
            return dict(rec), (dict(grant) if grant else None)

    def consume(self, actor: str, tool: str, args, conversation: str) -> Optional[str]:
        """Consume one exact grant only when its persisted removal succeeds."""
        who = (actor or "").strip().lower()
        if not who or not conversation:
            return None
        fingerprint, _ = _operation(who, tool, args, conversation)
        now = time.time()
        with self._transaction():
            data = self._read()
            grant = next((g for g in data["grants"]
                          if g.get("actor") == who and g.get("tool") == tool
                          and g.get("operation") == fingerprint
                          and float(g.get("expires_at") or 0) > now
                          and int(g.get("remaining") or 0) > 0), None)
            if grant is None:
                return None
            grant["remaining"] = int(grant["remaining"]) - 1
            self._write(data)
            return str(grant.get("id") or "")

    def grants(self) -> list:
        now = time.time()
        with self._transaction():
            return [
                g for g in self._read()["grants"]
                if g.get("operation") and int(g.get("remaining") or 0) > 0
                and float(g.get("expires_at") or 0) > now
            ]

    def revoke(self, actor: str = "", tool: str = "") -> int:
        now = time.time()
        with self._transaction():
            data = self._read()
            keep, dropped = [], 0
            for g in data["grants"]:
                hit = ((not actor or g.get("actor") == actor.strip().lower())
                       and (not tool or g.get("tool") == tool.strip().lower()))
                if hit and float(g.get("expires_at") or 0) > now:
                    dropped += 1
                else:
                    keep.append(g)
            data["grants"] = keep
            self._write(data)
            return dropped


_APPROVALS_STORE: Optional[ApprovalStore] = None


def _approval_store() -> ApprovalStore:
    global _APPROVALS_STORE
    if _APPROVALS_STORE is None:
        _APPROVALS_STORE = ApprovalStore()
    return _APPROVALS_STORE


def _actor_label(actor: str) -> str:
    """Same shape /role uses (leading 12 + trailing 8) so the owner can match a page."""
    actor = (actor or "").strip()
    if not actor or actor == "unknown":
        return "unknown sender"
    return f"{actor[:12]}…{actor[-8:]}"


def _approval_dm_text(rec: dict) -> str:
    """The page the owner gets: what was attempted, by whom, and how to answer."""
    who = _actor_label(rec.get("actor", ""))
    lines = [
        f"🔔 Approval request {rec['id']} — family user {who}",
        f"Tool: {rec['tool']} ({rec.get('action') or rec['tool']})",
    ]
    if rec.get("args"):
        lines.append(f"What: {rec['args']}")
    if rec.get("prompt"):
        asked = rec["prompt"].replace("\n", " ")
        lines.append(f"Asked: {asked[:300]}{'…' if len(asked) > 300 else ''}")
    if rec.get("room_id"):
        lines.append(f"Where: group room {rec['room_id'][:12]}…")
    lines.append(
        f"Reply /approve {rec['id']} to allow these exact arguments once in this chat "
        f"for {int(APPROVAL_TTL_SEC / 60)} min, or /deny {rec['id']}. Redacted values stay bound."
    )
    return "\n".join(lines)


def _family_verdict(actor: str, tool_name: str, args=None, task_id: str = "",
                    session_id: str = "") -> Optional[dict]:
    """None when a family-role call may proceed, else the pre_tool_call block dict.

    Proceeds on a standing `/role allow` allowance or a live owner approval;
    otherwise creates a pending request, pages the owner and blocks.
    """
    if tool_name not in FAMILY_APPROVAL_REQUIRED:
        return None
    room_id = APPROVALS._resolve_room(task_id, session_id) or ""
    conversation = _actor_context.get()[2] or room_id
    try:
        try:
            from gateway.session_context import get_session_env
        except ImportError:
            pass
        else:
            if get_session_env("HERMES_SESSION_PLATFORM") == "nostr":
                conversation = get_session_env("HERMES_SESSION_CHAT_ID") or conversation
        if not conversation:
            raise ValueError("Approval conversation is unknown")
        if conversation != actor:
            room_id = conversation
        if _allowances().has(actor, tool_name):
            return None
        if _approval_store().consume(actor, tool_name, args, conversation):
            return None
        rec = _approval_store().create(
            actor, tool_name, action=_DISPLAY.get(tool_name, "use " + tool_name),
            args=args, room_id=room_id, prompt=APPROVALS.last_prompt(actor), conversation=conversation,
        )
    except (OSError, ValueError, TypeError) as exc:
        log.warning("[nostr-dm] approval state unavailable: %s", type(exc).__name__)
        return {"action": "block", "message": "This operation could not be submitted for approval."}
    APPROVALS.notify_owner(_approval_dm_text(rec), task_id=task_id, session_id=session_id)
    return {"action": "block", "message": f"This exact operation needs owner approval (request {rec['id']})."}


# Tools a `friend` may use. Everything else is blocked outright.
FRIEND_ALLOWED = {
    "web_search",
    "web_extract",
    # Queueing an attached ebook for narration. Deliberately a purpose-built
    # tool, not terminal: it validates the file and drops it in a queue, and a
    # separate cron worker does the rendering. Never widen this to terminal.
    "audiobook_request",
}

# Tools a `family` member may use freely (read/browse only).
# Anything NOT in this set and NOT below is allowed (misc safe tools) —
# the gate list is specifically state-changing / resource-heavy surfaces.
FAMILY_APPROVAL_REQUIRED = {
    "terminal",        # installs, deletes, anything on the VM
    "execute_code",
    "write_file",
    "patch",
    "cronjob",         # scheduled jobs = persistent side effects
    "memory",          # memory pollution guard
    "skill_manage",
    "delegate_task",   # spawns subagents (resources)
}

_DISPLAY = {
    "terminal": "run terminal commands",
    "execute_code": "execute code on the machine",
    "write_file": "write files",
    "patch": "edit files",
    "cronjob": "schedule jobs",
    "memory": "change saved memories",
    "skill_manage": "install/remove skills",
    "delegate_task": "spawn subagents",
}


def resolve_role(actor: Optional[str], owner: Optional[str]) -> Optional[str]:
    if not actor:
        return None
    if actor == owner:
        return "owner"
    try:
        return restricted_role(actor)
    except RoleStoreUnavailable:
        return None


def family_slash_allowed(content: str) -> bool:
    """Keep gateway commands that mutate state out of the family tool-policy bypass path."""
    match = re.match(r"^/([a-z0-9_-]+)(?:@[^\s/]+)?(?:\s|$)", content.strip(), re.IGNORECASE)
    if match is None:
        return True
    if match[1].lower() in {"help", "commands", "whoami", "status", "usage"}:
        return True
    return content.strip().lower() in {"/model", "/sessions"}


_STORE: Optional[RoleStore] = None


def _store() -> RoleStore:
    global _STORE
    if _STORE is None:
        _STORE = RoleStore()
    return _STORE


class ApprovalProxy:
    """Bridge: pre_tool_call (agent thread) -> adapter loop -> owner DM.
    Group-aware: when the blocked action arrives from a group session
    (session key tail = room id present in the adapter's group state),
    the approval request also posts IN the group, addressed to the owner,
    so other members see why the bot is pausing."""

    def __init__(self):
        self._loop = None
        self._sender_fn = None       # async fn(chat_id, text); set by the adapter
        self._owner_fn = None        # zero-arg callable returning owner hex (or None)
        self._group_known_fn = None  # fn(room_id) -> room|None (room classifier)
        self._group_fn = None        # async fn(room_id, text); group posting
        self._group_lookup = None    # set by bind(); None = "no room known"
        self._prompt_fn = None       # fn(actor) -> the sender's latest message text
        self._resume_fn = None       # async fn(request_rec) -> continue the blocked turn

    def bind(self, loop, sender_fn, owner_fn, group_fn=None, group_lookup=None,
             prompt_fn=None, resume_fn=None) -> None:
        self._loop = loop
        self._sender_fn = sender_fn
        self._owner_fn = owner_fn
        self._group_fn = group_fn
        self._group_lookup = group_lookup or (lambda rid: True if group_fn else None)
        self._prompt_fn = prompt_fn
        self._resume_fn = resume_fn

    def _resolve_room(self, task_id: str, session_id: str) -> Optional[str]:
        """Group room id from the session key tail, if this dispatch is a group
        session (room ids and pubkeys are both 64-hex; distinguish by checking
        the adapter's known rooms)."""
        for sid in (session_id, task_id):
            tail = str(sid or "").rstrip().split(":")[-1].strip().lower()
            if len(tail) == 64 and all(c in "0123456789abcdef" for c in tail):
                lookup = self._group_lookup
                room = lookup(tail) if lookup else None
                if room:
                    return tail
        return None

    def notify_owner(self, text: str, task_id: str = "", session_id: str = "") -> None:
        try:
            owner_hex = self._owner_fn() if self._owner_fn else None
        except Exception:
            owner_hex = None
        if not (self._loop and self._sender_fn and owner_hex):
            return
        import asyncio

        async def _deliver():
            await self._sender_fn(owner_hex, text)
            # group echo: "Owner, do you approve ..." visible to members
            room_id = self._resolve_room(task_id, session_id)
            if room_id and self._group_fn:
                short = text.splitlines()[0] if text else str(text)
                member_ask = (
                    f"\u23f3 Waiting on approval: {short}\n"
                    "Owner, do you approve this? (You can also tell me in DM.)"
                )
                await self._group_fn(room_id, member_ask[:4000])

        try:
            fut = asyncio.run_coroutine_threadsafe(_deliver(), self._loop)
            # don't block the agent thread on delivery; best-effort
            fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        except Exception:
            pass

    def last_prompt(self, actor_hex: str) -> str:
        """The sender's most recent message text, so a page can show WHAT was asked."""
        if not self._prompt_fn:
            return ""
        try:
            return str(self._prompt_fn(actor_hex) or "")
        except Exception:
            return ""

    def resume_approval(self, rec: dict) -> bool:
        """True when the approved request was handed back to run as the sender's turn.

        The gate ended the original turn, so nothing is queued anywhere: an approval
        has to re-enter the conversation for the work to actually happen. False when
        there is no live adapter/loop or no captured request text (then the caller
        falls back to telling the sender to ask again).
        """
        if not (self._loop and self._resume_fn) or not (rec or {}).get("prompt"):
            return False
        import asyncio

        try:
            fut = asyncio.run_coroutine_threadsafe(self._resume_fn(dict(rec)), self._loop)
            fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
            return True
        except Exception as e:
            log.warning("[nostr-dm] could not resume approved request: %s", e)
            return False

    def notify_actor(self, actor_hex: str, text: str) -> None:
        """DM the requester — e.g. 'the owner approved request ab12, ask again'."""
        if not (self._loop and self._sender_fn and actor_hex):
            return
        import asyncio

        async def _deliver():
            await self._sender_fn(actor_hex, text)

        try:
            fut = asyncio.run_coroutine_threadsafe(_deliver(), self._loop)
            fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        except Exception:
            pass


APPROVALS = ApprovalProxy()

_HOOK_REGISTERED = False


def set_hook_registered(registered: bool):
    global _HOOK_REGISTERED
    _HOOK_REGISTERED = registered


def hook_registered() -> bool:
    return _HOOK_REGISTERED


def _nostr_tool_actor(task_id, session_id, platform):
    actor = get_actor()
    ids = [str(value or "") for value in (session_id, task_id)]
    is_nostr = platform in ("nostr", "nostr-friend") or any(
        "nostr" in value.split(":") or value.startswith("friend-lane-") for value in ids
    )
    try:
        from gateway.session_context import get_session_env
        current_platform = get_session_env("HERMES_SESSION_PLATFORM")
        if current_platform in ("nostr", "nostr-friend"):
            source_actor = get_session_env("HERMES_SESSION_ACTOR_ID") or get_session_env("HERMES_SESSION_USER_ID")
            return source_actor or actor, True
    except ImportError:
        pass
    if actor:
        return actor, True
    # Without a gateway actor or propagated ContextVar, a session key is not
    # enough to prove who initiated this tool call, especially in shared rooms.
    return None, is_nostr


FAMILY_UNATTENDED_TOOLS = {"read_file", "search_files", "web_search", "web_extract"}


def _module_level_pre_tool_call(tool_name: str, args=None, task_id="", session_id="", **kw):
    platform = kw.get("platform") or kw.get("session_platform")
    actor, is_nostr = _nostr_tool_actor(task_id, session_id, getattr(platform, "value", platform))
    if not is_nostr:
        return None
    role = resolve_role(actor, _actor_context.get()[1])
    if role == "owner":
        return None
    if role == "friend" and tool_name in FRIEND_ALLOWED:
        return None
    if role == "family":
        if tool_name in FAMILY_UNATTENDED_TOOLS:
            return None
        if tool_name in FAMILY_APPROVAL_REQUIRED:
            return _family_verdict(actor, tool_name, args, task_id=task_id, session_id=session_id)
    return {"action": "block", "message": "This tool is not available to the current Nostr sender."}


# ---------------------------------------------------------------------------
# friend lane: isolated, memoryless, web-only side agent
# ---------------------------------------------------------------------------

FRIEND_PLATFORM_HINT = (
    "You are a friendly assistant talking with a friend of the owner over an "
    "encrypted Nostr DM. You are a SHARED assistant, not the owner's personal agent. "
    "You have NO access to the owner's files, notes, accounts, or machines. Never "
    "pretend otherwise, never reference the owner's private information (you have "
    "none), and keep answers concise and friendly. You can search the web and "
    "read public web pages."
)


def run_friend_turn(text: str, sender_hex: str) -> str:
    """Run a fully isolated one-shot agent for a friend-role sender.

    Isolation properties: skip_memory=True (no MEMORY.md/USER.md blocks in the
    system prompt), no Honcho provider, only web toolsets enabled, fresh
    non-persistent session id, own conversation history (empty).
    The gateway process imports run_agent fine (it constructs AIAgent itself).
    """
    try:
        import run_agent as _ra

        agent = _ra.AIAgent(
            skip_memory=True,
            skip_context_files=True,
            platform="nostr-friend",
            session_id=f"friend-lane-{sender_hex[:16]}",
            quiet_mode=True,
            # Whitelist ONLY the web toolset (verified: resolves to exactly
            # web_search + web_extract). Do NOT pass disabled_toolsets here —
            # the 'browser' toolset includes web_search, so disabling it
            # strips the very tools we want.
            enabled_toolsets=["web"],
        )
        # Belt-and-suspenders: even if a toolset name drifts in a future
        # version, the pre_tool_call hook still blocks anything not
        # web_search/web_extract for friend-role senders.
        result = agent.chat(text) if hasattr(agent, "chat") else ""
        return (result or "").strip() or "(no reply)"
    except Exception as e:
        log.warning("[nostr-dm] friend lane error: %s", e)
        return "Sorry — I couldn't process that right now."


# ---------------------------------------------------------------------------
# /role commands (owner-only, parsed by the adapter before agent dispatch)
# ---------------------------------------------------------------------------

def parse_role_command(text: str, sender_hex: str, owner_hex: Optional[str]) -> Optional[str]:
    """Return a reply string if this text is a /role command for the owner;
    None if it's not a role command. Non-owners get told permission denied."""
    t = text.strip()
    if not t or t.split(maxsplit=1)[0].lower() != "/role":
        return None
    if not owner_hex or sender_hex != owner_hex:
        return "Role commands are owner-only."
    parts = t.split()
    store = _store()
    if len(parts) == 1:
        entries = store.all_non_owner()
        if not entries:
            return ("No restricted users configured. Usage:\n"
                    "/role family <npub>\n/role friend <npub>\n"
                    "/role allow <npub> <tool>\n/role deny <npub> <tool>\n"
                    "/role remove <npub>")
        lines = [f"{r}: {pk[:12]}…{pk[-8:]}" for pk, r in sorted(entries.items(), key=lambda kv: kv[1])]
        reply = "Current roles:\n" + "\n".join(lines)
        allow = _allowances().all()
        if allow:
            alines = [f"{pk[:12]}…: {', '.join(sorted(t))}" for pk, t in sorted(allow.items())]
            reply += "\nTool allowances:\n" + "\n".join(alines)
        return reply
    sub = parts[1].lower()
    if sub in ("family", "friend") and len(parts) >= 3:
        target = _norm_hex(parts[2])
        if not target:
            return f"Could not parse npub/hex: {parts[2]}"
        store.set(target, sub)
        label = "trusted family (reads anything; state-changing actions blocked + owner notified)" if sub == "family" else "friend (chat + web only, isolated)"
        return f"Done — {parts[2][:16]}… is now role '{sub}' ({label})."
    if sub == "allow" and len(parts) >= 4:
        target = _norm_hex(parts[2])
        tool = parts[3].lower().strip()
        if not target:
            return f"Could not parse npub/hex: {parts[2]}"
        if tool not in FAMILY_APPROVAL_REQUIRED:
            return (f"'{tool}' is not a gated tool. Allowable tools: "
                    + ", ".join(sorted(FAMILY_APPROVAL_REQUIRED)))
        _allowances().set(target, tool, granted=True)
        return (f"Done — {target[:12]}… may now use '{tool}' freely. "
                f"Revoke with /role deny <npub> {tool}")
    if sub == "deny" and len(parts) >= 4:
        target = _norm_hex(parts[2])
        tool = parts[3].lower().strip()
        if not target:
            return f"Could not parse npub/hex: {parts[2]}"
        _allowances().set(target, tool, granted=False)
        return f"Done — '{tool}' allowance removed for {target[:12]}…"
    if sub == "remove" and len(parts) >= 3:
        target = _norm_hex(parts[2])
        store.remove(target)
        return f"Removed role for {parts[2][:16]}… (back to owner-grade or unauthorized)."
    return (
        "Usage:\n"
        "/role — list restricted users\n"
        "/role family <npub> — trusted: full read access, state-changing tools generate an approval DM to you\n"
        "/role friend <npub> — isolated chat: web + conversation only\n"
        "/role allow <npub> <tool> — let a family user use a gated tool without approval requests\n"
        f"  (gated tools: {', '.join(sorted(FAMILY_APPROVAL_REQUIRED))})\n"
        "/role deny <npub> <tool> — revoke a tool allowance\n"
        "/role remove <npub>"
    )


def parse_approval_command(text: str, sender_hex: str, owner_hex: Optional[str]) -> Optional[str]:
    """Owner-facing answer surface for blocked family-role calls.

    ``/pending``            open requests
    ``/approve <id> [min]`` allow the reviewed operation once (default 15 min)
    ``/deny <id>``          refuse it — and ignoring a request is the same as denying
    ``/approve revoke``     cancel live approvals now (optional tool filter)
    A positive decision requires an explicit request ID.

    Returns the reply to send back, or None when this is not an approval command
    (or a bare word with nothing pending — ordinary chat must not be swallowed).
    """
    t = (text or "").strip()
    if not t:
        return None
    low = t.lower()
    parts = low.split()
    store = _approval_store()
    slash = parts[0] in ("/approve", "/deny", "/pending", "/ignore", "/approvals")
    bare = None
    if not slash:
        if len(parts) <= 3 and parts[0] in _APPROVE_WORDS | _DENY_WORDS:
            bare = parts[0]
            if not store.pending():
                return None  # ordinary "yes"/"no" in a chat with nothing pending
        else:
            return None
    is_owner = bool(owner_hex) and _norm_hex(sender_hex) == _norm_hex(owner_hex)
    if not is_owner:
        # A non-owner's "yes"/"no" is ordinary chat and must reach the agent; only an
        # explicit /approve or /deny from them earns the refusal.
        return None if bare else "Approvals are owner-only."

    if parts[0] in ("/pending", "/approvals"):
        try:
            if len(parts) > 1:
                request = store.find(parts[1])
                return _approval_dm_text(request) if request else "No matching pending approval."
            open_reqs = store.pending()
        except (OSError, ValueError):
            return "Approval storage is unavailable."
        if not open_reqs:
            return "No approval requests pending."
        lines = []
        for r in open_reqs:
            lines.append(f"{r['id']} — {_actor_label(r.get('actor', ''))}: {r['tool']}"
                         + (f" ({r['args'][:120]}…)" if r.get("args") else ""))
        return "Pending approvals:\n" + "\n".join(lines) + "\nUse /pending <id> to review the complete operation."

    # /approve revoke [tool]
    if parts[0] in ("/approve", "/ignore") and len(parts) >= 2 and parts[1] in ("revoke", "clear", "cancel"):
        tool = parts[2] if len(parts) >= 3 else ""
        dropped = store.revoke(tool=tool)
        return (f"Revoked {dropped} live approval(s)"
                + (f" for '{tool}'" if tool else "") + ".")

    want_approve = parts[0] == "/approve" if slash else bare in _APPROVE_WORDS

    # resolve the target request: explicit id, or the single open one
    target = ""
    minutes: Optional[float] = None
    if len(parts) >= 2 and parts[1] not in ("revoke", "clear", "cancel"):
        target = parts[1].lstrip("#")
        if len(parts) >= 3:
            try:
                minutes = float(parts[2].rstrip("m"))
            except ValueError:
                minutes = None
    if want_approve and not target:
        return "Use /pending to find the request and reply /approve <id> after reviewing it."
    if not target:
        open_reqs = store.pending()
        if len(open_reqs) == 1:
            target = open_reqs[0]["id"]
        elif not open_reqs:
            return "No approval requests pending."
        else:
            return ("More than one request is open — say /approve <id>:\n"
                    + "\n".join(f"{r['id']} — {r['tool']}" for r in open_reqs))

    try:
        rec, grant = store.decide(target, want_approve, minutes=minutes)
    except ValueError as exc:
        return str(exc)
    except OSError:
        return "Approval storage is unavailable. The operation is still blocked."
    if rec is None:
        return f"No open request {target}. /pending lists them."

    if not want_approve:
        return (f"Denied {rec['id']} — '{rec['tool']}' stays blocked for "
                f"{_actor_label(rec.get('actor', ''))}. Nothing happens unless they ask again.")

    resumed = APPROVALS.resume_approval(rec)
    if not resumed and rec.get("actor"):
        APPROVALS.notify_actor(rec["actor"], "The owner approved the exact operation once. Try again.")
    status = "retrying the request" if resumed else "the requester can retry"
    return f"Approved {rec['id']} once for the exact operation. {status.capitalize()}."


def _norm_hex(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    try:
        import nostr_sdk as _ns  # local import: policy must import without sdk too
        return _normalize_pubkey_hex_ns(v, _ns)
    except Exception:
        return v.strip().lower()


def _normalize_pubkey_hex_ns(v: str, ns) -> str:
    try:
        return ns.PublicKey.parse(v.strip()).to_hex()
    except Exception:
        return v.strip().lower()