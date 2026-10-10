import type { StorageAdapter } from './storage/types'

/** How a read (GET or HEAD) uses the cache. */
export type ReadStrategy =
  /** Ask the network; if it is unreachable, answer from the cache. The default. */
  | 'network-first'
  /** Answer from the cache if there is a fresh entry; otherwise ask the network. */
  | 'cache-first'
  /** Never answer from the cache (successful responses are still stored unless `cache: false`). */
  | 'network-only'

/** How the response body is turned into `data`. */
export type ResponseType = 'auto' | 'json' | 'text'

/** A body oajax knows how to send. Plain objects and arrays are sent as JSON. */
export type RequestBody =
  | string
  | URLSearchParams
  | Record<string, unknown>
  | unknown[]
  | FormData
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | null

/** One request. Only `url` is required. */
export interface OajaxRequest {
  url: string
  /** Defaults to `"GET"`. */
  method?: string
  headers?: Record<string, string> | Headers | [string, string][]
  /** Appended to the URL as a query string. `null` and `undefined` values are skipped. */
  params?: Record<string, string | number | boolean | null | undefined>
  /**
   * The body. Plain objects and arrays are sent as JSON with
   * `Content-Type: application/json`. Only strings, `URLSearchParams`, plain
   * objects and arrays can be saved to the outbox; a write with a `FormData`,
   * `Blob` or binary body is sent normally but rejects instead of queueing.
   */
  body?: RequestBody
  /** Reads only. Overrides the client's `strategy`. */
  strategy?: ReadStrategy
  /** Reads only. `false` skips the cache for this request entirely. */
  cache?: boolean
  /** Reads only. Use your own cache key, e.g. to separate users who share a URL. */
  cacheKey?: string
  /**
   * Writes only. `false` means "do not queue this one": a network failure
   * rejects as it would with plain `fetch`.
   */
  queue?: boolean
  /** Writes only. Use your own idempotency key instead of a generated one. */
  idempotencyKey?: string
  /** How to read the body. Defaults to `"auto"` (JSON when the server says JSON). */
  responseType?: ResponseType
  /** Milliseconds before the attempt is abandoned. Overrides the client's `timeout`. */
  timeout?: number
  /** Passed to `fetch`. Saved with queued writes. */
  credentials?: RequestCredentials
  /** Cancels the request. A cancelled request is never queued and never served from cache. */
  signal?: AbortSignal
  /** Anything JSON-serialisable you want back in the outbox events, e.g. a local record id. */
  meta?: unknown
}

/** A response that came from the network or the cache. */
export interface OajaxResponse<T = unknown> {
  queued: false
  /** `true` when the network failed and this is a stored copy. */
  fromCache: boolean
  ok: boolean
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  data: T
  /** When the cached copy was stored (epoch ms). Only set when `fromCache` is true. */
  storedAt?: number
}

/** What a write resolves with when it was saved to the outbox instead of sent. */
export interface OajaxQueued {
  queued: true
  /** The outbox item id. Use it with `outbox.discard(id)` or to match events. */
  id: string
  idempotencyKey: string
}

export type OajaxResult<T = unknown> = OajaxResponse<T> | OajaxQueued

/** A write waiting in the outbox. This is exactly what is stored. */
export interface OutboxItem {
  id: string
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  credentials?: RequestCredentials
  responseType?: ResponseType
  idempotencyKey: string
  /** Epoch ms when it was first attempted. */
  createdAt: number
  /** Attempts so far, including the original one if it was made. */
  attempts: number
  /** Epoch ms before which automatic replay leaves this item alone. */
  nextAttemptAt: number
  lastError?: string
  meta?: unknown
}

/** A write that will not be retried automatically. */
export interface DeadItem extends OutboxItem {
  deadAt: number
  /** `"max-attempts"` or `"rejected"` (the server answered with a non-retryable status). */
  reason: 'max-attempts' | 'rejected'
  status?: number
}

/** What `prepareReplay` receives and returns. */
export interface ReplayRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  credentials?: RequestCredentials
}

export interface RetryOptions {
  /** First retry delay in ms. Default 2000. */
  baseDelay?: number
  /** Upper bound for the delay in ms. Default 300000 (5 minutes). */
  maxDelay?: number
  /** After this many failed attempts an item moves to the dead-letter list. Default 8. */
  maxAttempts?: number
  /** Randomise delays (half fixed, half random) so many clients do not retry in step. Default true. */
  jitter?: boolean
}

export interface CacheOptions {
  /** Entries older than this (ms) are never served and are removed. Default 7 days. */
  maxAge?: number
  /** Keep at most this many entries; the oldest are removed first. Default 200. */
  maxEntries?: number
}

export interface OajaxOptions {
  /**
   * Where the cache and outbox live. `"auto"` (default) picks IndexedDB, then
   * localStorage, then memory. You can also pass any {@link StorageAdapter}.
   */
  storage?: 'auto' | 'indexeddb' | 'localstorage' | 'memory' | StorageAdapter
  /** Database name / key prefix. Use different names for separate clients. Default `"oajax"`. */
  name?: string
  /** The fetch to use. Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Default read strategy. Default `"network-first"`. */
  strategy?: ReadStrategy
  /** Per-attempt timeout in ms. `0` disables it. Default 20000. */
  timeout?: number
  /** Cache limits, or `false` to turn the read cache off. */
  cache?: CacheOptions | false
  retry?: RetryOptions
  /** Header that carries the idempotency key, or `false` to not send one. Default `"Idempotency-Key"`. */
  idempotencyHeader?: string | false
  /**
   * Queue writes that fail because the network is unreachable. Default true.
   * When false, writes behave like plain fetch and the outbox is only used by
   * items already in it.
   */
  queue?: boolean
  /**
   * Called before each replay. Use it to add a fresh auth header instead of
   * storing a token in the outbox, or to rewrite the URL.
   */
  prepareReplay?: (request: ReplayRequest, item: OutboxItem) => ReplayRequest | Promise<ReplayRequest>
  /** Statuses that mean "try again later". Default: 408, 425, 429 and 500-599. */
  isRetryableStatus?: (status: number) => boolean
  /** Whether the device is online. Default reads `navigator.onLine` (and assumes online without it). */
  isOnline?: () => boolean
  /**
   * Listen for `online` / `visibilitychange` and replay automatically. Default
   * true in a browser. Call `start()` yourself when false.
   */
  autoStart?: boolean
  /** While offline, how often (ms) to check again in case no `online` event arrives. Default 30000. */
  pollInterval?: number
  /** Clock, for tests. */
  now?: () => number
  /** Random source in [0, 1), for tests. */
  random?: () => number
}

/** Events and the data they carry. */
export interface OajaxEvents {
  /** A write was saved to the outbox. */
  queued: { item: OutboxItem }
  /** A queued write reached the server and got a successful answer. */
  replayed: { item: OutboxItem; response: OajaxResponse }
  /** A replay attempt failed and will be retried at `nextAttemptAt`. */
  failed: { item: OutboxItem; error: unknown; nextAttemptAt: number }
  /** An item gave up and moved to the dead-letter list. */
  dead: { item: DeadItem; error: unknown }
  /** The outbox became empty after a replay. */
  drained: { replayed: number }
}

export type OajaxEventName = keyof OajaxEvents

export interface FlushResult {
  replayed: number
  failed: number
  dead: number
  /** Items still waiting. */
  pending: number
}

export interface OutboxApi {
  /** Waiting writes, oldest first. */
  list(): Promise<OutboxItem[]>
  size(): Promise<number>
  /** Remove one waiting write without sending it. */
  discard(id: string): Promise<boolean>
  /** Writes that gave up. */
  dead(): Promise<DeadItem[]>
  /** Put dead items (all, or one) back at the end of the outbox with their attempts reset. */
  retryDead(id?: string): Promise<number>
  clearDead(): Promise<void>
  /** Remove every waiting write. */
  clear(): Promise<void>
}

export interface CacheApi {
  /** Remove every cached response. Do this on logout. */
  clear(): Promise<void>
  /** Remove the entry for one request (same url, method, params and body). */
  delete(request: OajaxRequest | string): Promise<void>
  /** Remove expired entries and trim to `maxEntries`. */
  prune(): Promise<void>
}

export interface OajaxClient {
  <T = unknown>(request: OajaxRequest | string): Promise<OajaxResult<T>>
  request<T = unknown>(request: OajaxRequest | string): Promise<OajaxResult<T>>
  /**
   * Try to send everything in the outbox now, oldest first, ignoring backoff.
   * Stops at the first failure so later writes never overtake earlier ones.
   */
  flush(): Promise<FlushResult>
  on<E extends OajaxEventName>(event: E, listener: (payload: OajaxEvents[E]) => void): () => void
  off<E extends OajaxEventName>(event: E, listener: (payload: OajaxEvents[E]) => void): void
  outbox: OutboxApi
  cache: CacheApi
  /** Start listening for `online` and replaying on a timer. Called for you unless `autoStart: false`. */
  start(): void
  /** Stop listening and cancel timers. Stored items stay where they are. */
  stop(): void
  readonly storage: StorageAdapter
}
