export function proposalTurn(proposal, turns) {
  if (!Number.isFinite(proposal?.at) || typeof turns?.values !== 'function') return undefined
  let latest
  let before
  for (const location of turns.values()) {
    const end = location?.end?.time
    if (location?.status !== 'closed' || !Number.isFinite(end)) continue
    const later = target => target === undefined || end > target.end.time || (end === target.end.time && location.turn > target.turn)
    if (later(latest)) latest = location
    if (end <= proposal.at && later(before)) before = location
  }
  return (before ?? latest)?.turn
}
