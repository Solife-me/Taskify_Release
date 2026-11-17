"""Persist signed recipient wraps and retry them without replaying acknowledged copies."""

import sqlite3
import time
import uuid
from contextlib import contextmanager

RETENTION_SECONDS = 7 * 86400
LEASE_SECONDS = 120


class DeliveryQueue:
    def __init__(self, path):
        self.path = path
        with self._connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS deliveries (
                    rumor TEXT NOT NULL, recipient TEXT NOT NULL, event TEXT NOT NULL,
                    created REAL NOT NULL, due REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    lease TEXT, lease_until REAL NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (rumor, recipient)
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(acknowledged, due)")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def enqueue(self, rumor, wraps):
        now = time.time()
        with self._connect() as db:
            db.executemany(
                "INSERT OR IGNORE INTO deliveries(rumor, recipient, event, created, due) VALUES (?, ?, ?, ?, ?)",
                [(rumor, recipient, event, now, now) for recipient, event in wraps],
            )

    def ready(self, limit=16):
        now = time.time()
        with self._connect() as db:
            db.execute("DELETE FROM deliveries WHERE created < ? AND lease_until <= ?",
                       (now - RETENTION_SECONDS, now))
            return db.execute("""
                SELECT rumor, recipient FROM deliveries
                WHERE acknowledged = 0 AND due <= ? AND lease_until <= ?
                ORDER BY due LIMIT ?
            """, (now, now, limit)).fetchall()

    def claim(self, key):
        now = time.time()
        lease = uuid.uuid4().hex
        with self._connect() as db:
            changed = db.execute("""
                UPDATE deliveries SET lease = ?, lease_until = ?, attempts = attempts + 1
                WHERE rumor = ? AND recipient = ? AND acknowledged = 0 AND due <= ? AND lease_until <= ?
            """, (lease, now + LEASE_SECONDS, *key, now, now)).rowcount
            if not changed:
                return None
            return db.execute(
                "SELECT event, attempts, lease FROM deliveries WHERE rumor = ? AND recipient = ?", key,
            ).fetchone()

    def acknowledged(self, key):
        with self._connect() as db:
            row = db.execute(
                "SELECT acknowledged FROM deliveries WHERE rumor = ? AND recipient = ?", key,
            ).fetchone()
            return row is not None and bool(row[0])

    def finish(self, key, lease, attempts, acknowledged):
        now = time.time()
        with self._connect() as db:
            if acknowledged:
                db.execute("""
                    UPDATE deliveries SET acknowledged = 1, event = '', lease = NULL, lease_until = 0
                    WHERE rumor = ? AND recipient = ? AND lease = ?
                """, (*key, lease))
            else:
                delay = min(3600, 5 * 2 ** min(attempts - 1, 10))
                db.execute("""
                    UPDATE deliveries SET due = ?, lease = NULL, lease_until = 0
                    WHERE rumor = ? AND recipient = ? AND lease = ?
                """, (now + delay, *key, lease))
