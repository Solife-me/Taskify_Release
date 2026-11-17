"""Unit tests for the nostr-dm bot-to-bot loop guard (loop_guard.py).

Run:  venv-python -m pytest tests/test_loop_guard.py -q   (from the plugin dir)
Stdlib + pytest only; a fake clock drives every timing assertion.
"""

import os
import sys
import threading
import time
import types
import unittest

import importlib.util as _ilu
_SPEC = _ilu.spec_from_file_location(
    "nostr_dm_loop_guard",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "loop_guard.py"),
)
_mod = _ilu.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_mod)
LoopGuard = _mod.LoopGuard
parse_settings = _mod.parse_settings


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s


class TestParseSettings(unittest.TestCase):
    def test_defaults(self):
        s = parse_settings({})
        assert s == {"enabled": True, "max_events": 10, "window_sec": 60, "cooldown_sec": 60}
        assert parse_settings(None) == s

    def test_overrides(self):
        s = parse_settings({"loop_guard": "off", "loop_max_events": "3",
                            "loop_window_sec": 30, "loop_cooldown_sec": "120"})
        assert s == {"enabled": False, "max_events": 3, "window_sec": 30, "cooldown_sec": 120}

    def test_malformed_values_fall_back_to_defaults(self):
        s = parse_settings({"loop_max_events": "banana", "loop_window_sec": None,
                            "loop_cooldown_sec": [1]})
        assert s["max_events"] == 10 and s["window_sec"] == 60 and s["cooldown_sec"] == 60

    def test_disabled_forms(self):
        for v in ("0", "false", "no", "off"):
            assert parse_settings({"loop_guard": v})["enabled"] is False
        for v in ("1", "true", "yes", "on", "anything-else"):
            assert parse_settings({"loop_guard": v})["enabled"] is True


class TestLoopGuardBudget(unittest.TestCase):
    def _guard(self, max_events=3, window=60, cooldown=60):
        clock = FakeClock()
        g = LoopGuard(max_events=max_events, window_sec=window,
                      cooldown_sec=cooldown, clock=clock)
        return g, clock

    def test_fills_budget_then_cooldowns(self):
        g, _ = self._guard(max_events=3)
        for _ in range(3):
            allowed, entered, _ = g.check("roomA")
            assert allowed and not entered
        allowed, entered, reason = g.check("roomA")
        assert not allowed and entered and "cooldown" in reason
        # still suppressed inside cooldown, without re-entering it
        allowed, entered, _ = g.check("roomA")
        assert not allowed and not entered

    def test_cooldown_expires_and_budget_resets(self):
        g, clock = self._guard(max_events=2, cooldown=60)
        g.check("k"); g.check("k")
        assert not g.check("k")[0]
        clock.advance(61)  # cooldown over; window also empty (60s window)
        allowed, entered, _ = g.check("k")
        assert allowed and not entered

    def test_windows_slide(self):
        g, clock = self._guard(max_events=3, window=60)
        g.check("k")
        clock.advance(30); g.check("k")
        clock.advance(31)  # first event aged out of the window
        allowed, entered, _ = g.check("k")
        assert allowed and not entered

    def test_keys_are_independent(self):
        g, _ = self._guard(max_events=2)
        g.check("dm1"); g.check("dm1")
        assert not g.check("dm1")[0]
        allowed, _, _ = g.check("dm2")
        assert allowed

    def test_owner_always_allowed_and_not_recorded(self):
        g, clock = self._guard(max_events=2, cooldown=60)
        g.check("k"); g.check("k")
        assert not g.check("k")[0]  # budget exhausted
        for _ in range(5):
            allowed, entered, _ = g.check("k", is_owner=True)
            assert allowed and not entered
        clock.advance(10)  # still mid-cooldown
        assert g.check("k", is_owner=True)[0]
        # owner traffic left no events: after cooldown the budget is still full
        clock.advance(51)
        allowed, entered, _ = g.check("k")
        assert allowed and not entered

    def test_disabled_guard_allows_everything(self):
        g, _ = self._guard()
        g.enabled = False
        for _ in range(50):
            assert g.check("k")[0]

    def test_max_events_below_one_disables(self):
        g, _ = self._guard()
        g2 = LoopGuard(max_events=0)
        assert g2.enabled is False and g2.check("k")[0]

    def test_thread_safety_smoke(self):
        g, _ = self._guard(max_events=1000)
        errs = []
        def worker():
            try:
                for _ in range(200):
                    g.check("shared")
            except Exception as e:  # pragma: no cover
                errs.append(e)
        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads: t.start()
        for t in threads: t.join()
        assert not errs

    def test_real_clock_construction(self):
        g = LoopGuard()  # default clock == time.time, enabled defaults
        assert g.enabled and g.max_events == 10
        allowed, entered, _ = g.check("selftest")
        assert allowed and not entered


if __name__ == "__main__":
    unittest.main()