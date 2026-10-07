import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlag, parseTask } from '../server/gemma.js';

/**
 * Parsing the model's output, which is messier than its API suggests.
 *
 * Observed from real gemma4:e4b responses: markdown fences around the JSON,
 * a sentence of preamble before it, and booleans emitted as the strings
 * "true"/"false". Each of these breaks a naive JSON.parse.
 */

// --- shapes the model actually emits --------------------------------------

test('reads bare JSON', () => {
  assert.equal(parseFlag('{"outdoor": true}', 'outdoor').value, true);
});

test('reads JSON inside markdown fences', () => {
  // This is the most common real response shape.
  assert.equal(parseFlag('```json\n{"outdoor": true}\n```', 'outdoor').value, true);
});

test('reads JSON after a sentence of preamble', () => {
  const raw = 'Here is my assessment:\n{"through_glass": true}\nHope that helps.';
  assert.equal(parseFlag(raw, 'through_glass').value, true);
});

test('coerces string booleans', () => {
  assert.equal(parseFlag('{"outdoor": "true"}', 'outdoor').value, true);
  assert.equal(parseFlag('{"outdoor": "false"}', 'outdoor', { failValue: true }).value, false);
});

test('coerces yes and no', () => {
  assert.equal(parseFlag('{"outdoor": "yes"}', 'outdoor').value, true);
  assert.equal(parseFlag('{"outdoor": "no"}', 'outdoor', { failValue: true }).value, false);
});

test('handles a nested object without tripping on inner braces', () => {
  const raw = '{"outdoor": true, "detail": {"sky": "visible"}}';
  assert.equal(parseFlag(raw, 'outdoor').value, true);
});

test('handles a brace inside a string value', () => {
  const raw = '{"outdoor": true, "evidence": "a brace { here"}';
  const r = parseFlag(raw, 'outdoor');
  assert.equal(r.value, true);
  assert.match(r.evidence, /brace/);
});

// --- failing closed -------------------------------------------------------

test('unreadable output takes the fail value, in both directions', () => {
  // outdoor: absent means "not outdoors", so false rejects.
  assert.equal(parseFlag('I cannot tell', 'outdoor', { failValue: false }).value, false);
  // glass: absent means "assume glass", so true rejects.
  assert.equal(parseFlag('I cannot tell', 'through_glass', { failValue: true }).value, true);
});

test('empty output fails closed', () => {
  assert.equal(parseFlag('', 'outdoor', { failValue: false }).value, false);
  assert.equal(parseFlag(null, 'outdoor', { failValue: false }).value, false);
});

test('a missing field fails closed rather than defaulting to pass', () => {
  const r = parseFlag('{"something_else": true}', 'outdoor', { failValue: false });
  assert.equal(r.value, false);
  assert.equal(r.readable, false);
});

test('malformed JSON fails closed', () => {
  assert.equal(parseFlag('{"outdoor": tru', 'outdoor', { failValue: false }).value, false);
});

test('readable reports whether the model actually answered', () => {
  assert.equal(parseFlag('{"outdoor": true}', 'outdoor').readable, true);
  assert.equal(parseFlag('{}', 'outdoor').readable, false);
});

// --- evidence -------------------------------------------------------------

test('evidence is surfaced for the retake message', () => {
  const r = parseFlag('{"through_glass": true, "evidence": "A dark window frame surrounds the view."}', 'through_glass');
  assert.match(r.evidence, /window frame/i);
});

test('evidence is null when blank or absent', () => {
  assert.equal(parseFlag('{"outdoor": true}', 'outdoor').evidence, null);
  assert.equal(parseFlag('{"outdoor": true, "evidence": "   "}', 'outdoor').evidence, null);
});

// --- parseTask ------------------------------------------------------------

test('parseTask reads task_done with its reason', () => {
  const r = parseTask('{"task_done": true, "reason": "Two fingers clearly raised."}');
  assert.equal(r.ok, true);
  assert.match(r.reason, /two fingers/i);
});

test('parseTask fails closed on junk and still gives a usable reason', () => {
  const r = parseTask('the model rambled');
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0, 'the user needs to be told something actionable');
});

test('parseTask supplies a default reason when the model omits one', () => {
  assert.match(parseTask('{"task_done": false}').reason, /not.*done|retake/i);
});

test('parseTask reads fenced JSON too', () => {
  assert.equal(parseTask('```json\n{"task_done": true}\n```').ok, true);
});
