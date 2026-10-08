import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_PROMPTS, nextConfirmStep, confirmComplete } from '../extension/hatches.js';

/**
 * The two-step skip confirmation.
 *
 * The product's whole claim is that the break is not dismissible in a quarter
 * of a second. A one-click skip button quietly breaks that claim, so the skip
 * asks twice and escalates: the second prompt names what it costs.
 */

test('there are exactly two confirmation prompts', () => {
  assert.equal(SKIP_PROMPTS.length, 2, 'ask twice: "really?" then "really really?"');
});

test('each prompt has a question and an explicit confirm label', () => {
  for (const p of SKIP_PROMPTS) {
    assert.ok(p.question.length > 10, 'the question must actually ask something');
    assert.ok(p.confirm.length > 0);
    assert.ok(p.cancel.length > 0, 'backing out must always be offered');
  }
});

test('the second prompt is more insistent than the first', () => {
  const [first, second] = SKIP_PROMPTS;
  assert.notEqual(first.question, second.question);
  // The escalation is the point: the second one says what it costs.
  assert.match(second.question, /really|sure|certain/i);
});

test('cancelling is the safer-looking choice on both prompts', () => {
  for (const p of SKIP_PROMPTS) {
    assert.equal(p.destructive, true, 'the confirm button is the destructive one');
  }
});

test('step 0 advances to step 1, not straight to done', () => {
  assert.equal(nextConfirmStep(0), 1);
  assert.equal(confirmComplete(1), false, 'one confirmation is not enough');
});

test('step 1 advances to completion', () => {
  assert.equal(nextConfirmStep(1), 2);
  assert.equal(confirmComplete(2), true);
});

test('completion requires passing through every prompt', () => {
  assert.equal(confirmComplete(0), false);
  assert.equal(confirmComplete(SKIP_PROMPTS.length), true);
});
