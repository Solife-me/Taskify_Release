-- The CalDAV and first Google Calendar integrations predate this directory, so no migration made
-- or removed their tables. Both are retired. Remove their account emails, OAuth tokens, password
-- hash and events, as 0005 did for the later Google Calendar integration.
DROP TABLE IF EXISTS caldav_events;
DROP TABLE IF EXISTS caldav_accounts;
DROP TABLE IF EXISTS google_calendar_sessions;
DROP TABLE IF EXISTS google_calendar_accounts;
DROP TABLE IF EXISTS google_calendar_state;
