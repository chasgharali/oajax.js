import { createMemoryStorage } from '../src/storage/memory'
import type { OajaxOptions } from '../src/types'
import { createOajax } from '../src/client'

export interface SeenRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
}

type Handler = (req: SeenRequest, n: number) => Response | Promise<Response> | 'network-error'

/**
 * A fake server behind a fake fetch. `down = true` makes every call fail the
 * way fetch does when the network is unreachable (a TypeError).
 */
export function fakeServer(handler?: Handler) {
  const seen: SeenRequest[] = []
  const state = {
    down: false,
    handler: handler ?? ((req: SeenRequest) => json({ ok: true, method: req.method, url: req.url, body: req.body })),
  }
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => (headers[k] = v))
    const req: SeenRequest = {
      method: init.method ?? 'GET',
      url: String(input),
      headers,
      body: typeof init.body === 'string' ? init.body : init.body == null ? null : '[binary]',
    }
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    seen.push(req)
    if (state.down) throw new TypeError('Failed to fetch')
    // Like real fetch: an abort (timeout or caller) rejects at once.
    const aborted = new Promise<never>((_, reject) =>
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
    )
    const out = await Promise.race([state.handler(req, seen.length), aborted])
    if (out === 'network-error') throw new TypeError('Failed to fetch')
    return out
  }) as typeof fetch
  return {
    fetch: fakeFetch,
    seen,
    get down() {
      return state.down
    },
    set down(v: boolean) {
      state.down = v
    },
    set handler(h: Handler) {
      state.handler = h
    },
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A client wired to a fake server and memory storage, not auto-started. */
export function setup(options: OajaxOptions = {}, handler?: Handler) {
  const server = fakeServer(handler)
  const map = new Map<string, string>()
  const online = { value: true }
  const client = createOajax({
    fetch: server.fetch,
    storage: createMemoryStorage(map),
    autoStart: false,
    isOnline: () => online.value,
    retry: { jitter: false, baseDelay: 1000 },
    ...options,
  })
  return { client, server, map, online }
}

/** Wait until `check` passes (polls microtasks and short timers). */
export async function until(check: () => boolean | Promise<boolean>, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeout) throw new Error('until(): timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
