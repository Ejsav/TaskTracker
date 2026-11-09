'use strict';

/**
 * End-to-end tests that drive index.html in headless Chromium.
 * Requires Playwright (`npm i -D playwright && npx playwright install chromium`);
 * the suite is skipped automatically when it is not installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let playwright = null;
try {
  playwright = require('playwright');
} catch (err) {
  playwright = null;
}

const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const KEY = 'tasktracker:v1';
const skip = playwright ? false : 'playwright is not installed';

let browser;

test.before(async () => {
  if (playwright) browser = await playwright.chromium.launch();
});

test.after(async () => {
  if (browser) await browser.close();
});

/** Opens the app in a fresh context and records any JS errors. */
async function openApp(options = {}) {
  const context = await browser.newContext(options.context || {});
  if (options.initScript) await context.addInitScript(options.initScript);
  const page = await context.newPage();
  if (options.clock) await page.clock.install();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(APP_URL);
  return { context, page, errors };
}

async function addTask(page, title, priority = 'medium') {
  await page.fill('#task-title', title);
  await page.selectOption('#task-priority', priority);
  await page.click('.composer-submit');
  // Step past the duplicate-submission guard so consecutive adds are distinct.
  await page.waitForTimeout(650);
}

async function counts(page) {
  return page.evaluate(() => ({
    total: Number(document.getElementById('count-total').textContent),
    active: Number(document.getElementById('count-active').textContent),
    completed: Number(document.getElementById('count-completed').textContent)
  }));
}

async function titles(page) {
  return page.$$eval('#task-list .task-title', (nodes) => nodes.map((n) => n.textContent));
}

async function stored(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);
}

function row(page, title) {
  return page.locator('#task-list .task').filter({ has: page.locator('.task-title', { hasText: title }) });
}

test('shows an empty state and zero counts on first load', { skip }, async () => {
  const { context, page, errors } = await openApp();
  assert.deepEqual(await counts(page), { total: 0, active: 0, completed: 0 });
  assert.equal(await page.isVisible('#empty-state'), true);
  assert.equal(await page.textContent('#empty-title'), 'No tasks yet');
  assert.equal(await page.isVisible('#empty-reset'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('creates tasks with priorities, validates titles, and persists', { skip }, async () => {
  const { context, page, errors } = await openApp();

  // Empty and whitespace-only titles are rejected with an accessible error.
  await page.click('.composer-submit');
  assert.equal(await page.isVisible('#task-title-error'), true);
  assert.equal(await page.textContent('#task-title-error'), 'Enter a task title.');
  assert.equal(await page.getAttribute('#task-title', 'aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-title');

  await page.fill('#task-title', '     ');
  await page.press('#task-title', 'Enter');
  assert.equal(await page.isVisible('#task-title-error'), true);
  assert.equal(await page.locator('#task-list .task').count(), 0);

  // Typing a valid title clears the error.
  await page.fill('#task-title', 'x');
  assert.equal(await page.isVisible('#task-title-error'), false);
  assert.equal(await page.getAttribute('#task-title', 'aria-invalid'), null);

  await addTask(page, '  Ship   landing page  ', 'high');
  await addTask(page, 'Reply to emails', 'low');
  await addTask(page, 'Plan sprint', 'medium');

  assert.deepEqual(await titles(page), ['Plan sprint', 'Reply to emails', 'Ship landing page']);
  assert.deepEqual(await counts(page), { total: 3, active: 3, completed: 0 });
  assert.equal(await page.inputValue('#task-title'), '', 'input clears after adding');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-title', 'focus stays in input');
  assert.equal(await row(page, 'Ship landing page').locator('.priority-label').textContent(), 'High');
  assert.equal(await row(page, 'Reply to emails').locator('.priority-label').textContent(), 'Low');

  const data = await stored(page);
  assert.equal(data.version, 1);
  assert.equal(data.tasks.length, 3);
  assert.deepEqual(data.tasks.map((t) => t.priority), ['medium', 'low', 'high']);
  assert.equal(new Set(data.tasks.map((t) => t.id)).size, 3, 'ids are unique');

  // Survives a reload.
  await page.reload();
  assert.deepEqual(await titles(page), ['Plan sprint', 'Reply to emails', 'Ship landing page']);
  assert.deepEqual(await counts(page), { total: 3, active: 3, completed: 0 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('ignores accidental repeated submissions', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await page.fill('#task-title', 'Only once');
  await page.dblclick('.composer-submit');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#task-list .task').count(), 1);
  assert.equal(await page.isVisible('#task-title-error'), false, 'no error flash on double submit');
  assert.equal((await stored(page)).tasks.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('renders user text safely and handles unusual input', { skip }, async () => {
  const { context, page, errors } = await openApp();
  const nasty = '<img src=x onerror="window.__xss = true"><script>window.__xss = true</script>';
  await addTask(page, nasty);
  await addTask(page, 'Ünïcödé ✓ 日本語 🚀 — "quotes" & \'apostrophes\'');
  await addTask(page, 'a'.repeat(200));

  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#task-list img, #task-list script').count(), 0);
  const list = await titles(page);
  assert.equal(list[2], nasty);
  assert.equal(list[1], 'Ünïcödé ✓ 日本語 🚀 — "quotes" & \'apostrophes\'');
  assert.equal(list[0].length, 200);

  // A 200-char unbroken title must not overflow the layout.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);

  // maxlength caps input at 200 characters.
  await page.fill('#task-title', 'b'.repeat(250));
  assert.equal((await page.inputValue('#task-title')).length, 200);

  await page.reload();
  assert.equal((await titles(page))[2], nasty);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.deepEqual(errors, []);
  await context.close();
});

test('completes and restores tasks, keeping counts and storage in sync', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Alpha', 'high');
  await addTask(page, 'Beta', 'low');

  await row(page, 'Alpha').locator('[data-role="toggle"]').check();
  assert.deepEqual(await counts(page), { total: 2, active: 1, completed: 1 });
  assert.equal(await row(page, 'Alpha').evaluate((el) => el.classList.contains('is-completed')), true);
  assert.equal(await row(page, 'Alpha').locator('[data-role="toggle"]').isChecked(), true);
  assert.equal((await stored(page)).tasks.find((t) => t.title === 'Alpha').completed, true);
  // Focus stays on the toggled checkbox after the re-render.
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'toggle');

  // Keyboard: Space toggles the focused checkbox.
  await row(page, 'Beta').locator('[data-role="toggle"]').focus();
  await page.keyboard.press('Space');
  assert.deepEqual(await counts(page), { total: 2, active: 0, completed: 2 });

  // Restore.
  await row(page, 'Alpha').locator('[data-role="toggle"]').uncheck();
  assert.deepEqual(await counts(page), { total: 2, active: 1, completed: 1 });
  assert.equal(await row(page, 'Alpha').evaluate((el) => el.classList.contains('is-completed')), false);

  await page.reload();
  assert.equal(await row(page, 'Alpha').locator('[data-role="toggle"]').isChecked(), false);
  assert.equal(await row(page, 'Beta').locator('[data-role="toggle"]').isChecked(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('edits title and priority without losing other task data', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Draft proposal', 'low');
  await row(page, 'Draft proposal').locator('[data-role="toggle"]').check();
  const before = (await stored(page)).tasks[0];

  await row(page, 'Draft proposal').locator('[data-role="edit"]').click();
  const input = page.locator('[data-role="edit-title"]');
  assert.equal(await input.inputValue(), 'Draft proposal');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'edit-title');

  // Empty title is rejected; the edit stays open with an error.
  await input.fill('   ');
  await input.press('Enter');
  assert.equal(await page.isVisible('.edit-error'), true);
  assert.equal(await input.getAttribute('aria-invalid'), 'true');
  assert.equal((await stored(page)).tasks[0].title, 'Draft proposal');

  // Escape cancels without saving.
  await input.fill('Should not save');
  await input.press('Escape');
  assert.equal(await page.locator('.edit-form').count(), 0);
  assert.deepEqual(await titles(page), ['Draft proposal']);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'edit');

  // Save a real change via the Save button.
  await row(page, 'Draft proposal').locator('[data-role="edit"]').click();
  await page.fill('[data-role="edit-title"]', 'Final proposal');
  await page.selectOption('[data-role="edit-priority"]', 'high');
  await page.click('[data-role="save"]');

  const after = (await stored(page)).tasks[0];
  assert.equal(after.title, 'Final proposal');
  assert.equal(after.priority, 'high');
  assert.equal(after.id, before.id);
  assert.equal(after.completed, true, 'completion state preserved');
  assert.equal(after.createdAt, before.createdAt, 'creation time preserved');
  assert.equal(after.completedAt, before.completedAt, 'completion time preserved');
  assert.ok(after.updatedAt >= before.updatedAt);
  assert.equal(await row(page, 'Final proposal').locator('.priority-label').textContent(), 'High');
  assert.deepEqual(await counts(page), { total: 1, active: 0, completed: 1 });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'edit');
  assert.deepEqual(errors, []);
  await context.close();
});

test('an unsaved edit draft survives other list updates', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'One');
  await addTask(page, 'Two');
  await row(page, 'One').locator('[data-role="edit"]').click();
  await page.fill('[data-role="edit-title"]', 'One (edited)');
  await row(page, 'Two').locator('[data-role="toggle"]').check();
  assert.equal(await page.inputValue('[data-role="edit-title"]'), 'One (edited)');
  await page.click('[data-role="save"]');
  assert.deepEqual(await titles(page), ['Two', 'One (edited)']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('filters by status and priority, and filters persist across changes', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'High active', 'high');
  await addTask(page, 'High done', 'high');
  await addTask(page, 'Low active', 'low');
  await addTask(page, 'Medium done', 'medium');
  await row(page, 'High done').locator('[data-role="toggle"]').check();
  await row(page, 'Medium done').locator('[data-role="toggle"]').check();

  await page.click('label[for="status-active"]');
  assert.deepEqual(await titles(page), ['Low active', 'High active']);
  assert.equal(await page.textContent('#results-summary'), 'Showing 2 of 4 tasks');

  await page.click('label[for="status-completed"]');
  assert.deepEqual(await titles(page), ['Medium done', 'High done']);

  await page.selectOption('#priority-filter', 'high');
  assert.deepEqual(await titles(page), ['High done']);

  await page.click('label[for="status-all"]');
  assert.deepEqual(await titles(page), ['High done', 'High active']);

  // Adding a task that doesn't match keeps the filters and says so.
  await addTask(page, 'New low', 'low');
  assert.equal(await page.inputValue('#priority-filter'), 'high');
  assert.deepEqual(await titles(page), ['High done', 'High active']);
  assert.equal(await page.isVisible('#toast'), true);
  assert.match(await page.textContent('#toast-message'), /hidden by your filters/);
  assert.deepEqual(await counts(page), { total: 5, active: 3, completed: 2 });

  // Completing a task under "Active" hides it; focus moves to the next item.
  await page.click('label[for="status-active"]');
  assert.deepEqual(await titles(page), ['High active']);
  await row(page, 'High active').locator('[data-role="toggle"]').click();
  assert.deepEqual(await titles(page), []);
  assert.equal(await page.textContent('#empty-title'), 'No active high-priority tasks');
  assert.equal(await page.isVisible('#empty-reset'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-list-heading');

  // Clear filters from the empty state.
  await page.click('#empty-reset');
  assert.equal(await page.isChecked('#status-all'), true);
  assert.equal(await page.inputValue('#priority-filter'), 'all');
  assert.equal((await titles(page)).length, 5);

  // Segment counts mirror the header counts.
  const seg = await page.$$eval('.seg-count', (n) => n.map((x) => Number(x.textContent)));
  const c = await counts(page);
  assert.deepEqual(seg, [c.total, c.active, c.completed]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('deletes tasks predictably, with undo', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Keep A');
  await addTask(page, 'Remove me');
  await addTask(page, 'Keep B');
  await row(page, 'Remove me').locator('[data-role="toggle"]').check();

  await row(page, 'Remove me').locator('[data-role="delete"]').click();
  assert.deepEqual(await titles(page), ['Keep B', 'Keep A']);
  assert.deepEqual(await counts(page), { total: 2, active: 2, completed: 0 });
  assert.equal((await stored(page)).tasks.length, 2);
  // Focus lands on the next item's delete button, not lost to <body>.
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'delete');
  assert.equal(await page.isVisible('#toast'), true);

  // Undo restores the same task at its original position with its state.
  await page.click('#toast-action');
  assert.deepEqual(await titles(page), ['Keep B', 'Remove me', 'Keep A']);
  assert.deepEqual(await counts(page), { total: 3, active: 2, completed: 1 });
  assert.equal((await stored(page)).tasks.length, 3);
  assert.equal(await page.isVisible('#toast'), false);

  // Delete everything; the empty state returns and storage is empty.
  for (const t of ['Keep A', 'Keep B', 'Remove me']) {
    await row(page, t).locator('[data-role="delete"]').click();
  }
  assert.deepEqual(await titles(page), []);
  assert.equal(await page.isVisible('#empty-state'), true);
  assert.deepEqual((await stored(page)).tasks, []);
  await page.reload();
  assert.deepEqual(await counts(page), { total: 0, active: 0, completed: 0 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('recovers from corrupted storage without crashing', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await page.evaluate((key) => localStorage.setItem(key, '{"tasks": [ broken json'), KEY);
  await page.reload();
  assert.equal(await page.isVisible('#notice'), true);
  assert.match(await page.textContent('#notice-message'), /couldn’t be read/);
  assert.equal(await page.getAttribute('#notice', 'role'), 'status');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('tasktracker:v1:unreadable-backup')),
    '{"tasks": [ broken json'
  );
  await addTask(page, 'Fresh start');
  assert.equal((await stored(page)).tasks[0].title, 'Fresh start');

  // Partially valid data: good records survive, bad ones are counted.
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    tasks: [{ id: 'ok-1', title: 'Survivor', priority: 'high', completed: true, createdAt: 1, updatedAt: 1 }, { title: '' }, 7]
  })), KEY);
  await page.reload();
  assert.deepEqual(await titles(page), ['Survivor']);
  assert.match(await page.textContent('#notice-message'), /2 saved tasks were unreadable/);
  assert.deepEqual(await counts(page), { total: 1, active: 0, completed: 1 });

  // Notice can be dismissed.
  await page.click('#notice-dismiss');
  assert.equal(await page.isVisible('#notice'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('keeps working when localStorage is unavailable', { skip }, async () => {
  const { context, page, errors } = await openApp({
    initScript: () => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('Access denied', 'SecurityError'); }
      });
    }
  });
  assert.equal(await page.isVisible('#notice'), true);
  assert.equal(await page.getAttribute('#notice', 'role'), 'alert');
  assert.match(await page.textContent('#notice-message'), /can’t be saved/);
  assert.equal(await page.textContent('#save-status'), 'Changes aren’t being saved right now.');
  assert.doesNotMatch(await page.textContent('#empty-body'), /saved automatically/);

  await addTask(page, 'Session only', 'high');
  await row(page, 'Session only').locator('[data-role="toggle"]').check();
  await row(page, 'Session only').locator('[data-role="edit"]').click();
  await page.fill('[data-role="edit-title"]', 'Session only (edited)');
  await page.press('[data-role="edit-title"]', 'Enter');
  assert.deepEqual(await titles(page), ['Session only (edited)']);
  assert.deepEqual(await counts(page), { total: 1, active: 0, completed: 1 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('warns when saving fails and clears the warning once saving works again', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Saved fine');
  assert.equal(await page.isVisible('#notice'), false);

  await page.evaluate(() => {
    window.__realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
  await addTask(page, 'Not saved');
  assert.deepEqual(await titles(page), ['Not saved', 'Saved fine'], 'app keeps working in-session');
  assert.deepEqual(await counts(page), { total: 2, active: 2, completed: 0 });
  assert.equal(await page.isVisible('#notice'), true);
  assert.match(await page.textContent('#notice-message'), /couldn’t be saved/);
  assert.equal(await page.textContent('#save-status'), 'Changes aren’t being saved right now.');
  // Dismissing the warning doesn't hide the persistent footer status.
  await page.click('#notice-dismiss');
  await addTask(page, 'Still not saved');
  assert.equal(await page.isVisible('#notice'), false, 'dismissed warning stays dismissed while failures continue');
  assert.equal(await page.textContent('#save-status'), 'Changes aren’t being saved right now.');

  await page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });
  await row(page, 'Saved fine').locator('[data-role="toggle"]').check();
  assert.equal(await page.isVisible('#notice'), false);
  assert.equal(await page.textContent('#save-status'), 'Tasks are saved automatically in this browser.');
  assert.equal((await stored(page)).tasks.length, 3);
  assert.deepEqual(errors, []);
  await context.close();
});

test('stays in sync across two open tabs', { skip }, async () => {
  const { context, page, errors } = await openApp();
  const second = await context.newPage();
  await second.goto(APP_URL);
  await addTask(page, 'From tab one', 'high');
  await second.waitForFunction(() => document.querySelectorAll('#task-list .task').length === 1);
  assert.deepEqual(await titles(second), ['From tab one']);
  assert.equal(await second.textContent('#count-total'), '1');
  assert.deepEqual(errors, []);
  await context.close();
});

test('is fully operable with the keyboard', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await page.focus('#task-title');
  await page.keyboard.type('Keyboard task');
  await page.keyboard.press('Tab'); // priority select
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-priority');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  assert.deepEqual(await titles(page), ['Keyboard task']);

  // Tab through filters into the list: checkbox, Edit, Delete.
  await page.focus('#status-all');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.isChecked('#status-active'), true, 'arrow keys move between status filters');
  await page.keyboard.press('ArrowLeft');
  await page.focus('#priority-filter');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'toggle');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'edit');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' updated');
  await page.keyboard.press('Enter');
  // Text was selected on entering edit mode, so typing replaces it.
  assert.deepEqual(await titles(page), ['updated']);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.role), 'delete');
  await page.keyboard.press('Enter');
  assert.deepEqual(await titles(page), []);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-list-heading');

  // Focus indicator is visible on a focused control.
  await page.focus('#task-title');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  assert.notEqual(ring, 'none');
  assert.deepEqual(errors, []);
  await context.close();
});

test('fits a phone-width viewport without horizontal scrolling', { skip }, async () => {
  const { context, page, errors } = await openApp({ context: { viewport: { width: 360, height: 740 } } });
  await addTask(page, 'A reasonably long task title that needs to wrap on a narrow phone screen', 'high');
  await addTask(page, 'Short', 'low');
  await row(page, 'Short').locator('[data-role="edit"]').click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);
  // Icon-only action buttons still have accessible names.
  const label = await row(page, 'A reasonably long').locator('[data-role="delete"]').getAttribute('aria-label');
  assert.match(label, /^Delete “A reasonably long/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('remembers filter choices across reloads and ignores bad saved preferences', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Open high', 'high');
  await addTask(page, 'Open low', 'low');
  await page.click('label[for="status-active"]');
  await page.selectOption('#priority-filter', 'high');
  await page.reload();
  assert.equal(await page.isChecked('#status-active'), true);
  assert.equal(await page.inputValue('#priority-filter'), 'high');
  assert.deepEqual(await titles(page), ['Open high']);
  assert.equal(await page.textContent('#results-summary'), 'Showing 1 of 2 tasks');

  await page.evaluate(() => localStorage.setItem('tasktracker:v1:view', '{"status":"bogus","priority":'));
  await page.reload();
  assert.equal(await page.isChecked('#status-all'), true);
  assert.equal(await page.inputValue('#priority-filter'), 'all');
  assert.equal(await page.isVisible('#notice'), false, 'bad view prefs are not worth a warning');
  assert.deepEqual(errors, []);
  await context.close();
});

test('shows a character counter near the title limit', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await page.fill('#task-title', 'x'.repeat(100));
  assert.equal(await page.isVisible('#task-title-count'), false);
  await page.fill('#task-title', 'x'.repeat(170));
  assert.equal(await page.textContent('#task-title-count'), '170/200');
  await page.fill('#task-title', 'x'.repeat(200));
  assert.equal(await page.getAttribute('#task-title-count', 'class'), 'char-count is-limit');
  await page.click('.composer-submit');
  assert.equal(await page.isVisible('#task-title-count'), false, 'counter resets after adding');

  await row(page, 'xxxx').locator('[data-role="edit"]').click();
  assert.equal(await page.textContent('.edit-count'), '200/200');
  await page.fill('[data-role="edit-title"]', 'short');
  assert.equal(await page.isVisible('.edit-count'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Ctrl+Z undoes a delete, but not while typing in a field', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'First');
  await addTask(page, 'Second');
  assert.equal(await page.getAttribute('#toast-action', 'aria-keyshortcuts'), null);

  await row(page, 'Second').locator('[data-role="delete"]').click();
  assert.equal(await page.getAttribute('#toast-action', 'aria-keyshortcuts'), 'Control+Z Meta+Z');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await titles(page), ['Second', 'First']);
  assert.equal(await page.isVisible('#toast'), false);

  await row(page, 'Second').locator('[data-role="delete"]').click();
  await page.focus('#task-title');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await titles(page), ['First'], 'native text undo is left alone in inputs');
  assert.equal(await page.isVisible('#toast'), true);

  // A second undo after the toast closed does nothing.
  await page.click('#toast-dismiss');
  await page.focus('#task-list-heading');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await titles(page), ['First']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('toast auto-hides, pauses while focused, and closes with Escape', { skip }, async () => {
  const { context, page, errors } = await openApp({ clock: true });
  await page.fill('#task-title', 'Ephemeral');
  await page.click('.composer-submit');
  await row(page, 'Ephemeral').locator('[data-role="delete"]').click();
  assert.equal(await page.isVisible('#toast'), true);
  await page.clock.fastForward(7500);
  assert.equal(await page.isVisible('#toast'), false);

  await page.fill('#task-title', 'Second');
  await page.click('.composer-submit');
  await row(page, 'Second').locator('[data-role="delete"]').click();
  await page.focus('#toast-action');
  await page.clock.fastForward(20000);
  assert.equal(await page.isVisible('#toast'), true, 'stays open while focused');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#toast'), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-list-heading');
  assert.deepEqual(await titles(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('"Show all" reveals a task hidden by an edit', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Retitle me', 'high');
  await page.selectOption('#priority-filter', 'high');
  await row(page, 'Retitle me').locator('[data-role="edit"]').click();
  await page.selectOption('[data-role="edit-priority"]', 'low');
  await page.press('[data-role="edit-title"]', 'Enter');
  assert.deepEqual(await titles(page), []);
  assert.match(await page.textContent('#toast-message'), /saved, but hidden/);
  await page.click('#toast-action');
  assert.equal(await page.inputValue('#priority-filter'), 'all');
  assert.deepEqual(await titles(page), ['Retitle me']);
  assert.equal(await row(page, 'Retitle me').locator('.priority-label').textContent(), 'Low');
  assert.deepEqual(errors, []);
  await context.close();
});

test('reports "no changes" when an edit is saved untouched', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Untouched', 'medium');
  const before = (await stored(page)).tasks[0];
  await row(page, 'Untouched').locator('[data-role="edit"]').click();
  await page.fill('[data-role="edit-title"]', '   Untouched   ');
  await page.click('[data-role="save"]');
  await page.waitForFunction(() => document.getElementById('live-region').textContent === 'No changes to save.');
  assert.deepEqual((await stored(page)).tasks[0], before, 'updatedAt untouched');
  assert.deepEqual(errors, []);
  await context.close();
});

test('loads existing tasks read-only when storage is full at startup', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Already saved', 'high');
  await context.addInitScript(() => {
    Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); };
  });
  await page.reload();
  assert.deepEqual(await titles(page), ['Already saved']);
  assert.equal(await page.getAttribute('#notice', 'role'), 'alert');
  assert.match(await page.textContent('#notice-message'), /full or blocked/);
  await addTask(page, 'In memory only');
  assert.deepEqual(await counts(page), { total: 2, active: 2, completed: 0 });
  assert.equal(await page.textContent('#save-status'), 'Changes aren’t being saved right now.');
  assert.deepEqual(errors, []);
  await context.close();
});

test('handles another tab deleting a task being edited, and ignores corrupt writes', { skip }, async () => {
  const { context, page, errors } = await openApp();
  const other = await context.newPage();
  await other.goto(APP_URL);
  await addTask(page, 'Shared task');
  await addTask(page, 'Keeper');
  await other.waitForFunction(() => document.querySelectorAll('#task-list .task').length === 2);

  await row(page, 'Shared task').locator('[data-role="edit"]').click();
  await row(other, 'Shared task').locator('[data-role="delete"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task').length === 1);
  assert.equal(await page.locator('.edit-form').count(), 0, 'edit mode closes when its task disappears');
  assert.deepEqual(await titles(page), ['Keeper']);

  await other.evaluate((key) => localStorage.setItem(key, 'not json at all'), KEY);
  await page.waitForTimeout(200);
  assert.deepEqual(await titles(page), ['Keeper'], 'garbage from elsewhere is ignored');

  await other.evaluate(() => localStorage.clear());
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task').length === 0);
  assert.equal(await page.textContent('#count-total'), '0');
  assert.deepEqual(errors, []);
  await context.close();
});

test('undoing a delete under a filter restores counts even if the task stays hidden', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Done thing');
  await addTask(page, 'Open thing');
  await row(page, 'Done thing').locator('[data-role="toggle"]').check();
  await page.click('label[for="status-completed"]');
  await row(page, 'Done thing').locator('[data-role="delete"]').click();
  assert.equal(await page.textContent('#empty-title'), 'Nothing completed yet');
  await page.click('label[for="status-active"]');
  await page.click('#toast-action');
  assert.deepEqual(await counts(page), { total: 2, active: 1, completed: 1 });
  assert.deepEqual(await titles(page), ['Open thing']);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'task-list-heading');
  assert.deepEqual(errors, []);
  await context.close();
});

test('exposes accessible names and structure for every control', { skip }, async () => {
  const { context, page, errors } = await openApp();
  await addTask(page, 'Label check', 'high');
  const toggle = row(page, 'Label check').locator('[data-role="toggle"]');
  assert.equal(await toggle.evaluate((el) => document.getElementById(el.getAttribute('aria-labelledby')).textContent), 'Label check');
  assert.equal(
    await toggle.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby')).textContent.replace(/\s+/g, ' ').trim()),
    'High priority'
  );
  assert.equal(await page.getByRole('checkbox', { name: 'Label check' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Edit “Label check”' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Delete “Label check”' }).count(), 1);
  assert.equal(await page.getByLabel('New task').count(), 1);
  assert.equal(await page.getByRole('combobox', { name: 'Priority' }).count(), 2);
  assert.equal(await page.getByRole('radio', { name: /Active/ }).count(), 1);
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.getAttribute('html', 'lang'), 'en');

  await row(page, 'Label check').locator('[data-role="edit"]').click();
  assert.equal(await page.getByRole('textbox', { name: 'Task title' }).count(), 1);
  assert.equal(await page.getByRole('form', { name: 'Edit task' }).count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('does not re-announce an active warning on every change', { skip }, async () => {
  const { context, page, errors } = await openApp({
    initScript: () => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
    }
  });
  await page.evaluate(() => {
    window.__noticeMutations = 0;
    new MutationObserver((records) => { window.__noticeMutations += records.length; })
      .observe(document.getElementById('notice'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await addTask(page, 'One');
  await addTask(page, 'Two');
  await row(page, 'One').locator('[data-role="toggle"]').check();
  await page.click('label[for="status-completed"]');
  assert.equal(await page.evaluate(() => window.__noticeMutations), 0);
  assert.equal(await page.isVisible('#notice'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('shows the completion date, not the last edit date, for completed tasks', { skip }, async () => {
  const { context, page, errors } = await openApp();
  const yesterday = Date.now() - 86400000 * 3;
  await page.evaluate(({ key, ts }) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    tasks: [{ id: 'done-1', title: 'Old win', priority: 'low', completed: true, createdAt: ts, updatedAt: ts, completedAt: ts }]
  })), { key: KEY, ts: yesterday });
  await page.reload();
  const expected = await page.evaluate((ts) => 'Completed ' + new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts)), yesterday);
  assert.equal(await row(page, 'Old win').locator('.task-date').textContent(), expected);
  await row(page, 'Old win').locator('[data-role="edit"]').click();
  await page.fill('[data-role="edit-title"]', 'Old win, renamed');
  await page.press('[data-role="edit-title"]', 'Enter');
  assert.equal(await row(page, 'Old win, renamed').locator('.task-date').textContent(), expected);
  assert.equal((await stored(page)).tasks[0].completedAt, yesterday);
  assert.deepEqual(errors, []);
  await context.close();
});
