// The first start: where the app keeps its data and the Bots' files (the default places, or the
// one folder picked from the start page), and whether it copies the Bot team of the user's own
// DSH. The answers are kept in the app's own data.
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findTeam, newerSessions, teamInUse, userDshHome } from './import.mjs'
import { installFolder } from './move-data.mjs'

const TEXT = {
  en: {
    pickRoot: 'Where DeepSeek Bot keeps its data',
    inDsh: home => `Choose a folder outside the DeepSeek Harness data (${home}).`,
    inProgram: 'Choose a folder outside the program folder: uninstalling removes it.',
    pickMove: 'New folder for DeepSeek Bot data',
    moveDrive: 'Choose a folder, not a whole drive.',
    moveNested: 'Choose a folder outside the current data folder.',
    moveWorkspace: 'The data folder and the team workspace cannot hold each other.',
    moveNotEmpty: 'Choose an empty folder or a new one.',
    moveConfirm: to => `Move DeepSeek Bot's data to ${to}?`,
    moveDetail: from => `DeepSeek Bot copies its data there and starts again. ${from} stays as it is; you can delete it once everything works.`,
    move: 'Move and restart', cancel: 'Cancel',
    moveInUse: 'Another DeepSeek Harness is using this data, so it was not moved. Close it, then try again.',
    moveFailed: message => `The data could not be copied: ${message}\n\nDeepSeek Bot goes on with its data where it was.`,
    found: (bots, rooms) => `DeepSeek Harness has a Bot team: ${bots} Bot${bots === 1 ? '' : 's'}${rooms > 0 ? `, ${rooms} group${rooms === 1 ? '' : 's'}` : ''}. Copy it into DeepSeek Bot?`,
    foundDetail: home => `The copy takes the Bots, groups, memories, chats, files, keys and model settings. Nothing in ${home} changes, and the two teams do not stay in step.`,
    copy: 'Copy', skip: 'Do not copy',
    inUse: 'DeepSeek Harness is using this team. Close it, then try again.', retry: 'Try again',
    newer: count => `${count} chat${count === 1 ? ' was' : 's were'} written by a newer DeepSeek Harness than this DeepSeek Bot can read. Update DeepSeek Bot, then start it again to copy the team.`,
    quit: 'Quit', startEmpty: 'Start without the team',
    whichModels: 'Which model settings should DeepSeek Bot use?',
    failed: message => `The team could not be copied: ${message}\n\nDeepSeek Bot starts with a new team. The team in DeepSeek Harness is unchanged.`,
  },
  zh: {
    pickRoot: '选择 DeepSeek Bot 放数据的位置',
    inDsh: home => `请选择 DeepSeek Harness 数据（${home}）以外的文件夹。`,
    inProgram: '请选择程序文件夹以外的位置：卸载时会删掉程序文件夹。',
    pickMove: '选择 DeepSeek Bot 数据的新文件夹',
    moveDrive: '请选择一个文件夹，不要选整个磁盘。',
    moveNested: '请选择现在的数据文件夹以外的位置。',
    moveWorkspace: '数据文件夹和总工作区不能互相包含。',
    moveNotEmpty: '请选择一个空文件夹，或者新建一个。',
    moveConfirm: to => `把 DeepSeek Bot 的数据移到 ${to} 吗？`,
    moveDetail: from => `DeepSeek Bot 会把数据复制过去，然后重新启动。${from} 会原样保留，确认一切正常后可以自己删掉。`,
    move: '移动并重启', cancel: '取消',
    moveInUse: '另一个 DeepSeek Harness 正在使用这份数据，所以没有移动。请先关掉它，再重试。',
    moveFailed: message => `数据没有复制成功：${message}\n\nDeepSeek Bot 会继续使用原来位置的数据。`,
    found: (bots, rooms) => `DeepSeek Harness 里有一个 Bot 团队：${bots} 个 Bot${rooms > 0 ? `、${rooms} 个群` : ''}。要复制到 DeepSeek Bot 吗？`,
    foundDetail: home => `会复制 Bot、群、记忆、对话、文件、密钥和模型设置。${home} 里的内容不会改变；复制以后两个团队各自独立。`,
    copy: '复制', skip: '不复制',
    inUse: 'DeepSeek Harness 正在使用这个团队。请先关掉它，再重试。', retry: '重试',
    newer: count => `有 ${count} 段对话是更新版本的 DeepSeek Harness 写的，这个版本的 DeepSeek Bot 读不了。请先更新 DeepSeek Bot，再打开它来复制团队。`,
    quit: '退出', startEmpty: '不带团队开始',
    whichModels: 'DeepSeek Bot 用哪一份模型设置？',
    failed: message => `团队没有复制成功：${message}\n\nDeepSeek Bot 会用一个新团队开始。DeepSeek Harness 里的团队没有变化。`,
  },
}
export const localeText = table => (app.getLocale().toLowerCase().startsWith('zh') ? table.zh : table.en)
export const text = () => localeText(TEXT)

const PROFILE_NAMES = { desktop: 'DSH Desktop', web: 'DSH Web' }
const locationsFile = () => join(app.getPath('userData'), 'locations.json')

// A quit request while a first-run dialog is open stops the first run right after that dialog.
class Quit extends Error {}

// The dialogs belong to `ui.owner()` (the start window); `ui.asking` holds the start's clock while
// the user answers.
async function ask(options, signal, ui) {
  const { response } = await ui.asking(dialog.showMessageBox(ui.owner(), { title: 'DeepSeek Bot', noLink: true, ...options, signal }))
  // A quit that arrived while a synchronous macOS box was open gets to run first.
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return response
}

async function pick(title, from, signal, ui) {
  const { canceled, filePaths } = await ui.asking(dialog.showOpenDialog(ui.owner(), { title, defaultPath: existsSync(from) ? from : dirname(from), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] }))
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return canceled ? undefined : filePaths[0]
}

export const programFolder = () => installFolder(app.getPath('exe'))

/**
 * The system picker of 「换个位置…」 on the start page: one folder, from which the root rule
 * (place.mjs) makes the places. Undefined when the box was cancelled or the app is quitting.
 * @param {string} from the folder the picker opens in
 */
export async function pickRoot(from, signal, ui) {
  try {
    return await pick(text().pickRoot, from, signal, ui)
  } catch (error) {
    if (error instanceof Quit) return undefined
    throw error
  }
}

/** The places a first start offers. */
export const defaultPlaces = () => ({ dataDir: join(homedir(), '.ds-bot'), workspace: join(homedir(), 'DeepSeek Bot') })

/** The Bot team in a data folder, if it has one. */
export function teamIn(dataDir) {
  try {
    return findTeam(dataDir)
  } catch {
    return undefined
  }
}

/**
 * What the start window can say before the first-run questions: the team that a reinstall keeps,
 * or whether the user's own DSH has a team to offer.
 */
export function teamsAt(dataDir = defaultPlaces().dataDir) {
  const team = teamIn(dataDir)
  return { team, offered: team === undefined && teamIn(userDshHome()) !== undefined }
}

/** @returns {Promise<{ offered: boolean, import?: { from: string, profile?: string }, quit?: true }>} */
async function offerImport(t, dataDir, signal, ui) {
  const from = userDshHome()
  let found
  try {
    found = teamIn(dataDir) === undefined ? findTeam(from) : undefined
  } catch (error) {
    console.error(error)
  }
  if (found === undefined) return { offered: false }
  if (await ask({ type: 'question', message: t.found(found.bots, found.rooms), detail: t.foundDetail(from), buttons: [t.copy, t.skip], defaultId: 0, cancelId: 1 }, signal, ui) === 1) return { offered: true }
  while (teamInUse(from)) {
    if (await ask({ type: 'warning', message: t.inUse, buttons: [t.retry, t.skip], defaultId: 0, cancelId: 1 }, signal, ui) === 1) return { offered: true }
  }
  const newer = newerSessions(from, found.team)
  if (newer.length > 0) {
    if (await ask({ type: 'warning', message: t.newer(newer.length), buttons: [t.quit, t.startEmpty], defaultId: 0, cancelId: 0 }, signal, ui) === 0) return { offered: true, quit: true }
    return { offered: true }
  }
  const { profiles } = found
  const profile = profiles.length < 2 ? profiles[0]?.name
    : profiles[await ask({ type: 'question', message: t.whichModels, buttons: profiles.map(entry => PROFILE_NAMES[entry.name] ?? entry.name), defaultId: 0, cancelId: 0 }, signal, ui)].name
  return { offered: true, import: { from, profile } }
}

/** Write the chosen places once the first run is finished; quitting before that asks again. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/**
 * Where the app keeps its data and the Bots' files: the saved places, or at the first start the
 * default ones without a question (the start page says where the data goes and offers
 * 「换个位置…」; windows-onboarding §3). The offer to copy a team is still a dialog that belongs
 * to `ui.owner()`. A run on throwaway folders (DS_BOT_HOME, for development and tests) asks
 * nothing and copies nothing. `offered` says whether the first run offered to copy a team.
 * @param {AbortSignal} signal
 * @param {{ owner: () => import('electron').BrowserWindow | undefined, asking: <T>(answer: Promise<T>) => Promise<T> }} ui
 * @returns {Promise<{ dataDir: string, workspace?: string, import?: { from: string, profile?: string }, offered?: boolean, quit?: true }>}
 */
export async function chooseLocations(signal, ui) {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { dataDir: saved.dataDir, workspace: saved.workspace }
  }
  const { dataDir, workspace } = defaultPlaces()
  let offered
  try {
    const offer = await offerImport(text(), dataDir, signal, ui)
    if (offer.quit) return { quit: true }
    if (offer.import !== undefined) return { dataDir, workspace, import: offer.import, offered: true }
    offered = offer.offered
  } catch (error) {
    if (error instanceof Quit) return { quit: true }
    throw error
  }
  // There is nothing to copy, so the first run ends with the chosen places.
  saveLocations({ dataDir, workspace })
  return { dataDir, workspace, offered }
}
