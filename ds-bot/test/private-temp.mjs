import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { invalidateWindowsAclCache, isPrivateDirectory } from '../src/host/private-storage.mjs'

let windowsPrivateRoot

const WINDOWS_PRIVATE_ACL = [
  "$ErrorActionPreference = 'Stop'",
  '$path = $env:DSBOT_TEST_PRIVATE_PATH',
  "if ([string]::IsNullOrWhiteSpace($path)) { exit 10 }",
  '$acl = Get-Acl -LiteralPath $path -ErrorAction Stop',
  '$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)',
  '$acl.SetAccessRuleProtection($true, $false)',
  'foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }',
  '$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
  "$sids = @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
  "if ($env:DSBOT_TEST_SHARED_ACCESS -eq '1') { $sids += [Security.Principal.SecurityIdentifier]::new('S-1-1-0') }",
  'foreach ($sid in $sids) {',
  '  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
  '  [void]$acl.AddAccessRule($rule)',
  '}',
  'Set-Acl -LiteralPath $path -AclObject $acl -ErrorAction Stop',
].join('\n')

const WINDOWS_ACL_DETAILS = [
  "$ErrorActionPreference = 'Stop'",
  '$path = $env:DSBOT_TEST_PRIVATE_PATH',
  '$acl = Get-Acl -LiteralPath $path -ErrorAction Stop',
  '$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  'Write-Output "identity=$identity owner=$owner"',
  'foreach ($entry in $acl.Access) { $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; Write-Output "$sid $($entry.AccessControlType) $($entry.FileSystemRights) inherited=$($entry.IsInherited)" }',
].join('\n')

export function setPrivateTempAcl(path, { shared = false } = {}) {
  if (process.platform !== 'win32') return path
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('Windows test temp ACL unavailable')
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_ACL], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024, windowsHide: true,
    env: { ...process.env, DSBOT_TEST_PRIVATE_PATH: path, DSBOT_TEST_SHARED_ACCESS: shared ? '1' : '0' },
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `PowerShell exited with ${result.status}`
    throw new Error(`Could not secure Windows test temp directory: ${detail}`)
  }
  invalidateWindowsAclCache(path)
  return path
}

export function describePrivateTempAcl(path) {
  if (process.platform !== 'win32') return ''
  const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let structural
  try {
    const stat = lstatSync(path)
    structural = isPrivateDirectory(path, stat, { platform:'win32', checkWindowsAcl:() => true })
  } catch (error) { structural = error.message }
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_DETAILS], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024, windowsHide: true,
    env: { ...process.env, DSBOT_TEST_PRIVATE_PATH: path },
  })
  const acl = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `PowerShell exited with ${result.status}`
  return `node-structure=${structural}\n${acl}`
}

export function privateTempDir(prefix) {
  if (process.platform !== 'win32') return mkdtempSync(prefix)
  return setPrivateTempAcl(mkdtempSync(join(ensureWindowsPrivateRoot(), `${basename(prefix)}-`)))
}

export async function privateTempDirAsync(prefix) {
  if (process.platform !== 'win32') return mkdtemp(prefix)
  return setPrivateTempAcl(await mkdtemp(join(ensureWindowsPrivateRoot(), `${basename(prefix)}-`)))
}

export function grantSharedTempAccessForTest(path) {
  return setPrivateTempAcl(path, { shared: true })
}

function ensureWindowsPrivateRoot() {
  if (windowsPrivateRoot) return windowsPrivateRoot
  const path = mkdtempSync(join(tmpdir(), 'dsbot-private-tests-'))
  try {
    windowsPrivateRoot = setPrivateTempAcl(path)
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  process.once('exit', () => {
    try { rmSync(path, { recursive: true, force: true }) } catch {}
  })
  return windowsPrivateRoot
}
