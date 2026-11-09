/**
 * TaskCore — pure task logic: validation, creation, updates, filtering,
 * counting and (de)serialization. No DOM or storage access, so it runs
 * unchanged in the browser (as window.TaskCore) and in Node tests.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.TaskCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var MAX_TITLE_LENGTH = 200;
  var PRIORITIES = Object.freeze(['high', 'medium', 'low']);
  var PRIORITY_LABELS = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low' });
  var DEFAULT_PRIORITY = 'medium';
  var STATUS_FILTERS = Object.freeze(['all', 'active', 'completed']);
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  // Characters that render as nothing; a title made only of these is empty.
  var INVISIBLE_CHARS = /[­​-‍⁠﻿]/g;

  function isPriority(value) {
    return PRIORITIES.indexOf(value) !== -1;
  }

  function isTimestamp(value) {
    return typeof value === 'number' && isFinite(value) && value > 0;
  }

  /** Collapses whitespace (incl. tabs/newlines) to single spaces and trims. */
  function sanitizeTitle(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  /**
   * @returns {{ok: boolean, value: string, error: string|null}}
   */
  function validateTitle(raw) {
    var value = sanitizeTitle(raw);
    if (value.replace(INVISIBLE_CHARS, '').trim() === '') {
      return { ok: false, value: '', error: 'Enter a task title.' };
    }
    if (value.length > MAX_TITLE_LENGTH) {
      return {
        ok: false,
        value: value,
        error: 'Titles can be at most ' + MAX_TITLE_LENGTH + ' characters (this one is ' + value.length + ').'
      };
    }
    return { ok: true, value: value, error: null };
  }

  function randomId() {
    var c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID();
    }
    var suffix = '';
    if (c && typeof c.getRandomValues === 'function') {
      var bytes = c.getRandomValues(new Uint8Array(8));
      for (var i = 0; i < bytes.length; i++) suffix += bytes[i].toString(16).padStart(2, '0');
    } else {
      suffix = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return 't' + Date.now().toString(36) + '-' + suffix.slice(0, 16);
  }

  /**
   * Creates an id that is not in `taken` (a Set of ids), if provided.
   */
  function createId(taken) {
    var id;
    do {
      id = randomId();
    } while (taken && taken.has(id));
    return id;
  }

  /**
   * Creates a new active task. Throws if the title is invalid — callers
   * should validate first to show a friendly message.
   */
  function createTask(input, options) {
    var opts = options || {};
    var check = validateTitle(input && input.title);
    if (!check.ok) throw new TypeError(check.error);
    var now = isTimestamp(opts.now) ? opts.now : Date.now();
    return {
      id: createId(opts.taken),
      title: check.value,
      priority: isPriority(input.priority) ? input.priority : DEFAULT_PRIORITY,
      completed: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
  }

  /**
   * Applies whitelisted changes (title, priority, completed). Returns the
   * original object when nothing changed, otherwise a new task with all
   * other fields (id, createdAt) preserved. Throws on an invalid title.
   */
  function updateTask(task, changes, now) {
    var next = {
      title: task.title,
      priority: task.priority,
      completed: task.completed
    };
    if (Object.prototype.hasOwnProperty.call(changes, 'title')) {
      var check = validateTitle(changes.title);
      if (!check.ok) throw new TypeError(check.error);
      next.title = check.value;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'priority') && isPriority(changes.priority)) {
      next.priority = changes.priority;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'completed')) {
      next.completed = changes.completed === true;
    }
    if (next.title === task.title && next.priority === task.priority && next.completed === task.completed) {
      return task;
    }
    var updatedAt = isTimestamp(now) ? Math.max(now, task.createdAt) : Date.now();
    var completedAt = null;
    if (next.completed) {
      // Only a change of completion state moves completedAt; edits keep it.
      completedAt = task.completed && isTimestamp(task.completedAt) ? task.completedAt : updatedAt;
    }
    return {
      id: task.id,
      title: next.title,
      priority: next.priority,
      completed: next.completed,
      createdAt: task.createdAt,
      updatedAt: updatedAt,
      completedAt: completedAt
    };
  }

  /**
   * Turns one untrusted stored record into a valid task, or null if it
   * cannot be salvaged (not an object, or no usable title).
   */
  function normalizeTask(raw, seenIds, now) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var value = sanitizeTitle(raw.title);
    if (value.replace(INVISIBLE_CHARS, '').trim() === '') return null;

    var id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) && !seenIds.has(raw.id)
      ? raw.id
      : createId(seenIds);
    seenIds.add(id);

    var createdAt = isTimestamp(raw.createdAt) ? raw.createdAt : now;
    var updatedAt = isTimestamp(raw.updatedAt) && raw.updatedAt >= createdAt ? raw.updatedAt : createdAt;
    var completed = raw.completed === true;
    var completedAt = null;
    if (completed) {
      completedAt = isTimestamp(raw.completedAt) && raw.completedAt >= createdAt ? raw.completedAt : updatedAt;
    }

    return {
      id: id,
      title: value.slice(0, MAX_TITLE_LENGTH),
      priority: isPriority(raw.priority) ? raw.priority : DEFAULT_PRIORITY,
      completed: completed,
      createdAt: createdAt,
      updatedAt: updatedAt,
      completedAt: completedAt
    };
  }

  /**
   * Parses the raw localStorage string.
   * status: 'empty' (nothing stored), 'ok', 'partial' (some records were
   * dropped) or 'corrupt' (unreadable; tasks is empty).
   */
  function parseStoredTasks(raw, now) {
    var time = isTimestamp(now) ? now : Date.now();
    if (raw === null || raw === undefined || raw === '') {
      return { status: 'empty', tasks: [], dropped: 0 };
    }
    var data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { status: 'corrupt', tasks: [], dropped: 0 };
    }
    var list;
    if (Array.isArray(data)) {
      list = data; // tolerate a bare array of tasks
    } else if (data && typeof data === 'object' && Array.isArray(data.tasks)) {
      list = data.tasks;
    } else {
      return { status: 'corrupt', tasks: [], dropped: 0 };
    }
    var seen = new Set();
    var tasks = [];
    var dropped = 0;
    for (var i = 0; i < list.length; i++) {
      var task = normalizeTask(list[i], seen, time);
      if (task) tasks.push(task);
      else dropped++;
    }
    return { status: dropped > 0 ? 'partial' : 'ok', tasks: tasks, dropped: dropped };
  }

  function serializeTasks(tasks) {
    return JSON.stringify({ version: SCHEMA_VERSION, tasks: tasks });
  }

  function matchesFilters(task, filters) {
    var status = filters && filters.status;
    var priority = filters && filters.priority;
    if (status === 'active' && task.completed) return false;
    if (status === 'completed' && !task.completed) return false;
    if (isPriority(priority) && task.priority !== priority) return false;
    return true;
  }

  function filterTasks(tasks, filters) {
    return tasks.filter(function (task) {
      return matchesFilters(task, filters);
    });
  }

  /** Returns valid filters from untrusted input, defaulting each to 'all'. */
  function normalizeFilters(raw) {
    var src = raw && typeof raw === 'object' ? raw : {};
    return {
      status: STATUS_FILTERS.indexOf(src.status) !== -1 ? src.status : 'all',
      priority: isPriority(src.priority) ? src.priority : 'all'
    };
  }

  function parseStoredFilters(raw) {
    if (typeof raw !== 'string' || raw === '') return normalizeFilters(null);
    try {
      return normalizeFilters(JSON.parse(raw));
    } catch (err) {
      return normalizeFilters(null);
    }
  }

  function countTasks(tasks) {
    var completed = 0;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].completed) completed++;
    }
    return { total: tasks.length, active: tasks.length - completed, completed: completed };
  }

  return Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_TITLE_LENGTH: MAX_TITLE_LENGTH,
    PRIORITIES: PRIORITIES,
    PRIORITY_LABELS: PRIORITY_LABELS,
    DEFAULT_PRIORITY: DEFAULT_PRIORITY,
    STATUS_FILTERS: STATUS_FILTERS,
    isPriority: isPriority,
    sanitizeTitle: sanitizeTitle,
    validateTitle: validateTitle,
    createId: createId,
    createTask: createTask,
    updateTask: updateTask,
    normalizeTask: normalizeTask,
    parseStoredTasks: parseStoredTasks,
    serializeTasks: serializeTasks,
    matchesFilters: matchesFilters,
    filterTasks: filterTasks,
    normalizeFilters: normalizeFilters,
    parseStoredFilters: parseStoredFilters,
    countTasks: countTasks
  });
});
