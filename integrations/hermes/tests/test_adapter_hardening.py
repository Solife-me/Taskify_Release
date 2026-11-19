import asyncio
import importlib.util
import os
import tempfile
import time
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "nostr_dm_adapter_hardening", Path(__file__).resolve().parents[1] / "adapter.py"
)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)
ns = adapter.ns
policy = adapter._role_policy


class HardeningTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner_keys = ns.Keys.generate()
        self.owner = self.owner_keys.public_key().to_hex()
        self.peer = ns.Keys.generate().public_key().to_hex()
        self.bot = ns.Keys.generate()
        self.app = object.__new__(adapter.NostrDmAdapter)
        self.app._configured_owner = self.owner
        self.app._my_hex = self.bot.public_key().to_hex()
        self.app._signer = self.bot
        self.app._roles = None
        self.app._fallback_relays = ["wss://relay.example"]
        self.app._peer_relays = []
        self.app._target_relays = AsyncMock(return_value=self.app._fallback_relays)
        self.app._publish_sender_copy = AsyncMock()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.app._delivery_queue = adapter._delivery_queue.DeliveryQueue(Path(directory.name) / "queue.db")

    async def test_unconfigured_owner_does_not_admit_first_sender_or_connect(self):
        self.app._configured_owner = ""
        self.app._secret = self.bot.secret_key().to_hex()
        self.assertFalse(self.app._roles_authorized(self.peer))
        self.assertEqual(self.app.resolved_allowlist_user_ids(), set())
        with patch.object(adapter, "_relay_client") as client, self.assertLogs(adapter.log, level="ERROR"):
            self.assertFalse(await self.app.connect())
            client.assert_not_called()

    async def test_corrupt_store_or_missing_hook_cannot_elevate_a_family_sender(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "roles.json"
            self.app._roles = policy.RoleStore(str(path))
            self.assertTrue(self.app._roles.set(self.peer, "family"))
            with patch.object(policy, "_HOOK_REGISTERED", True):
                self.assertEqual(self.app._sender_role(self.peer), "family")
                path.write_text("invalid JSON")
                self.assertIsNone(self.app._sender_role(self.peer))
                self.assertEqual(self.app._sender_role(self.owner), "owner")
            with patch.object(policy, "_HOOK_REGISTERED", False):
                self.assertIsNone(self.app._sender_role(self.peer))

    async def test_hook_blocks_unresolved_nostr_context_and_unknown_family_tools(self):
        self.assertEqual(
            policy._module_level_pre_tool_call("terminal", platform="nostr")["action"], "block",
        )
        with patch.object(policy, "restricted_role", return_value="family"):
            token = policy.set_actor(self.peer)
            try:
                self.assertEqual(policy._module_level_pre_tool_call("other_tool")["action"], "block")
                self.assertIsNone(policy._module_level_pre_tool_call("read_file"))
            finally:
                policy.reset_actor(token)
        self.assertTrue(policy.family_slash_allowed("/sessions"))
        self.assertFalse(policy.family_slash_allowed("/model example --global"))

    async def test_dispatch_failure_does_not_stop_next_message(self):
        done = asyncio.Event()

        async def dispatch(event):
            if event == "failed message":
                raise ValueError("message failure")
            done.set()

        self.app._queue = asyncio.Queue()
        self.app._dispatch_wrap = AsyncMock(side_effect=dispatch)
        self.app._queue.put_nowait(("event", "failed message"))
        self.app._queue.put_nowait(("event", "next message"))
        with self.assertLogs(adapter.log, level="ERROR"):
            pump = asyncio.create_task(self.app._pump())
            try:
                await asyncio.wait_for(done.wait(), 2)
            finally:
                pump.cancel()
                await asyncio.gather(pump, return_exceptions=True)
        self.assertEqual(self.app._dispatch_wrap.await_count, 2)

    async def test_owner_can_dispatch_a_signed_and_encrypted_sessions_command(self):
        self.app._boot_ts = int(time.time())
        self.app._groups = None
        self.app._loop_guard = None
        self.app._dedup_lock = None
        self.app._processed_rumor_ids = set()
        self.app._taskify_requests = OrderedDict()
        self.app.build_source = Mock(return_value=SimpleNamespace(chat_id=self.owner))

        async def receive_command(event):
            self.assertEqual(event.text, "/sessions")
            self.assertEqual(event.message_type, adapter.MessageType.COMMAND)
            self.assertEqual(policy.get_actor(), self.owner)
            self.assertIsNone(policy._module_level_pre_tool_call("terminal"))

        self.app.handle_message = AsyncMock(side_effect=receive_command)
        rumor = adapter._private_msg_rumor(
            self.bot.public_key(), "/sessions",
        ).finalize_unsigned(self.owner_keys.public_key()).ensure_id()
        with patch.object(adapter._relay_pow_mod, "nip11_min_pow", return_value=0):
            wrap = await adapter._build_recipient_wrap(
                self.owner_keys, self.app._my_hex, rumor, self.app._fallback_relays,
            )
        await self.app._dispatch_wrap(wrap)
        self.app.handle_message.assert_awaited_once()
        self.assertIsNone(policy.get_actor())

    async def test_group_attachment_passes_its_rumor_id(self):
        room = "room"
        self.app._groups = SimpleNamespace(
            rooms={room: {"backlog": adapter._groups_mod.Backlog(), "members": [self.owner, self.peer]}},
            gate=SimpleNamespace(should_dispatch=Mock(return_value=True)),
        )
        self.app._loop_guard = None
        self.app.build_source = Mock(return_value=SimpleNamespace(chat_id=self.owner))
        self.app._dispatch_as_sender = AsyncMock()
        self.app._process_file_rumor = Mock(
            return_value=("[file: notes.pdf]", ["/tmp/fixture.pdf"], adapter.MessageType.DOCUMENT, ["application/pdf"]),
        )
        rumor = object()
        await self.app._handle_group_message(
            None, rumor, 15, self.owner, "rumor-id", "https://files.example/blob", [], "", room,
        )
        self.app._process_file_rumor.assert_called_once_with(rumor, "https://files.example/blob", "rumor-id", True)
        event, sender = self.app._dispatch_as_sender.await_args.args
        self.assertEqual(sender, self.owner)
        self.assertEqual(event.media_urls, ["/tmp/fixture.pdf"])
        self.assertNotIn("https://files.example/blob", event.text)

    async def test_completed_turn_removes_only_plugin_staged_attachments(self):
        with tempfile.TemporaryDirectory() as directory:
            self.app._media_dir = Path(directory)
            staged = self.app._media_dir / "nostr-k15-note.wav"
            unrelated = self.app._media_dir / "other.wav"
            staged.write_bytes(b"test")
            unrelated.write_bytes(b"other")
            with patch.object(adapter.BasePlatformAdapter, "on_processing_complete", AsyncMock(), create=True):
                await self.app.on_processing_complete(
                    SimpleNamespace(media_urls=[str(staged), str(unrelated)]), "success",
                )
            self.assertFalse(staged.exists())
            self.assertTrue(unrelated.exists())

    async def test_discovery_uses_signed_approved_routes_and_configured_fallback(self):
        keys = ns.Keys.generate()
        recipient = keys.public_key().to_hex()
        event = ns.EventBuilder(ns.Kind(10050), "").tags([
            ns.Tag.parse(["relay", "wss://unknown.example"]),
            ns.Tag.parse(["relay", "wss://approved.example/inbox"]),
        ]).finalize(keys)
        self.app._peer_relays = ["wss://approved.example/inbox"]
        self.app._relays_client = SimpleNamespace(fetch_events=AsyncMock(return_value=[event]))
        self.app._inbox_relay_cache, self.app._inbox_cache_ts = {}, {}
        relays = await adapter.NostrDmAdapter._target_relays(self.app, recipient)
        self.assertEqual(relays, ["wss://approved.example/inbox", "wss://relay.example"])

    async def test_payload_delivery_requires_ack_and_closes_relay_client(self):
        signer = self.app._signer
        wrap = SimpleNamespace(id=lambda: SimpleNamespace(to_hex=lambda: "wrap-id"))
        with patch.object(adapter, "_build_recipient_wrap", AsyncMock(return_value=wrap)), \
             patch.object(adapter, "_relay_client") as factory:
            client = factory.return_value
            client.add_relay, client.connect, client.shutdown = AsyncMock(), AsyncMock(), AsyncMock()
            client.send_event = AsyncMock(side_effect=[
                SimpleNamespace(success=[]), SimpleNamespace(success=["relay"]),
            ])
            with self.assertRaisesRegex(OSError, "No relay accepted"):
                await adapter._publish_recipient_wrap(signer, self.peer, object(), self.app._fallback_relays)
            self.assertEqual(
                await adapter._publish_recipient_wrap(signer, self.peer, object(), self.app._fallback_relays),
                "wrap-id",
            )
            self.assertEqual(client.shutdown.await_count, 2)

    async def test_partial_group_delivery_is_reported_and_uses_per_recipient_routes(self):
        self.app._target_relays = AsyncMock(side_effect=[["wss://owner.example"], ["wss://peer.example"]])
        publish = AsyncMock(side_effect=["wrap-one", OSError("rejected")])
        with patch.object(adapter, "_send_wrap", publish), patch.object(adapter._relay_pow_mod, "nip11_min_pow", return_value=0):
            rumor = adapter._private_msg_rumor(self.bot.public_key(), "test").finalize_unsigned(self.bot.public_key()).ensure_id()
            status = await self.app._publish_multiple_recipients(rumor, [self.owner, self.peer])
        self.assertIn("1 of 2", status)
        self.assertEqual([call.args[-1] for call in publish.await_args_list],
                         [["wss://owner.example"], ["wss://peer.example"]])
        self.app._publish_sender_copy.assert_awaited_once()

    async def test_group_send_reports_partial_delivery(self):
        backlog = adapter._groups_mod.Backlog()
        self.app._groups = SimpleNamespace(
            rooms={"room": {"members": [self.app._my_hex, self.owner, self.peer], "backlog": backlog}},
        )
        publish = AsyncMock(side_effect=["acknowledged", OSError("rejected")])
        with patch.object(adapter, "_send_wrap", publish), patch.object(adapter._relay_pow_mod, "nip11_min_pow", return_value=0):
            result = await self.app.send_group("room", "group message")
        self.assertFalse(result.success)
        self.assertIn("1 of 2", result.error)
        self.assertEqual(len(backlog), 0)

    async def test_file_send_reports_recipient_rejection(self):
        self.app._upload_blossom = AsyncMock(return_value="https://blossom.solife.me/test")
        publish = AsyncMock(side_effect=OSError("rejected"))
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "notes.pdf"
            file.write_bytes(b"fixture")
            with patch.object(adapter, "_send_wrap", publish), patch.object(adapter._relay_pow_mod, "nip11_min_pow", return_value=0):
                result = await self.app._send_file_msg(self.peer, str(file), None, None, False)
        self.assertFalse(result.success)
        self.assertIn("1 of 1", result.error)
        self.app._publish_sender_copy.assert_not_awaited()


class StandaloneDeliveryTests(unittest.TestCase):
    def test_cron_reports_rejected_delivery_as_error(self):
        keys = ns.Keys.generate()
        recipient = ns.Keys.generate().public_key().to_hex()
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {"NOSTR_DM_NSEC": keys.secret_key().to_hex(), "HERMES_HOME": directory}), \
             patch.object(adapter._relay_pow_mod, "nip11_min_pow", return_value=0), \
             patch.object(adapter, "_send_wrap", AsyncMock(side_effect=OSError("rejected"))):
            result = adapter._standalone_send(chat_id=recipient, message="scheduled test")
        self.assertIn("queued", result["error"])
        self.assertNotIn("success", result)
