import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from taskify_commands import PickerMenus, command_tags, model_listing, session_options


class TaskifyCommandTests(unittest.TestCase):
    def test_public_catalog_uses_compatible_names_and_marks_required_arguments(self):
        commands = [
            SimpleNamespace(name="queue", description="Queue\na prompt", args_hint="<prompt>"),
            SimpleNamespace(name="model", description="Choose a model", args_hint="[model]"),
            SimpleNamespace(name="sessions", description="List sessions", args_hint=""),
            SimpleNamespace(name="bad-name", description="Invalid wire name"),
            SimpleNamespace(name="cli", description="CLI only"),
        ]
        tags = command_tags(commands, lambda command: command.name != "cli")
        self.assertEqual(tags[0], ["d", "taskify-bot-commands"])
        self.assertEqual(tags[3:], [
            ["command", "model", "Choose a model"],
            ["command", "sessions", "List sessions"],
            ["command", "queue", "Queue a prompt", "requires-arguments"],
        ])

    def test_model_listing_pairs_each_button_with_a_valid_provider_model(self):
        content, options = model_listing(
            [
                {"slug": "custom:local", "name": "Local", "models": ["good:model", "unsafe model"],
                 "total_models": 5},
                {"slug": "nous", "name": "Nous Portal", "models": ["anthropic/example"]},
            ],
            "good:model", "custom:local", 1000,
        )
        self.assertIn("**Local** `--provider custom:local` (current):", content)
        self.assertIn("`good:model` (+4 more)", content)
        self.assertEqual(options, {("custom:local", "good:model"), ("nous", "anthropic/example")})

    def test_model_action_is_bound_to_peer_menu_and_exact_command(self):
        menus = PickerMenus()
        parent = "a" * 64
        menus.remember("me", "model", parent, {("nous", "anthropic/example")})
        tag = ["taskify-bot-ui", "v1", "model-select", parent, "nous", "anthropic/example"]
        command = "/model anthropic/example --provider nous"
        self.assertIsNone(menus.validate("me", [tag], [parent], command))
        self.assertIsNotNone(menus.validate("another", [tag], [parent], command))
        self.assertIsNotNone(menus.validate("me", [tag], ["b" * 64], command))
        self.assertIsNotNone(menus.validate("me", [tag], [parent], command + " --global"))
        menus.remember("me", "model", "b" * 64, {("nous", "anthropic/example")})
        self.assertIn("expired", menus.validate("me", [tag], [parent], command))

    def test_session_action_uses_only_ids_in_the_named_session_list(self):
        session_id = "20261109_013330_790ece03"
        listing = f"📋 **Named Sessions**\n\n1. **Audit** (current) — `{session_id}` — _notes_"
        self.assertEqual(session_options(listing), {session_id})
        self.assertEqual(session_options(listing.splitlines()[-1]), set())
        parent = "c" * 64
        menus = PickerMenus()
        menus.remember("me", "sessions", parent, session_options(listing))
        tag = ["taskify-bot-ui", "v1", "session-resume", parent, session_id]
        command = f"/resume {session_id}"
        self.assertIsNone(menus.validate("me", [tag], [parent], command))
        self.assertIsNotNone(menus.validate("me", [tag], [], command))
        other_session = "20261109_013330_790ece99"
        tag[-1] = other_session
        self.assertIsNotNone(menus.validate("me", [tag], [parent], f"/resume {other_session}"))

    def test_menu_actions_expire(self):
        parent = "c" * 64
        menus = PickerMenus()
        with patch("taskify_commands.time.monotonic", return_value=10):
            menus.remember("me", "model", parent, {("nous", "model")})
        action = ["taskify-bot-ui", "v1", "model-select", parent, "nous", "model"]
        with patch("taskify_commands.time.monotonic", return_value=3610):
            self.assertIn("expired", menus.validate("me", [action], [parent], "/model model --provider nous"))


if __name__ == "__main__":
    unittest.main()
