PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL UNIQUE,
  subscription_auth TEXT NOT NULL,
  subscription_p256dh TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  device_id TEXT NOT NULL,
  reminder_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  board_id TEXT,
  title TEXT NOT NULL,
  due_iso TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  send_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, reminder_key),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_send_at ON reminders(send_at);

CREATE TABLE IF NOT EXISTS pending_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  board_id TEXT,
  title TEXT NOT NULL,
  due_iso TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_device ON pending_notifications(device_id);
