import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTimer, DEFAULTS } from '../extension/timer.js';

const MIN = 60 * 1000;

test('a fresh timer is not due', () => {
  const t = new ActivityTimer();
  assert.equal(t.isDue(), false);
  assert.equal(t.remainingMs(), DEFAULTS.workMs);
});

test('continuous activity accrues toward the threshold', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  for (let i = 0; i < 35; i++) t.tick((now += MIN));

  assert.equal(t.isDue(), true, '35 minutes of ticking should come due');
});

test('is not due one minute short', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  for (let i = 0; i < 34; i++) t.tick((now += MIN));
  assert.equal(t.isDue(), false);
});

test('a long absence counts as a break already taken', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  for (let i = 0; i < 30; i++) t.tick((now += MIN));
  assert.ok(t.activeMs > 25 * MIN);

  // Closed the laptop and went for lunch.
  t.tick((now += 45 * MIN));

  assert.equal(t.activeMs, 0, 'coming back from lunch should not greet you with a lock');
  assert.equal(t.isDue(), false);
});

test('a short pause still counts as work', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  t.tick((now += 30 * 1000)); // half-minute pause, within grace
  assert.equal(t.activeMs, 30 * 1000);
});

test('an idle gap past grace accrues nothing but does not reset', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  t.tick((now += 10 * MIN)); // longer than grace, shorter than away-credit

  assert.equal(t.activeMs, 0, 'idle time is not desk time');
  assert.equal(t.isDue(), false);
});

test('a verified break resets the stretch', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  for (let i = 0; i < 40; i++) t.tick((now += MIN));
  assert.equal(t.isDue(), true);

  t.creditBreak(now);
  assert.equal(t.isDue(), false);
  assert.equal(t.activeMs, 0);
});

test('snooze defers without discarding accrued time', () => {
  const t = new ActivityTimer();
  let now = 0;
  t.tick(now);
  for (let i = 0; i < 40; i++) t.tick((now += MIN));

  t.snooze(5 * MIN);
  assert.equal(t.isDue(), false, 'snoozed, so not due right now');

  for (let i = 0; i < 5; i++) t.tick((now += MIN));
  assert.equal(t.isDue(), true, 'and due again five minutes later, not a full cycle');
});

test('a backwards clock does not corrupt the count', () => {
  const t = new ActivityTimer();
  t.tick(1_000_000);
  const before = t.activeMs;
  t.tick(500_000); // NTP correction, sleep/wake
  assert.equal(t.activeMs, before);
});

test('the interval is configurable', () => {
  const t = new ActivityTimer({ config: { workMs: 10 * MIN } });
  let now = 0;
  t.tick(now);
  for (let i = 0; i < 10; i++) t.tick((now += MIN));
  assert.equal(t.isDue(), true);
});
