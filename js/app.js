/**
 * TaskTracker UI controller.
 *
 * Flow: user action -> update `state` -> persist() -> render().
 * Rendering is a full, cheap rebuild of the list from state, so the list,
 * counters, filters and saved data can never drift apart.
 */
(function () {
  'use strict';

  var Core = window.TaskCore;

  var STORAGE_KEY = 'tasktracker:v1';
  var BACKUP_KEY = 'tasktracker:v1:unreadable-backup';
  var VIEW_KEY = 'tasktracker:v1:view';
  var PROBE_KEY = 'tasktracker:probe';
  var COUNTER_THRESHOLD = Math.floor(Core.MAX_TITLE_LENGTH * 0.8);
  var TOAST_MS = 7000;
  var RESUBMIT_GUARD_MS = 600;

  var MESSAGES = {
    unavailable: 'Browser storage is unavailable, so tasks can’t be saved. You can keep working, but changes will be lost when you close or refresh this page.',
    readonly: 'Browser storage is full or blocked, so changes may not be saved. Your tasks still work for this session.',
    saveFailed: 'Your latest changes couldn’t be saved (storage may be full or blocked). Everything still works for this session, but changes may be lost after a refresh.'
  };

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  /** Detects read and write access separately: a full store is still readable. */
  function openStorage() {
    var store;
    try {
      store = window.localStorage;
      if (!store) return { store: null, writable: false };
      store.getItem(STORAGE_KEY);
    } catch (err) {
      return { store: null, writable: false };
    }
    try {
      store.setItem(PROBE_KEY, '1');
      store.removeItem(PROBE_KEY);
      return { store: store, writable: true };
    } catch (err) {
      return { store: store, writable: false };
    }
  }

  var storage = openStorage();

  function readStored() {
    if (!storage.store) return null;
    try {
      return storage.store.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function writeStored(key, value) {
    if (!storage.store) return false;
    try {
      storage.store.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = {
    tasks: [],
    filters: { status: 'all', priority: 'all' },
    editing: null, // { id, title, priority, error }
    notice: null, // { kind: 'warning'|'info', reason, message }
    canSave: storage.writable, // false when storage is missing or the last save failed
    dismissedNotice: null,
    lastAdd: { at: 0, title: '' }
  };

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  var els = {
    form: byId('task-form'),
    titleInput: byId('task-title'),
    titleError: byId('task-title-error'),
    titleCount: byId('task-title-count'),
    prioritySelect: byId('task-priority'),
    statusRadios: document.querySelectorAll('input[name="status-filter"]'),
    priorityFilter: byId('priority-filter'),
    list: byId('task-list'),
    listHeading: byId('task-list-heading'),
    summary: byId('results-summary'),
    empty: byId('empty-state'),
    emptyTitle: byId('empty-title'),
    emptyBody: byId('empty-body'),
    emptyReset: byId('empty-reset'),
    countTotal: byId('count-total'),
    countActive: byId('count-active'),
    countCompleted: byId('count-completed'),
    segCounts: document.querySelectorAll('.seg-count'),
    notice: byId('notice'),
    noticeMessage: byId('notice-message'),
    noticeDismiss: byId('notice-dismiss'),
    toast: byId('toast'),
    toastMessage: byId('toast-message'),
    toastAction: byId('toast-action'),
    toastDismiss: byId('toast-dismiss'),
    live: byId('live-region'),
    saveStatus: byId('save-status'),
    taskTemplate: byId('task-template'),
    editTemplate: byId('edit-template')
  };

  var dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  var dateFormatWithYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function findTask(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  function takenIds() {
    return new Set(state.tasks.map(function (t) { return t.id; }));
  }

  function replaceTask(updated) {
    return state.tasks.map(function (t) { return t.id === updated.id ? updated : t; });
  }

  function visibleTasks() {
    return Core.filterTasks(state.tasks, state.filters);
  }

  function visibleIndex(id) {
    var list = visibleTasks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return i;
    }
    return -1;
  }

  function filtersActive() {
    return state.filters.status !== 'all' || state.filters.priority !== 'all';
  }

  function quote(title, max) {
    var limit = max || 60;
    var text = title.length > limit ? title.slice(0, limit - 1).trimEnd() + '…' : title;
    return '“' + text + '”';
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function formatDate(ms) {
    var d = new Date(ms);
    return d.getFullYear() === new Date().getFullYear() ? dateFormat.format(d) : dateFormatWithYear.format(d);
  }

  function itemIdFrom(node) {
    var li = node.closest('.task');
    return li ? li.dataset.id : null;
  }

  var announceTimer = null;
  function announce(message) {
    // Clear first so repeated identical messages are still announced.
    els.live.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      els.live.textContent = message;
    }, 50);
  }

  function setFieldError(input, errorEl, message) {
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  /** Shows "n/max" once a title gets close to the length limit. */
  function updateCounter(input, counter) {
    var length = input.value.length;
    var show = length >= COUNTER_THRESHOLD;
    counter.hidden = !show;
    counter.textContent = show ? length + '/' + Core.MAX_TITLE_LENGTH : '';
    counter.classList.toggle('is-limit', length >= Core.MAX_TITLE_LENGTH);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function setNotice(notice) {
    state.notice = notice;
    renderNotice();
  }

  function persist() {
    if (!storage.store) return; // already warned at startup
    state.canSave = writeStored(STORAGE_KEY, Core.serializeTasks(state.tasks));
    if (state.canSave) {
      if (state.notice && (state.notice.reason === 'save-failed' || state.notice.reason === 'readonly')) {
        setNotice(null);
      }
      if (state.dismissedNotice === 'save-failed') state.dismissedNotice = null;
    } else if (!state.notice || state.notice.kind !== 'warning') {
      if (state.dismissedNotice !== 'save-failed') {
        setNotice({ kind: 'warning', reason: 'save-failed', message: MESSAGES.saveFailed });
      }
    }
  }

  /** View preferences are a convenience: failures here are silent. */
  function saveFilters() {
    if (storage.writable) writeStored(VIEW_KEY, JSON.stringify(state.filters));
  }

  function loadFilters() {
    if (!storage.store) return Core.normalizeFilters(null);
    try {
      return Core.parseStoredFilters(storage.store.getItem(VIEW_KEY));
    } catch (err) {
      return Core.normalizeFilters(null);
    }
  }

  function commit(nextTasks, options) {
    var opts = options || {};
    state.tasks = nextTasks;
    persist();
    render(opts.focus);
    if (opts.announce) announce(opts.announce);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render(focusRequest) {
    var focus = focusRequest || captureListFocus();
    renderCounts();
    renderFilters();
    renderList();
    renderNotice();
    if (focus) restoreFocus(focus);
  }

  function renderCounts() {
    var counts = Core.countTasks(state.tasks);
    els.countTotal.textContent = counts.total;
    els.countActive.textContent = counts.active;
    els.countCompleted.textContent = counts.completed;
    els.segCounts.forEach(function (node) {
      node.textContent = counts[node.dataset.count];
    });
  }

  function renderFilters() {
    els.statusRadios.forEach(function (radio) {
      radio.checked = radio.value === state.filters.status;
    });
    els.priorityFilter.value = state.filters.priority;
  }

  function renderList() {
    var visible = visibleTasks();
    var fragment = document.createDocumentFragment();
    visible.forEach(function (task) {
      var editing = state.editing && state.editing.id === task.id;
      fragment.appendChild(editing ? buildEditItem(task) : buildTaskItem(task));
    });
    els.list.replaceChildren(fragment);
    els.list.hidden = visible.length === 0;

    var total = state.tasks.length;
    if (total === 0) {
      els.summary.textContent = '';
    } else if (visible.length === total) {
      els.summary.textContent = plural(total, 'task');
    } else {
      els.summary.textContent = 'Showing ' + visible.length + ' of ' + plural(total, 'task');
    }

    renderEmptyState(visible.length);
  }

  function buildTaskItem(task) {
    var li = els.taskTemplate.content.firstElementChild.cloneNode(true);
    var titleId = 'task-title-' + task.id;
    var label = Core.PRIORITY_LABELS[task.priority];

    li.dataset.id = task.id;
    li.dataset.priority = task.priority;
    li.classList.toggle('is-completed', task.completed);

    var title = li.querySelector('.task-title');
    title.id = titleId;
    title.textContent = task.title; // textContent: user input is never parsed as HTML

    var badge = li.querySelector('.priority-badge');
    badge.id = 'task-priority-' + task.id;
    badge.dataset.priority = task.priority;
    li.querySelector('.priority-label').textContent = label;

    var date = li.querySelector('.task-date');
    date.textContent = (task.completed ? 'Completed ' : 'Added ') + formatDate(task.completed ? task.completedAt : task.createdAt);

    var toggle = li.querySelector('[data-role="toggle"]');
    toggle.checked = task.completed;
    toggle.setAttribute('aria-labelledby', titleId);
    toggle.setAttribute('aria-describedby', badge.id);

    li.querySelector('[data-role="edit"]').setAttribute('aria-label', 'Edit ' + quote(task.title));
    li.querySelector('[data-role="delete"]').setAttribute('aria-label', 'Delete ' + quote(task.title));
    return li;
  }

  function buildEditItem(task) {
    var draft = state.editing;
    var li = els.editTemplate.content.firstElementChild.cloneNode(true);
    li.dataset.id = task.id;

    var form = li.querySelector('.edit-form');
    form.setAttribute('aria-label', 'Edit task');

    var titleInput = li.querySelector('[data-role="edit-title"]');
    var prioritySelect = li.querySelector('[data-role="edit-priority"]');
    var error = li.querySelector('.edit-error');
    var counter = li.querySelector('.edit-count');

    titleInput.id = 'edit-title-' + task.id;
    prioritySelect.id = 'edit-priority-' + task.id;
    error.id = 'edit-error-' + task.id;
    li.querySelector('[data-for="title"]').htmlFor = titleInput.id;
    li.querySelector('[data-for="priority"]').htmlFor = prioritySelect.id;
    counter.id = 'edit-count-' + task.id;
    titleInput.setAttribute('aria-describedby', error.id + ' ' + counter.id);

    titleInput.value = draft.title;
    updateCounter(titleInput, counter);
    prioritySelect.value = draft.priority;
    setFieldError(titleInput, error, draft.error);
    return li;
  }

  function renderEmptyState(visibleCount) {
    if (visibleCount > 0) {
      els.empty.hidden = true;
      return;
    }
    var counts = Core.countTasks(state.tasks);
    var status = state.filters.status;
    var priority = state.filters.priority;
    var pLabel = priority === 'all' ? '' : Core.PRIORITY_LABELS[priority].toLowerCase() + '-priority ';
    var title;
    var body;

    if (counts.total === 0) {
      title = 'No tasks yet';
      body = state.canSave
        ? 'Add your first task above. Everything is saved automatically in this browser.'
        : 'Add your first task above to get started.';
    } else if (status === 'active' && counts.active === 0) {
      title = 'All caught up';
      body = 'Every task is complete. Switch to Completed to review them.';
    } else if (status === 'completed' && counts.completed === 0) {
      title = 'Nothing completed yet';
      body = 'Tasks you check off will appear here.';
    } else {
      var statusWord = status === 'all' ? '' : status + ' ';
      title = 'No ' + statusWord + pLabel + 'tasks';
      body = 'Try a different status or priority, or clear the filters to see everything.';
    }

    els.emptyTitle.textContent = title;
    els.emptyBody.textContent = body;
    els.emptyReset.hidden = counts.total === 0 || !filtersActive();
    els.empty.hidden = false;
  }

  var renderedNoticeKey = '';

  function renderNotice() {
    var status = state.canSave
      ? 'Tasks are saved automatically in this browser.'
      : 'Changes aren’t being saved right now.';
    if (els.saveStatus.textContent !== status) els.saveStatus.textContent = status;

    // Touch the alert region only when its content really changes, so
    // screen readers don't re-announce it on every render.
    var notice = state.notice;
    var visible = notice && state.dismissedNotice !== notice.reason;
    var key = visible ? notice.kind + '|' + notice.reason + '|' + notice.message : '';
    if (key === renderedNoticeKey) return;
    renderedNoticeKey = key;
    if (!visible) {
      els.notice.hidden = true;
      els.notice.removeAttribute('role');
      return;
    }
    els.notice.className = 'notice notice-' + notice.kind;
    // Warnings interrupt; informational notices are announced politely.
    els.notice.setAttribute('role', notice.kind === 'warning' ? 'alert' : 'status');
    els.noticeMessage.textContent = notice.message;
    els.notice.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Focus management (the list is rebuilt on every render)
  // ---------------------------------------------------------------------------

  function captureListFocus() {
    var active = document.activeElement;
    if (!active || !els.list.contains(active)) return null;
    var role = active.dataset.role;
    var id = itemIdFrom(active);
    if (!role || !id) return null;
    var req = { id: id, role: role, index: visibleIndex(id) };
    if (typeof active.selectionStart === 'number') {
      req.selection = [active.selectionStart, active.selectionEnd];
    }
    return req;
  }

  /**
   * Focuses `role` within the task `id`; if that task is no longer visible,
   * focuses the same control on the task now at `index` (or the one before
   * it), and finally the list heading.
   */
  function restoreFocus(req) {
    var target = null;
    if (req.id) {
      var li = els.list.querySelector('.task[data-id="' + cssEscape(req.id) + '"]');
      if (li) target = li.querySelector('[data-role="' + req.role + '"]') || li.querySelector('[data-role="toggle"]');
    }
    if (!target && typeof req.index === 'number' && req.index >= 0) {
      var items = els.list.querySelectorAll('.task');
      if (items.length) {
        var item = items[Math.min(req.index, items.length - 1)];
        target = item.querySelector('[data-role="' + req.role + '"]') || item.querySelector('[data-role="toggle"]');
      }
    }
    if (!target) target = els.listHeading;
    target.focus();
    if (req.select && typeof target.select === 'function') {
      target.select();
    } else if (req.selection && typeof target.setSelectionRange === 'function') {
      try {
        target.setSelectionRange(req.selection[0], req.selection[1]);
      } catch (err) { /* not a text input */ }
    }
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
  }

  // ---------------------------------------------------------------------------
  // Toast (undo / show-all actions)
  // ---------------------------------------------------------------------------

  var toastTimer = null;
  var toastAction = null;
  var toastIsUndo = false;

  function showToast(message, actionLabel, onAction, isUndo) {
    toastAction = onAction;
    toastIsUndo = isUndo === true;
    els.toastMessage.textContent = message;
    els.toastAction.textContent = actionLabel;
    if (toastIsUndo) {
      els.toastAction.setAttribute('aria-keyshortcuts', 'Control+Z Meta+Z');
      els.toastAction.title = 'Undo (Ctrl+Z / ⌘Z)';
    } else {
      els.toastAction.removeAttribute('aria-keyshortcuts');
      els.toastAction.removeAttribute('title');
    }
    els.toast.hidden = false;
    startToastTimer();
  }

  function startToastTimer() {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { hideToast(false); }, TOAST_MS);
  }

  function hideToast(restoreFocusToList) {
    clearTimeout(toastTimer);
    var hadFocus = els.toast.contains(document.activeElement);
    els.toast.hidden = true;
    toastAction = null;
    toastIsUndo = false;
    if (hadFocus || restoreFocusToList) els.listHeading.focus();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function addTask(event) {
    event.preventDefault();
    var now = Date.now();
    var check = Core.validateTitle(els.titleInput.value);
    var recentlyAdded = now - state.lastAdd.at < RESUBMIT_GUARD_MS;

    if (!check.ok) {
      // A double-click/Enter right after a successful add hits the cleared
      // input — ignore it instead of flashing an error.
      if (check.value === '' && recentlyAdded) return;
      setFieldError(els.titleInput, els.titleError, check.error);
      els.titleInput.focus();
      return;
    }
    if (recentlyAdded && check.value === state.lastAdd.title) return; // duplicate submission

    var task = Core.createTask(
      { title: check.value, priority: els.prioritySelect.value },
      { now: now, taken: takenIds() }
    );
    state.lastAdd = { at: now, title: task.title };
    els.titleInput.value = '';
    updateCounter(els.titleInput, els.titleCount);
    setFieldError(els.titleInput, els.titleError, null);

    var hidden = !Core.matchesFilters(task, state.filters);
    commit([task].concat(state.tasks), {
      announce: 'Added ' + quote(task.title) + '.' + (hidden ? ' It is hidden by the current filters.' : '')
    });
    els.titleInput.focus();
    if (hidden) showToast('Task added, but hidden by your filters.', 'Show all', clearFilters);
  }

  function setCompleted(id, completed) {
    var task = findTask(id);
    if (!task) {
      render();
      return;
    }
    var index = visibleIndex(id);
    var updated = Core.updateTask(task, { completed: completed }, Date.now());
    if (updated === task) {
      render();
      return;
    }
    var stillVisible = Core.matchesFilters(updated, state.filters);
    commit(replaceTask(updated), {
      focus: { id: id, role: 'toggle', index: index },
      announce: quote(updated.title) + (updated.completed ? ' marked complete.' : ' restored to active.') +
        (stillVisible ? '' : ' Hidden by the current filter.')
    });
  }

  function startEdit(id) {
    var task = findTask(id);
    if (!task) return;
    state.editing = { id: id, title: task.title, priority: task.priority, error: null };
    render({ id: id, role: 'edit-title', select: true });
  }

  function cancelEdit() {
    if (!state.editing) return;
    var id = state.editing.id;
    state.editing = null;
    render({ id: id, role: 'edit', index: visibleIndex(id) });
    announce('Edit cancelled.');
  }

  function saveEdit() {
    var draft = state.editing;
    if (!draft) return;
    var task = findTask(draft.id);
    if (!task) {
      state.editing = null;
      render();
      announce('That task no longer exists.');
      return;
    }
    var check = Core.validateTitle(draft.title);
    if (!check.ok) {
      draft.error = check.error;
      render({ id: draft.id, role: 'edit-title' });
      return;
    }

    var index = visibleIndex(draft.id);
    var updated = Core.updateTask(task, { title: check.value, priority: draft.priority }, Date.now());
    state.editing = null;

    if (updated === task) {
      render({ id: task.id, role: 'edit', index: index });
      announce('No changes to save.');
      return;
    }
    var hidden = !Core.matchesFilters(updated, state.filters);
    commit(replaceTask(updated), {
      focus: { id: updated.id, role: 'edit', index: index },
      announce: 'Saved ' + quote(updated.title) + '.' + (hidden ? ' It is hidden by the current filters.' : '')
    });
    if (hidden) showToast('Task saved, but hidden by your filters.', 'Show all', clearFilters);
  }

  function deleteTask(id) {
    var position = -1;
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) position = i;
    }
    if (position === -1) return;

    var task = state.tasks[position];
    var index = visibleIndex(id);
    if (state.editing && state.editing.id === id) state.editing = null;

    var next = state.tasks.slice();
    next.splice(position, 1);
    commit(next, { focus: { id: null, role: 'delete', index: index } });
    showToast('Deleted ' + quote(task.title, 40), 'Undo', function () {
      restoreTask(task, position);
    }, true);
    announce('Deleted ' + quote(task.title) + '. Press Control+Z to undo.');
  }

  function restoreTask(task, position) {
    if (findTask(task.id)) return;
    var next = state.tasks.slice();
    next.splice(Math.min(position, next.length), 0, task);
    commit(next, {
      focus: { id: task.id, role: 'toggle' },
      announce: 'Restored ' + quote(task.title) + '.'
    });
  }

  function setFilter(key, value) {
    if (state.filters[key] === value) return;
    state.filters[key] = value;
    saveFilters();
    render();
    var n = visibleTasks().length;
    announce('Showing ' + plural(n, 'task') + '.');
  }

  function clearFilters() {
    state.filters = Core.normalizeFilters(null);
    saveFilters();
    render();
    announce('Filters cleared. Showing ' + plural(state.tasks.length, 'task') + '.');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function bindEvents() {
    els.form.addEventListener('submit', addTask);

    els.titleInput.addEventListener('input', function () {
      updateCounter(els.titleInput, els.titleCount);
      if (els.titleInput.hasAttribute('aria-invalid') && Core.validateTitle(els.titleInput.value).ok) {
        setFieldError(els.titleInput, els.titleError, null);
      }
    });

    els.statusRadios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) setFilter('status', radio.value);
      });
    });
    els.priorityFilter.addEventListener('change', function () {
      setFilter('priority', els.priorityFilter.value);
    });
    els.emptyReset.addEventListener('click', function () {
      clearFilters();
      els.listHeading.focus();
    });

    els.list.addEventListener('change', function (event) {
      var target = event.target;
      if (target.matches('[data-role="toggle"]')) {
        setCompleted(itemIdFrom(target), target.checked);
      } else if (target.matches('[data-role="edit-priority"]') && state.editing) {
        state.editing.priority = target.value;
      }
    });

    els.list.addEventListener('input', function (event) {
      var target = event.target;
      if (target.matches('[data-role="edit-title"]') && state.editing) {
        state.editing.title = target.value;
        updateCounter(target, target.form.querySelector('.edit-count'));
        if (state.editing.error && Core.validateTitle(target.value).ok) {
          state.editing.error = null;
          var error = target.form.querySelector('.edit-error');
          setFieldError(target, error, null);
        }
      }
    });

    els.list.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-role]');
      if (!button) return;
      var id = itemIdFrom(button);
      switch (button.dataset.role) {
        case 'edit': startEdit(id); break;
        case 'delete': deleteTask(id); break;
        case 'cancel': cancelEdit(); break;
        default: break;
      }
    });

    els.list.addEventListener('submit', function (event) {
      if (event.target.matches('.edit-form')) {
        event.preventDefault();
        saveEdit();
      }
    });

    els.list.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && event.target.closest('.edit-form')) {
        event.preventDefault();
        cancelEdit();
      }
    });

    els.noticeDismiss.addEventListener('click', function () {
      if (state.notice) state.dismissedNotice = state.notice.reason;
      renderNotice();
      els.titleInput.focus();
    });

    els.toastAction.addEventListener('click', function () {
      var action = toastAction;
      hideToast(false);
      if (action) action();
    });
    els.toastDismiss.addEventListener('click', function () { hideToast(true); });
    // Don't let the toast vanish while someone is reading or reaching for it.
    els.toast.addEventListener('mouseenter', function () { clearTimeout(toastTimer); });
    els.toast.addEventListener('mouseleave', function () {
      if (!els.toast.contains(document.activeElement)) startToastTimer();
    });
    els.toast.addEventListener('focusin', function () { clearTimeout(toastTimer); });
    els.toast.addEventListener('focusout', function (event) {
      if (!els.toast.contains(event.relatedTarget)) startToastTimer();
    });
    document.addEventListener('keydown', function (event) {
      if (els.toast.hidden) return;
      if (event.key === 'Escape' && els.toast.contains(document.activeElement)) {
        hideToast(true);
        return;
      }
      var isUndoKey = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey &&
        (event.key === 'z' || event.key === 'Z');
      // Leave native text undo alone inside editable fields.
      var target = event.target;
      var editable = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) &&
        target.type !== 'checkbox' && target.type !== 'radio';
      if (isUndoKey && toastIsUndo && !editable) {
        event.preventDefault();
        var action = toastAction;
        hideToast(false);
        if (action) action();
      }
    });

    // Keep multiple open tabs in sync instead of overwriting each other.
    window.addEventListener('storage', function (event) {
      if (!storage.store || event.storageArea !== storage.store) return;
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      var parsed = Core.parseStoredTasks(event.key === null ? readStored() : event.newValue);
      if (parsed.status === 'corrupt') return;
      state.tasks = parsed.tasks;
      if (state.editing && !findTask(state.editing.id)) state.editing = null;
      render();
    });
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  function init() {
    var raw = readStored();
    var parsed = Core.parseStoredTasks(raw);
    state.tasks = parsed.tasks;
    state.filters = loadFilters();

    if (!storage.store) {
      setNotice({ kind: 'warning', reason: 'unavailable', message: MESSAGES.unavailable });
    } else if (!storage.writable) {
      setNotice({ kind: 'warning', reason: 'readonly', message: MESSAGES.readonly });
    } else if (parsed.status === 'corrupt' || parsed.status === 'partial') {
      // Keep a copy of what couldn't be read before it gets overwritten.
      var backedUp = writeStored(BACKUP_KEY, raw);
      var message = parsed.status === 'corrupt'
        ? 'Your saved tasks couldn’t be read, so the list started empty.'
        : plural(parsed.dropped, 'saved task') + (parsed.dropped === 1 ? ' was' : ' were') + ' unreadable and skipped.';
      if (backedUp) message += ' A copy of the original data was kept in this browser’s storage.';
      setNotice({ kind: 'info', reason: 'recovered', message: message });
    }

    bindEvents();
    render();
  }

  init();
})();
