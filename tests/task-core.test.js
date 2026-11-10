'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/task-core.js');

test('validateTitle rejects empty, whitespace-only and invisible-only titles', () => {
  for (const raw of ['', '   ', '\n\t ', '​​', '  　', null, undefined, 42, {}]) {
    const result = Core.validateTitle(raw);
    assert.equal(result.ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
    assert.equal(result.error, 'Enter a task title.');
  }
});

test('validateTitle trims and collapses internal whitespace', () => {
  const result = Core.validateTitle('  Buy \n\t  milk   ');
  assert.deepEqual(result, { ok: true, value: 'Buy milk', error: null });
});

test('validateTitle enforces the maximum length', () => {
  assert.equal(Core.validateTitle('a'.repeat(Core.MAX_TITLE_LENGTH)).ok, true);
  const tooLong = Core.validateTitle('a'.repeat(Core.MAX_TITLE_LENGTH + 1));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /at most 200/);
});

test('validateTitle keeps markup-like text verbatim (escaping is the renderer’s job)', () => {
  const raw = '<img src=x onerror="alert(1)"> & <b>bold</b>';
  assert.equal(Core.validateTitle(raw).value, raw);
});

test('createTask builds a complete active task', () => {
  const task = Core.createTask({ title: ' Write report ', priority: 'high' }, { now: 1000 });
  assert.equal(typeof task.id, 'string');
  assert.ok(task.id.length > 0);
  assert.deepEqual(
    { ...task, id: undefined },
    { id: undefined, title: 'Write report', priority: 'high', completed: false, createdAt: 1000, updatedAt: 1000, completedAt: null }
  );
});

test('createTask defaults an unknown priority to medium and rejects empty titles', () => {
  assert.equal(Core.createTask({ title: 'x', priority: 'urgent' }).priority, 'medium');
  assert.throws(() => Core.createTask({ title: '   ' }), TypeError);
});

test('createId avoids ids that are already taken', () => {
  const taken = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = Core.createId(taken);
    assert.equal(taken.has(id), false);
    taken.add(id);
  }
  assert.equal(taken.size, 2000);
});

test('updateTask changes only whitelisted fields and preserves the rest', () => {
  const task = { id: 'abc', title: 'Old', priority: 'low', completed: true, createdAt: 100, updatedAt: 150, completedAt: 150 };
  const updated = Core.updateTask(task, { title: ' New ', priority: 'high', id: 'hijack', createdAt: 1, completedAt: 9 }, 500);
  assert.deepEqual(updated, { id: 'abc', title: 'New', priority: 'high', completed: true, createdAt: 100, updatedAt: 500, completedAt: 150 });
  assert.equal(task.title, 'Old', 'original must not be mutated');
});

test('updateTask returns the same object when nothing changed', () => {
  const task = { id: 'a', title: 'Same', priority: 'medium', completed: false, createdAt: 1, updatedAt: 1 };
  assert.equal(Core.updateTask(task, { title: '  Same ', priority: 'medium' }, 99), task);
  assert.equal(Core.updateTask(task, { priority: 'nonsense' }, 99), task);
});

test('updateTask toggles completion and rejects empty titles', () => {
  const task = { id: 'a', title: 'T', priority: 'medium', completed: false, createdAt: 1, updatedAt: 1 };
  const done = Core.updateTask(task, { completed: true }, 2);
  assert.equal(done.completed, true);
  assert.equal(Core.updateTask(done, { completed: false }, 3).completed, false);
  assert.throws(() => Core.updateTask(task, { title: ' ' }, 2), TypeError);
});

test('parseStoredTasks handles empty storage', () => {
  for (const raw of [null, undefined, '']) {
    assert.deepEqual(Core.parseStoredTasks(raw), { status: 'empty', tasks: [], dropped: 0 });
  }
});

test('parseStoredTasks flags unreadable data as corrupt', () => {
  for (const raw of ['{not json', 'null', '42', '"text"', '{"tasks":"nope"}', 'true', '{}']) {
    const result = Core.parseStoredTasks(raw);
    assert.equal(result.status, 'corrupt', raw);
    assert.deepEqual(result.tasks, []);
  }
});

test('parseStoredTasks round-trips serialized tasks', () => {
  const tasks = [
    Core.createTask({ title: 'One', priority: 'high' }, { now: 10 }),
    Core.createTask({ title: 'Two', priority: 'low' }, { now: 20 })
  ];
  tasks[1] = Core.updateTask(tasks[1], { completed: true }, 30);
  const result = Core.parseStoredTasks(Core.serializeTasks(tasks));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tasks, tasks);
});

test('parseStoredTasks salvages valid records and drops invalid ones', () => {
  const raw = JSON.stringify({
    version: 1,
    tasks: [
      { id: 'good', title: 'Valid', priority: 'high', completed: true, createdAt: 5, updatedAt: 6 },
      { id: 'blank', title: '   ' },
      null,
      'string',
      [1, 2],
      { title: 'No id, bad priority', priority: 'urgent', completed: 'yes' },
      { id: 'good', title: 'Duplicate id' },
      { id: '<script>', title: 'Unsafe id' }
    ]
  });
  const result = Core.parseStoredTasks(raw, 1000);
  assert.equal(result.status, 'partial');
  assert.equal(result.dropped, 4);
  assert.equal(result.tasks.length, 4);

  const [valid, repaired, dupe, unsafe] = result.tasks;
  assert.deepEqual(valid, { id: 'good', title: 'Valid', priority: 'high', completed: true, createdAt: 5, updatedAt: 6, completedAt: 6 });
  assert.equal(repaired.priority, 'medium');
  assert.equal(repaired.completed, false, 'only literal true counts as completed');
  assert.equal(repaired.createdAt, 1000);
  assert.notEqual(dupe.id, 'good', 'duplicate ids are re-assigned');
  assert.match(unsafe.id, /^[A-Za-z0-9_-]+$/);

  const ids = new Set(result.tasks.map((t) => t.id));
  assert.equal(ids.size, result.tasks.length, 'all ids are unique');
});

test('parseStoredTasks accepts a bare array and truncates overlong titles', () => {
  const result = Core.parseStoredTasks(JSON.stringify([{ id: 'x', title: 'y'.repeat(500) }]));
  assert.equal(result.status, 'ok');
  assert.equal(result.tasks[0].title.length, Core.MAX_TITLE_LENGTH);
});

test('filterTasks and countTasks agree across status and priority filters', () => {
  const t = (id, priority, completed) => ({ id, title: id, priority, completed, createdAt: 1, updatedAt: 1 });
  const tasks = [t('a', 'high', false), t('b', 'high', true), t('c', 'medium', false), t('d', 'low', true), t('e', 'low', false)];
  const ids = (filters) => Core.filterTasks(tasks, filters).map((x) => x.id).join('');

  assert.equal(ids({ status: 'all', priority: 'all' }), 'abcde');
  assert.equal(ids({ status: 'active', priority: 'all' }), 'ace');
  assert.equal(ids({ status: 'completed', priority: 'all' }), 'bd');
  assert.equal(ids({ status: 'all', priority: 'high' }), 'ab');
  assert.equal(ids({ status: 'active', priority: 'low' }), 'e');
  assert.equal(ids({ status: 'completed', priority: 'medium' }), '');

  assert.deepEqual(Core.countTasks(tasks), { total: 5, active: 3, completed: 2 });
  assert.deepEqual(Core.countTasks([]), { total: 0, active: 0, completed: 0 });
});

test('normalizeFilters keeps valid values and defaults anything else to all', () => {
  assert.deepEqual(Core.normalizeFilters({ status: 'completed', priority: 'low' }), { status: 'completed', priority: 'low' });
  assert.deepEqual(Core.normalizeFilters({ status: 'done', priority: 'urgent' }), { status: 'all', priority: 'all' });
  assert.deepEqual(Core.normalizeFilters({ status: 'active' }), { status: 'active', priority: 'all' });
  for (const raw of [null, undefined, 'active', 5, []]) {
    assert.deepEqual(Core.normalizeFilters(raw), { status: 'all', priority: 'all' });
  }
});

test('parseStoredFilters survives missing or corrupted preferences', () => {
  assert.deepEqual(Core.parseStoredFilters(null), { status: 'all', priority: 'all' });
  assert.deepEqual(Core.parseStoredFilters('{oops'), { status: 'all', priority: 'all' });
  assert.deepEqual(Core.parseStoredFilters('"active"'), { status: 'all', priority: 'all' });
  assert.deepEqual(
    Core.parseStoredFilters(JSON.stringify({ status: 'active', priority: 'high', extra: '<b>' })),
    { status: 'active', priority: 'high' }
  );
});

test('updateTask never moves updatedAt before createdAt', () => {
  const task = { id: 'a', title: 'T', priority: 'low', completed: false, createdAt: 5000, updatedAt: 5000 };
  assert.equal(Core.updateTask(task, { completed: true }, 10).updatedAt, 5000);
});

test('normalizeTask repairs timestamps that are invalid or out of order', () => {
  const seen = new Set();
  const t = Core.normalizeTask({ id: 'x', title: 'T', createdAt: 'yesterday', updatedAt: -4 }, seen, 777);
  assert.equal(t.createdAt, 777);
  assert.equal(t.updatedAt, 777);
  const u = Core.normalizeTask({ id: 'y', title: 'U', createdAt: 900, updatedAt: 100 }, seen, 777);
  assert.equal(u.updatedAt, 900);
  assert.equal(Core.normalizeTask({ id: 'z', title: 'V', createdAt: Infinity }, seen, 1).createdAt, 1);
});

test('serialized output contains only the documented fields', () => {
  const task = Core.createTask({ title: 'Clean', priority: 'low' }, { now: 1 });
  const parsed = JSON.parse(Core.serializeTasks([task]));
  assert.equal(parsed.version, Core.SCHEMA_VERSION);
  assert.deepEqual(Object.keys(parsed.tasks[0]).sort(), ['completed', 'completedAt', 'createdAt', 'id', 'priority', 'title', 'updatedAt']);
});

test('completedAt is set on completion, cleared on restore, and kept through edits', () => {
  const task = Core.createTask({ title: 'Track me' }, { now: 100 });
  const done = Core.updateTask(task, { completed: true }, 200);
  assert.equal(done.completedAt, 200);
  const edited = Core.updateTask(done, { title: 'Track me better', priority: 'high' }, 300);
  assert.equal(edited.completedAt, 200, 'editing a completed task keeps its completion time');
  assert.equal(edited.updatedAt, 300);
  const restored = Core.updateTask(edited, { completed: false }, 400);
  assert.equal(restored.completedAt, null);
  assert.equal(Core.updateTask(restored, { completed: true }, 500).completedAt, 500);
});

test('normalizeTask derives completedAt for legacy or inconsistent records', () => {
  const seen = new Set();
  const legacy = Core.normalizeTask({ id: 'a', title: 'Old', completed: true, createdAt: 10, updatedAt: 20 }, seen, 99);
  assert.equal(legacy.completedAt, 20, 'falls back to updatedAt');
  const active = Core.normalizeTask({ id: 'b', title: 'Open', completed: false, completedAt: 50 }, seen, 99);
  assert.equal(active.completedAt, null, 'active tasks never carry a completion time');
  const early = Core.normalizeTask({ id: 'c', title: 'Odd', completed: true, createdAt: 30, updatedAt: 40, completedAt: 5 }, seen, 99);
  assert.equal(early.completedAt, 40, 'completion before creation is repaired');
});
