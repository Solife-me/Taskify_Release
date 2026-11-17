"""Role-assigned senders must survive the gateway's admission re-check.

Regression: the pump admits a `/role family` sender and dispatches, then the
gateway's native admission re-check refused it with
``permission_denied (user_not_authorized)`` because it only knew the flat
``NOSTR_DM_OWNER_NPUB`` allowlist — The owner's DMs worked. The family sender's DMs (DM or ``@Hermes``
in a group room) came back as an error.

These tests drive the REAL core gate (``gateway.authz_mixin.GatewayAuthorizationMixin``)
against the real adapter method, so what they assert is "this core version unions
``resolved_allowlist_user_ids()`` into the allowlist verdict" — not a copy of the
plugin's intent.

Run:  venv-python -m pytest tests/test_gateway_admission.py -q   (from the plugin dir)
  or: venv-python tests/test_gateway_admission.py               (stdlib unittest)
"""

import importlib.util as _ilu
import json
import os
import sys
import tempfile
import types
import unittest

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERMES_AGENT = os.environ.get(
    "HERMES_AGENT_DIR", os.path.join(os.path.expanduser("~"), ".hermes", "hermes-agent")
)
if HERMES_AGENT not in sys.path:
    sys.path.insert(0, HERMES_AGENT)

from gateway.authz_mixin import GatewayAuthorizationMixin  # noqa: E402
from gateway.config import Platform  # noqa: E402
from gateway.session import SessionSource  # noqa: E402

OWNER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
FAMILY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
FRIEND = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
STRANGER = "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13"
ROOM = "a" * 64

_SPEC = _ilu.spec_from_file_location(
    "nostr_dm_adapter_under_test", os.path.join(PLUGIN_DIR, "adapter.py")
)
adapter_mod = _ilu.module_from_spec(_SPEC)
_SPEC.loader.exec_module(adapter_mod)


class _Runner(GatewayAuthorizationMixin):
    """Minimal stand-in for GatewayRunner that still runs the real authz mixin."""

    def __init__(self, platform, live_adapter):
        self.adapters = {platform: live_adapter}
        self._profile_adapters = {}
        self.config = types.SimpleNamespace(multiplex_profiles=False)
        self.pairing_stores = {}
        self.pairing_store = None

    def _active_profile_name(self):
        return "default"


def _source(platform, user_id, chat_id=None, chat_type="dm"):
    """A real SessionSource: the gate reads its transport/relay fields directly."""
    return SessionSource(
        platform=platform,
        chat_id=chat_id or user_id,
        chat_type=chat_type,
        user_id=user_id,
        message_id="m1",
    )


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self._env_backup = {k: os.environ.get(k) for k in (
            "NOSTR_DM_OWNER_NPUB", "NOSTR_DM_ALLOW_ALL_USERS",
            "GATEWAY_ALLOWED_USERS", "GATEWAY_ALLOW_ALL_USERS")}
        os.environ["NOSTR_DM_OWNER_NPUB"] = OWNER
        for k in ("NOSTR_DM_ALLOW_ALL_USERS", "GATEWAY_ALLOWED_USERS", "GATEWAY_ALLOW_ALL_USERS"):
            os.environ.pop(k, None)
        # The allowlist env NAME lives on the platform-registry entry the plugin
        # registers at load — without discovery this test would exercise the
        # no-allowlist branch instead of the one that denied the family sender.
        from hermes_cli.plugins import discover_plugins

        discover_plugins()
        self.platform = Platform("nostr")
        roles_file = os.path.join(tempfile.mkdtemp(prefix="nostr-roles-"), "nostr_roles.json")
        with open(roles_file, "w") as fh:
            json.dump({FAMILY: "family", FRIEND: "friend"}, fh)
        # A real adapter instance with only the admission-path state populated:
        # no connect(), the gate reads allowlist + claimed owner + role store only.
        self.adapter = object.__new__(adapter_mod.NostrDmAdapter)
        self.adapter._configured_owner = OWNER
        adapter_mod._role_policy.set_hook_registered(True)
        self.adapter._roles = adapter_mod._role_policy.RoleStore(path=roles_file)
        self.runner = _Runner(self.platform, self.adapter)

    def tearDown(self):
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _admitted(self, source):
        return self.runner._is_user_authorized(source, allow_adapter_delegation=True)

    def test_role_members_are_resolved_into_the_allowlist(self):
        ids = self.adapter.resolved_allowlist_user_ids()
        self.assertIn(OWNER, ids)
        self.assertIn(FAMILY, ids, "a /role family assignment must reach the gateway verdict")
        self.assertIn(FRIEND, ids)
        self.assertNotIn(STRANGER, ids)

    def test_family_dm_is_admitted(self):
        self.assertIs(self._admitted(_source(self.platform, FAMILY)), True)

    def test_family_group_mention_is_admitted(self):
        """The @Hermes path in a group room: chat_id is the room, user_id is the sender."""
        self.assertIs(
            self._admitted(_source(self.platform, FAMILY, chat_id=ROOM, chat_type="group")), True)

    def test_owner_dm_still_admitted(self):
        self.assertIs(self._admitted(_source(self.platform, OWNER)), True)

    def test_stranger_is_still_denied(self):
        self.assertIs(self._admitted(_source(self.platform, STRANGER)), False)

    def test_verdict_depends_on_the_hook(self):
        """Without the hook this exact sender is refused — the pre-fix behaviour."""
        live = self.adapter

        class _NoHook:
            resolved_allowlist_user_ids = None  # the pre-fix adapter surface

            def __getattr__(self, name):
                return getattr(live, name)

        self.runner.adapters[self.platform] = _NoHook()
        # The owner-only flat allowlist is configured by Hermes, while the
        # adapter still independently enforces assigned roles on message intake.
        self.assertIs(self._admitted(_source(self.platform, FAMILY)), False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
