"""Audio detection in the nostr kind-15 file path.

Guards the contract that makes voice notes work end to end: an audio/* kind-15
attachment must arrive as MessageType.VOICE (the gateway's STT gate keys on that),
images stay PHOTO, everything else is a DOCUMENT, and media_types is populated so
_event_media_type_at() can answer.
"""
import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.abspath(os.path.join(HERE, "..", "adapter.py"))
# the adapter imports gateway.* — make the Hermes checkout importable
HERMES_REPO = os.environ.get("HERMES_REPO", os.path.expanduser("~/.hermes/hermes-agent"))
if HERMES_REPO not in sys.path:
    sys.path.insert(0, HERMES_REPO)


class _Tag:
    def __init__(self, *parts):
        self._parts = list(parts)

    def to_vec(self):
        return self._parts


class _Rumor:
    def __init__(self, tags, content=""):
        self._tags = [_Tag(*t) for t in tags]
        self._content = content

    def tags(self):
        return self._tags


def _load_adapter():
    """Import the adapter module without registering a platform."""
    spec = importlib.util.spec_from_file_location("nostr_dm_adapter_undertest", ADAPTER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class ProcessFileRumorAudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_adapter()
        # Build the adapter without __init__ (it needs a live PlatformConfig).
        cls.adapter = cls.mod.NostrDmAdapter.__new__(cls.mod.NostrDmAdapter)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.adapter._media_dir = Path(directory.name)
        self.adapter._attachment_origins = self.mod._network.attachment_origins(())
        self.adapter._owner_private_origins = set()
        self.adapter._owner_attachment_bytes = 512 * 1024 * 1024

    def _classify(self, tags):
        with patch.object(self.mod._network, "stream_https", side_effect=lambda url, write, **kw: write(b"test media")):
            result = self.adapter._process_file_rumor(_Rumor(tags), "", "rid")
        for path in result[1]:
            self.addCleanup(os.unlink, path)
        return result

    def test_audio_becomes_voice_with_media_type(self):
        caption, urls, mtype, types = self._classify([
            ("file-type", "audio/wav"),
            ("filename", "note.wav"),
            ("url", "https://example.invalid/blob"),
        ])
        self.assertEqual(mtype, self.mod.MessageType.VOICE)
        self.assertEqual(types, ["audio/wav"])
        self.assertIn("[audio: note.wav]", caption)

    def test_opus_and_m4a_are_voice(self):
        for mime, name in (("audio/ogg", "n.ogg"), ("audio/mp4", "n.m4a"),
                           ("audio/mpeg", "n.mp3"), ("audio/opus", "n.opus")):
            with self.subTest(mime=mime):
                _, _, mtype, types = self._classify([
                    ("file-type", mime), ("filename", name),
                    ("url", "https://example.invalid/x"),
                ])
                self.assertEqual(mtype, self.mod.MessageType.VOICE)
                self.assertEqual(types, [mime])

    def test_image_stays_photo(self):
        _, _, mtype, types = self._classify([
            ("file-type", "image/png"), ("filename", "a.png"),
            ("url", "https://example.invalid/y"),
        ])
        self.assertEqual(mtype, self.mod.MessageType.PHOTO)
        self.assertEqual(types, ["image/png"])

    def test_other_file_is_document(self):
        _, _, mtype, types = self._classify([
            ("file-type", "application/pdf"), ("filename", "a.pdf"),
            ("url", "https://example.invalid/z"),
        ])
        self.assertEqual(mtype, self.mod.MessageType.DOCUMENT)
        self.assertEqual(types, ["application/pdf"])

    def test_audio_without_file_type_falls_back_to_extension(self):
        """Taskify clients that omit file-type still get VOICE via the filename."""
        _, _, mtype, types = self._classify([
            ("filename", "recording.m4a"),
            ("url", "https://example.invalid/w"),
        ])
        self.assertEqual(mtype, self.mod.MessageType.VOICE)
        self.assertEqual(types, ["audio/mp4"])

    def test_record_expiring_blob_writes_ledger(self):
        """Audio blobs must land in the expiry ledger, or the sweeper can never find them."""
        import json

        tmpdir = tempfile.mkdtemp()
        old = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = tmpdir
        try:
            self.adapter._record_expiring_blob("a" * 64)
            ledger = os.path.join(tmpdir, "nostr_audio_blobs.jsonl")
            self.assertTrue(os.path.isfile(ledger))
            with open(ledger) as fh:
                rows = [json.loads(l) for l in fh if l.strip()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["sha"], "a" * 64)
            self.assertIsInstance(rows[0]["uploaded"], int)
        finally:
            if old is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = old
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_recorder_never_raises_on_bad_path(self):
        """A ledger write failure must not fail the send."""
        old = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = "/proc/nonexistent-read-only"
        try:
            self.adapter._record_expiring_blob("b" * 64)  # must not raise
        finally:
            if old is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = old

    def test_mp3_transcode_is_smaller_and_audio_mime(self):
        """Voice replies ship mp3 (audio/mpeg); a bad suffix would classify as DOCUMENT."""
        import shutil as _sh
        import subprocess as _sp

        if not _sh.which("ffmpeg"):
            self.skipTest("ffmpeg not available")
        src = os.path.join(tempfile.mkdtemp(), "reply.wav")
        _sp.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                 "sine=frequency=440:duration=2", "-ar", "24000", "-ac", "1", src],
                check=True, capture_output=True)
        out = self.mod._to_mp3(src)
        try:
            self.assertIsNotNone(out, f"transcode failed for {src}")
            self.assertTrue(out.endswith(".mp3"), "temp file must keep a .mp3 suffix")
            self.assertEqual(self.mod._mimetype_for(out), "audio/mpeg")
            self.assertGreater(os.path.getsize(out), 0)
            self.assertLess(os.path.getsize(out), os.path.getsize(src),
                            "mp3 should be smaller than the source WAV")
        finally:
            if out:
                _sh.rmtree(os.path.dirname(out), ignore_errors=True)
            _sh.rmtree(os.path.dirname(src), ignore_errors=True)

    def test_mp3_transcode_degrades_to_none_on_bad_input(self):
        """A failed transcode must return None so the caller ships the original, not nothing."""
        self.assertIsNone(self.mod._to_mp3("/nonexistent/definitely-not-audio.wav"))

    def test_only_voice_replies_opt_into_expiry(self):
        """send_voice opts into TTL expiry; send_document/send_video/send_image_file must not.

        Otherwise a photo or document would be deleted from Blossom without the owner's knowledge.
        """
        import asyncio

        captured = []

        async def fake_send(chat_id, path, caption, reply_to, group,
                            file_name=None, expire_after_ttl=False):
            captured.append({"path": path, "expire": expire_after_ttl})
            return self.mod.SendResult(success=True)

        self.adapter._groups = None  # __new__ instance has no group state
        self.adapter._send_file_msg = fake_send

        asyncio.run(self.adapter.send_voice("npub1chat", "/tmp/reply.wav"))
        asyncio.run(self.adapter.send_document("npub1chat", "/tmp/report.pdf"))
        asyncio.run(self.adapter.send_video("npub1chat", "/tmp/clip.mp4"))

        self.assertEqual(len(captured), 3)
        self.assertTrue(captured[0]["expire"], "send_voice must opt into expiry")
        self.assertFalse(captured[1]["expire"], "documents must NOT be swept")
        self.assertFalse(captured[2]["expire"], "videos must NOT be swept")

    def test_owner_can_stream_from_an_explicit_private_origin(self):
        origin = ("files.internal", 443)
        self.adapter._owner_private_origins = {origin}
        url = "https://files.internal/voice"
        with patch.object(self.mod._network, "stream_https",
                          side_effect=lambda url, write, **kwargs: write(b"sample")) as stream:
            fixture = _Rumor([("file-type", "audio/wav"), ("filename", "voice.wav")])
            _, paths, _, _ = self.adapter._process_file_rumor(fixture, url, "rid", True)
            self.assertTrue(paths)
            self.assertEqual(stream.call_args.kwargs["private_origins"], {origin})
            self.assertEqual(stream.call_args.kwargs["limit"], 512 * 1024 * 1024)
            self.adapter._process_file_rumor(fixture, url, "rid", False)
            self.assertNotIn(origin, stream.call_args.kwargs["origins"])
            self.assertEqual(stream.call_args.kwargs["limit"], 64 * 1024 * 1024)

    def test_owner_streams_an_attachment_larger_than_the_old_limit(self):
        expected = 65 * 1024 * 1024
        chunk = b"x" * (64 * 1024)

        def stream(url, write, *, limit, **kwargs):
            self.assertGreaterEqual(limit, expected)
            for _ in range(expected // len(chunk)):
                write(chunk)

        with patch.object(self.mod._network, "stream_https", side_effect=stream):
            _, paths, _, _ = self.adapter._process_file_rumor(
                _Rumor([("filename", "large.pdf"), ("size", str(expected))]),
                "https://originless.solife.me/document", "rid", True,
            )
        self.assertEqual(Path(paths[0]).stat().st_size, expected)

    def test_failed_authentication_removes_the_partial_plaintext(self):
        tags = [
            ("filename", "notes.pdf"),
            ("encryption-algorithm", "aes-gcm"),
            ("decryption-key", "00" * 32),
            ("decryption-nonce", "00" * 16),
        ]
        with patch.object(self.mod._network, "stream_https",
                          side_effect=lambda url, write, **kw: write(b"invalid fixture" * 3)):
            _, paths, _, _ = self.adapter._process_file_rumor(_Rumor(tags),
                                                             "https://originless.solife.me/x", "rid")
        self.assertEqual(paths, [])
        self.assertEqual(list(self.adapter._media_dir.iterdir()), [])

    def test_encrypted_voice_note_becomes_voice(self):
        """The production path: AES-GCM kind-15 audio decrypts to a local file and is VOICE."""
        import hashlib
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        plaintext = b"RIFF....WAVEfake-audio-bytes"
        key, iv = os.urandom(32), os.urandom(16)
        ct = AESGCM(key).encrypt(iv, plaintext, None)
        digest = hashlib.sha256(ct).hexdigest()

        self.adapter._attachment_origins = self.mod._network.attachment_origins(())
        def stream(url, write, **kwargs):
            for offset in range(0, len(ct), 7):
                write(ct[offset:offset + 7])

        with patch.object(self.mod._network, "stream_https", side_effect=stream):
            caption, urls, mtype, types = self.mod.NostrDmAdapter._process_file_rumor(
                self.adapter,
                _Rumor([
                    ("file-type", "audio/wav"),
                    ("filename", "voice.wav"),
                    ("encryption-algorithm", "aes-gcm"),
                    ("decryption-key", key.hex()),
                    ("decryption-nonce", iv.hex()),
                    ("x", digest),
                    ("size", str(len(plaintext))),
                ], ""),
                "https://example.invalid/ct",  # rumor content = the blob URL
                "rid",
            )

        self.assertEqual(mtype, self.mod.MessageType.VOICE)
        self.assertEqual(types, ["audio/wav"])
        self.assertIn("[audio: voice.wav]", caption)
        # the decrypted bytes land on disk for the STT pipeline to read
        self.assertTrue(urls and os.path.isfile(urls[0]))
        with open(urls[0], "rb") as fh:
            self.assertEqual(fh.read(), plaintext)
        self.assertTrue(urls[0].endswith(".wav"))
        os.unlink(urls[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
