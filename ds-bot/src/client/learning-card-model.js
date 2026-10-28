export function proposalPlacement(proposal, turns) {
  if (!Number.isFinite(proposal?.at) || typeof turns?.values !== 'function') return { kind: 'dock' }
  let latest
  let before
  for (const location of turns.values()) {
    const end = location?.end?.time
    if (location?.status !== 'closed' || !Number.isFinite(end)) continue
    const later = target => target === undefined || end > target.end.time || (end === target.end.time && location.turn > target.turn)
    if (later(latest)) latest = location
    if (end <= proposal.at && later(before)) before = location
  }
  const turn = (before ?? latest)?.turn
  return turn === undefined ? { kind: 'dock' } : { kind: 'turn', turn }
}

export function fileLines(text) {
  const body = String(text ?? '').replace(/\n+$/, '')
  return body === '' ? [] : body.split('\n')
}

export function lineDiff(before, after) {
  const a = fileLines(before)
  const b = fileLines(after)
  const keep = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      keep[i][j] = a[i] === b[j] ? keep[i + 1][j + 1] + 1 : Math.max(keep[i + 1][j], keep[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: 'same', line: b[j], number: j + 1 })
      i++
      j++
    } else if (i < a.length && (j === b.length || keep[i + 1][j] >= keep[i][j + 1])) {
      rows.push({ kind: 'removed', line: a[i] })
      i++
    } else {
      rows.push({ kind: 'added', line: b[j], number: j + 1 })
      j++
    }
  }
  return rows
}
