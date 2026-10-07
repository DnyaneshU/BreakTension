import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, TOKEN_TTL_MS } from '../server/session.js';

// A controllable clock so expiry is tested without sleeping.
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('session starts idle', () => {
  const s = new Session({ clock: fakeClock() });
  assert.equal(s.state, 'idle');
  assert.equal(s.token, null);
});

test('becoming due mints a single-use token and assigns a task', () => {
  const s = new Session({ clock: fakeClock() });
  const { token, task } = s.markDue();

  assert.equal(s.state, 'due');
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 16, 'token should be long enough not to be guessable');
  assert.ok(task.text.length > 0);
});

test('valid token moves the session to pending', () => {
  const s = new Session({ clock: fakeClock() });
  const { token } = s.markDue();

  assert.equal(s.claim(token), true);
  assert.equal(s.state, 'pending');
});

test('a wrong token is rejected and does not change state', () => {
  const s = new Session({ clock: fakeClock() });
  s.markDue();

  assert.equal(s.claim('not-the-token'), false);
  assert.equal(s.state, 'due');
});

test('an expired token is rejected', () => {
  const clock = fakeClock();
  const s = new Session({ clock });
  const { token } = s.markDue();

  clock.advance(TOKEN_TTL_MS + 1);
  assert.equal(s.claim(token), false, 'token past its TTL must not work');
});

test('a token cannot be reused after a successful verification', () => {
  const s = new Session({ clock: fakeClock() });
  const { token } = s.markDue();
  s.claim(token);
  s.pass();

  assert.equal(s.state, 'verified');
  assert.equal(s.claim(token), false, 'single-use means single-use');
});

test('a failed verification stays pending so the user can retake', () => {
  const s = new Session({ clock: fakeClock() });
  const { token } = s.markDue();
  s.claim(token);

  s.fail('indoors');
  assert.equal(s.state, 'pending', 'failing must not lock the user out of retrying');
  assert.equal(s.lastReason, 'indoors');
  assert.equal(s.attempts, 1);
});

test('attempts accumulate across retakes', () => {
  const s = new Session({ clock: fakeClock() });
  const { token } = s.markDue();
  s.claim(token);
  s.fail('a');
  s.fail('b');
  assert.equal(s.attempts, 2);
});

test('passing records how long the break lasted', () => {
  const clock = fakeClock();
  const s = new Session({ clock });
  const { token } = s.markDue();
  clock.advance(4 * 60 * 1000); // four minutes outside
  s.claim(token);
  s.pass();

  assert.ok(s.breakDurationMs >= 4 * 60 * 1000);
});

test('reset returns the session to idle for the next cycle', () => {
  const s = new Session({ clock: fakeClock() });
  const { token } = s.markDue();
  s.claim(token);
  s.pass();
  s.reset();

  assert.equal(s.state, 'idle');
  assert.equal(s.token, null);
  assert.equal(s.attempts, 0);
});

test('cannot pass a session that was never claimed', () => {
  const s = new Session({ clock: fakeClock() });
  s.markDue();
  assert.throws(() => s.pass(), /pending/i, 'passing straight from due would bypass capture');
});

test('the next task differs from the one just completed', () => {
  const s = new Session({ clock: fakeClock(), rng: () => 0 });
  const first = s.markDue().task;
  const t = s.token;
  s.claim(t);
  s.pass();
  s.reset();
  const second = s.markDue().task;

  assert.notEqual(second.id, first.id);
});
