// Object-bound evidence: a Bot that cites a commit or blob may only do so when the
// configured repository actually holds the object. The text of an evidence note is
// never trusted for this; only `git cat-file -e` on the exact identity counts.
import { execFileSync } from 'node:child_process'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FIELDS = ['targetCommit', 'targetBlob', 'acceptanceBlob']

// The identities in a `kind: 'git'` evidence value, in field order.
export function evidenceShas(value) {
  if (!value || value.kind !== 'git') return []
  return FIELDS.filter(field => typeof value[field] === 'string' && SHA.test(value[field])).map(field => value[field])
}

// True only when the repository holds every identity the evidence cites.
export function verifyGitEvidence(repo, value) {
  if (typeof repo !== 'string' || repo.trim() === '') return false
  const shas = evidenceShas(value)
  if (shas.length === 0) return false
  try {
    for (const sha of shas) {
      execFileSync('git', ['-C', repo, 'cat-file', '-e', sha], { stdio: 'ignore', timeout: 5000 })
    }
    return true
  } catch {
    return false
  }
}

// A read-only audit for the team: how many board reports cite objects the repository
// can still resolve. `reports` is [{ id, status, evidence }].
export function auditReports(repo, reports) {
  const rows = []
  for (const report of reports) {
    const evidence = report.evidence
    const kind = evidence?.kind ?? 'none'
    const shas = evidenceShas(evidence)
    const verified = kind === 'git' ? verifyGitEvidence(repo, evidence) : false
    rows.push({ id: report.id, status: report.status, kind, structured: shas.length > 0, verified })
  }
  const summary = {
    total: rows.length,
    personal: rows.filter(row => row.kind === 'personal').length,
    git: rows.filter(row => row.kind === 'git').length,
    verifiedGit: rows.filter(row => row.verified).length,
    unstructured: rows.filter(row => row.kind === 'none').length,
  }
  return { summary, rows }
}