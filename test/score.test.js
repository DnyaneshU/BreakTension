import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POINTS_PER_BREAK,
  STREAK_BONUS,
  SKIP_PENALTY,
  LEVELS,
  creditBreak,
  penaliseSkip,
  levelFor,
  summarise,
} from '../extension/score.js';

const at = (iso) => new Date(iso);

/**
 * The reward loop.
 *
 * Entirely local: there is no server, no leaderboard and no other users, so
 * nothing here can be gamed against anyone but yourself. The point is to make
 * the streak visible enough that spending a skip feels like it costs
 * something, which is what makes the two-step confirmation meaningful rather
 * than merely annoying.
 */

test('a fresh score is zero with no streak', () => {
  const s = summarise({});
  assert.equal(s.points, 0);
  assert.equal(s.streak, 0);
  assert.equal(s.level.index, 0);
});

test('a verified break earns points and starts a streak', () => {
  const state = creditBreak({}, at('2026-10-08T10:00:00'));
  assert.equal(state.points, POINTS_PER_BREAK);
  assert.equal(state.streak, 1);
  assert.equal(state.totalBreaks, 1);
});

test('consecutive breaks build the streak and pay a bonus', () => {
  let s = creditBreak({}, at('2026-10-08T10:00:00'));
  s = creditBreak(s, at('2026-10-08T11:00:00'));
  s = creditBreak(s, at('2026-10-08T12:00:00'));

  assert.equal(s.streak, 3);
  // The bonus grows with the streak: 10, then 10+2, then 10+4.
  assert.equal(s.points, 10 + 12 + 14);
  assert.equal(s.lastEarned, POINTS_PER_BREAK + STREAK_BONUS * 2);
});

test('each consecutive break is worth more than the last, up to the cap', () => {
  let s = {};
  const earned = [];
  for (let i = 0; i < 8; i++) {
    s = creditBreak(s, at('2026-10-08T10:00:00'));
    earned.push(s.lastEarned);
  }

  assert.ok(earned[1] > earned[0], 'a streak should pay better than a cold start');
  assert.equal(earned[earned.length - 1], earned[earned.length - 2], 'and plateau at the cap');
});

test('the streak bonus is capped so it cannot run away', () => {
  let s = {};
  for (let i = 0; i < 50; i++) s = creditBreak(s, at('2026-10-08T10:00:00'));
  const perBreak = s.points / 50;
  assert.ok(perBreak < POINTS_PER_BREAK + STREAK_BONUS * 10, 'bonus must be bounded');
});

test('a skip costs points and resets the streak', () => {
  let s = creditBreak({}, at('2026-10-08T10:00:00'));
  s = creditBreak(s, at('2026-10-08T11:00:00'));
  const before = s.points;
  assert.equal(s.streak, 2);

  s = penaliseSkip(s, at('2026-10-08T12:00:00'));

  assert.equal(s.streak, 0, 'the streak is the thing a skip actually costs');
  assert.equal(s.points, before - SKIP_PENALTY);
  assert.equal(s.totalSkips, 1);
});

test('points never go negative', () => {
  let s = penaliseSkip({}, at('2026-10-08T10:00:00'));
  s = penaliseSkip(s, at('2026-10-08T11:00:00'));
  assert.ok(s.points >= 0, 'a new user skipping twice should not owe points');
});

test('a skip is recorded even when there were no points to take', () => {
  const s = penaliseSkip({}, at('2026-10-08T10:00:00'));
  assert.equal(s.totalSkips, 1);
});

// --- levels ---------------------------------------------------------------

test('levels are ordered and start at zero', () => {
  assert.ok(LEVELS.length >= 4);
  assert.equal(LEVELS[0].at, 0);
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].at > LEVELS[i - 1].at, 'thresholds must increase');
    assert.ok(LEVELS[i].name.length > 0);
  }
});

test('levelFor picks the highest threshold reached', () => {
  assert.equal(levelFor(0).index, 0);
  assert.equal(levelFor(LEVELS[1].at).index, 1);
  assert.equal(levelFor(LEVELS[1].at - 1).index, 0);
  assert.equal(levelFor(999999).index, LEVELS.length - 1, 'the top level is a ceiling, not an error');
});

test('summarise reports progress toward the next level', () => {
  const s = summarise({ points: LEVELS[1].at });
  assert.equal(s.level.index, 1);
  assert.ok(s.nextLevel === null || s.nextLevel.at > s.points);
  assert.ok(s.toNext === null || s.toNext > 0);
});

test('at the top level there is no next level to chase', () => {
  const s = summarise({ points: LEVELS[LEVELS.length - 1].at + 100 });
  assert.equal(s.nextLevel, null);
  assert.equal(s.toNext, null);
});

// --- honesty --------------------------------------------------------------

test('only a verified break can add points', () => {
  // penaliseSkip is the only other mutator and it never increases points.
  const before = creditBreak({}, at('2026-10-08T10:00:00'));
  const after = penaliseSkip(before, at('2026-10-08T11:00:00'));
  assert.ok(after.points <= before.points);
});

test('totals accumulate for the writeup, not just the current streak', () => {
  let s = creditBreak({}, at('2026-10-08T10:00:00'));
  s = penaliseSkip(s, at('2026-10-08T11:00:00'));
  s = creditBreak(s, at('2026-10-08T12:00:00'));

  assert.equal(s.totalBreaks, 2);
  assert.equal(s.totalSkips, 1);
  assert.equal(s.streak, 1, 'streak restarts after the skip');
});
