# Changelog

## 2.0.0 (2026-10-10)

A rewrite. Same idea as v1 (keep a web or hybrid app working when the server cannot be reached), rebuilt on `fetch` with no dependencies.

- `createOajax()` and a shared `oajax` client. Reads are network-first with a cached fallback (`cache-first` and `network-only` available). Writes that hit a network error, a timeout, a retryable status or an offline browser are saved to an outbox and resolve with `{ queued: true, id, idempotencyKey }`; `queue: false` opts out.
- Outbox: first-in, first-out, persisted in IndexedDB (localStorage and memory adapters too, or your own). Replays on `online`, on page visibility, on a backoff timer and on `flush()`; stops at the first failure so order is kept; exponential backoff with jitter; dead-letter list after `maxAttempts` or a non-retryable rejection; `Idempotency-Key` header generated before the first attempt and reused on every retry; `prepareReplay` hook; `queued`, `replayed`, `failed`, `dead` and `drained` events. Web Locks keep two tabs from replaying the same outbox at once, where available.
- Read cache keyed by method, URL and a body hash, with `maxAge` and `maxEntries`, and `clear`, `delete` and `prune`.
- `oajax.js/jquery`: a v1-style `$oajax` (jQuery option names, `success` / `error` / `complete`, a promise-like jqXHR) and `installJQuery($, { patchAjax })`. jQuery is no longer required.
- `dist/oajax.min.js`: script-tag build exposing `window.oajax` and `window.$oajax` (and `jQuery.oajax` when jQuery is on the page).
- TypeScript types, ESM and CommonJS builds, no globals, safe to import during server rendering.
- 52 tests with vitest, jsdom and fake-indexeddb. **Not yet tested in a real browser or WebView.**

### Fixed from v1

- The error path called the `success` handler.
- Queue entries were removed with `splice` while the queue was being iterated, skipping items.
- Replays used `async: false`, blocking the page.
- `sync_que` and `ref_cache` leaked as globals.
- Writes were replayed in no guaranteed order, with no idempotency key, forever every 10 seconds.
- The app could not tell that a request had been queued.

### Breaking

- `$.ajax` is no longer patched by default; call `installJQuery(jQuery, { patchAjax: true })` for v1 behaviour. `$oajax` and `$.oajax` are added as before.
- A queued write calls `queued` (if given) or `error` with `textStatus` `'queued'`, never `success`.
- `oajax.parseResult`, `oajax.logMsg`, `oajax.getQue`, `oajax.queHandle` and `oajax.syncData` are gone.
- Storage moved from localStorage (`sync_que`, `cache@...`, `request@...`) to IndexedDB; v1's queue is not migrated.
- `bower.json` is removed (Bower is deprecated); install from npm or a CDN. The committed v1 `dist/oajax.min.js` is removed from the repository (it stays in git history; v2 builds into `dist/`). The v1 source and demo are in `examples/v1`.

## 1.0.0 (2017)

First release: a jQuery `$.ajax` patch that cached successful responses in localStorage and queued failed requests for replay every 10 seconds.
