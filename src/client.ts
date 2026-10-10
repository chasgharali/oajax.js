import { createEmitter } from './emitter'
import { OajaxError, OajaxHttpError, OajaxNetworkError, OajaxTimeoutError } from './errors'
import { createAutoStorage } from './storage/auto'
import { createIndexedDBStorage } from './storage/indexeddb'
import { createLocalStorage } from './storage/local'
import { createMemoryStorage } from './storage/memory'
import type { StorageAdapter } from './storage/types'
import type {
  CacheApi,
  DeadItem,
  FlushResult,
  OajaxClient,
  OajaxEvents,
  OajaxOptions,
  OajaxRequest,
  OajaxResponse,
  OajaxResult,
  OutboxApi,
  OutboxItem,
  ReplayRequest,
  ResponseType,
} from './types'
import { createMutex, errorMessage, hash, headersToRecord, isPlainObject, uuid, withParams } from './util'

const OUTBOX = 'outbox:'
const DEAD = 'dead:'
const CACHE = 'cache:'
const CACHE_META = 'cachemeta:'

const READ_METHODS = new Set(['GET', 'HEAD'])
const DAY = 24 * 60 * 60 * 1000

interface CacheEntry {
  url: string
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  storedAt: number
}

interface Prepared {
  method: string
  url: string
  headers: Record<string, string>
  /** What goes to fetch. */
  body: BodyInit | null
  /** The same body as a string, or `undefined` if it cannot be stored. */
  storableBody: string | null | undefined
  request: OajaxRequest
}

/** Statuses that mean "the server is there but cannot take this right now". */
export function defaultIsRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

function defaultIsOnline(): boolean {
  const nav = (globalThis as { navigator?: Navigator }).navigator
  return !nav || nav.onLine !== false
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

const TEXTUAL = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded/i

function parseBody(text: string, contentType: string | undefined, type: ResponseType = 'auto'): unknown {
  if (type === 'text') return text
  if (type === 'json') return text === '' ? null : JSON.parse(text)
  if (contentType && /json/i.test(contentType) && text !== '') {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

function resolveStorage(option: OajaxOptions['storage'], name: string): StorageAdapter {
  if (option && typeof option === 'object') return option
  switch (option) {
    case 'memory':
      return createMemoryStorage()
    case 'localstorage':
      return createLocalStorage(name)
    case 'indexeddb':
      return createIndexedDBStorage(name)
    default:
      return createAutoStorage(name)
  }
}

/**
 * Creates an offline-first request client.
 *
 * ```ts
 * const api = createOajax()
 * const todos = await api('/api/todos')           // network, or the cached copy offline
 * const r = await api({ url: '/api/todos', method: 'POST', body: { title: 'Milk' } })
 * if (r.queued) showToast('Saved offline, will sync')
 * ```
 *
 * Creating a client touches no browser API; storage is opened on first use.
 */
export function createOajax(options: OajaxOptions = {}): OajaxClient {
  const name = options.name ?? 'oajax'
  const storage = resolveStorage(options.storage, name)
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const isOnline = options.isOnline ?? defaultIsOnline
  const isRetryableStatus = options.isRetryableStatus ?? defaultIsRetryableStatus
  const defaultTimeout = options.timeout ?? 20000
  const idemHeader = options.idempotencyHeader === undefined ? 'Idempotency-Key' : options.idempotencyHeader
  const cacheOpts = options.cache === false ? false : { maxAge: 7 * DAY, maxEntries: 200, ...options.cache }
  const retry = { baseDelay: 2000, maxDelay: 15 * 60 * 1000, maxAttempts: 15, jitter: true, ...options.retry }
  const pollInterval = options.pollInterval ?? 30000
  const emitter = createEmitter<OajaxEvents>()
  const lock = createMutex()
  let seq = 0

  const getFetch = (): typeof fetch => {
    const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
    if (!f) throw new OajaxError('oajax: no fetch available; pass options.fetch')
    return f
  }

  const newId = () =>
    `${now().toString(36).padStart(10, '0')}-${(seq++ % 1679616).toString(36).padStart(4, '0')}-${Math.floor(random() * 1679616)
      .toString(36)
      .padStart(4, '0')}`

  const backoff = (attempts: number) => {
    const exp = Math.min(retry.maxDelay, retry.baseDelay * 2 ** Math.max(0, attempts - 1))
    return retry.jitter ? Math.round(exp / 2 + (random() * exp) / 2) : exp
  }

  // ---------------------------------------------------------------- prepare

  function prepare(input: OajaxRequest | string): Prepared {
    const request: OajaxRequest = typeof input === 'string' ? { url: input } : input
    if (!request || typeof request.url !== 'string') throw new TypeError('oajax: request.url is required')
    const method = (request.method ?? 'GET').toUpperCase()
    const url = withParams(request.url, request.params)
    const headers = headersToRecord(request.headers)
    const raw = request.body
    let body: BodyInit | null = null
    let storableBody: string | null | undefined = null

    if (raw === undefined || raw === null) {
      body = null
    } else if (typeof raw === 'string') {
      body = storableBody = raw
    } else if (raw instanceof URLSearchParams) {
      body = storableBody = raw.toString()
      headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'
    } else if (Array.isArray(raw) || isPlainObject(raw)) {
      body = storableBody = JSON.stringify(raw)
      headers['content-type'] ??= 'application/json'
    } else {
      // FormData, Blob, ArrayBuffer, typed arrays: sent as-is, cannot be stored.
      body = raw as BodyInit
      storableBody = undefined
    }
    return { method, url, headers, body, storableBody, request }
  }

  const cacheKeyOf = (p: Prepared) =>
    p.request.cacheKey ?? `${p.method} ${p.url}${typeof p.storableBody === 'string' ? `#${hash(p.storableBody)}` : ''}`

  // ---------------------------------------------------------------- network

  async function send(
    req: Omit<ReplayRequest, 'body'> & { body: BodyInit | null },
    extra: { timeout?: number; signal?: AbortSignal; responseType?: ResponseType },
  ): Promise<OajaxResponse> {
    const timeout = extra.timeout ?? defaultTimeout
    const controller = new AbortController()
    const outer = extra.signal
    let timedOut = false
    const onAbort = () => controller.abort(outer?.reason)
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason)
      else outer.addEventListener('abort', onAbort, { once: true })
    }
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeout)
        : undefined
    try {
      const res = await getFetch()(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        credentials: req.credentials,
        signal: controller.signal,
      })
      const text = req.method === 'HEAD' ? '' : await res.text()
      const headers = headersToRecord(res.headers)
      return {
        queued: false,
        fromCache: false,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: res.url || req.url,
        headers,
        data: res.ok ? parseBody(text, headers['content-type'], extra.responseType) : parseBody(text, headers['content-type']),
        // Keep the raw text around for the cache; stripped before returning.
        ...({ __text: text } as object),
      }
    } catch (err) {
      if (timedOut) throw new OajaxTimeoutError(timeout)
      throw err
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    }
  }

  const strip = <T>(r: OajaxResponse): OajaxResponse<T> => {
    const { __text: _ignored, ...rest } = r as OajaxResponse & { __text?: string }
    return rest as OajaxResponse<T>
  }

  const httpError = (r: OajaxResponse) => new OajaxHttpError(r.status, r.statusText, r.data, r.headers)

  // ---------------------------------------------------------------- cache

  async function cacheGet(key: string): Promise<CacheEntry | undefined> {
    if (!cacheOpts) return undefined
    const entry = await storage.get<CacheEntry>(CACHE + key)
    if (!entry) return undefined
    if (now() - entry.storedAt > cacheOpts.maxAge) {
      await cacheDeleteKey(key)
      return undefined
    }
    return entry
  }

  async function cacheDeleteKey(key: string) {
    await storage.delete(CACHE + key)
    await storage.delete(CACHE_META + key)
  }

  async function cachePut(key: string, r: OajaxResponse) {
    if (!cacheOpts) return
    const text = (r as OajaxResponse & { __text?: string }).__text ?? ''
    const type = r.headers['content-type']
    if (type && !TEXTUAL.test(type)) return // binary bodies are not cached
    const entry: CacheEntry = {
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
      body: text,
      storedAt: now(),
    }
    try {
      await storage.set(CACHE + key, entry)
      await storage.set(CACHE_META + key, entry.storedAt)
      await trimCache()
    } catch {
      // The cache is best effort: a full store must not fail the request.
    }
  }

  async function trimCache() {
    if (!cacheOpts) return
    const metaKeys = await storage.keys(CACHE_META)
    if (metaKeys.length <= cacheOpts.maxEntries) return
    const metas = await Promise.all(
      metaKeys.map(async (k) => ({ key: k.slice(CACHE_META.length), at: (await storage.get<number>(k)) ?? 0 })),
    )
    metas.sort((a, b) => a.at - b.at)
    for (const m of metas.slice(0, metas.length - cacheOpts.maxEntries)) await cacheDeleteKey(m.key)
  }

  function fromCache<T>(entry: CacheEntry, responseType?: ResponseType): OajaxResponse<T> {
    return {
      queued: false,
      fromCache: true,
      ok: true,
      status: entry.status,
      statusText: entry.statusText,
      url: entry.url,
      headers: entry.headers,
      data: parseBody(entry.body, entry.headers['content-type'], responseType) as T,
      storedAt: entry.storedAt,
    }
  }

  const cache: CacheApi = {
    async clear() {
      for (const k of await storage.keys(CACHE_META)) await cacheDeleteKey(k.slice(CACHE_META.length))
      for (const k of await storage.keys(CACHE)) await storage.delete(k)
    },
    async delete(request) {
      const p = prepare(request)
      await cacheDeleteKey(cacheKeyOf(p))
    },
    async prune() {
      if (!cacheOpts) return
      for (const k of await storage.keys(CACHE_META)) {
        const at = (await storage.get<number>(k)) ?? 0
        if (now() - at > cacheOpts.maxAge) await cacheDeleteKey(k.slice(CACHE_META.length))
      }
      await trimCache()
    },
  }

  // ---------------------------------------------------------------- reads

  async function read<T>(p: Prepared): Promise<OajaxResponse<T>> {
    const { request } = p
    const useCache = request.cache !== false && cacheOpts !== false
    const strategy = request.strategy ?? options.strategy ?? 'network-first'
    const key = cacheKeyOf(p)
    const extra = { timeout: request.timeout, signal: request.signal, responseType: request.responseType }

    if (useCache && strategy !== 'network-only') {
      const entry = await cacheGet(key)
      // cache-first always answers from a fresh entry; network-first does so
      // only when the browser says it is offline (otherwise it asks first).
      if (entry && (strategy === 'cache-first' || !isOnline())) return fromCache<T>(entry, request.responseType)
    }

    let res: OajaxResponse
    try {
      res = await send({ ...p, credentials: request.credentials }, extra)
    } catch (err) {
      if (isAbortError(err) && !(err instanceof OajaxTimeoutError)) throw err
      const entry = useCache && strategy !== 'network-only' ? await cacheGet(key) : undefined
      if (entry) return fromCache<T>(entry, request.responseType)
      if (err instanceof OajaxTimeoutError) throw err
      throw new OajaxNetworkError(`oajax: ${p.method} ${p.url} failed and nothing is cached`, err)
    }

    if (res.ok) {
      if (useCache) await cachePut(key, res)
      return strip<T>(res)
    }
    if (isRetryableStatus(res.status) && useCache && strategy !== 'network-only') {
      const entry = await cacheGet(key)
      if (entry) return fromCache<T>(entry, request.responseType)
    }
    throw httpError(res)
  }

  // ---------------------------------------------------------------- outbox

  async function listOutbox(): Promise<OutboxItem[]> {
    const keys = (await storage.keys(OUTBOX)).sort()
    const items = await Promise.all(keys.map((k) => storage.get<OutboxItem>(k)))
    return items.filter((x): x is OutboxItem => !!x)
  }

  async function enqueue(p: Prepared, idempotencyKey: string, attempted: boolean, error?: unknown): Promise<OutboxItem> {
    const t = now()
    const item: OutboxItem = {
      id: newId(),
      method: p.method,
      url: p.url,
      headers: p.headers,
      body: p.storableBody ?? null,
      idempotencyKey,
      createdAt: t,
      attempts: attempted ? 1 : 0,
      nextAttemptAt: attempted ? t + backoff(1) : t,
    }
    if (p.request.credentials) item.credentials = p.request.credentials
    if (p.request.responseType) item.responseType = p.request.responseType
    if (error !== undefined) item.lastError = errorMessage(error)
    if (p.request.meta !== undefined) item.meta = p.request.meta
    await lock(() => storage.set(OUTBOX + item.id, item))
    emitter.emit('queued', { item })
    schedule(item.nextAttemptAt - t)
    return item
  }

  async function write<T>(p: Prepared): Promise<OajaxResult<T>> {
    const { request } = p
    const headerName = idemHeader ? idemHeader.toLowerCase() : undefined
    const idempotencyKey = request.idempotencyKey ?? (headerName && p.headers[headerName]) ?? uuid(random)
    if (headerName) p.headers[headerName] = idempotencyKey
    const canQueue = request.queue !== false && options.queue !== false && p.storableBody !== undefined
    const queued = (item: OutboxItem): OajaxResult<T> => ({ queued: true, id: item.id, idempotencyKey })

    if (canQueue) {
      // Never let a new write overtake older ones that are still waiting.
      if (!isOnline() || (await storage.keys(OUTBOX)).length > 0) {
        return queued(await enqueue(p, idempotencyKey, false))
      }
    }

    let res: OajaxResponse
    try {
      res = await send({ ...p, credentials: request.credentials }, {
        timeout: request.timeout,
        signal: request.signal,
        responseType: request.responseType,
      })
    } catch (err) {
      if (isAbortError(err) && !(err instanceof OajaxTimeoutError)) throw err
      if (canQueue) return queued(await enqueue(p, idempotencyKey, true, err))
      if (err instanceof OajaxTimeoutError) throw err
      throw new OajaxNetworkError(`oajax: ${p.method} ${p.url} failed`, err)
    }
    if (res.ok) return strip<T>(res)
    if (canQueue && isRetryableStatus(res.status)) {
      return queued(await enqueue(p, idempotencyKey, true, httpError(res)))
    }
    throw httpError(res)
  }

  // ---------------------------------------------------------------- replay

  let timer: ReturnType<typeof setTimeout> | undefined
  let timerAt = Infinity
  let started = false
  let running: Promise<FlushResult> | undefined

  function schedule(delay: number) {
    if (!started) return
    const at = now() + Math.max(0, delay)
    if (timer !== undefined && timerAt <= at) return
    if (timer !== undefined) clearTimeout(timer)
    timerAt = at
    timer = setTimeout(() => {
      timer = undefined
      timerAt = Infinity
      void autoFlush()
    }, Math.max(0, delay))
    ;(timer as { unref?: () => void }).unref?.()
  }

  async function toDead(item: OutboxItem, reason: DeadItem['reason'], error: unknown, status?: number) {
    const dead: DeadItem = { ...item, lastError: errorMessage(error), deadAt: now(), reason }
    if (status !== undefined) dead.status = status
    await lock(async () => {
      await storage.set(DEAD + item.id, dead)
      await storage.delete(OUTBOX + item.id)
    })
    emitter.emit('dead', { item: dead, error })
  }

  async function replayLoop(force: boolean): Promise<FlushResult> {
    const result: FlushResult = { replayed: 0, failed: 0, dead: 0, pending: 0 }
    for (;;) {
      const items = await listOutbox()
      const head = items[0]
      if (!head) {
        if (result.replayed > 0) emitter.emit('drained', { replayed: result.replayed })
        return result
      }
      result.pending = items.length
      if (!force && head.nextAttemptAt > now()) {
        schedule(head.nextAttemptAt - now())
        return result
      }

      let req: ReplayRequest = {
        method: head.method,
        url: head.url,
        headers: { ...head.headers },
        body: head.body,
        credentials: head.credentials,
      }
      let res: OajaxResponse | undefined
      let error: unknown
      try {
        if (options.prepareReplay) req = await options.prepareReplay(req, head)
        res = await send(req, { responseType: head.responseType })
      } catch (err) {
        error = err
      }

      if (res?.ok) {
        await lock(() => storage.delete(OUTBOX + head.id))
        result.replayed++
        result.pending--
        emitter.emit('replayed', { item: head, response: strip(res) })
        continue
      }

      if (res && !isRetryableStatus(res.status)) {
        // The server is reachable and said no. Retrying will not change that.
        await toDead(head, 'rejected', httpError(res), res.status)
        result.dead++
        result.pending--
        continue
      }

      // Unreachable, timed out, or a retryable status: stop here to keep order.
      error ??= res ? httpError(res) : new OajaxNetworkError('oajax: replay failed')
      const attempts = head.attempts + 1
      if (attempts >= retry.maxAttempts) {
        await toDead({ ...head, attempts }, 'max-attempts', error, res?.status)
        result.dead++
        result.pending--
        schedule(backoff(1))
        return result
      }
      const nextAttemptAt = now() + backoff(attempts)
      const updated: OutboxItem = { ...head, attempts, nextAttemptAt, lastError: errorMessage(error) }
      await lock(async () => {
        // Skip the write if the item was discarded meanwhile.
        if (await storage.get(OUTBOX + head.id)) await storage.set(OUTBOX + head.id, updated)
      })
      result.failed++
      emitter.emit('failed', { item: updated, error, nextAttemptAt })
      schedule(nextAttemptAt - now())
      return result
    }
  }

  /** Runs the loop under a cross-tab lock when the browser has Web Locks. */
  async function withTabLock(force: boolean): Promise<FlushResult> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
    if (!locks || typeof locks.request !== 'function') return replayLoop(force)
    let out: FlushResult | undefined
    await locks.request(`oajax:${name}:replay`, { ifAvailable: true }, async (held) => {
      // Another tab is replaying the same outbox; let it.
      if (held) out = await replayLoop(force)
    })
    return out ?? { replayed: 0, failed: 0, dead: 0, pending: (await storage.keys(OUTBOX)).length }
  }

  function run(force: boolean): Promise<FlushResult> {
    if (running) {
      if (!force) return running
      return running.then(() => run(true))
    }
    running = withTabLock(force).finally(() => {
      running = undefined
    })
    return running
  }

  async function autoFlush(): Promise<void> {
    try {
      if (!isOnline()) {
        if ((await storage.keys(OUTBOX)).length) schedule(pollInterval)
        return
      }
      await run(false)
    } catch (err) {
      console.error('oajax: replay failed', err)
      schedule(pollInterval)
    }
  }

  const onOnline = () => {
    // Coming back online is a good moment to try now, whatever the backoff says.
    void (async () => {
      try {
        await run(true)
      } catch (err) {
        console.error('oajax: replay failed', err)
      }
    })()
  }
  const onVisible = () => {
    if ((globalThis as { document?: Document }).document?.visibilityState === 'visible') void autoFlush()
  }

  const outbox: OutboxApi = {
    list: listOutbox,
    async size() {
      return (await storage.keys(OUTBOX)).length
    },
    async discard(id) {
      return lock(async () => {
        if (!(await storage.get(OUTBOX + id))) return false
        await storage.delete(OUTBOX + id)
        return true
      })
    },
    async dead() {
      const keys = (await storage.keys(DEAD)).sort()
      const items = await Promise.all(keys.map((k) => storage.get<DeadItem>(k)))
      return items.filter((x): x is DeadItem => !!x)
    },
    async retryDead(id) {
      const dead = await outbox.dead()
      const chosen = id === undefined ? dead : dead.filter((d) => d.id === id)
      for (const d of chosen) {
        const { deadAt: _a, reason: _r, status: _s, ...rest } = d
        const item: OutboxItem = { ...rest, id: newId(), attempts: 0, nextAttemptAt: now() }
        await lock(async () => {
          await storage.set(OUTBOX + item.id, item)
          await storage.delete(DEAD + d.id)
        })
      }
      if (chosen.length) schedule(0)
      return chosen.length
    },
    async clearDead() {
      await lock(async () => {
        for (const k of await storage.keys(DEAD)) await storage.delete(k)
      })
    },
    async clear() {
      await lock(async () => {
        for (const k of await storage.keys(OUTBOX)) await storage.delete(k)
      })
    },
  }

  // ---------------------------------------------------------------- client

  async function request<T = unknown>(input: OajaxRequest | string): Promise<OajaxResult<T>> {
    const p = prepare(input)
    return READ_METHODS.has(p.method) ? read<T>(p) : write<T>(p)
  }

  const client = request as OajaxClient
  Object.assign(client, {
    request,
    flush: () => run(true),
    on: emitter.on,
    off: emitter.off,
    outbox,
    cache,
    start() {
      if (started) return
      started = true
      const w = globalThis as { addEventListener?: Window['addEventListener']; document?: Document }
      w.addEventListener?.('online', onOnline)
      w.document?.addEventListener?.('visibilitychange', onVisible)
      void autoFlush()
    },
    stop() {
      started = false
      const w = globalThis as { removeEventListener?: Window['removeEventListener']; document?: Document }
      w.removeEventListener?.('online', onOnline)
      w.document?.removeEventListener?.('visibilitychange', onVisible)
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      timerAt = Infinity
    },
  })
  Object.defineProperty(client, 'storage', { value: storage, enumerable: true })

  const inBrowser = typeof (globalThis as { window?: unknown }).window !== 'undefined'
  if (options.autoStart ?? inBrowser) client.start()
  return client
}
