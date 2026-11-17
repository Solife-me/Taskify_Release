"""Owner approval-by-reply for blocked family-role tool calls.

The old page was inert: a gated call was blocked, the owner got a DM with no id and
no way to answer, so every request died whether he replied or not. These tests pin
the contract that replaced it:

  block -> pending request with the (masked) args -> owner /approve <id>
        -> a short-lived grant lets THAT sender use THAT tool on the retry

Run:  venv-python -m pytest tests/test_family_approval.py -q   (from the plugin dir)
  or: venv-python tests/test_family_approval.py               (stdlib unittest)
"""

import importlib.util as _ilu
import json
import os
import shutil
import sys
import tempfile
import unittest

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# policy.py resolves its state files from HERMES_HOME at import — point it at a
# scratch home so nothing here touches the real nostr_roles.json / approvals.
_HOME = tempfile.mkdtemp(prefix="nostr-policy-home-")
os.environ["HERMES_HOME"] = _HOME

NAME = "nostr_dm_policy_under_test"
_SPEC = _ilu.spec_from_file_location(NAME, os.path.join(PLUGIN_DIR, "policy.py"))
policy = _ilu.module_from_spec(_SPEC)
_SPEC.loader.exec_module(policy)

OWNER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
FAMILY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
OTHER = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"


def tearDownModule():
    shutil.rmtree(_HOME, ignore_errors=True)


class ApprovalFlowTest(unittest.TestCase):
    def setUp(self):
        # fresh state per test
        for f in ("nostr_roles.json", "nostr_allowances.json", "nostr_pending_approvals.json"):
            path = os.path.join(_HOME, f)
            if os.path.exists(path):
                os.unlink(path)
        policy._APPROVALS_STORE = None
        policy._ALLOWANCES = None
        policy._STORE = None
        policy._store().set(FAMILY, "family")
        # a live adapter normally supplies the sender's latest message text; tests
        # that do not care get a fixed one so pages/resume have something to carry
        self._saved = (policy.APPROVALS._prompt_fn, policy.APPROVALS.resume_approval,
                       policy.APPROVALS.notify_actor)
        policy.APPROVALS._prompt_fn = lambda actor: "please convert this audio to m4b"
        policy._resumed = []
        policy.APPROVALS.resume_approval = lambda rec: policy._resumed.append(rec) or True

    def tearDown(self):
        (policy.APPROVALS._prompt_fn, policy.APPROVALS.resume_approval,
         policy.APPROVALS.notify_actor) = self._saved

    def _gate(self, actor, tool, args=None, conversation=""):
        token = policy.set_actor(actor, owner=OWNER, conversation=conversation or actor)
        try:
            return policy._module_level_pre_tool_call(tool, args, task_id="t", session_id="s")
        finally:
            policy.reset_actor(token)

    def _owner_says(self, text):
        return policy.parse_approval_command(text, OWNER, OWNER)

    # -- the block ---------------------------------------------------------
    def test_blocked_call_creates_a_request_with_masked_args(self):
        verdict = self._gate(FAMILY, "terminal", {"command": "rm -rf /tmp/x", "api_key": "sk-live-123"})
        self.assertEqual(verdict["action"], "block")
        self.assertIn("request", verdict["message"])
        reqs = policy._approval_store().pending()
        self.assertEqual(len(reqs), 1)
        self.assertEqual(reqs[0]["tool"], "terminal")
        self.assertEqual(reqs[0]["actor"], FAMILY)
        self.assertIn("rm -rf /tmp/x", reqs[0]["args"])
        self.assertNotIn("sk-live-123", reqs[0]["args"], "credentials must be masked on the page")

    def test_request_id_appears_in_the_page_for_the_owner(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        page = policy._approval_dm_text(policy._approval_store().pending()[0])
        self.assertIn(rid, page)
        self.assertIn(f"/approve {rid}", page)
        self.assertIn("ls", page)

    # -- approve -----------------------------------------------------------
    def test_owner_approval_lets_the_retry_through(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        reply = self._owner_says(f"/approve {rid}")
        self.assertIn("Approved", reply)
        self.assertIsNone(self._gate(FAMILY, "terminal", {"command": "ls"}),
                          "the approved sender must get through on the retry")

    def test_approval_is_scoped_to_the_sender_and_the_tool(self):
        policy._store().set(OTHER, "family")  # a second family user
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        self._owner_says(f"/approve {rid}")
        self.assertEqual(self._gate(OTHER, "terminal", {"command": "ls"})["action"], "block",
                         "one family member's approval must not cover another")
        self.assertEqual(self._gate(FAMILY, "execute_code", {"code": "1"})["action"], "block",
                         "approval covers the approved tool only")

    def test_approval_rejects_changed_args_and_conversation(self):
        original = {"command": "ls", "env": {"mode": "read"}}
        self._gate(FAMILY, "terminal", original, conversation="chat-a")
        rec = policy._approval_store().pending()[0]
        self.assertIn('"mode": "read"', self._owner_says(f"/pending {rec['id']}"))
        self._owner_says(f"/approve {rec['id']}")
        self.assertIsNotNone(self._gate(FAMILY, "terminal", original, conversation="chat-b"))
        self.assertIsNotNone(self._gate(FAMILY, "terminal", {"command": "ls", "env": {"mode": "changed"}},
                                        conversation="chat-a"))
        self.assertIsNone(self._gate(FAMILY, "terminal", {"env": {"mode": "read"}, "command": "ls"},
                                     conversation="chat-a"))

    def test_approval_burns_after_its_use_budget(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        self._owner_says(f"/approve {rid}")
        self.assertIsNone(self._gate(FAMILY, "terminal", {"command": "ls"}))
        self.assertEqual(self._gate(FAMILY, "terminal", {"command": "ls"})["action"], "block")

    def test_expired_approval_no_longer_grants(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        self._owner_says(f"/approve {rid}")
        path = policy.PENDING_FILE
        data = json.load(open(path))
        for g in data["grants"]:
            g["expires_at"] = 1
        json.dump(data, open(path, "w"))
        self.assertEqual(self._gate(FAMILY, "terminal", {"command": "ls"})["action"], "block")

    def test_revoke_cancels_a_live_approval(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        self._owner_says(f"/approve {rid}")
        self.assertIn("Revoked 1", self._owner_says("/approve revoke terminal"))
        self.assertEqual(self._gate(FAMILY, "terminal", {"command": "ls"})["action"], "block")

    # -- deny / ignore -----------------------------------------------------
    def test_deny_keeps_it_blocked_and_closes_the_request(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        self.assertIn("Denied", self._owner_says(f"/deny {rid}"))
        self.assertEqual(policy._approval_store().pending(), [])
        self.assertEqual(self._gate(FAMILY, "terminal", {"command": "ls"})["action"], "block")

    def test_ignoring_a_request_changes_nothing(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        self.assertEqual(self._gate(FAMILY, "terminal", {"command": "ls"})["action"], "block",
                         "a request nobody answered must not silently authorize anything")

    # -- owner-only + chat safety -----------------------------------------
    def test_non_owner_bare_yes_is_left_to_the_agent(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        self.assertIsNone(policy.parse_approval_command("yes", FAMILY, OWNER),
                          "a family member's 'yes' must reach the agent, not the gate")

    def test_non_owner_cannot_approve(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        reply = policy.parse_approval_command(f"/approve {rid}", FAMILY, OWNER)
        self.assertIn("owner-only", reply)
        self.assertEqual(len(policy._approval_store().pending()), 1, "request stays open")

    def test_bare_yes_requires_explicit_request_id(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        self.assertIn("/approve <id>", policy.parse_approval_command("yes", OWNER, OWNER))
        self.assertEqual(policy._approval_store().grants(), [])

    def test_bare_yes_is_ordinary_chat_when_nothing_is_pending(self):
        self.assertIsNone(policy.parse_approval_command("yes", OWNER, OWNER))
        self.assertIsNone(policy.parse_approval_command("no thanks", OWNER, OWNER))

    def test_two_open_requests_require_an_id(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        self._gate(FAMILY, "write_file", {"path": "/tmp/y"})
        reply = policy.parse_approval_command("approve", OWNER, OWNER)
        self.assertIn("/approve <id>", reply)

    # -- untouched paths ---------------------------------------------------
    def test_standing_allowance_still_skips_the_page(self):
        policy._allowances().set(FAMILY, "terminal", granted=True)
        self.assertIsNone(self._gate(FAMILY, "terminal", {"command": "ls"}))
        self.assertEqual(policy._approval_store().pending(), [])

    # -- auto-resume -------------------------------------------------------
    def test_request_records_what_was_asked(self):
        self._gate(FAMILY, "terminal", {"command": "ffmpeg -i in.mp3 out.m4b"})
        rec = policy._approval_store().pending()[0]
        self.assertEqual(rec["prompt"], "please convert this audio to m4b")
        self.assertIn("Asked:", policy._approval_dm_text(rec))

    def test_approve_resumes_the_request_instead_of_waiting_for_a_retry(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        reply = self._owner_says(f"/approve {rid}")
        self.assertEqual(len(policy._resumed), 1, "an approval must hand the work back to run")
        self.assertEqual(policy._resumed[0]["prompt"], "please convert this audio to m4b")
        self.assertIn("Retrying the request", reply)

    def test_approve_without_a_resumable_prompt_tells_her_to_ask_again(self):
        policy.APPROVALS.resume_approval = lambda rec: False
        sent = []
        policy.APPROVALS.notify_actor = lambda actor, text: sent.append((actor, text))
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        reply = self._owner_says(f"/approve {rid}")
        self.assertEqual(sent and sent[0][0], FAMILY)
        self.assertIn("requester can retry", reply)

    def test_deny_never_resumes(self):
        self._gate(FAMILY, "terminal", {"command": "ls"})
        rid = policy._approval_store().pending()[0]["id"]
        self._owner_says(f"/deny {rid}")
        self.assertEqual(policy._resumed, [])

    def test_ungated_tools_still_pass(self):
        self.assertIsNone(self._gate(FAMILY, "web_search", {"query": "x"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
