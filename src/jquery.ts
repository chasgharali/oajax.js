/**
 * `oajax.js/jquery`: the v1 calling style on top of the v2 core.
 *
 * v1 patched `$.ajax` and exposed `$oajax(settings)` with jQuery's option
 * names and `success` / `error` callbacks. This entry keeps that shape so a v1
 * app can move by swapping the script, and fixes what v1 got wrong: a failure
 * calls `error`, never `success`, and a write saved for later is reported as
 * `queued`, not as a server answer.
 *
 * It does not need jQuery itself. Pass jQuery to `installJQuery` only if you
 * want `$.oajax` (and, optionally, a patched `$.ajax`).
 */
import { OajaxHttpError, OajaxTimeoutError } from './errors'
import { getDefaultClient } from './index'
import type { OajaxClient, OajaxQueued, OajaxRequest, OajaxResponse, ReadStrategy } from './types'

/** jQuery-style settings. Unknown jQuery options are ignored. */
export interface AjaxSettings {
  url?: string
  /** jQuery's old name for `method`. */
  type?: string
  method?: string
  /** Query string for GET/HEAD; request body otherwise (form-encoded unless `contentType` is JSON). */
  data?: unknown
  /** Default `"application/x-www-form-urlencoded; charset=UTF-8"`, like jQuery. `false` sends none. */
  contentType?: string | false
  /** `"json"` parses JSON, `"text"` / `"html"` returns text, anything else guesses from the response. */
  dataType?: string
  headers?: Record<string, string>
  timeout?: number
  /** `this` inside the callbacks. */
  context?: unknown
  /** `false` keeps this request out of the oajax cache. */
  cache?: boolean
  /** Ignored. v2 never makes synchronous requests (v1 replayed with `async: false`). */
  async?: boolean
  success?: (data: any, textStatus: string, xhr: OajaxXHR) => void
  error?: (xhr: OajaxXHR, textStatus: string, errorThrown: unknown) => void
  complete?: (xhr: OajaxXHR, textStatus: string) => void
  /**
   * A write was saved to the outbox. If you pass this, a queued write calls it
   * instead of `error` and the returned promise resolves with the queued info.
   */
  queued?: (info: OajaxQueued, xhr: OajaxXHR) => void
  /** oajax: read strategy for this request. */
  strategy?: ReadStrategy
  /** oajax: `false` turns off queueing for this write. */
  queue?: boolean
  /** oajax: your own idempotency key. */
  idempotencyKey?: string
}

/** The jqXHR-like object `$oajax` returns. It is also a promise. */
export interface OajaxXHR extends PromiseLike<any> {
  readyState: number
  status: number
  statusText: string
  responseText?: string
  responseJSON?: unknown
  /** `true` when the data came from the cache because the network failed. */
  fromCache: boolean
  /** Set when the write was saved to the outbox. */
  queued?: OajaxQueued
  getResponseHeader(name: string): string | null
  getAllResponseHeaders(): string
  done(fn: (data: any, textStatus: string, xhr: OajaxXHR) => void): OajaxXHR
  fail(fn: (xhr: OajaxXHR, textStatus: string, errorThrown: unknown) => void): OajaxXHR
  always(fn: (...args: any[]) => void): OajaxXHR
  catch<R = never>(onrejected?: (reason: any) => R | PromiseLike<R>): Promise<any>
}

export type AjaxFunction = {
  (settings: AjaxSettings): OajaxXHR
  (url: string, settings?: AjaxSettings): OajaxXHR
}

/** jQuery's `$.param` for the common cases: nested objects and arrays use bracket notation. */
export function param(data: unknown): string {
  const parts: string[] = []
  const add = (key: string, value: unknown) => {
    const v = typeof value === 'function' ? (value as () => unknown)() : value
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v === null || v === undefined ? '' : String(v))}`)
  }
  const build = (prefix: string, value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') build(`${prefix}[${i}]`, v)
        else add(`${prefix}[]`, v)
      })
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) build(`${prefix}[${k}]`, v)
    } else add(prefix, value)
  }
  if (Array.isArray(data)) {
    // jQuery's serializeArray() shape: [{ name, value }]
    for (const item of data as { name: string; value: unknown }[]) add(item.name, item.value)
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) build(k, v)
  }
  return parts.join('&')
}

function appendQuery(url: string, query: string): string {
  if (!query) return url
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

/** Turns jQuery-style settings into a core request. */
export function toRequest(settings: AjaxSettings): OajaxRequest {
  if (!settings.url) throw new TypeError('oajax: url is required')
  const method = (settings.method ?? settings.type ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...settings.headers }
  const contentType =
    settings.contentType === undefined ? 'application/x-www-form-urlencoded; charset=UTF-8' : settings.contentType
  const req: OajaxRequest = { url: settings.url, method, headers }
  const { data } = settings
  const isRead = method === 'GET' || method === 'HEAD'

  if (data !== undefined && data !== null) {
    if (isRead) {
      req.url = appendQuery(settings.url, typeof data === 'string' ? data : param(data))
    } else {
      if (contentType) headers['Content-Type'] = contentType
      if (typeof data === 'string') req.body = data
      else if (contentType && /json/i.test(contentType)) req.body = JSON.stringify(data)
      else req.body = param(data)
    }
  }

  if (settings.dataType === 'json') req.responseType = 'json'
  else if (settings.dataType === 'text' || settings.dataType === 'html') req.responseType = 'text'
  if (settings.timeout !== undefined) req.timeout = settings.timeout
  if (settings.cache === false) req.cache = false
  if (settings.strategy) req.strategy = settings.strategy
  if (settings.queue !== undefined) req.queue = settings.queue
  if (settings.idempotencyKey) req.idempotencyKey = settings.idempotencyKey
  return req
}

/**
 * Makes a `$oajax` function bound to a client (the shared one by default).
 */
export function createAjax(client?: OajaxClient): AjaxFunction {
  return function ajax(urlOrSettings: string | AjaxSettings, maybeSettings?: AjaxSettings): OajaxXHR {
    const settings: AjaxSettings =
      typeof urlOrSettings === 'string' ? { ...maybeSettings, url: urlOrSettings } : { ...urlOrSettings }
    const ctx = settings.context
    let headers: Record<string, string> = {}
    const xhr = {
      readyState: 0,
      status: 0,
      statusText: '',
      fromCache: false,
      getResponseHeader(name: string) {
        return headers[name.toLowerCase()] ?? null
      },
      getAllResponseHeaders() {
        return Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('')
      },
    } as unknown as OajaxXHR

    type Outcome =
      | { kind: 'success'; data: unknown; textStatus: string }
      | { kind: 'queued'; info: OajaxQueued }
      | { kind: 'error'; textStatus: string; error: unknown }

    const fill = (r: OajaxResponse) => {
      xhr.readyState = 4
      xhr.status = r.status
      xhr.statusText = r.statusText
      xhr.fromCache = r.fromCache
      headers = r.headers
      if (typeof r.data === 'string') xhr.responseText = r.data
      else {
        xhr.responseJSON = r.data
        xhr.responseText = JSON.stringify(r.data)
      }
    }

    const outcome: Promise<Outcome> = (async (): Promise<Outcome> => {
      try {
        const result = await (client ?? getDefaultClient()).request(toRequest(settings))
        if (result.queued) {
          xhr.readyState = 4
          xhr.queued = result
          return { kind: 'queued', info: result }
        }
        fill(result)
        return { kind: 'success', data: result.data, textStatus: result.status === 304 ? 'notmodified' : 'success' }
      } catch (error) {
        xhr.readyState = 4
        if (error instanceof OajaxHttpError) {
          fill({ ...error, queued: false, fromCache: false, ok: false, url: '', data: error.data } as OajaxResponse)
          return { kind: 'error', textStatus: 'error', error: error.statusText || error.message }
        }
        if (error instanceof OajaxTimeoutError) return { kind: 'error', textStatus: 'timeout', error }
        if ((error as { name?: string })?.name === 'AbortError') return { kind: 'error', textStatus: 'abort', error }
        if (error instanceof SyntaxError) return { kind: 'error', textStatus: 'parsererror', error }
        return { kind: 'error', textStatus: 'error', error }
      }
    })()

    const call = (fn: ((...a: any[]) => void) | undefined, ...args: unknown[]) => {
      if (!fn) return
      try {
        fn.apply(ctx ?? xhr, args)
      } catch (err) {
        console.error('oajax: a callback threw', err)
      }
    }

    // Callbacks, in jQuery's order: success/error, then complete.
    void outcome.then((o) => {
      if (o.kind === 'success') call(settings.success, o.data, o.textStatus, xhr)
      else if (o.kind === 'queued') {
        if (settings.queued) call(settings.queued, o.info, xhr)
        else call(settings.error, xhr, 'queued', 'Saved offline; it will be sent when the connection returns')
      } else call(settings.error, xhr, o.textStatus, o.error)
      call(settings.complete, xhr, o.kind === 'error' ? o.textStatus : o.kind === 'queued' ? 'queued' : o.kind)
    })

    // The promise mirrors the callbacks: resolves on success (and on queued
    // when you handle `queued`), rejects with the xhr otherwise.
    const promise = outcome.then((o) => {
      if (o.kind === 'success') return o.data
      if (o.kind === 'queued' && settings.queued) return o.info
      throw xhr
    })
    promise.catch(() => undefined) // a rejection nobody listens to is not an error here

    const statusOf = (o: Outcome) => (o.kind === 'success' ? o.textStatus : o.kind === 'queued' ? 'queued' : o.textStatus)
    Object.assign(xhr, {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      done(fn: (...a: any[]) => void) {
        void outcome.then((o) => {
          if (o.kind === 'success') call(fn, o.data, o.textStatus, xhr)
          else if (o.kind === 'queued' && settings.queued) call(fn, o.info, 'queued', xhr)
        })
        return xhr
      },
      fail(fn: (...a: any[]) => void) {
        void outcome.then((o) => {
          if (o.kind === 'error') call(fn, xhr, o.textStatus, o.error)
          else if (o.kind === 'queued' && !settings.queued) call(fn, xhr, 'queued', 'Saved offline')
        })
        return xhr
      },
      always(fn: (...a: any[]) => void) {
        void outcome.then((o) => {
          if (o.kind === 'success') call(fn, o.data, statusOf(o), xhr)
          else call(fn, xhr, statusOf(o), o.kind === 'error' ? o.error : undefined)
        })
        return xhr
      },
    })
    return xhr
  } as AjaxFunction
}

/** `$oajax` bound to the shared client. */
export const $oajax: AjaxFunction = createAjax()

interface JQueryLike {
  ajax: (...args: any[]) => unknown
  oajax?: unknown
}

export interface InstallOptions {
  /** Client to use. Default: the shared one. */
  client?: OajaxClient
  /**
   * Replace `$.ajax` (and so `$.get`, `$.post`, `$.getJSON`) with the oajax
   * version, as v1 did. Default false: only `$.oajax` is added.
   */
  patchAjax?: boolean
}

/**
 * Adds `$.oajax` to jQuery, and with `patchAjax: true` routes `$.ajax`
 * through oajax like v1. Returns a function that undoes it.
 */
export function installJQuery($: JQueryLike, options: InstallOptions = {}): () => void {
  const ajax = options.client ? createAjax(options.client) : $oajax
  const original = $.ajax
  const hadOajax = 'oajax' in $
  const previous = $.oajax
  $.oajax = ajax
  if (options.patchAjax) $.ajax = ajax as JQueryLike['ajax']
  return () => {
    if (options.patchAjax) $.ajax = original
    if (hadOajax) $.oajax = previous
    else delete $.oajax
  }
}
