-- Version-2 request signatures already used, kept until they expire (60 seconds after signing),
-- so a captured voice or Watch publish request cannot be replayed.
CREATE TABLE IF NOT EXISTS request_signatures (
  signature  TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL  -- milliseconds since the epoch
);
