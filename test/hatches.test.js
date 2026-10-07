import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNOOZE_MS,
  MEETING_MS,
  DAILY_SKIPS,
  dayKey,
  skipsLeft,
  useSkip,
  canSnooze,
  meetingActive,
  deferReason,
} from '../extension/hatches.js';

const MIN = 60 * 1000;
const at = (iso) => new Date(iso);

/**
 * The escape hatches.
 *
 * These exist because a tool that locks your browser at the wrong moment
 * gets uninstalled, and an uninstalled tool prevents zero sitting. But every
 * hatch is also a way out, so each one is deliberately limited: the snooze is
 * once per cycle, the skips are counted per day, and the meeting toggle
 * expires on its own.
 */

// --- daily skip budget ----------------------------------------------------

test('dayKey is stable within a day and changes across days', () => {
  assert.equal(dayKey(at('2026-10-08T09:00:00')), dayKey(at('2026-10-08T23:59:00')));
  assert.notEqual(dayKey(at('2026-10-08T23:59:00')), dayKey(at('2026-10-09T00:01:00')));
});

test('a fresh day starts with the full skip budget', () => {
  assert.equal(skipsLeft({}, at('2026-10-08T09:00:00')), DAILY_SKIPS);
});

test('using a skip decrements the budget', () => {
  let state = {};
  state = useSkip(state, at('2026-10-08T09:00:00'));
  assert.equal(skipsLeft(state, at('2026-10-08T10:00:00')), DAILY_SKIPS - 1);
});

test('the budget runs out and then refuses', () => {
  let state = {};
  const now = at('2026-10-08T09:00:00');
  for (let i = 0; i < DAILY_SKIPS; i++) state = useSkip(state, now);

  assert.equal(skipsLeft(state, now), 0);
  const before = JSON.stringify(state);
  state = useSkip(state, now);
  assert.equal(skipsLeft(state, now), 0, 'must not go negative');
  assert.equal(JSON.stringify(state), before, 'a refused skip changes nothing');
});

test('the budget resets the next day', () => {
  let state = {};
  const today = at('2026-10-08T09:00:00');
  for (let i = 0; i < DAILY_SKIPS; i++) state = useSkip(state, today);
  assert.equal(skipsLeft(state, today), 0);

  assert.equal(skipsLeft(state, at('2026-10-09T09:00:00')), DAILY_SKIPS);
});

test('skip state from an old day does not leak into today', () => {
  const state = useSkip({}, at('2026-10-01T09:00:00'));
  assert.equal(skipsLeft(state, at('2026-10-08T09:00:00')), DAILY_SKIPS);
});

// --- snooze ---------------------------------------------------------------

test('a cycle starts snoozable', () => {
  assert.equal(canSnooze({}), true);
});

test('snoozing once consumes it for that cycle', () => {
  const state = { snoozedThisCycle: true };
  assert.equal(canSnooze(state), false, 'one snooze per cycle, or it is just a dismiss button');
});

test('the snooze is short enough to still be a nuisance', () => {
  assert.ok(SNOOZE_MS <= 10 * MIN, 'a long snooze defeats the point');
  assert.ok(SNOOZE_MS >= MIN);
});

// --- meeting toggle -------------------------------------------------------

test('no meeting set means not in a meeting', () => {
  assert.equal(meetingActive({}, at('2026-10-08T09:00:00')), false);
  assert.equal(meetingActive({ meetingUntil: null }, at('2026-10-08T09:00:00')), false);
});

test('a meeting is active until its expiry', () => {
  const now = at('2026-10-08T09:00:00');
  const state = { meetingUntil: now.getTime() + 30 * MIN };
  assert.equal(meetingActive(state, now), true);
});

test('a meeting expires on its own, so a forgotten toggle cannot disable the product forever', () => {
  const now = at('2026-10-08T09:00:00');
  const state = { meetingUntil: now.getTime() - 1 };
  assert.equal(meetingActive(state, now), false);
});

test('the meeting window is bounded', () => {
  assert.ok(MEETING_MS <= 4 * 60 * MIN, 'an unbounded meeting flag is an off switch');
});

// --- the combined gate ----------------------------------------------------

const WORK_HOURS = at('2026-10-08T14:00:00'); // Thursday afternoon

test('a break is allowed in the middle of a working afternoon', () => {
  const r = deferReason({ state: {}, date: WORK_HOURS, settings: {} });
  assert.equal(r, null, 'nothing should stand in the way of a normal break');
});

test('quiet hours defer the break', () => {
  const r = deferReason({ state: {}, date: at('2026-10-08T03:00:00'), settings: {} });
  assert.match(r, /quiet/i);
});

test('an active meeting defers the break', () => {
  const state = { meetingUntil: WORK_HOURS.getTime() + 10 * MIN };
  assert.match(deferReason({ state, date: WORK_HOURS, settings: {} }), /meeting/i);
});

test('a live snooze defers the break', () => {
  const state = { snoozeUntil: WORK_HOURS.getTime() + 2 * MIN };
  assert.match(deferReason({ state, date: WORK_HOURS, settings: {} }), /snooze/i);
});

test('an expired snooze does not defer', () => {
  const state = { snoozeUntil: WORK_HOURS.getTime() - 1 };
  assert.equal(deferReason({ state, date: WORK_HOURS, settings: {} }), null);
});

test('a used skip defers the rest of that cycle', () => {
  const state = { skipUntil: WORK_HOURS.getTime() + 20 * MIN };
  assert.match(deferReason({ state, date: WORK_HOURS, settings: {} }), /skip/i);
});

test('weekends defer when the setting is on', () => {
  const sat = at('2026-10-10T14:00:00');
  assert.equal(sat.getDay(), 6, 'fixture sanity: should be a Saturday');
  assert.match(deferReason({ state: {}, date: sat, settings: { workDaysOnly: true } }), /weekend/i);
  assert.equal(deferReason({ state: {}, date: sat, settings: { workDaysOnly: false } }), null);
});

test('the reason is specific, so the popup can explain the wait', () => {
  // A user who sees nothing happen needs to know why.
  const state = { meetingUntil: WORK_HOURS.getTime() + MIN };
  const r = deferReason({ state, date: WORK_HOURS, settings: {} });
  assert.ok(typeof r === 'string' && r.length > 3);
});
