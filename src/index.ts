import { createOajax } from './client'
import type { OajaxClient, OajaxOptions } from './types'

export { createOajax, defaultIsRetryableStatus } from './client'
export { OajaxError, OajaxHttpError, OajaxNetworkError, OajaxTimeoutError } from './errors'
export { createAutoStorage } from './storage/auto'
export { createIndexedDBStorage } from './storage/indexeddb'
export { createLocalStorage } from './storage/local'
export { createMemoryStorage } from './storage/memory'
export type { StorageAdapter } from './storage/types'
export type * from './types'

let shared: OajaxClient | undefined
let sharedOptions: OajaxOptions | undefined

/**
 * Sets the options of the shared `oajax` client. Call it before the first
 * request; afterwards it throws, because the client already exists.
 */
export function configure(options: OajaxOptions): void {
  if (shared) throw new Error('oajax: configure() must be called before the first request')
  sharedOptions = options
}

/** The shared client, created on first use. */
export function getDefaultClient(): OajaxClient {
  shared ??= createOajax(sharedOptions)
  return shared
}

/**
 * The shared client. It is created the first time you use it, so importing
 * this module on a server does nothing.
 *
 * ```ts
 * import { oajax } from 'oajax.js'
 * const res = await oajax('/api/me')
 * ```
 */
export const oajax: OajaxClient = Object.assign(
  ((request) => getDefaultClient().request(request)) as OajaxClient,
  {
    request: ((request) => getDefaultClient().request(request)) as OajaxClient['request'],
    flush: () => getDefaultClient().flush(),
    on: ((event, fn) => getDefaultClient().on(event, fn)) as OajaxClient['on'],
    off: ((event, fn) => getDefaultClient().off(event, fn)) as OajaxClient['off'],
    start: () => getDefaultClient().start(),
    stop: () => getDefaultClient().stop(),
  },
)
Object.defineProperties(oajax, {
  outbox: { get: () => getDefaultClient().outbox, enumerable: true },
  cache: { get: () => getDefaultClient().cache, enumerable: true },
  storage: { get: () => getDefaultClient().storage, enumerable: true },
})
