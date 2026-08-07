-- One-time, browser-bound state for the Google OAuth authorization-code flow.
CREATE TABLE IF NOT EXISTS gcal_oauth_states (
  state_hash          TEXT    PRIMARY KEY,
  npub                TEXT    NOT NULL,
  browser_nonce_hash  TEXT    NOT NULL,
  redirect_uri        TEXT    NOT NULL,
  expires_at          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_gcal_oauth_states_expiry
  ON gcal_oauth_states(expires_at);
