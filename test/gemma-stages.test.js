import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutdoorPrompt,
  buildGlassPrompt,
  buildScreenPrompt,
  buildTaskPrompt,
  parseFlag,
  parseTask,
  judgeStaged,
} from '../server/gemma.js';

/**
 * Why this file exists.
 *
 * MEASURED on the fixtures, 2026-10-07:
 *   long combined checklist prompt → window fixture detected 0/5
 *   short single-question prompt   → window fixture detected 3/3,
 *                                    with 0/3 false positives on two
 *                                    genuine outdoor photos
 *
 * The model can see the window frame; a long multi-question prompt
 * reliably suppresses the signal. These tests pin the short prompts and
 * the staged, short-circuiting orchestration.
 */

// --- prompt shape ---------------------------------------------------------

test('each authenticity prompt asks exactly one question', () => {
  for (const [name, p] of [
    ['outdoor', buildOutdoorPrompt()],
    ['glass', buildGlassPrompt()],
    ['screen', buildScreenPrompt()],
  ]) {
    // One JSON field requested per prompt is the whole point of the split.
    const asked = ['outdoor', 'through_glass', 'screen_photo'].filter((f) =>
      p.includes(`"${f}"`)
    );
    assert.equal(asked.length, 1, `${name} prompt should request one field, got ${asked}`);
  }
});

test('prompts stay short — length is the thing that made detection work', () => {
  for (const p of [buildOutdoorPrompt(), buildGlassPrompt(), buildScreenPrompt()]) {
    assert.ok(
      p.length < 420,
      `prompt is ${p.length} chars; the 0/5 failure was a long checklist, keep these terse`
    );
  }
});

test('glass prompt names the visual cues that actually worked', () => {
  const p = buildGlassPrompt();
  assert.match(p, /window/i);
  assert.match(p, /frame|glazing|reflection/i);
});

test('task prompt carries the check and does not re-ask authenticity', () => {
  const p = buildTaskPrompt({ check: 'exactly three fingers are extended' });
  assert.match(p, /exactly three fingers are extended/);
  assert.match(p, /task_done/);
  assert.doesNotMatch(p, /through_glass|screen_photo/);
});

// --- parseFlag ------------------------------------------------------------

test('parseFlag reads a boolean field', () => {
  assert.equal(parseFlag('{"outdoor": true}', 'outdoor').value, true);
  assert.equal(parseFlag('{"outdoor": false}', 'outdoor', { failValue: false }).value, false);
});

test('parseFlag handles fenced and prose-wrapped JSON', () => {
  assert.equal(parseFlag('```json\n{"through_glass": true}\n```', 'through_glass').value, true);
  assert.equal(parseFlag('Here: {"through_glass": true} ok?', 'through_glass').value, true);
});

test('parseFlag coerces string booleans', () => {
  assert.equal(parseFlag('{"outdoor": "true"}', 'outdoor').value, true);
});

test('parseFlag returns the failValue on unreadable output', () => {
  const g = parseFlag('I cannot tell', 'through_glass', { failValue: true });
  assert.equal(g.value, true, 'glass must fail closed');
  assert.equal(g.readable, false);

  const o = parseFlag('I cannot tell', 'outdoor', { failValue: false });
  assert.equal(o.value, false, 'outdoor must fail closed');
});

test('parseFlag returns the failValue when the field is missing', () => {
  assert.equal(parseFlag('{"something_else": true}', 'outdoor', { failValue: false }).value, false);
});

test('parseFlag surfaces evidence for the retake message', () => {
  const r = parseFlag('{"through_glass": true, "evidence": "A dark window frame surrounds the view."}', 'through_glass');
  assert.match(r.evidence, /window frame/i);
});

test('parseTask reads task_done and fails closed', () => {
  assert.equal(parseTask('{"task_done": true, "reason": "two fingers"}').ok, true);
  assert.equal(parseTask('{"task_done": false, "reason": "no hand"}').ok, false);
  assert.equal(parseTask('who knows').ok, false);
});

// --- staged orchestration -------------------------------------------------

function stubFetch(responses) {
  let i = 0;
  const calls = [];
  const fetchImpl = async (_url, opts) => {
    calls.push(JSON.parse(opts.body).messages[0].content);
    const content = responses[i++] ?? '{}';
    return { ok: true, status: 200, json: async () => ({ message: { content } }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const OK_OUTDOOR = '{"outdoor": true}';
const OK_GLASS = '{"through_glass": false}';
const OK_SCREEN = '{"screen_photo": false}';
const OK_TASK = '{"task_done": true, "reason": "Two fingers clearly raised."}';

test('judgeStaged passes only when every stage passes', async () => {
  const v = await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'two fingers' },
    fetchImpl: stubFetch([OK_OUTDOOR, OK_GLASS, OK_SCREEN, OK_TASK]),
  });
  assert.equal(v.ok, true);
  assert.equal(v.stage, 'complete');
});

test('judgeStaged rejects a window photo and stops early', async () => {
  const f = stubFetch([
    OK_OUTDOOR,
    '{"through_glass": true, "evidence": "A dark window frame surrounds the scene."}',
  ]);
  const v = await judgeStaged({ imageB64: 'AAAA', task: { check: 'two fingers' }, fetchImpl: f });

  assert.equal(v.ok, false);
  assert.equal(v.stage, 'glass');
  assert.match(v.reason, /window frame/i);
  assert.match(v.reason, /outside/i, 'tell them what to do, not just what is wrong');
  assert.equal(f.calls.length, 2, 'no point asking about the gesture once glass is detected');
});

test('judgeStaged rejects an indoor photo on the first call', async () => {
  const f = stubFetch(['{"outdoor": false, "evidence": "This is an office desk."}']);
  const v = await judgeStaged({ imageB64: 'AAAA', task: { check: 'x' }, fetchImpl: f });

  assert.equal(v.stage, 'outdoor');
  assert.match(v.reason, /office desk/i);
  assert.equal(f.calls.length, 1, 'cheapest rejection should cost one call');
});

test('judgeStaged rejects a photo of a screen', async () => {
  const v = await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'x' },
    fetchImpl: stubFetch([OK_OUTDOOR, OK_GLASS, '{"screen_photo": true, "evidence": "Visible pixel grid."}']),
  });
  assert.equal(v.stage, 'screen');
  assert.match(v.reason, /pixel grid/i);
});

test('judgeStaged fails on the task stage with actionable feedback', async () => {
  const v = await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'two fingers' },
    fetchImpl: stubFetch([OK_OUTDOOR, OK_GLASS, OK_SCREEN, '{"task_done": false, "reason": "No hand is visible."}']),
  });
  assert.equal(v.ok, false);
  assert.equal(v.stage, 'task');
  assert.equal(v.outdoor, true, 'passing earlier stages should be reported');
  assert.match(v.reason, /no hand/i);
});

test('judgeStaged fails closed when a stage returns junk', async () => {
  const v = await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'x' },
    fetchImpl: stubFetch([OK_OUTDOOR, 'the model rambled instead of answering']),
  });
  assert.equal(v.ok, false, 'unreadable glass answer must not unlock the browser');
  assert.equal(v.stage, 'glass');
});

test('judgeStaged fails closed when Ollama is unreachable', async () => {
  const v = await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'x' },
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /ollama|reach/i);
});

test('judgeStaged fails closed on a 404 and names the pull command', async () => {
  const v = await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'x' },
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /ollama pull/i);
});

test('judgeStaged rejects an empty photo without calling the model', async () => {
  const f = stubFetch([]);
  const v = await judgeStaged({ imageB64: '', task: { check: 'x' }, fetchImpl: f });
  assert.equal(v.ok, false);
  assert.equal(f.calls.length, 0);
});

test('judgeStaged strips the data: prefix', async () => {
  let sent = null;
  const fetchImpl = async (_u, opts) => {
    sent ??= JSON.parse(opts.body).messages[0].images[0];
    return { ok: true, status: 200, json: async () => ({ message: { content: OK_OUTDOOR } }) };
  };
  await judgeStaged({ imageB64: 'data:image/jpeg;base64,ZZZZ', task: { check: 'x' }, fetchImpl });
  assert.equal(sent, 'ZZZZ');
});

test('judgeStaged reports progress so the phone can show which check is running', async () => {
  const seen = [];
  await judgeStaged({
    imageB64: 'AAAA',
    task: { check: 'x' },
    fetchImpl: stubFetch([OK_OUTDOOR, OK_GLASS, OK_SCREEN, OK_TASK]),
    onProgress: (s) => seen.push(s),
  });
  assert.deepEqual(seen, ['outdoor', 'glass', 'screen', 'task']);
});

test('every stage sends think:false — thinking mode costs ~24s vs ~3s', async () => {
  let bodies = [];
  const fetchImpl = async (_u, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ message: { content: OK_OUTDOOR } }) };
  };
  await judgeStaged({ imageB64: 'AAAA', task: { check: 'x' }, fetchImpl });
  assert.ok(bodies.length > 0);
  for (const b of bodies) {
    assert.equal(b.think, false);
    assert.equal(b.stream, false);
  }
});
