"""The Taskify bot command list and private Hermes picker actions."""

import re
import time
from collections import OrderedDict

COMMAND_D_TAG = "taskify-bot-commands"
DISCOVERY_RELAYS = ("wss://relay.damus.io", "wss://nos.lol", "wss://relay.solife.me")
MENU_TAG = "taskify-bot-menu"
ACTION_TAG = "taskify-bot-ui"
VERSION = "v1"
RUMOR_ID = re.compile(r"[0-9a-f]{64}")
PROVIDER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}")
SESSION_ID = re.compile(r"[0-9]{8}_[0-9]{6}_[0-9A-Fa-f]{8}")
SESSION_HEADING = re.compile(r"\s*(?:📋\s*)?\*\*Named Sessions\*\*\s*", re.IGNORECASE)
SESSION_ROW = re.compile(
    r"\s*\d+[.)]\s+\*\*(.+?)\*\*\s*(?:\(current\))?\s*[—–-]\s*"
    r"`([0-9]{8}_[0-9]{6}_[0-9A-Fa-f]{8})`(?:\s*[—–-].*)?", re.IGNORECASE,
)


def command_tags(registry, available):
    """Advertise static registry commands. Never inspect skills or private session data."""
    commands = {}
    for command in registry:
        name = command.name
        if not re.fullmatch(r"[a-z0-9_]{1,32}", name) or not available(command):
            continue
        description = " ".join(command.description.split())[:100]
        tag = ["command", name, description]
        if (getattr(command, "args_hint", "") or "").lstrip().startswith("<"):
            tag.append("requires-arguments")
        commands.setdefault(name, tag)

    # Keep the two pickers and help visible at the top even when there are many commands.
    ordered = [commands.pop(name) for name in ("model", "sessions", "help") if name in commands]
    ordered.extend(commands.values())
    ordered = ordered[:100]
    return [
        ["d", COMMAND_D_TAG],
        ["alt", f"Taskify bot commands ({len(ordered)})"],
        ["client", "hermes-agent"],
        *ordered,
    ]


def model_listing(providers, current_model, current_provider, max_length):
    """Build the readable reply and exact choices from Hermes's provider catalog."""
    lines = []
    options = set()
    seen = set()
    if MODEL_ID.fullmatch(current_model or "") and PROVIDER_ID.fullmatch(current_provider or ""):
        lines.extend([f"Current: `{current_model}` on {current_provider}", ""])
    for provider in providers:
        slug = provider.get("slug") or ""
        if not PROVIDER_ID.fullmatch(slug) or slug.lower() in seen:
            continue
        seen.add(slug.lower())
        name = " ".join((provider.get("name") or slug).split()).replace("*", "").replace("`", "")[:120]
        models = {}
        for model in provider.get("models") or []:
            if isinstance(model, str) and MODEL_ID.fullmatch(model):
                models.setdefault(model.lower(), model)
        if not models:
            continue
        current = " (current)" if slug == current_provider else ""
        model_line = ", ".join(f"`{model}`" for model in models.values())
        more = max(0, (provider.get("total_models") or 0) - len(models))
        if more:
            model_line += f" (+{more} more)"
        block = [f"**{name or slug}** `--provider {slug}`{current}:", f"  {model_line}", ""]
        if len("\n".join(lines + block)) > max_length:
            break
        lines.extend(block)
        options.update((slug, model) for model in models.values())
    return "\n".join(lines).rstrip(), options


def session_options(content):
    """Recognize the gateway's named-session listing and extract stable IDs."""
    lines = iter(content.splitlines())
    if not any(SESSION_HEADING.fullmatch(line) for line in lines):
        return set()
    options = set()
    for line in lines:
        if match := SESSION_ROW.fullmatch(line):
            options.add(match[2])
            if len(options) == 100:
                break
    return options


class PickerMenus:
    """Bound action validation to the latest issued menu of each type for a given sender."""

    def __init__(self):
        self._menus = OrderedDict()

    def remember(self, peer, kind, rumor_id, options):
        key = (peer, kind)
        self._menus[key] = (rumor_id, frozenset(options), time.monotonic() + 3600)
        self._menus.move_to_end(key)
        if len(self._menus) > 128:
            self._menus.popitem(last=False)

    def validate(self, peer, actions, parents, content):
        """Return an error for an invalid bound action. Older model clients omit the parent."""
        if not parents and len(actions) == 1 and len(actions[0]) == 6 and actions[0][2] == "model-select":
            return None
        if len(actions) != 1 or len(parents) != 1:
            return "This picker action is invalid."
        action = actions[0]
        if (len(action) < 5 or action[1] != VERSION or action[3] != parents[0]
                or not RUMOR_ID.fullmatch(action[3])):
            return "This picker action is invalid."
        if action[2] == "model-select" and len(action) == 6:
            provider, model = action[4:]
            kind, option = "model", (provider, model)
            expected = f"/model {model} --provider {provider}"
        elif action[2] == "session-resume" and len(action) == 5 and SESSION_ID.fullmatch(action[4]):
            kind, option = "sessions", action[4]
            expected = f"/resume {option}"
        else:
            return "This picker action is invalid."
        menu = self._menus.get((peer, kind))
        if not menu or menu[0] != action[3] or menu[2] <= time.monotonic():
            return f"This picker expired. Send /{kind} to open it again."
        if option not in menu[1] or content != expected:
            return "This option was not offered by Hermes."
        return None
