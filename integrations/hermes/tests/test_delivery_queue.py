import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import delivery_queue as queue


class DeliveryQueueTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "deliveries.sqlite3"
        self.queue = queue.DeliveryQueue(self.path)

    def test_reopened_queue_retries_only_unacknowledged_recipient(self):
        with patch.object(queue.time, "time", return_value=10):
            self.queue.enqueue("rumor", [("alice", "signed-alice"), ("bob", "signed-bob")])
            for recipient, acknowledged in (("alice", True), ("bob", False)):
                key = ("rumor", recipient)
                _, attempts, lease = self.queue.claim(key)
                self.queue.finish(key, lease, attempts, acknowledged)
        reopened = queue.DeliveryQueue(self.path)
        with patch.object(queue.time, "time", return_value=16):
            self.assertEqual(reopened.ready(), [("rumor", "bob")])
            self.assertTrue(reopened.acknowledged(("rumor", "alice")))
            self.assertEqual(reopened.claim(("rumor", "bob"))[:2], ("signed-bob", 2))

    def test_expired_lease_recovers_same_event_and_old_worker_cannot_replace_state(self):
        self.queue.enqueue("rumor", [("bob", "signed")])
        key = ("rumor", "bob")
        _, tries, old_lease = self.queue.claim(key)
        self.assertIsNone(queue.DeliveryQueue(self.path).claim(key))
        now = queue.time.time()
        with patch.object(queue.time, "time", return_value=now + queue.LEASE_SECONDS + 1):
            event, attempts, lease = self.queue.claim(key)
            self.queue.finish(key, old_lease, tries, True)
            self.assertFalse(self.queue.acknowledged(key))
            self.assertEqual(event, "signed")
            self.queue.finish(key, lease, attempts, True)
            self.assertTrue(self.queue.acknowledged(key))
            self.queue.enqueue("rumor", [("bob", "different-wrap")])
            self.assertIsNone(self.queue.claim(key))
