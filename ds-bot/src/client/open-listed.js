// DSH's main view opens only a Session that its client list already holds; any other id
// throws `sessions.retain: unknown session`. A part the Host made a moment ago, or any part
// before the first list arrives, waits for the list; a newer navigation drops the wait.
export function listedOpener({ list, open, refresh }) {
  let drop = () => {}
  return (target) => {
    drop()
    drop = () => {}
    const listed = () => list.getSnapshot().byId?.[target] !== undefined
    if (listed()) { open(target); return }
    const off = list.subscribe(() => {
      if (!listed()) return
      off()
      drop = () => {}
      open(target)
    })
    drop = off
    refresh?.()
  }
}
