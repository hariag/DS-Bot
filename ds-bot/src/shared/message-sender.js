// Old relay records can identify the sender by a Bot id or by the Session it sent from.
// A target Session, an asking Bot and a group admin are not evidence of who sent a message.
const field = value => typeof value === 'string' && value.trim() ? value.trim() : undefined

export function relaySender(source) {
  const sender = source?.sender
  return {
    id: field(source?.senderSessionId) ?? field(source?.senderId) ?? field(source?.fromId)
      ?? field(sender?.id) ?? field(sender?.sessionId) ?? field(sender),
    name: field(source?.senderName) ?? field(sender?.name) ?? field(source?.fromName),
  }
}

export function peerRole(source) {
  if (!source || source.form === 'snapshot') return undefined
  if (['request', 'reply', 'stopped'].includes(source.role)) return source.role
  if (source.role !== undefined) return undefined
  const sender = relaySender(source)
  if (source.form === 'relay' || sender.id || sender.name) return 'request'
}
