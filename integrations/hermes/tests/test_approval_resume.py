"""Verify approved operations resume only in the original conversation."""

import asyncio
import importlib.util as _ilu
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERMES_AGENT = os.environ.get(
    "HERMES_AGENT_DIR", os.path.join(os.path.expanduser("~"), ".hermes", "hermes-agent")
)
if HERMES_AGENT not in sys.path:
    sys.path.insert(0, HERMES_AGENT)

FAMILY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
OWNER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
BOT = "b" * 64


def _load(name, filename):
    spec = _ilu.spec_from_file_location(name, os.path.join(PLUGIN_DIR, filename))
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


groups = _load("nostr_dm_groups_resume", "groups.py")
adapter_mod = _load("nostr_dm_adapter_resume", "adapter.py")
policy = adapter_mod._role_policy


class ResumeTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="nostr-resume-state-")
        self.addCleanup(directory.cleanup)
        policy._APPROVALS_STORE = policy.ApprovalStore(os.path.join(directory.name, "approvals.json"))
        policy._STORE = policy.RoleStore(os.path.join(directory.name, "roles.json"))
        policy._STORE.set(FAMILY, "family")
        policy.set_hook_registered(True)
        self.adapter = object.__new__(adapter_mod.NostrDmAdapter)
        self.adapter._configured_owner = OWNER
        self.adapter._roles = policy._STORE
        self.adapter.build_source = lambda **fields: SimpleNamespace(**fields)
        self.adapter._loop_guard = None
        self.adapter._groups = groups.GroupState(BOT)
        self.events = []

        async def _capture(event):
            self.events.append((event, policy.get_actor()))

        self.adapter.handle_message = _capture

    def _rec(self, prompt="please turn this recording into an m4b", room_id=""):
        store = policy._approval_store()
        rec = store.create(
            FAMILY, "terminal", args={"command": "test"}, prompt=prompt,
            room_id=room_id, conversation=room_id or FAMILY,
        )
        return store.decide(rec["id"], True)[0]

    def test_resume_dispatches_in_the_senders_dm(self):
        asyncio.run(self.adapter._resume_family_request(self._rec()))
        self.assertEqual(len(self.events), 1)
        event, actor_during_turn = self.events[0]
        self.assertEqual(event.source.chat_id, FAMILY)
        self.assertEqual(event.source.chat_type, "dm")
        self.assertEqual(event.source.user_id, FAMILY)
        self.assertIn("please turn this recording into an m4b", event.text)
        self.assertIn("Owner approved one exact", event.text)
        self.assertEqual(actor_during_turn, FAMILY, "the gate must see the requester as the acting user")

    def test_resume_goes_back_to_the_room_it_came_from(self):
        room_id = self.adapter._groups.classify(FAMILY, [FAMILY, OWNER, BOT])
        asyncio.run(self.adapter._resume_family_request(self._rec(room_id=room_id)))
        event, _actor = self.events[0]
        self.assertEqual(event.source.chat_id, room_id)
        self.assertEqual(event.source.chat_type, "group",
                         "an approval from a room must answer in that room")

    def test_unknown_room_cannot_resume_into_a_dm(self):
        asyncio.run(self.adapter._resume_family_request(self._rec(room_id="c" * 64)))
        self.assertEqual(self.events, [])

    def test_no_prompt_means_no_resume(self):
        asyncio.run(self.adapter._resume_family_request(self._rec(prompt="")))
        self.assertEqual(self.events, [])

    def test_resume_describes_the_exact_one_use_grant(self):
        asyncio.run(self.adapter._resume_family_request(self._rec()))
        text = self.events[0][0].text
        self.assertIn("'terminal'", text)
        self.assertIn("one exact", text)

    def test_unapproved_record_does_not_resume(self):
        asyncio.run(self.adapter._resume_family_request({
            "id": "missing", "actor": FAMILY, "prompt": "a request", "room_id": "",
        }))
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
