// The window's files and the authenticated request forwarding to the Host.
// The launch-token exchange and the forwarding adapt DeepSeek Harness
// apps/desktop/src/web-document.ts (MIT); see NOTICE.
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export const APP_ORIGIN = 'dsh-app://app'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}

/**
 * Serve a file of the window's build.
 * @param {Request} request - request from the app origin
 * @param {string} root - the build's directory
 * @returns {Promise<Response>}
 */
export async function serveFile(request, root) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  if (!target.startsWith(resolve(root) + sep)) return new Response(null, { status: 403 })
  let body
  try { body = await readFile(target) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return new Response(null, { status: 404 })
    throw error
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host's launch URL for its authority-bound cookie.
 * @param {string} url - authenticated URL reported by the Host
 * @returns {Promise<string>} the `name=value` cookie pair
 */
export async function authenticateWebHost(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('DeepSeek Bot: the DSH Host refused the launch token')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

// `set-cookie` would put the Host cookie into the page's cookie jar, which the shell owns instead;
// the rest describe Node's own connection, which Chromium never sees.
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/**
 * Forward a request from the app origin to the Host as a same-origin request with the Host cookie.
 * The response streams through, so the live feed arrives as it is written.
 * @param {Request} request - request from the app origin
 * @param {string} host - Host URL
 * @param {string} cookie - Host cookie pair
 * @returns {Promise<Response>}
 */
export async function forwardWebRequest(request, host, cookie) {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== APP_ORIGIN) return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const response = await fetch(target, {
    method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual',
  })
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  return new Response(response.body, { status: response.status, headers: outgoing })
}
