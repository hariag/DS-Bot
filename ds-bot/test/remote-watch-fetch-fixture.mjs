// Preloaded only by the isolated Host test. Never make an external request.
import { appendFileSync } from 'node:fs'
const realFetch=globalThis.fetch
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40)
const commit=sha=>({sha,commit:{message:`Fixture ${sha[0]}`,author:{name:'Fixture'},committer:{date:'2026-01-01T00:00:00Z'}}})
globalThis.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string' ? input : input.url)
  if (url.hostname==='127.0.0.1' || url.hostname==='localhost' || url.hostname==='::1') return realFetch(input,options)
  if (url.origin!=='https://api.github.com' || !url.pathname.startsWith('/repos/example/project/') || options.headers?.Authorization!=='Bearer isolated-test-token') throw new Error('external network blocked by isolated fixture')
  if (process.env.DSBOT_E2E_TRACE) appendFileSync(process.env.DSBOT_E2E_TRACE,`${url.pathname}${url.search}\n`)
  let body
  if (url.pathname.endsWith('/commits')) body=[{sha:c}]
  else if (url.pathname.endsWith(`/compare/${a}...${c}`)) body={status:'ahead',merge_base_commit:{sha:a},total_commits:2,commits:[commit(b),commit(c)]}
  else if (url.pathname.endsWith(`/commits/${b}`)) body={sha:b,files:[{filename:'team/patrol/cursor'}]}
  else if (url.pathname.endsWith(`/commits/${c}`)) body={sha:c,files:[{filename:'src/real-change.js'}]}
  else throw new Error('unexpected fixture request')
  return Response.json(body)
}
