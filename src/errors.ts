/** Base class for errors oajax creates. */
export class OajaxError extends Error {
  /** The underlying error, e.g. the TypeError fetch threw. */
  cause?: unknown
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'OajaxError'
    if (options && 'cause' in options) this.cause = options.cause
  }
}

/** The server answered, with a status outside 200-299. */
export class OajaxHttpError<T = unknown> extends OajaxError {
  readonly status: number
  readonly statusText: string
  readonly data: T
  readonly headers: Record<string, string>
  constructor(status: number, statusText: string, data: T, headers: Record<string, string>) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`)
    this.name = 'OajaxHttpError'
    this.status = status
    this.statusText = statusText
    this.data = data
    this.headers = headers
  }
}

/** The attempt took longer than `timeout`. */
export class OajaxTimeoutError extends OajaxError {
  constructor(timeout: number) {
    super(`Request timed out after ${timeout} ms`)
    this.name = 'OajaxTimeoutError'
  }
}

/**
 * The network was unreachable and there was nothing to fall back on: no cached
 * copy for a read, or queueing was turned off / impossible for a write.
 */
export class OajaxNetworkError extends OajaxError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'OajaxNetworkError'
  }
}
