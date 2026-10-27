-- C13-8: the Worker no longer keeps reminder titles; the device shows its own copy when a
-- reminder fires. Clears the titles stored before that change. The columns stay, always empty.
UPDATE reminders SET title = '' WHERE title <> '';
UPDATE pending_notifications SET title = '' WHERE title <> '';
