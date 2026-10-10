/**
 * A tiny asynchronous key-value store. oajax keeps its cache and its outbox in
 * one of these. Values must survive a JSON round trip.
 *
 * Every outbox item and every cache entry lives under its own key, so two tabs
 * writing at the same time never overwrite each other's list.
 */
export interface StorageAdapter {
  /** A short name for logs and debugging, such as `"indexeddb"`. */
  readonly kind: string
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** Every key that starts with `prefix`, in no particular order. */
  keys(prefix: string): Promise<string[]>
}
