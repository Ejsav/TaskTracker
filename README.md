# TaskTracker

A focused task manager built with plain HTML, CSS, and vanilla JavaScript: no frameworks, no build step, no network calls. Tasks are saved to `localStorage`, so they survive page refreshes and browser restarts.

## Features

- Add tasks with a title and a **Low / Medium / High** priority
- Edit a task's title and priority inline (**Enter** saves, **Esc** cancels). Completion state and creation date are kept.
- Mark tasks complete and restore them to active
- Delete tasks, with a short **Undo** window (button or **Ctrl/⌘+Z**)
- Filter by status (**All / Active / Completed**) and by priority. Filters stay as they are while you add, edit, complete, or delete tasks, and are remembered across reloads.
- Live total / active / completed counts
- Title validation: empty or whitespace-only titles are rejected, with a 200-character limit and a counter as you get close to it
- Automatic saving, with clear warnings if storage is unavailable, full, or contains unreadable data
- Keeps open tabs in sync
- Responsive layout, light and dark themes, keyboard operable, and screen-reader friendly. Priority is shown as text plus a signal-bar icon, so color is never the only cue.

## Running it

Open `index.html` in any modern browser. That's it.

To serve it over HTTP instead (optional):

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Project structure

```
index.html          Markup, templates for task rows and the edit form
css/styles.css      Design tokens, layout, components, responsive and theme rules
js/task-core.js     Pure logic: validation, ids, create/update, filtering, counts,
                    parsing and repairing stored data (no DOM; unit-tested in Node)
js/app.js           UI controller: state, rendering, events, persistence, focus handling
tests/              Node test runner suites (unit + Playwright end-to-end)
```

### Data model

Stored under the `tasktracker:v1` key:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "uuid",
      "title": "Ship landing page",
      "priority": "high",
      "completed": false,
      "createdAt": 1731196800000,
      "updatedAt": 1731196800000
    }
  ]
}
```

If stored data can't be read, the app starts with whatever could be recovered, tells the user, and keeps a copy of the original under `tasktracker:v1:unreadable-backup` before anything overwrites it.

## Tests

Requires Node.js 21+.

```bash
npm test             # everything
npm run test:unit    # core logic only, zero dependencies
npm run test:e2e     # browser tests (needs Playwright)
```

The end-to-end suite drives the real page in headless Chromium. It is skipped automatically if Playwright isn't installed. To enable it:

```bash
npm i -D playwright && npx playwright install chromium
```
