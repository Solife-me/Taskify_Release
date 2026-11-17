"""Bot-to-bot loop guard for the nostr-dm adapter.

The gateway's Telegram bot-loop guard (#79077) exists because "mentions"
admission re-arms the peer every turn: two bots replying to each other never
terminate (observed 132 messages in one group before a human intervened).
This adapter has the same trigger shape (mention + reply-to-bot), and its
existing defenses stop only REPLAYED events — the rumor-id dedupe claim and
the freshness gate — not a live back-and-forth between authorized senders.

Per-conversation sliding window, mirroring the gateway guard's shape and
OpenClaw reference defaults, sized down for Nostr volume:

  key     room id (groups) or sender hex (DMs)
  budget  10 dispatches / 60 s window -> 60 s cooldown; owner always exempt

One owner notification per cooldown transition (via the existing
approval-proxy DM channel); suppressed messages during cooldown stay silent.

Settings come from config.yaml platforms.nostr.extra (no new HERMES_* env
vars): loop_guard (on/off), loop_max_events, loop_window_sec,
loop_cooldown_sec. In allow-all dev mode there is no owner, so every sender
is budgeted — exactly the configuration that needs the brake.

Pure logic — no nostr_sdk import — unit-tests standalone (tests/).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable, Deque, Dict, Optional, Tuple

DEFAULT_MAX_EVENTS = 10
DEFAULT_WINDOW_SEC = 60
DEFAULT_COOLDOWN_SEC = 60

_TRUTHY = ("1", "true", "yes", "on")
_FALSY = ("0", "false", "no", "off")


def parse_settings(extra: Optional[dict]) -> Dict[str, object]:
    """Guard settings from the adapter's config.yaml extra mapping.

    Defaults: enabled, 10 events / 60 s window / 60 s cooldown.
    Malformed values fall back to the default rather than raising — a bad
    config.yaml key must never take the adapter down.
    """
    extra = extra or {}
    enabled = str(extra.get("loop_guard", "true")).strip().lower() not in _FALSY

    def _int(key: str, default: int) -> int:
        try:
            return int(str(extra.get(key, default)).strip())
        except (TypeError, ValueError):
            return default

    return {
        "enabled": enabled,
        "max_events": _int("loop_max_events", DEFAULT_MAX_EVENTS),
        "window_sec": _int("loop_window_sec", DEFAULT_WINDOW_SEC),
        "cooldown_sec": _int("loop_cooldown_sec", DEFAULT_COOLDOWN_SEC),
    }


class LoopGuard:
    """Per-conversation sliding-window dispatch budget with cooldown."""

    def __init__(
        self,
        enabled: bool = True,
        max_events: int = DEFAULT_MAX_EVENTS,
        window_sec: int = DEFAULT_WINDOW_SEC,
        cooldown_sec: int = DEFAULT_COOLDOWN_SEC,
        clock: Callable[[], float] = time.time,
    ):
        self.enabled = bool(enabled) and max_events >= 1
        self.max_events = max_events
        self.window_sec = window_sec
        self.cooldown_sec = cooldown_sec
        self._clock = clock
        self._events: Dict[str, Deque[float]] = {}
        self._cooldown_until: Dict[str, float] = {}
        self._lock = threading.Lock()

    def check(self, key: str, is_owner: bool = False) -> Tuple[bool, bool, str]:
        """Admission decision for one dispatch.

        Returns (allowed, entered_cooldown, reason). Owner traffic is always
        allowed and never recorded — the owner's messages must never stall,
        even mid-cooldown for a loop the owner is not part of.
        """
        if not self.enabled:
            return True, False, ""
        if is_owner:
            return True, False, ""
        now = self._clock()
        with self._lock:
            until = self._cooldown_until.get(key, 0.0)
            if now < until:
                return False, False, f"cooldown active ({int(until - now)}s left)"
            events = self._events.setdefault(key, deque())
            cutoff = now - self.window_sec
            while events and events[0] < cutoff:
                events.popleft()
            if len(events) >= self.max_events:
                self._cooldown_until[key] = now + self.cooldown_sec
                events.clear()
                return False, True, (
                    f"{self.max_events} dispatches in {self.window_sec}s "
                    f"-> cooldown {self.cooldown_sec}s"
                )
            events.append(now)
            return True, False, ""