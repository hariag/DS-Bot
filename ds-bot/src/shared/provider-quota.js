// Some adapters keep the HTTP status and provider payload only in the error text.
const FORBIDDEN_PREFIX = /^[^\s:]+ API error \(403\):\s*/
const QUOTED_STRING = /"(?:\\.|[^"\\])*"|'((?:\\.|[^'\\])*)'/gs

export function isForbiddenQuota(error) {
  if (error?.code !== 'AUTH' || (error.status !== undefined && error.status !== 403)) return false
  if (typeof error.message !== 'string') return false
  const text = error.message.trim()
  const prefix = FORBIDDEN_PREFIX.exec(text)
  if (prefix === null && error.status !== 403) return false
  let body = text.slice(prefix?.[0].length ?? 0)
  if (!body.startsWith('{')) return false
  // A gateway may serialize its flat error object with single-quoted strings.
  // Decode fields before checking the code so a quoted example in the message
  // cannot turn a real credential failure into a quota failure.
  if (/^\{\s*'/.test(body)) {
    body = body.replace(QUOTED_STRING, (token, single) =>
      single === undefined ? token : JSON.stringify(single.replace(/\\(['\\])/g, '$1')))
  }
  try {
    return JSON.parse(body)?.code === 'insufficient_user_quota'
  } catch {
    return false
  }
}
