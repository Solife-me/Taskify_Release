"""NIP-17 group chat support for the nostr-dm adapter.

Room identity (Taskify/0xchat interoperable):
  room_id = sha256(",".join(sorted(set(all_members)))) hex, where all_members
  = sender + every recipient p-tag, lowercased, deduped (Taskify
  useDmState.generateGroupId — byte-compatible with Taskify group threads).

Group classification (Taskify useDmSubscription):
  a rumor is a group message when >= 2 recipient p-tags accompany the sender
  (Taskify senders include themselves in p-tags, so >= 3 p-tags total).

Trigger gate: mention + reply-to-bot only. The bot sees
every message (backlog) but dispatches to the agent only when addressed.

Context: per-room ring buffer; rendered backlog is prepended to the dispatched
turn inside the user message (never the system prompt).

Pure logic — no nostr_sdk import — so it unit-tests standalone.
"""

from __future__ import annotations

import hashlib
import re
from collections import deque
from typing import Dict, List, Optional, Set

# Taskify's MAX_GROUP_MEMBERS = 17 (useDmState.ts)
MAX_GROUP_MEMBERS = 17

# Backlog sizes
BACKLOG_MAXLEN = 40
CONTEXT_MSG_CAP = 12
CONTEXT_CHAR_CAP = 2000
OLD_LINE_TRUNCATE = 80


def normalize_hex(v: str) -> str:
    """Lowercase trim; strip 0x / leading 02|03 compression prefixes the way
    Taskify's normalizeDmPeerHex does (it slices the last 64 chars)."""
    v = (v or "").strip().lower()
    if not v:
        return ""
    if v.startswith("0x") and len(v) == 66:
        v = v[2:]
    if len(v) == 66 and v[:2] in ("02", "03") and all(c in "0123456789abcdef" for c in v):
        v = v[2:]
    return v


def room_id_for(sender_hex: str, p_tag_hexes: List[str]) -> str:
    """Taskify-compatible group id: sha256 of sorted unique member list joined
    by commas. Members = sender + ALL p-tags (0xchat: Taskify group sends
    include the sender AND every member — including us the bot — among
    p-tags; verified live 2026-08-31)."""
    members = {normalize_hex(sender_hex)} | {normalize_hex(r) for r in p_tag_hexes if r}
    members.discard("")
    payload = ",".join(sorted(members)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def is_group_rumor(sender_hex: str, recipient_p_hexes: List[str]) -> bool:
    """Group test over the FULL 0xchat member set: members = p-tags + sender;
    group when 2+ members accompany the sender (bot + 1 other human, or 2 other
    humans — matches Taskify's `recipients.length >= 2`, where their senders
    include themselves among p-tags). A 1:1 DM has p-tags = {bot} only → 1
    non-sender member → DM."""
    members = {normalize_hex(sender_hex)} | {normalize_hex(r) for r in recipient_p_hexes if normalize_hex(r)}
    members.discard("")
    others = members - {normalize_hex(sender_hex)}
    return len(others) >= 2


def room_members(sender_hex: str, recipient_hexes: List[str]) -> List[str]:
    """Canonical sorted member list of the room (sender included)."""
    members = {normalize_hex(sender_hex)} | {normalize_hex(r) for r in recipient_hexes if r}
    members.discard("")
    return sorted(members)


class Backlog:
    """Per-room conversation memory (adapter-side, ephemeral)."""

    def __init__(self, maxlen: int = BACKLOG_MAXLEN):
        self._lines: deque = deque(maxlen=maxlen)
        self._bot_rumor_ids: Set[str] = set()

    def add(self, sender_hex: str, sender_name: str, content: str, rumor_id: str = "",
            is_bot: bool = False) -> None:
        self._lines.append({
            "sender": normalize_hex(sender_hex),
            "name": sender_name or f"…{(sender_hex or '')[-8:]}",
            "content": content or "",
            "rumor_id": rumor_id or "",
            "is_bot": bool(is_bot),
        })
        if is_bot and rumor_id:
            self._bot_rumor_ids.add(rumor_id)

    def is_reply_to_bot(self, e_tag_ids: List[str]) -> bool:
        return any(eid in self._bot_rumor_ids for eid in e_tag_ids if eid)

    def render(self, self_name: str = "Hermes", cap_msgs: int = CONTEXT_MSG_CAP,
               cap_chars: int = CONTEXT_CHAR_CAP) -> str:
        """Render the recent conversation for context injection.

        Last cap_msgs lines; lines older than the newest 10 are truncated to
        OLD_LINE_TRUNCATE chars. Hard cap at cap_chars total — the OLDEST
        lines are dropped first when over budget (newest context matters).
        """
        if not self._lines:
            return ""
        lines = list(self._lines)[-cap_msgs:]
        newest_ten_start = max(0, len(lines) - 10)
        rendered: List[str] = []
        for i, entry in enumerate(lines):
            name = self_name if entry["is_bot"] else entry["name"]
            text = entry["content"].replace("\n", " ").strip()
            if i < newest_ten_start and len(text) > OLD_LINE_TRUNCATE:
                text = text[:OLD_LINE_TRUNCATE] + "…"
            rendered.append(f"[{name}]: {text}")
        # char budget: drop oldest lines until under cap (keep at least the
        # last 2 lines regardless — a trigger usually references those)
        out = "\n".join(rendered)
        while len(out) > cap_chars and len(rendered) > 2:
            rendered.pop(0)
            out = "\n".join(rendered)
        if len(out) > cap_chars:
            out = out[-cap_chars:]
        return out

    def __len__(self) -> int:
        return len(self._lines)


class MentionGate:
    """Trigger gate: dispatch only on explicit address (mention or reply-to-bot).
    Mention matching: full npub, 8+ char hex prefix (e.g. 12-hex tail a client
    shows), or the bot display name with word boundaries."""

    def __init__(self, self_hex: str, self_npub: str = "", display_name: str = "Hermes"):
        self.self_hex = normalize_hex(self_hex)
        self.self_npub = (self_npub or "").strip()
        self.display_name = (display_name or "Hermes").strip()

    def _mention_in(self, content: str) -> bool:
        lowered = (content or "").lower()
        if not lowered:
            return False
        if self.self_npub and self.self_npub.lower() in lowered:
            return True
        if self.self_hex and len(self.self_hex) >= 8:
            # any 8+ char chunk of the hex appearing contiguously
            for width in (64, 32, 16, 12, 8):
                probe = self.self_hex[:width]
                if len(probe) >= 8 and probe in lowered:
                    return True
        if self.display_name:
            pattern = rf"(?<!\w)@?{re.escape(self.display_name.lower())}(?!\w)"
            if re.search(pattern, lowered):
                return True
        return False

    @staticmethod
    def strip_leading_mention(content: str, display_name: str = "") -> str:
        """Remove a leading @Name / “Name,” mention so slash commands still work.
        Only strips when the leading token IS an addressing form (@Name or
        Name: / Name ,) — plain sentences are untouched."""
        text = (content or "").strip()
        name = (display_name or "Hermes").strip()
        if not name:
            return text
        # @Name ...  |  Name, ...  |  Name: ...
        pat = rf"^@?{re.escape(name)}(?=\s*[,:])?\s*[,:@]?\s*"
        m = re.match(rf"^@{re.escape(name)}\b\s*", text, re.I)
        if m:
            return text[m.end():]
        m = re.match(rf"^{re.escape(name)}\b\s*[,:]\s*", text, re.I)
        if m:
            return text[m.end():]
        return text

    def should_dispatch(self, content: str, e_tag_ids: List[str], backlog: Backlog) -> bool:
        if self._mention_in(content):
            return True
        if e_tag_ids and backlog.is_reply_to_bot(e_tag_ids):
            return True
        return False


class GroupState:
    """All group rooms the bot has seen since boot."""

    def __init__(self, self_hex: str, self_npub: str = "", display_name: str = "Hermes"):
        self.self_hex = normalize_hex(self_hex)
        self.rooms: Dict[str, dict] = {}
        self.gate = MentionGate(self_hex, self_npub, display_name)

    def classify(self, sender_hex: str, recipient_p_hexes: List[str]) -> Optional[str]:
        """Room id when this rumor is a group message, else None (DM path)."""
        others = [normalize_hex(r) for r in recipient_p_hexes if normalize_hex(r)]
        if not is_group_rumor(sender_hex, others):
            return None
        rid = room_id_for(sender_hex, others)
        members = room_members(sender_hex, others)
        room = self.rooms.setdefault(rid, {
            "members": members, "subject": "", "backlog": Backlog(),
        })
        # refresh members if the spec-consistent set grew (same id => same set,
        # but keep canonical sorted order)
        room["members"] = members
        return rid

    def record_bot_reply(self, room_id: str, rumor_id: str, content: str) -> None:
        room = self.rooms.get(room_id)
        if room:
            room["backlog"].add(self.self_hex, "Hermes", content, rumor_id=rumor_id, is_bot=True)