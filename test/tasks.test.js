import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, pickTask } from '../server/tasks.js';

test('task pool is non-empty and well-formed', () => {
  assert.ok(TASKS.length >= 5, 'want a pool big enough to not repeat immediately');
  for (const t of TASKS) {
    assert.equal(typeof t.id, 'string');
    assert.ok(t.id.length > 0);
    assert.equal(typeof t.text, 'string');
    assert.ok(t.text.length > 0, `task ${t.id} needs instruction text`);
    assert.equal(typeof t.check, 'string');
    assert.ok(t.check.length > 0, `task ${t.id} needs a check clause for the model`);
  }
});

test('task ids are unique', () => {
  const ids = TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('pickTask is deterministic under an injected rng', () => {
  const first = pickTask({ rng: () => 0 });
  assert.equal(first.id, TASKS[0].id);

  // rng returning just under 1 must stay in bounds, not overflow the array
  const last = pickTask({ rng: () => 0.999999 });
  assert.equal(last.id, TASKS[TASKS.length - 1].id);
});

test('pickTask avoids immediately repeating the previous task', () => {
  const prev = TASKS[0].id;
  // an rng that always points at index 0 would normally return TASKS[0]
  const picked = pickTask({ rng: () => 0, excludeId: prev });
  assert.notEqual(picked.id, prev, 'should not hand back the task just completed');
});

test('pickTask works with the default rng', () => {
  const t = pickTask();
  assert.ok(TASKS.some((x) => x.id === t.id));
});
