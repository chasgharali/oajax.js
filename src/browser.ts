/**
 * Script-tag build (dist/oajax.min.js). Defines:
 *
 * - `window.oajax`: the shared client (callable), plus `createOajax`, the
 *   storage adapters, error classes, `configure`, `installJQuery` and
 *   `createAjax`.
 * - `window.$oajax`: the v1-style function with `success` / `error` callbacks.
 * - `jQuery.oajax`, when jQuery is already on the page.
 *
 * Like v1, it is meant to be loaded after jQuery if you use jQuery, but it
 * does not need it.
 */
import * as core from './index'
import { $oajax, createAjax, installJQuery, param } from './jquery'

const { oajax, ...rest } = core
const api = Object.assign(oajax, rest, { $oajax, createAjax, installJQuery, param, version: '2.0.0' })

const g = globalThis as Record<string, unknown> & { jQuery?: { ajax: (...a: unknown[]) => unknown } }
g.oajax = api
g.$oajax = $oajax
if (g.jQuery && typeof g.jQuery.ajax === 'function') installJQuery(g.jQuery)
