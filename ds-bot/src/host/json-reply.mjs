// Memory reviews and tidies ask a model for one JSON object. Models sometimes wrap
// it in a sentence, a code fence, or several candidates. Reading the reply as a whole
// JSON value, then as any complete object or array that parses, keeps a usable answer
// from being thrown away while still refusing prose that holds no list at all.
const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)```/g

function spans(text, open, close) {
  const found = []
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, start + 1)) {
    let depth = 0, inString = false, escaped = false, end = -1
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) { end = i + 1; break }
      }
    }
    if (end !== -1) found.push(text.slice(start, end))
  }
  return found
}

function changesOf(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Array.isArray(value.changes)) return value.changes
  return undefined
}

function candidates(text) {
  const list = []
  const raw = String(text ?? '')
  for (const match of raw.matchAll(FENCE)) list.push(match[1])
  list.push(raw.replace(/```(?:json|JSON)?/g, ''))
  return list
}

// The changes list a reply carries, or undefined when it carries none.
export function readChanges(text) {
  const sources = candidates(text)
  for (const source of sources) {
    const trimmed = source.trim()
    if (trimmed === '') continue
    try {
      const changes = changesOf(JSON.parse(trimmed))
      if (changes !== undefined) return changes
    } catch { /* not a single JSON value */ }
  }
  for (const source of sources) {
    for (const object of spans(source, '{', '}').reverse()) {
      try {
        const changes = changesOf(JSON.parse(object))
        if (changes !== undefined) return changes
      } catch { /* a brace that was not JSON */ }
    }
    for (const array of spans(source, '[', ']').reverse()) {
      try {
        const value = JSON.parse(array)
        if (Array.isArray(value) && value.every(item => item !== null && typeof item === 'object')) return value
      } catch { /* an array that was not JSON */ }
    }
  }
  return undefined
}

// Whether the reply carries any JSON list, for diagnostics that separate "the model
// explained instead of answering" from "the answer was cut off".
export function looksLikeExplanation(text) {
  return readChanges(text) === undefined && !/```/.test(String(text ?? ''))
}