-- Daily budgets on reminder and device writes. On the free plan D1 allows 100,000 rows written a
-- day for everything the Worker stores; these counters keep one address, or all of them together,
-- from spending it on reminders. Rows are kept for a week.
CREATE TABLE IF NOT EXISTS write_budget (
  key  TEXT    NOT NULL,  -- "reminders:all", or "reminders:address:" + a day-salted address hash
  date TEXT    NOT NULL,  -- YYYY-MM-DD UTC
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, date)
);
