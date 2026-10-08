import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clients } from '../server/clients.js';

const MIN = 60 * 1000;

/**
 * Sit at the desk for `minutes`, reporting the way a real client does.
 *
 * Clients check in roughly every 30 seconds, which is inside the idle grace.
 * Jumping the clock ten minutes between two reports is not "working for ten
 * minutes" -- it is being idle for ten minutes, and correctly accrues
 * nothing. Getting this wrong in a test looks like a bug in the budget.
 */
function sit(c, clock, minutes, names = ['browser']) {
  const ticks = minutes * 2; // one every 30s
  for (let i = 0; i < ticks; i++) {
    clock.advance(30 * 1000);
    for (const n of names) c.report(n);
  }
}

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

/**
 * The shared desk-time budget.
 *
 * Sitting is sitting. Switching from Chrome to VS Code is not a break, so the
 * two clients cannot each keep their own 35-minute timer — one of them would
 * always be fresh and nothing would ever come due. The server owns one
 * budget and both clients report activity into it.
 */

test('a single client accrues desk time', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN });

  c.report('browser');
  sit(c, clock, 10);

  assert.equal(c.activeMs, 10 * MIN);
});

test('two clients share one budget rather than each having their own', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN });

  c.report('browser');
  sit(c, clock, 20, ['browser']);

  // Switch to the editor. This must continue the same stretch, not start a
  // fresh one.
  sit(c, clock, 20, ['editor']);

  assert.ok(c.isDue(), 'alternating apps must not dodge the break');
});

test('overlapping activity from both clients is not double counted', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN });

  c.report('browser');
  c.report('editor'); // same instant, both alive
  sit(c, clock, 10, ['browser', 'editor']);

  assert.equal(c.activeMs, 10 * MIN, 'ten minutes of wall clock is ten minutes');
});

test('time passes only once even with many reports in between', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN });

  c.report('browser');
  for (let i = 0; i < 10; i++) {
    clock.advance(MIN);
    c.report('browser');
    c.report('editor');
  }

  assert.equal(c.activeMs, 10 * MIN);
});

test('a long gap with nobody reporting counts as a break already taken', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN, awayCreditsMs: 8 * MIN });

  c.report('browser');
  sit(c, clock, 30);
  assert.ok(c.activeMs > 25 * MIN);

  // Laptop shut, lunch taken.
  clock.advance(45 * MIN);
  c.report('browser');

  assert.equal(c.activeMs, 0, 'coming back from lunch must not greet you with a lock');
});

test('a short idle gap accrues nothing but does not reset', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN, idleGraceMs: 90 * 1000 });

  c.report('browser');
  clock.advance(5 * MIN); // past grace, short of away-credit
  c.report('browser');

  assert.equal(c.activeMs, 0, 'idle time is not desk time');
});

test('a verified break resets the shared budget for every client', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN });

  c.report('browser');
  sit(c, clock, 40, ['editor']);
  assert.ok(c.isDue());

  c.creditBreak();
  assert.equal(c.isDue(), false);
  assert.equal(c.activeMs, 0);
});

test('a backwards clock does not corrupt the budget', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 35 * MIN });

  c.report('browser');
  sit(c, clock, 10);
  const before = c.activeMs;

  clock.advance(-5 * MIN); // NTP correction or sleep/wake
  c.report('browser');
  assert.equal(c.activeMs, before);
});

// --- which clients are connected ------------------------------------------

test('clients are listed with how recently they checked in', () => {
  const clock = fakeClock();
  const c = new Clients({ clock });

  c.report('browser');
  clock.advance(MIN);
  c.report('editor');

  const seen = c.connected();
  assert.deepEqual(new Set(Object.keys(seen)), new Set(['browser', 'editor']));
  assert.ok(seen.editor > seen.browser, 'the editor checked in more recently');
});

test('a client that stops reporting is eventually considered gone', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, staleMs: 2 * MIN });

  c.report('browser');
  c.report('editor');
  assert.equal(c.activeClients().length, 2);

  clock.advance(5 * MIN);
  c.report('browser'); // only the browser is still alive

  assert.deepEqual(c.activeClients(), ['browser'], 'VS Code was closed; stop claiming it is there');
});

test('remainingMs counts down and floors at zero', () => {
  const clock = fakeClock();
  const c = new Clients({ clock, workMs: 10 * MIN });

  c.report('browser');
  sit(c, clock, 4);
  assert.equal(c.remainingMs(), 6 * MIN);

  sit(c, clock, 30);
  assert.equal(c.remainingMs(), 0, 'never negative');
});

test('state round-trips so the budget survives a server restart', () => {
  const clock = fakeClock();
  const a = new Clients({ clock, workMs: 35 * MIN });
  a.report('browser');
  sit(a, clock, 12);

  const b = new Clients({ clock, workMs: 35 * MIN });
  b.restore(a.toJSON());

  assert.equal(b.activeMs, a.activeMs);
});
