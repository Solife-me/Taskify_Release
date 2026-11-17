"""NIP-13 proof-of-work for outbound NIP-17 gift wraps (nostr-dm-platform).

relay.solife.me (Wisp) enforces NIP-11 min_pow_difficulty on writes and silently
rejects unmined events even though nostr-sdk's send_event reports success. This
module mirrors the Taskify CLI 0.7.0 writer: ephemeral wrap author, seal JSON
NIP-44-encrypted toward the recipient, nonce mined over the full tag set.
(SDK EventBuilder.pow() cannot be used for wraps: it drops preset tags, and a
1059 without its p-tag is rejected by NIP-17-aware relays. NIP-42 auth itself is
handled automatically by nostr-sdk clients.)

NOTE: changes here are inert until the gateway restarts (plugin code loads at
adapter init).
"""
import asyncio
import hashlib
import json
import time

from urllib.parse import urlsplit, urlunsplit

try:
    from .network_policy import download_https
except ImportError:  # support loading this module by filename
    from importlib.util import module_from_spec, spec_from_file_location
    from pathlib import Path

    _spec = spec_from_file_location("nostr_dm_network_policy", Path(__file__).with_name("network_policy.py"))
    _network = module_from_spec(_spec)
    _spec.loader.exec_module(_network)
    download_https = _network.download_https

# (relay-url -> (fetched_at_epoch_s, min_pow_difficulty))
_POW_CACHE: dict = {}
_POW_TTL_S = 6 * 3600
# Unreachable NIP-11: mine at solife's current bar rather than drop silently
# (mining ~1k hashes at d10 costs nothing; a silent reject costs a message).
_DEFAULT_DIFFICULTY = 10
_MINING_BUDGET_S = 120


def lead_zero_bits(hexid: str) -> int:
    zeros = 0
    for ch in hexid:
        v = int(ch, 16)
        if v == 0:
            zeros += 4
            continue
        zeros += {1: 3, 2: 2, 3: 1}.get(v, 0)
        break
    return zeros


def mine_nonce(pub_hex: str, created_at: int, kind: int, base_tags, content: str,
               difficulty: int, budget_s: int = _MINING_BUDGET_S):
    """NIP-13 nonce over the FULL tag set — returns base_tags with a ['nonce', s, d]
    appended (taskify-nostr 0.7.0 relay-mining algorithm)."""
    if difficulty <= 0:
        return list(base_tags)
    deadline = time.monotonic() + budget_s
    for candidate in range(50_000_000):
        tags = [*base_tags, ["nonce", str(candidate), str(difficulty)]]
        ser = json.dumps([0, pub_hex, created_at, kind, tags, content],
                         separators=(',', ':'), ensure_ascii=False)
        if lead_zero_bits(hashlib.sha256(ser.encode()).hexdigest()) >= difficulty:
            return tags
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"NIP-13: unmined at difficulty {difficulty} within {budget_s}s")
    raise RuntimeError("NIP-13: nonce space exhausted")


def nip11_min_pow(relays, now: float | None = None) -> int:
    """Highest advertised min_pow_difficulty across the given relays (cached per TTL)."""
    now = time.time() if now is None else now
    best = 0
    for r in relays:
        hit = _POW_CACHE.get(r)
        if hit and now - hit[0] < _POW_TTL_S:
            best = max(best, hit[1])
            continue
        try:
            parsed = urlsplit(r)
            if parsed.scheme != "wss":
                continue
            url = urlunsplit(("https", parsed.netloc, parsed.path or "/", parsed.query, ""))
            body = download_https(
                url, origins=None, limit=64 * 1024, timeout=6, accept="application/nostr+json",
            )
            lim = json.loads(body).get("limitation") or {}
            pow_req = min(20, max(0, int(lim.get("min_pow_difficulty") or 0)))
        except Exception:
            pow_req = None
        _POW_CACHE[r] = (now, pow_req if pow_req is not None else -1)
        best = max(best, pow_req or 0)
    if best == 0:
        best = _DEFAULT_DIFFICULTY
    return best


async def pow_gift_wrap(ns, ephemeral_keys, recipient, seal, difficulty: int):
    """Build one NIP-59 wrap of `seal` with a NIP-13 nonce (ephemeral author,
    NIP-44 content toward `recipient`). Returns the signed event."""
    epk = ephemeral_keys.public_key()
    content = str(ns.nip44_encrypt(ephemeral_keys.secret_key(), recipient,
                                   seal.as_json(), ns.Nip44Version.V2))
    created = int(time.time())
    tags = await asyncio.to_thread(
        mine_nonce, epk.to_hex(), created, 1059, [["p", recipient.to_hex()]], content, difficulty
    )
    return await (ns.EventBuilder(ns.Kind(1059), content) \
        .tags([ns.Tag.parse(t) for t in tags]) \
        .custom_created_at(ns.Timestamp.from_secs(created)) \
        .build(epk).sign(ns.NostrSigner.keys(ephemeral_keys)))