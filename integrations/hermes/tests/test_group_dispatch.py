"""Group-room (@Hermes) dispatch pieces that do not need relays.

Covers the two halves of "mention Hermes in a group and get an answer":
  1. the trigger gate — only an address (mention or reply-to-bot) dispatches, and the
     leading "@Hermes" is stripped so the turn sees a clean request;
  2. reply routing — a room id reaching ``send()`` must fan out through
     ``send_group`` (a room id is a 64-hex sha256, not a pubkey: the DM path would
     wrap it as a recipient and deliver nowhere).

Run:  venv-python -m pytest tests/test_group_dispatch.py -q   (from the plugin dir)
  or: venv-python tests/test_group_dispatch.py               (stdlib unittest)
"""

import asyncio
import importlib.util as _ilu
import os
import sys
import unittest

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERMES_AGENT = os.environ.get(
    "HERMES_AGENT_DIR", os.path.join(os.path.expanduser("~"), ".hermes", "hermes-agent")
)
if HERMES_AGENT not in sys.path:
    sys.path.insert(0, HERMES_AGENT)

OWNER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
FAMILY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
BOT = "b" * 64


def _load(name):
    spec = _ilu.spec_from_file_location(name, os.path.join(PLUGIN_DIR, f"{name.split('_')[-1]}.py"))
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


groups = _load("nostr_dm_groups")

_SPEC = _ilu.spec_from_file_location(
    "nostr_dm_adapter_under_test", os.path.join(PLUGIN_DIR, "adapter.py")
)
adapter_mod = _ilu.module_from_spec(_SPEC)
_SPEC.loader.exec_module(adapter_mod)


class MentionGateTest(unittest.TestCase):
    def setUp(self):
        self.gate = groups.MentionGate(BOT, "npub1botkey", "Hermes")
        self.backlog = groups.Backlog()

    def test_at_hermes_dispatches(self):
        self.assertTrue(self.gate.should_dispatch("@Hermes can you add milk to the list?", [], self.backlog))

    def test_bare_name_dispatches(self):
        self.assertTrue(self.gate.should_dispatch("hermes, what's on the calendar?", [], self.backlog))

    def test_npub_mention_dispatches(self):
        self.assertTrue(self.gate.should_dispatch("npub1botkey what's up", [], self.backlog))

    def test_unaddressed_chatter_is_backlog_only(self):
        self.assertFalse(self.gate.should_dispatch("we should get milk", [], self.backlog))

    def test_reply_to_bot_dispatches(self):
        self.backlog.add(BOT, "Hermes", "Anything else?", rumor_id="bot-1", is_bot=True)
        self.assertTrue(self.gate.should_dispatch("no thanks", ["bot-1"], self.backlog))

    def test_leading_mention_is_stripped(self):
        self.assertEqual(
            self.gate.strip_leading_mention("@Hermes add milk"), "add milk")
        self.assertEqual(
            self.gate.strip_leading_mention("Hermes: add milk"), "add milk")

    def test_room_id_is_member_hash(self):
        """3-person room (family sender + owner + bot) classifies, and Taskify agrees on the id."""
        rid = groups.room_id_for(FAMILY, [FAMILY, OWNER, BOT])
        self.assertEqual(len(rid), 64)
        self.assertEqual(rid, groups.room_id_for(FAMILY, [BOT, FAMILY, OWNER]), "order-independent")
        self.assertTrue(groups.is_group_rumor(FAMILY, [FAMILY, OWNER, BOT]))
        self.assertFalse(groups.is_group_rumor(FAMILY, [BOT]), "a 1:1 DM must not classify as a room")


class GroupReplyRoutingTest(unittest.TestCase):
    def test_room_id_send_routes_to_send_group(self):
        adapter = object.__new__(adapter_mod.NostrDmAdapter)
        adapter._groups = groups.GroupState(BOT)
        room_id = adapter._groups.classify(FAMILY, [FAMILY, OWNER, BOT])
        calls = []

        async def _fake_send_group(chat_id, content, reply_to=None, metadata=None):
            calls.append((chat_id, content))
            return adapter_mod.SendResult(success=True, message_id="x")

        adapter.send_group = _fake_send_group
        result = asyncio.run(adapter.send(room_id, "on it"))
        self.assertTrue(result.success)
        self.assertEqual(calls, [(room_id, "on it")], "group replies must fan out, not DM-wrap the room id")


if __name__ == "__main__":
    unittest.main(verbosity=2)
