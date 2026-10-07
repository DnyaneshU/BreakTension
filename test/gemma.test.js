import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, buildPrompt, judge, PASS, FAIL } from '../server/gemma.js';

const GOOD = {
  outdoor: true,
  through_glass: false,
  task_done: true,
  screen_photo: false,
  confidence: 0.9,
  reason: 'Open sky and grass visible, two fingers raised.',
};

test('parses a clean JSON verdict', () => {
  const v = parseVerdict(JSON.stringify(GOOD));
  assert.equal(v.outdoor, true);
  assert.equal(v.task_done, true);
  assert.equal(v.ok, true);
});

test('parses JSON wrapped in markdown fences', () => {
  const raw = '```json\n' + JSON.stringify(GOOD) + '\n```';
  assert.equal(parseVerdict(raw).ok, true);
});

test('parses JSON surrounded by prose', () => {
  const raw = `Here is my assessment:\n${JSON.stringify(GOOD)}\nHope that helps.`;
  assert.equal(parseVerdict(raw).ok, true);
});

test('fails closed on malformed output', () => {
  const v = parseVerdict('I think this looks fine to me!');
  assert.equal(v.ok, false, 'unparseable output must never pass');
  assert.ok(v.reason.length > 0);
});

test('fails closed on empty output', () => {
  assert.equal(parseVerdict('').ok, false);
});

// Each individual failure condition must sink the verdict on its own.
for (const [field, value] of [
  ['outdoor', false],
  ['through_glass', true],
  ['task_done', false],
  ['screen_photo', true],
]) {
  test(`verdict fails when ${field} is ${value}`, () => {
    const v = parseVerdict(JSON.stringify({ ...GOOD, [field]: value }));
    assert.equal(v.ok, false, `${field}=${value} must block the unlock`);
  });
}

test('missing boolean fields fail closed rather than defaulting to true', () => {
  const v = parseVerdict(JSON.stringify({ reason: 'dunno' }));
  assert.equal(v.ok, false);
});

test('coerces string booleans the model sometimes emits', () => {
  const v = parseVerdict(
    JSON.stringify({ ...GOOD, outdoor: 'true', through_glass: 'false' })
  );
  assert.equal(v.ok, true, '"true"/"false" strings are a common model quirk');
});

test('reason is always a string', () => {
  const v = parseVerdict(JSON.stringify({ ...GOOD, reason: null }));
  assert.equal(typeof v.reason, 'string');
});

test('prompt embeds the task check clause', () => {
  const p = buildPrompt({ check: 'exactly two fingers are extended' });
  assert.match(p, /exactly two fingers are extended/);
  assert.match(p, /JSON/i, 'prompt must demand JSON');
  assert.match(p, /through_glass/, 'prompt must name every field we parse');
  assert.match(p, /screen_photo/);
});

// judge() is tested against a fake fetch so no model call is needed.
function fakeFetch(payload, { status = 200 } = {}) {
  return async () => ({
    ok: status === 200,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

test('judge reads message.content and ignores message.thinking', async () => {
  // gemma4:e4b emits a `thinking` field; reading it instead of `content`
  // is the single easiest way to break this integration.
  const fetchImpl = fakeFetch({
    message: {
      role: 'assistant',
      thinking: 'Let me reason... this could be {"outdoor": false} perhaps',
      content: JSON.stringify(GOOD),
    },
    done: true,
  });

  const v = await judge({ imageB64: 'xxx', task: { check: 'two fingers' }, fetchImpl });
  assert.equal(v.ok, true, 'must parse content, not thinking');
});

test('judge fails closed when Ollama returns an error status', async () => {
  const v = await judge({
    imageB64: 'xxx',
    task: { check: 'two fingers' },
    fetchImpl: fakeFetch({ error: 'model not found' }, { status: 404 }),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /model|ollama|unavailable/i);
});

test('judge fails closed when the fetch itself throws', async () => {
  const v = await judge({
    imageB64: 'xxx',
    task: { check: 'two fingers' },
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /ollama|connect|unavailable/i);
});

test('judge strips a data: URL prefix before sending', async () => {
  let sentBody = null;
  const fetchImpl = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(GOOD) } }) };
  };

  await judge({
    imageB64: 'data:image/jpeg;base64,AAAA',
    task: { check: 'x' },
    fetchImpl,
  });

  assert.equal(sentBody.messages[0].images[0], 'AAAA', 'Ollama rejects the data: prefix');
});

test('judge sends stream:false so the response is a single object', async () => {
  let sentBody = null;
  const fetchImpl = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(GOOD) } }) };
  };
  await judge({ imageB64: 'AAAA', task: { check: 'x' }, fetchImpl });
  assert.equal(sentBody.stream, false);
});

test('PASS and FAIL helpers agree with parseVerdict', () => {
  assert.equal(PASS, true);
  assert.equal(FAIL, false);
});
