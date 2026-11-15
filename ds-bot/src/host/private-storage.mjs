import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'

const WINDOWS_ACL_CHECK = [
  "$ErrorActionPreference = 'Stop'",
  '$path = $env:DSBOT_PRIVATE_PATH',
  "if ([string]::IsNullOrWhiteSpace($path)) { exit 10 }",
  '$acl = Get-Acl -LiteralPath $path -ErrorAction Stop',
  '$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  'if ($owner -ne $identity) { exit 11 }',
  "$trusted = @($identity,'S-1-5-18','S-1-5-32-544','S-1-3-0')",
  '$privateBits = [int64]([Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes -bor [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::ReadPermissions -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::ExecuteFile)',
  'foreach ($entry in $acl.Access) {',
  '  if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }',
  '  $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value',
  '  if ($trusted -notcontains $sid -and (([int64]$entry.FileSystemRights -band $privateBits) -ne 0)) { exit 12 }',
  '}',
  'exit 0',
].join('\n')

function windowsAclIsPrivate(path) {
  const systemRoot = process.env.SystemRoot
  if (typeof systemRoot !== 'string' || !systemRoot) return false
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_CHECK], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024, windowsHide: true,
    env: { ...process.env, DSBOT_PRIVATE_PATH: path },
  })
  return result.error === undefined && result.status === 0
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino

/** Verify a private file or directory without treating Windows' mode bits as POSIX ACLs. */
export function isPrivatePath(path, stat, kind, { platform = process.platform, uid = typeof process.getuid === 'function' ? process.getuid() : undefined, checkWindowsAcl = windowsAclIsPrivate, inspectPath = lstatSync } = {}) {
  if (typeof path !== 'string' || !path || !stat || !['file', 'directory'].includes(kind)) return false
  const absolute = platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)
  if (!absolute || stat.isSymbolicLink?.() === true || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) return false
  if (platform !== 'win32') return uid !== undefined && stat.uid === uid && (stat.mode & 0o077) === 0
  if (checkWindowsAcl(path) !== true) return false
  try {
    const after = inspectPath(path)
    return !after.isSymbolicLink() && (kind === 'file' ? after.isFile() : after.isDirectory()) && sameIdentity(stat, after)
  } catch {
    return false
  }
}

export const isPrivateDirectory = (path, stat = lstatSync(path), options) => isPrivatePath(path, stat, 'directory', options)
export const isPrivateFile = (path, stat = lstatSync(path), options) => isPrivatePath(path, stat, 'file', options)
