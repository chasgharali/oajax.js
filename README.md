# oajax.js

Offline-first requests for web and hybrid apps (PWA, Cordova, Capacitor). Built on `fetch`, with no dependencies.

- **Reads** (GET, HEAD) go to the network first. If the network is unreachable, you get the last good copy from a local cache instead of an error.
- **Writes** (POST, PUT, PATCH, DELETE) that cannot reach the server are saved to a local **outbox**. The call resolves with `{ queued: true, id }` so your UI can say "saved offline, will sync". When the connection returns, the outbox is replayed **in order**, each request carrying the same **`Idempotency-Key`** it had the first time.

This is version 2. Version 1 (2017) was a jQuery plugin with the same idea. v2 is a rewrite that fixes its bugs and keeps a v1-style `$oajax` so old apps can move over by swapping the script. See [Moving from v1](#moving-from-v1).

## Install

```sh
npm install oajax.js
```

Or with a script tag (exposes `window.oajax` and `window.$oajax`):

```html
<script src="https://cdn.jsdelivr.net/npm/oajax.js@2/dist/oajax.min.js"></script>
```

ESM and CommonJS, with TypeScript types. Size, minified and gzipped: the core is about 5.6 KB, the core plus the jQuery-style adapter about 6.7 KB, and the script-tag build about 7.3 KB.

## Quick start

```ts
import { createOajax } from 'oajax.js'

const api = createOajax()

// Reads: network first, cached copy when offline.
const res = await api('/api/notes')
if (res.queued === false) {
  render(res.data)
  if (res.fromCache) showBanner('You are offline. Showing saved data.')
}

// Writes: sent now, or queued and replayed later.
const saved = await api({ url: '/api/notes', method: 'POST', body: { text: 'Buy milk' } })
if (saved.queued) showToast('Saved offline, will sync')

// Tell the user when queued writes go through (or give up).
api.on('replayed', ({ item, response }) => markSynced(item.meta, response.data))
api.on('dead', ({ item }) => showError(`Could not save: ${item.lastError}`))
```

There is also a shared client, created on first use, if you do not need options:

```ts
import { oajax, configure } from 'oajax.js'

configure({ retry: { maxAttempts: 10 } }) // optional, before the first request
await oajax('/api/me')
```

## How it decides

| Request | Network OK | Network error, timeout, or 408 / 425 / 429 / 5xx | Other 4xx |
| --- | --- | --- | --- |
| GET / HEAD (`network-first`) | response, and it is cached | cached copy (`fromCache: true`), else rejects with `OajaxNetworkError` | rejects with `OajaxHttpError` |
| POST / PUT / PATCH / DELETE | response | queued: resolves `{ queued: true, id, idempotencyKey }` | rejects with `OajaxHttpError` |

A few rules on top of that:

- If the browser reports it is offline (`navigator.onLine === false`), reads answer from the cache without waiting for the network, and writes are queued without being tried.
- If the outbox already has waiting writes, a new write is queued behind them even when the network is back. **Later writes never overtake earlier ones.**
- A write is only queued if its body can be stored: a string, `URLSearchParams`, or a plain object or array (sent as JSON). A write with `FormData`, a `Blob` or binary data is sent normally, but if it fails it rejects instead of queueing.
- `queue: false` on a request (or on the client) turns queueing off: the write fails like plain `fetch` would.
- A caller's `AbortSignal` always wins: an aborted request rejects with `AbortError`, is never queued and never answered from the cache.

## Replay: order, retries and idempotency

The outbox is a first-in, first-out list stored on the device. It is replayed:

- when the browser fires `online`;
- when the page becomes visible again;
- on a timer, after each failure, with exponential backoff;
- when you call `api.flush()` (which ignores the backoff and tries now).

Replay sends the oldest item first and **stops at the first failure**, so item 3 is never sent before item 2. The failed item is retried after `baseDelay × 2^(attempts − 1)` (2 s, 4 s, 8 s ... capped at 15 minutes, with jitter). After `maxAttempts` (default 15: about an hour to an hour and a half of an unreachable server, depending on jitter) it moves to the **dead-letter list**, and replay moves on.

If the server is reachable and answers with a status that will not get better by retrying (a 4xx other than 408, 425 and 429), the item goes straight to the dead-letter list with `reason: 'rejected'` and replay continues with the next one. Dead items are kept until you call `outbox.retryDead()` or `outbox.clearDead()`.

Every write gets an idempotency key **before its first attempt**, sent as an `Idempotency-Key` header, stored with the item and sent again, unchanged, on every retry. That matters because "the request failed" on the client does not mean the server did not get it: the connection can drop after the server has saved the note but before the response arrives. With the key, the server can recognise the retry.

### What the server needs to do

oajax can only promise **at-least-once** delivery. To get exactly-once effects, the server should deduplicate on the key:

1. On a write with an `Idempotency-Key`, look the key up (per user) in a table or cache.
2. If it has been seen, return the stored response without doing the work again.
3. If not, do the work and store the key with its response, in the same transaction if you can. Keep keys for at least as long as an item can sit in the outbox (days, not minutes).

This is the same pattern payment APIs use. If you cannot change the server, make the writes themselves idempotent (PUT to a client-generated id instead of POST to a collection).

## API

### `createOajax(options?)`

Returns a client. Creating it touches no browser API; storage is opened on first use.

| Option | Default | |
| --- | --- | --- |
| `storage` | `'auto'` | `'auto'` (IndexedDB, then localStorage, then memory), `'indexeddb'`, `'localstorage'`, `'memory'`, or your own `StorageAdapter` |
| `name` | `'oajax'` | IndexedDB database name / localStorage key prefix. Give separate clients separate names. |
| `strategy` | `'network-first'` | default for reads: also `'cache-first'` or `'network-only'` |
| `timeout` | `20000` | ms per attempt; `0` for none. A timeout counts as a network failure. |
| `cache` | `{ maxAge: 7 days, maxEntries: 200 }` | or `false` to turn the read cache off |
| `retry` | `{ baseDelay: 2000, maxDelay: 900000, maxAttempts: 15, jitter: true }` | |
| `idempotencyHeader` | `'Idempotency-Key'` | header name, or `false` to not send one |
| `queue` | `true` | `false` to never queue new writes |
| `prepareReplay` | | `(request, item) => request`: change a request just before it is replayed, e.g. add a fresh auth token |
| `isRetryableStatus` | 408, 425, 429, 5xx | which statuses mean "try again later" |
| `isOnline` | `navigator.onLine` | override if your platform reports it wrongly |
| `autoStart` | `true` in a browser | listen for `online` and replay automatically |
| `pollInterval` | `30000` | while offline, how often to check again |
| `fetch` | `globalThis.fetch` | |

### `api(request)` / `api.request(request)`

`request` is a URL string or an object:

| Field | |
| --- | --- |
| `url` | required |
| `method` | default `'GET'` |
| `headers` | object, `Headers` or entries |
| `params` | object appended as a query string |
| `body` | string, `URLSearchParams`, plain object / array (sent as JSON), or `FormData` / `Blob` / binary (sent, never queued) |
| `responseType` | `'auto'` (JSON if the server says JSON), `'json'` or `'text'` |
| `strategy`, `cache`, `cacheKey` | reads: per-request strategy; `cache: false` to skip the cache; your own cache key |
| `queue`, `idempotencyKey` | writes: `queue: false` to not queue this one; your own key |
| `timeout`, `credentials`, `signal` | as in `fetch` (`credentials` is stored with queued writes) |
| `meta` | anything JSON-serialisable, stored with a queued write and returned in its events |

It resolves with either a response or a queued result:

```ts
type OajaxResult<T> =
  | { queued: false; fromCache: boolean; ok: boolean; status: number; statusText: string;
      url: string; headers: Record<string, string>; data: T; storedAt?: number }
  | { queued: true; id: string; idempotencyKey: string }
```

It rejects with `OajaxHttpError` (has `status`, `data`, `headers`), `OajaxNetworkError` (has `cause`), `OajaxTimeoutError`, or the caller's `AbortError`. All oajax errors extend `OajaxError`.

### Events

`api.on(event, listener)` returns an unsubscribe function; `api.off(event, listener)` also works.

| Event | Payload | When |
| --- | --- | --- |
| `queued` | `{ item }` | a write was saved to the outbox |
| `replayed` | `{ item, response }` | a queued write got a successful answer |
| `failed` | `{ item, error, nextAttemptAt }` | a replay attempt failed and will be retried |
| `dead` | `{ item, error }` | an item moved to the dead-letter list (`item.reason` is `'max-attempts'` or `'rejected'`) |
| `drained` | `{ replayed }` | the outbox became empty after a replay |

### Outbox and cache

```ts
await api.flush()            // { replayed, failed, dead, pending }
await api.outbox.list()      // waiting items, oldest first
await api.outbox.size()
await api.outbox.discard(id) // drop one without sending it
await api.outbox.dead()      // items that gave up
await api.outbox.retryDead() // put them (or one, by id) back at the end, same idempotency key
await api.outbox.clearDead()
await api.outbox.clear()

await api.cache.clear()      // do this on logout
await api.cache.delete('/api/notes')
await api.cache.prune()      // remove expired entries now

api.stop()                   // stop listening and cancel timers (stored items stay)
api.start()
```

### Storage adapters

`createIndexedDBStorage(name)`, `createLocalStorage(name)`, `createMemoryStorage(map?)` and `createAutoStorage(name)` are exported. To use something else (Capacitor Preferences, SQLite, a file), implement four async methods:

```ts
interface StorageAdapter {
  readonly kind: string
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}
```

Every outbox item and cache entry is stored under its own key, so two tabs adding items at the same time cannot overwrite each other. Where the browser has Web Locks, only one tab replays a given outbox at a time.

## Moving from v1

v1 patched `$.ajax` and exposed `$oajax(settings)`. v2 keeps that call shape:

```html
<!-- before -->
<script src="jquery.min.js"></script>
<script src="bower_components/oajax.js/dist/oajax.min.js"></script>

<!-- after -->
<script src="jquery.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/oajax.js@2/dist/oajax.min.js"></script>
```

```js
$oajax({
  url: '/getData.php',
  type: 'POST',
  data: { id: 2 },
  success(result, textStatus, xhr) { /* xhr.fromCache is true for an offline copy */ },
  error(xhr, textStatus, errorThrown) { /* textStatus is 'queued' for a write saved offline */ },
  queued(info) { /* optional: a write saved offline; if given, error is not called for it */ },
})
```

From a bundler: `import { $oajax, installJQuery } from 'oajax.js/jquery'`.

What changed, on purpose:

- **A failure calls `error`.** v1 called `success` from its error path, with the error arguments.
- **A queued write is not a success.** It calls `queued` if you pass it, otherwise `error` with `textStatus === 'queued'`. v1 gave no way to tell.
- **`$.ajax` is no longer patched by default.** The script adds `$oajax` and `$.oajax`. To route every `$.ajax`, `$.get` and `$.post` through oajax as v1 did, call `oajax.installJQuery(jQuery, { patchAjax: true })`.
- Replays are asynchronous (v1 used `async: false`), in order, stop at the first failure, retry with backoff instead of every 10 seconds forever, and carry an idempotency key.
- No globals leak (`sync_que`, `ref_cache`), and v1's `oajax.parseResult` / `oajax.logMsg` flags are gone: use `dataType: 'json'` and the events.
- Storage moved from localStorage keys `cache@...`, `request@...` and `sync_que` to IndexedDB. v2 does not read v1's queue; anything still in a v1 queue is not replayed.
- jQuery itself is not required any more; `$oajax` works on any page with `fetch`.

The returned object is promise-like with `done`, `fail`, `always`, `then` and `catch`, `status`, `responseText`, `responseJSON` and `getResponseHeader`. It is not a full jqXHR (no `abort`, no `beforeSend`, no `dataFilter`).

## Limits, honestly

- **It is not a service worker.** Replay only happens while a page that uses oajax is open. If the user closes the app with writes in the outbox, they are sent the next time the app is opened and online. For sending while the app is closed you need a service worker and the Background Sync API (Chromium only at the time of writing).
- **Delivery is at-least-once.** Without server-side deduplication on the idempotency key, a write whose response was lost can be applied twice. See [What the server needs to do](#what-the-server-needs-to-do).
- **Headers are stored as you pass them.** An `Authorization` header on a queued write sits in IndexedDB or localStorage until it is replayed, and may have expired by then. Prefer adding credentials in `prepareReplay`.
- **The cache ignores request headers.** Two users of the same device share cache entries for the same URL unless you set `cacheKey` or call `cache.clear()` on logout.
- **Queued writes do not update cached reads.** After a write is queued, a cached GET still shows the old data; update your UI optimistically and refresh on `replayed`.
- **Only text responses are cached** (JSON, text, XML, JavaScript, form data). Bodies are stored as text, so binary responses are not cached.
- **Dead items after a permanent rejection stay put.** Replay moves past them, so a later write that depended on a rejected one will be sent anyway; check `dead` events if your writes depend on each other.
- localStorage (the fallback) holds about 5 MB per origin; a full store makes the write reject instead of queueing.
- `navigator.onLine === false` is trusted to mean offline. If your platform reports it wrongly, pass `isOnline`.

## What is tested, and what is not

- **52 unit tests** (vitest, jsdom, a fake `fetch`, `fake-indexeddb`): offline reads fall back to the cache; TTL and size limits; cache keys; timeouts and aborts; queued writes replay in order on the `online` event; a failure stops the batch; exponential backoff on fake timers and the dead-letter list; the idempotency key is the same on the first attempt and every retry; `prepareReplay`; persistence across a simulated reload with the memory, localStorage and IndexedDB adapters; the jQuery adapter calls `error` (not `success`) on failure and reports queued writes; server-side import without browser globals; the script-tag entry.
- The built bundles were checked by loading the CommonJS build in Node and the script-tag build in a jsdom window.
- **Real browsers: smoke-tested only.** `scripts/browser-smoke.mjs` runs the script-tag build in headless **Chromium and WebKit** (Playwright, 2026-10-10): a cached read is served offline, two writes made offline are queued, survive a page reload, and replay in order with their idempotency keys once the network is back. Firefox, real devices, and Cordova / Capacitor WebViews are not tested yet; the examples in [`examples/`](examples) are there for that, and reports are welcome.
- Not tested on Node 18 or 20: the package targets ES2020 and should run there, but the dev tools need Node 22+.

## Example

[`examples/index.html`](examples/index.html) is an offline notes page with a "simulate offline" switch, the pending list, dead letters and an event log. [`examples/jquery.html`](examples/jquery.html) shows the v1-style call. Build first, then serve the repository root:

```sh
npm install && npm run build
npx serve .        # then open http://localhost:3000/examples/
```

The v1 source and its original demo are kept in [`examples/v1`](examples/v1) for reference.

## Development

```sh
npm install
npm run check      # typecheck, tests, build, package lint
```

A GitHub Actions workflow is in [`docs/ci.yml.example`](docs/ci.yml.example); copy it to `.github/workflows/ci.yml` to use it.

## Licence

MIT © 2017–2026 Asghar Ali
