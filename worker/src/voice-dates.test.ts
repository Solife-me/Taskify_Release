import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVoiceDue, voiceLocalDates } from './voice-dates.ts';

const reference = '2026-09-12T03:02:00Z'; // September 11, 10:02 PM in Chicago.
test('tomorrow uses the local date even after UTC midnight', () => {
  assert.equal(voiceLocalDates(reference, 'America/Chicago', 300).tomorrow, '2026-09-12');
  assert.equal(normalizeVoiceDue('2026-09-13', 'tomorrow', 'Task', reference, 'America/Chicago', 300), '2026-09-12');
  assert.equal(normalizeVoiceDue('2026-09-13T18:00:00Z', 'tomorrow at 1 PM', 'Task', reference, 'America/Chicago', 300), '2026-09-12T18:00:00.000Z');
});
test('unqualified afternoon appointment ranges use 1 PM and preserve explicit AM', () => {
  const title = "Meet the Spectrum guy at Gail's house";
  assert.equal(normalizeVoiceDue('2026-09-12T06:00:00Z', 'tomorrow from 1-2', title, reference, 'America/Chicago', 300), '2026-09-12T18:00:00.000Z');
  assert.equal(normalizeVoiceDue('2026-09-12T18:00:00Z', 'tomorrow from 1-2 AM', title, reference, 'America/Chicago', 300), '2026-09-12T06:00:00.000Z');
  assert.equal(normalizeVoiceDue('2026-09-12', 'tomorrow from 11 to 1 PM', title, reference, 'America/Chicago', 300), '2026-09-12T16:00:00.000Z');
  assert.equal(normalizeVoiceDue('2026-09-12', 'tomorrow from 12 to 1 PM', title, reference, 'America/Chicago', 300), '2026-09-12T17:00:00.000Z');
  assert.equal(normalizeVoiceDue('2026-09-12', 'tomorrow morning from 1-2', title, reference, 'America/Chicago', 300), '2026-09-12T06:00:00.000Z');
});
test('relative days and local clock conversion honor DST and eastern time zones', () => {
  assert.equal(normalizeVoiceDue('2026-03-08', 'tomorrow from 1-2', 'Meet technician', '2026-03-08T03:00:00Z', 'America/Chicago', 360), '2026-03-08T18:00:00.000Z');
  assert.equal(voiceLocalDates('2026-09-11T23:00:00Z', 'Asia/Tokyo', -540).tomorrow, '2026-09-13');
});
