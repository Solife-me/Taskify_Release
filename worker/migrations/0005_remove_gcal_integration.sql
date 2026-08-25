-- Google Calendar integration was retired. Remove cached events, OAuth state,
-- and encrypted access/refresh tokens from D1.
DROP TABLE IF EXISTS gcal_events;
DROP TABLE IF EXISTS gcal_calendars;
DROP TABLE IF EXISTS gcal_connections;
DROP TABLE IF EXISTS gcal_oauth_states;
