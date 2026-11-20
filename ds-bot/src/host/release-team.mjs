// Release teams: the roles a release needs, which existing Bot fills each role,
// and the group the release uses for coordination. The board remains the task
// authority; the release group is where the roles coordinate and report.
import { RELEASE_ROLE_LABELS_ZH } from '../shared/release-labels.js'

const ROLE = (key, label, required, instructions) => ({ key, label, required, instructions })

export const RELEASE_ROLES = [
  ROLE('projectManager', 'Project Manager', true, 'Coordinate this release within the existing group, maintain its task board and gates, and report verified outcomes to the user.'),
  ROLE('productManager', 'Product Manager', true, 'Turn the requirement into acceptance criteria and a feature breakdown. Keep scope explicit.'),
  ROLE('architect', 'Architect', true, 'Own the technical design, interfaces, dependency order and review of technical risks.'),
  ROLE('uiDesigner', 'UI Designer', false, 'Own the user interface design and visual acceptance.'),
  ROLE('uxDesigner', 'UX Designer', false, 'Own the interaction flow and usability acceptance.'),
  ROLE('frontend', 'Frontend Developer', true, 'Implement the user-facing software and its automated checks.'),
  ROLE('backend', 'Backend Developer', true, 'Implement services, data and integration logic and their automated checks.'),
  ROLE('apiEngineer', 'API Engineer', false, 'Own API contracts, middleware and integration boundaries.'),
  ROLE('dba', 'Database Administrator', false, 'Own schema, migrations, data safety and database operations.'),
  ROLE('tester', 'Test Engineer', true, 'Write the failing tests first (TDD), then verify implementation, regression and acceptance evidence independently.'),
  ROLE('reviewer', 'Independent Reviewer', true, 'Review code and evidence independently from the owner; pass or request rework.'),
  ROLE('ops', 'Operations Engineer', true, 'Own deployment, environment checks, observability and rollback readiness.'),
]

export const RELEASE_ROLE_KEYS = RELEASE_ROLES.map(role => role.key)
const roleByKey = new Map(RELEASE_ROLES.map(role => [role.key, role]))
const labelKey = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/gu, ' ').replace(/([a-z]) (?=\p{Script=Han})/gu, '$1') : ''
const roleByLabel = new Map(RELEASE_ROLES.flatMap(role => [role.label, RELEASE_ROLE_LABELS_ZH[role.label]].map(label => [labelKey(label), role])))

export const invalidReleaseTeam = message => Object.assign(new Error(message), { code:'bot/invalid' })

export function releaseRole(key) { return roleByKey.get(key) }

export function roleForBot(bot) {
  if (!bot) return undefined
  return roleByLabel.get(labelKey(bot.role)) ?? roleByLabel.get(labelKey(bot.name))
}

export function canConfigureReleaseTeam(release, roomId) {
  return typeof roomId === 'string' && release?.groupId === roomId && release.scope === `room:${roomId}`
    && release.status === 'draft' && release.projectManagerId === undefined && Object.keys(release.roles ?? {}).length === 0
}

export function resolveReleaseTeam({ bots = {}, projectManagerId, roles = {}, explicitOnly = false }) {
  if (explicitOnly && (!roles || typeof roles !== 'object' || Array.isArray(roles)
    || Object.keys(roles).some(key => !roleByKey.has(key))
    || (projectManagerId !== undefined && roles.projectManager !== undefined && roles.projectManager !== projectManagerId))) {
    throw invalidReleaseTeam('Invalid release role selection')
  }
  const live = id => typeof id === 'string' && Object.hasOwn(bots, id) && bots[id]?.private !== true
  const byRole = new Map()
  for (const role of RELEASE_ROLES) {
    const chosen = roles?.[role.key]
    if (chosen !== undefined) {
      if (!live(chosen)) throw invalidReleaseTeam(`Release role ${role.label} is not an available Bot`)
      byRole.set(role.key, chosen)
      continue
    }
    if (explicitOnly) continue
    const found = Object.values(bots).find(bot => live(bot.id) && roleForBot(bot)?.key === role.key)
    if (found) byRole.set(role.key, found.id)
  }
  let pm = projectManagerId ?? byRole.get('projectManager')
  if (!pm) throw invalidReleaseTeam('Missing release roles: Project Manager')
  if (!live(pm)) throw invalidReleaseTeam('The project manager is not an available Bot')
  byRole.set('projectManager', pm)
  const missing = RELEASE_ROLES.filter(role => role.required && !byRole.has(role.key)).map(role => role.label)
  if (missing.length) throw invalidReleaseTeam(`Missing release roles: ${missing.join(', ')}`)
  const reviewer = byRole.get('reviewer')
  if (reviewer && [...byRole.entries()].some(([key, id]) => key !== 'reviewer' && id === reviewer)) {
    throw invalidReleaseTeam('The independent reviewer must be a Bot that did not fill another release role')
  }
  const members = [...new Set([pm, ...byRole.values()])]
  return { projectManagerId: pm, roles: Object.fromEntries(byRole), members }
}

export function releaseTeamView({ bots = {}, projectManagerId, roles = {} }) {
  return {
    projectManagerId,
    roles,
    members: [...new Set([projectManagerId, ...Object.values(roles)])],
    rolesView: RELEASE_ROLES.map(role => ({
      key: role.key,
      label: role.label,
      required: role.required,
      botId: roles[role.key] ?? null,
      botName: roles[role.key] ? (bots[roles[role.key]]?.name ?? null) : null,
    })),
  }
}

export function lifecyclePlan({ release, requirement, roles = {}, cardType = 'feature' }) {
  const owner = key => roles[key]
  const pm = roles.projectManager
  const items = []
  const add = (key, type, title, ownerRole, reviewerRole, dependencies = []) => {
    const ownerId = owner(ownerRole)
    const reviewerId = reviewerRole === 'projectManager' ? pm : owner(reviewerRole)
    if (!ownerId || !reviewerId || ownerId === reviewerId) throw invalidReleaseTeam(`Release task ${key} needs an owner and independent reviewer`)
    items.push({ key, type, title, owner: ownerId, reviewer: reviewerId, dependencies })
  }
  add('requirement', 'requirement', `Requirement and acceptance criteria: ${requirement}`, 'productManager', 'projectManager')
  add('design', 'design', `Technical and experience design: ${requirement}`, 'architect', 'projectManager', ['requirement'])
  add('test-plan', 'test', `TDD test plan and failing tests: ${requirement}`, 'tester', 'architect', ['design'])
  if (roles.uiDesigner || roles.uxDesigner) add('ui', 'ui', `UI/UX implementation and interaction checks: ${requirement}`, roles.uiDesigner ? 'uiDesigner' : 'uxDesigner', 'productManager', ['design'])
  add('backend', 'development', `Backend implementation and unit tests: ${requirement}`, 'backend', 'architect', ['design', 'test-plan'])
  add('frontend', 'development', `Frontend implementation and integration: ${requirement}`, 'frontend', roles.uiDesigner ? 'uiDesigner' : 'projectManager', ['design', 'test-plan', ...(roles.uiDesigner || roles.uxDesigner ? ['ui'] : [])])
  add('test-run', 'test', `TDD verification and regression suite: ${requirement}`, 'tester', 'projectManager', ['backend', 'frontend'])
  add('review', 'test', `Independent code and evidence review: ${requirement}`, 'reviewer', 'projectManager', ['test-run'])
  add('deploy', 'deployment', `Deployment to the target environment: ${requirement}`, 'ops', 'projectManager', ['review'])
  add('operations', 'operations', `Production smoke, observability and rollback check: ${requirement}`, 'ops', 'projectManager', ['deploy'])
  add('summary', cardType, requirement, 'projectManager', 'productManager', ['operations'])
  const deliveryEvidence = {
    deploy:'Identify the built artifact and target environment. Verify that the deployed version is reachable.',
    operations:'Record the observed version, user-facing smoke result and rollback readiness.',
    summary:'Reconcile all completed items, independent reviews, deliverable location and remaining release gates.',
  }
  return items.map(item => ({
    ...item,
    title: item.title.slice(0, 200),
    acceptance: `Record evidence on this task for independent review of ${release.name} ${release.version}.${deliveryEvidence[item.key] ? ' ' + deliveryEvidence[item.key] : ''}`,
  }))
}

export function buildReleaseReport(release, items, bots = {}) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char])
  const nameOf = id => bots[id]?.name ?? id
  const gates = release.gates ?? {}
  const lines = [
    `# ${release.name}${release.version ? ' ' + release.version : ''}`,
    '',
    `- 状态：${release.status}`,
    `- 版本：${release.version || '(未填写)'}`,
    `- 发布协调群：${release.groupId || '(未创建)'}`,
    `- 项目经理：${nameOf(release.projectManagerId)}`,
    `- 开始：${release.startedAt ? new Date(release.startedAt).toISOString() : '-'}`,
    `- 发布：${release.publishedAt ? new Date(release.publishedAt).toISOString() : '-'}`,
    '',
    '## 团队角色',
    '',
    '| 角色 | Bot |',
    '|---|---|',
    ...Object.entries(release.roles ?? {}).map(([role, id]) => `| ${role} | ${nameOf(id)} |`),
    '',
    '## 发布项',
    '',
    '| 任务 | 类型 | 负责人 | 验收人 | 状态 |',
    '|---|---|---|---|---|',
    ...items.map(task => `| ${task.title} | ${task.type ?? 'other'} | ${nameOf(task.owner)} | ${nameOf(task.reviewer)} | ${task.status} |`),
    '',
    '## 发布门禁',
    '',
    '| 门禁 | 状态 | 证据 |',
    '|---|---|---|',
    ...['docs','artifacts','environment','summary'].map(gate => `| ${gate} | ${gates[gate]?.status ?? 'pending'} | ${gates[gate]?.evidence ?? ''} |`),
    '',
    '## 总结',
    '',
    gates.summary?.evidence || '待补充总结证据。',
    '',
  ]
  const markdown = lines.join('\n')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(release.name)} ${escape(release.version ?? '')}</title><style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:960px;margin:40px auto;padding:0 20px;color:#141414}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}code{background:#f4f4f4;padding:1px 4px;border-radius:4px}</style></head><body><pre style="white-space:pre-wrap;font:inherit">${escape(markdown)}</pre></body></html>`
  return { markdown, html }
}
