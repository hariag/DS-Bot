// docx commands: read (block ids, tables, headers/footers, notes, comments,
// tracked changes), fields, and edit (batched ops, all-or-nothing).
import { childrenOf, elementsOf, firstOf, textOf, parseXml } from './xml.js'


const parts = (pkg) => [...pkg.parts.keys()].filter(name =>
  name === 'word/document.xml' || /^word\/(header|footer)\d+\.xml$/.test(name)
  || /^word\/(footnotes|endnotes|comments)\.xml$/.test(name))

// The paragraph/table texts a Bot reads, with tracked changes resolved one way.
function blockText(el, changes = false) {
  let out = ''
  const walk = (node, inside) => {
    if (node.nodeType === 3 || node.nodeType === 4) { if (!inside.del) out += node.data; return }
    if (node.nodeType !== 1) return
    const tag = node.tagName
    if (!changes) {
      for (const child of [...node.childNodes]) {
        if (tag === 'w:del' || tag === 'w:moveFrom') continue
        walk(child, inside)
      }
      return
    }
    let mark = inside
    let pre = '', post = ''
    const author = node.getAttribute?.('w:author') ?? ''
    if (tag === 'w:ins') { pre = `{+`; post = ` (${author})+}`; mark = { ...inside, del: false } }
    else if (tag === 'w:del') { pre = `{-`; post = ` (${author})-}`; mark = { ...inside, del: false } }
    else if (tag === 'w:moveFrom') { pre = `{<`; post = ` (${author})<}`; mark = { ...inside, del: false } }
    else if (tag === 'w:moveTo') { pre = `{>`; post = ` (${author})>}`; mark = { ...inside, del: false } }
    else if (tag === 'w:rPrChange' || tag === 'w:pPrChange') { out += '{~fmt~}'; return }
    else if (tag === 'w:moveFromRangeStart') { out += `{<move ${node.getAttribute('w:name') ?? ''}>`; return }
    else if (tag === 'w:moveToRangeStart') { out += `{>move ${node.getAttribute('w:name') ?? ''}>`; return }
    else if (tag === 'w:moveFromRangeEnd' || tag === 'w:moveToRangeEnd') { out += '{end}'; return }
    out += pre
    for (const child of [...node.childNodes]) walk(child, mark)
    out += post
  }
  walk(el, { del: false })
  return out
}

function paraStyle(p) { return firstOf(firstOf(p, 'w:pPr') ?? p, 'w:pStyle')?.getAttribute('w:val') }

function deletedParaMark(p) {
  const pPr = firstOf(p, 'w:pPr')
  return pPr !== undefined && firstOf(firstOf(pPr, 'w:rPr') ?? pPr, 'w:del') !== undefined
}

/** @returns {object[]} body blocks in reading order: pN paragraphs, tN tables */
export function docxRead(pkg, { changes = false } = {}) {
  const doc = pkg.xml('word/document.xml')
  const body = firstOf(doc.documentElement, 'w:body')
  const blocks = []
  let pi = 0, ti = 0
  const commentIds = commentsIndex(pkg)
  for (const el of childrenOf(body)) {
    if (el.tagName === 'w:p') {
      pi++
      const id = `p${pi}`
      const entry = { id, type: 'paragraph', style: paraStyle(el), text: blockText(el, changes) }
      const anchored = commentIds.get(el)
      if (anchored) entry.comments = anchored
      if (deletedParaMark(el)) entry.deletedParagraphMark = true
      blocks.push(entry)
    } else if (el.tagName === 'w:tbl') {
      ti++
      blocks.push({ id: `t${ti}`, type: 'table', rows: tableRows(el, changes) })
    }
  }
  // headers/footers per section, footnotes, endnotes, comments.
  const sections = []
  const refs = elementsOf(doc.documentElement, 'w:headerReference').concat(elementsOf(doc.documentElement, 'w:footerReference'))
  const rels = pkg.relsOf('word/document.xml')
  for (const ref of refs) {
    const rel = rels.get(ref.getAttribute('r:id'))
    if (!rel) continue
    const target = pkg.targetOf('word/document.xml', rel.target)
    const part = pkg.xml(target)
    sections.push({
      kind: ref.tagName === 'w:headerReference' ? 'header' : 'footer',
      type: ref.getAttribute('w:type'), part: target,
      text: elementsOf(part.documentElement, 'w:p').map(p => blockText(p, changes)).filter(Boolean).join('\n'),
    })
  }
  const notes = []
  for (const [kind, part] of [['footnote', 'word/footnotes.xml'], ['endnote', 'word/endnotes.xml']]) {
    if (!pkg.parts.has(part)) continue
    for (const note of elementsOf(pkg.xml(part).documentElement, `w:${kind}`)) {
      const id = note.getAttribute('w:id')
      if (id === '-1' || id === '0') continue
      notes.push({ kind, id, text: elementsOf(note, 'w:p').map(p => blockText(p, changes)).join(' ') })
    }
  }
  return { blocks, sections, notes, comments: commentsList(pkg, changes) }
}

// pN ids number only the body's top-level paragraphs — the same ids docxRead gives.
function commentsIndex(pkg) {
  const byEl = new Map()
  if (!pkg.parts.has('word/comments.xml')) return byEl
  const doc = pkg.xml('word/document.xml')
  for (const ref of elementsOf(doc.documentElement, 'w:commentReference')) {
    let p = ref.parentNode
    while (p && p.tagName !== 'w:p') p = p.parentNode
    if (!p) continue
    const arr = byEl.get(p) ?? []
    arr.push({ commentId: ref.getAttribute('w:id') })
    byEl.set(p, arr)
  }
  return byEl
}

function commentsList(pkg, changes) {
  if (!pkg.parts.has('word/comments.xml')) return []
  const commentsDoc = pkg.xml('word/comments.xml')
  const anchors = commentAnchors(pkg)
  return elementsOf(commentsDoc.documentElement, 'w:comment').map(c => ({
    id: c.getAttribute('w:id'), author: c.getAttribute('w:author'), initials: c.getAttribute('w:initials'),
    date: c.getAttribute('w:date'), text: elementsOf(c, 'w:p').map(p => blockText(p, changes)).join(' '),
    anchorsTo: anchors.get(c.getAttribute('w:id')),
  }))
}

function commentAnchors(pkg) {
  const map = new Map()
  const doc = pkg.xml('word/document.xml')
  const index = blockIndex(doc)
  const byEl = new Map([...index].map(([id, el]) => [el, id]))
  for (const ref of elementsOf(doc.documentElement, 'w:commentReference')) {
    let p = ref.parentNode
    while (p && p.tagName !== 'w:p') p = p.parentNode
    if (p && byEl.has(p)) map.set(ref.getAttribute('w:id'), byEl.get(p))
  }
  return map
}

function tableRows(tbl, changes) {
  return childrenOf(tbl, 'w:tr').map(tr =>
    childrenOf(tr, 'w:tc').map(tc => {
      const gridSpan = firstOf(firstOf(tc, 'w:tcPr') ?? tc, 'w:gridSpan')?.getAttribute('w:val')
      const vMerge = firstOf(firstOf(tc, 'w:tcPr') ?? tc, 'w:vMerge')
      return {
        text: elementsOf(tc, 'w:p').map(p => blockText(p, changes)).join(' '),
        ...(gridSpan ? { gridSpan: Number(gridSpan) } : {}),
        ...(vMerge ? { vMerge: vMerge.getAttribute('w:val') ?? 'continue' } : {}),
      }
    }))
}

/** @returns {object[]} simple + complex fields with instruction and cached result */
export function docxFields(pkg) {
  const out = []
  for (const name of parts(pkg)) {
    const doc = pkg.xml(name)
    for (const fld of elementsOf(doc.documentElement, 'w:fldSimple')) {
      out.push({ part: name, kind: 'simple', instruction: fld.getAttribute('w:instr') ?? '', result: textOf(fld) })
    }
    // Complex fields: instrText between fldChar begin and separate, result till end.
    const paras = elementsOf(doc.documentElement, 'w:p')
    let open = null
    const flush = () => { if (open) { delete open.phase; out.push(open) } open = null }
    for (const p of paras) {
      for (const el of elementsOf(p)) {
        if (el.tagName === 'w:fldChar') {
          const type = el.getAttribute('w:fldCharType')
          if (type === 'begin') { flush(); open = { part: name, kind: 'complex', instruction: '', result: '' } }
          else if (type === 'separate' && open) open.phase = 'result'
          else if (type === 'end') flush()
        } else if (open && el.tagName === 'w:instrText' && open.phase !== 'result') open.instruction += el.textContent
        else if (open && open.phase === 'result' && (el.tagName === 'w:t' || el.tagName === 'w:delText')) open.result += el.textContent
      }
    }
    flush()
  }
  return out
}

// ---- edit ops ----

const EDIT_PARTS = (pkg, bodyOnly) => parts(pkg).filter(name =>
  name === 'word/document.xml' || (!bodyOnly && /^word\/(header|footer)\d+\.xml$|^word\/(footnotes|endnotes)\.xml$/.test(name)))

/** Map pN/tN ids to elements exactly as docxRead numbers them. */
export function blockIndex(doc) {
  const body = firstOf(doc.documentElement, 'w:body')
  const map = new Map()
  let pi = 0, ti = 0
  for (const el of childrenOf(body)) {
    if (el.tagName === 'w:p') map.set(`p${++pi}`, el)
    else if (el.tagName === 'w:tbl') map.set(`t${++ti}`, el)
  }
  return map
}

function isDeleted(p, r) {
  for (let n = r; n && n !== p; n = n.parentNode) if (n.tagName === 'w:del' || n.tagName === 'w:moveFrom') return true
  return false
}



/**
 * Apply an array of ops to every docx part they reach. All-or-nothing: callers
 * hold the saved copy until every op reports success.
 * @returns {{ changed: string[], count: number }}
 */
export function docxEdit(pkg, ops) {
  const docs = new Map()
  const getDoc = (name) => {
    if (!docs.has(name)) docs.set(name, pkg.xml(name))
    return docs.get(name)
  }
  const changed = new Set()
  let count = 0
  ops.forEach((op, index) => {
    try { applyOp(pkg, getDoc, changed, op); count++ }
    catch (error) { const e = new Error(`op ${index} (${opKind(op)}): ${error.message}`); e.code = 'ops'; throw e }
  })
  for (const [name, doc] of docs) if (changed.has(name)) pkg.putXml(name, doc)
  return { changed: [...changed], count }
}

const opKind = (op) => Object.keys(op).find(k => !['o', 'inPlace'].includes(k)) ?? '?'

function applyOp(pkg, getDoc, changed, op) {
  const mainDoc = () => getDoc('word/document.xml')
  if (op.replace) {
    const { find, with: withText, regex = false, bodyOnly = false } = op.replace
    const re = regex ? new RegExp(find, 'g') : new RegExp(escapeRe(find), 'g')
    for (const name of EDIT_PARTS(pkg, bodyOnly)) {
      const doc = getDoc(name)
      const n = replaceInDoc(doc, re, withText)
      if (n > 0) changed.add(name)
    }
    return
  }
  if (op.set_cell) {
    const { table, row, col, text } = op.set_cell
    const tbl = blockIndex(mainDoc()).get(`t${table}`)
    if (!tbl) throw new Error(`no table t${table}`)
    const tr = childrenOf(tbl, 'w:tr')[row - 1]
    const tc = tr && childrenOf(tr, 'w:tc')[col - 1]
    if (!tc) throw new Error(`no cell r${row}c${col} in t${table}`)
    setCellText(getDoc('word/document.xml'), tc, String(text))
    changed.add('word/document.xml')
    return
  }
  if (op.set_field) {
    const { match, value } = op.set_field
    const re = new RegExp(match)
    let done = false
    for (const name of EDIT_PARTS(pkg, false)) {
      const doc = getDoc(name)
      for (const fld of elementsOf(doc.documentElement, 'w:fldSimple')) {
        if (re.test(fld.getAttribute('w:instr') ?? '')) { setFieldResult(doc, fld, String(value)); done = true }
      }
      if (setComplexFieldResult(doc, re, String(value))) done = true
      if (done) changed.add(name)
    }
    if (!done) throw new Error(`no field instruction matches /${match}/`)
    return
  }
  if (op.insert) {
    const { after, before, text, style, like } = op.insert
    const doc = mainDoc()
    const index = blockIndex(doc)
    const anchor = index.get(after ?? before)
    if (!anchor) throw new Error(`no paragraph ${after ?? before}`)
    const p = doc.createElement('w:p')
    if (style || like) {
      const pPr = doc.createElement('w:pPr')
      const pStyle = doc.createElement('w:pStyle')
      pStyle.setAttribute('w:val', style ?? paraStyle(index.get(like)) ?? 'Normal')
      pPr.appendChild(pStyle); p.appendChild(pPr)
    }
    const r = doc.createElement('w:r')
    const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
    t.appendChild(doc.createTextNode(text))
    r.appendChild(t); p.appendChild(r)
    anchor.parentNode.insertBefore(p, before ? anchor : anchor.nextSibling)
    changed.add('word/document.xml')
    return
  }
  if (op.delete) {
    const doc = mainDoc()
    const index = blockIndex(doc)
    for (const id of op.delete.paragraphs) {
      const el = index.get(id)
      if (!el) throw new Error(`no block ${id}`)
      el.parentNode.removeChild(el)
    }
    changed.add('word/document.xml')
    return
  }
  if (op.comment) {
    addComment(pkg, getDoc, changed, op.comment)
    return
  }
  if (op.accept_changes || op.reject_changes) {
    const accept = Boolean(op.accept_changes)
    for (const name of parts(pkg)) {
      if (!pkg.parts.has(name)) continue
      const doc = getDoc(name)
      if (resolveChanges(doc, accept)) changed.add(name)
    }
    return
  }
  throw new Error(`unknown op ${JSON.stringify(op)}`)
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// Replace text across runs inside one document; deletions skipped; formatting of
// the match-start run kept. Returns the number of replacements.
function replaceInDoc(doc, re, withText) {
  let total = 0
  const once = () => new RegExp(re.source, re.flags.replace('g', ''))
  for (const p of elementsOf(doc.documentElement, 'w:p')) {
    let guard = 0
    while (guard++ < 200) {
      const runs = elementsOf(p, 'w:r').filter(r => !isDeleted(p, r))
      const texts = runs.map(r => elementsOf(r, 'w:t').map(t => t.textContent).join(''))
      const joined = texts.join('')
      const m = once().exec(joined)
      if (!m) break
      let cursor = 0, first = -1, last = -1
      for (const [i] of runs.entries()) {
        const end = cursor + texts[i].length
        if (first < 0 && m.index < end) first = i
        if (m.index + m[0].length <= end) { last = i; break }
        cursor = end
      }
      if (first < 0) break
      if (last < 0) last = runs.length - 1
      const replacement = m[0].replace(new RegExp(re.source), withText)
      const startRun = runs[first]
      const preStart = texts[first].slice(0, m.index - sumTo(texts, first))
      const postEnd = texts[last].slice(m.index + m[0].length - sumTo(texts, last))
      const makeRun = (text) => {
        const clone = startRun.cloneNode(false)
        while (clone.firstChild && clone.firstChild.tagName !== 'w:rPr') clone.removeChild(clone.firstChild)
        const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
        t.appendChild(doc.createTextNode(text)); clone.appendChild(t)
        return clone
      }
      setRunText(startRun, preStart)
      const repl = makeRun(replacement)
      startRun.parentNode.insertBefore(repl, startRun.nextSibling)
      if (first === last) {
        if (postEnd !== '') startRun.parentNode.insertBefore(makeRun(postEnd), repl.nextSibling)
      } else {
        setRunText(runs[last], postEnd)
        for (let i = first + 1; i < last; i++) setRunText(runs[i], '')
      }
      total++
    }
  }
  return total
}

const sumTo = (arr, n) => arr.slice(0, n).reduce((a, b) => a + b.length, 0)

function setRunText(run, text) {
  const ts = elementsOf(run, 'w:t')
  if (ts.length === 0) return
  ts[0].textContent = text
  if (text !== text.trim()) ts[0].setAttribute('xml:space', 'preserve')
  for (const extra of ts.slice(1)) extra.textContent = ''
}

function setCellText(doc, tc, text) {
  for (const p of childrenOf(tc, 'w:p')) tc.removeChild(p)
  const p = doc.createElement('w:p')
  const r = doc.createElement('w:r')
  const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
  t.appendChild(doc.createTextNode(text))
  r.appendChild(t); p.appendChild(r); tc.appendChild(p)
}

function setFieldResult(doc, fld, value) {
  // Drop existing runs; one fresh run with the value.
  for (const child of [...fld.childNodes]) fld.removeChild(child)
  const r = doc.createElement('w:r')
  const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
  t.appendChild(doc.createTextNode(value))
  r.appendChild(t); fld.appendChild(r)
}

function setComplexFieldResult(doc, re, value) {
  let done = false
  const nodes = elementsOf(doc.documentElement)
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].tagName === 'w:instrText' && re.test(nodes[i].textContent)) {
      // Find the separate→end span in the same paragraph, keep the run right
      // after 'separate' and set its text.
      const p = ancestor(nodes[i], 'w:p')
      if (!p) continue
      let phase = 'pre', resultRun = null
      for (const el of elementsOf(p)) {
        if (el.tagName === 'w:fldChar') {
          const type = el.getAttribute('w:fldCharType')
          if (type === 'separate') phase = 'result'
          else if (type === 'end') phase = 'post'
        } else if (phase === 'result' && el.tagName === 'w:r' && resultRun === null) resultRun = el
      }
      if (resultRun) { setRunText(resultRun, value); done = true }
    }
  }
  return done
}

const ancestor = (node, tag) => { for (let n = node.parentNode; n; n = n.parentNode) if (n.tagName === tag) return n; return null }

function addComment(pkg, getDoc, changed, { paragraph, text, anchor, author = 'Bot', initials = 'B' }) {
  const doc = getDoc('word/document.xml')
  const p = blockIndex(doc).get(paragraph)
  if (!p) throw new Error(`no paragraph ${paragraph}`)
  // comments.xml + its rel + content type are created when missing.
  let commentsDoc
  if (!pkg.parts.has('word/comments.xml')) {
    commentsDoc = parseXml('<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
    pkg.rels.set('word/document.xml', pkg.relsOf('word/document.xml'))
    let next = 1
    const map = pkg.rels.get('word/document.xml')
    while (map.has(`rId${next}`)) next++
    map.set(`rId${next}`, { id: `rId${next}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', target: 'comments.xml', mode: 'Internal' })
    pkg.override('word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml')
  } else commentsDoc = getDoc('word/comments.xml')
  const id = String(Math.max(0, ...elementsOf(commentsDoc.documentElement, 'w:comment').map(c => Number(c.getAttribute('w:id')) || 0)) + 1)
  const comment = commentsDoc.createElement('w:comment')
  comment.setAttribute('w:id', id); comment.setAttribute('w:author', author); comment.setAttribute('w:initials', initials)
  const cp = commentsDoc.createElement('w:p'); const cr = commentsDoc.createElement('w:r')
  const ct = commentsDoc.createElement('w:t'); ct.setAttribute('xml:space', 'preserve')
  ct.appendChild(commentsDoc.createTextNode(text)); cr.appendChild(ct); cp.appendChild(cr); comment.appendChild(cp)
  commentsDoc.documentElement.appendChild(comment)
  pkg.putXml('word/comments.xml', commentsDoc)
  const rangeStart = doc.createElement('w:commentRangeStart'); rangeStart.setAttribute('w:id', id)
  const rangeEnd = doc.createElement('w:commentRangeEnd'); rangeEnd.setAttribute('w:id', id)
  const ref = doc.createElement('w:r')
  const refEl = doc.createElement('w:commentReference'); refEl.setAttribute('w:id', id)
  ref.appendChild(refEl)
  if (anchor) {
    p.insertBefore(rangeStart, p.firstChild)
    p.appendChild(rangeEnd); p.appendChild(ref)
  } else {
    p.appendChild(rangeEnd); p.appendChild(ref)
  }
  changed.add('word/document.xml')
}

// accept/reject tracked changes across one document part.
export function resolveChanges(doc, accept) {
  let dirty = false
  const lift = (el) => { while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el); el.parentNode.removeChild(el) }
  // Range markers first so wrappers see clean ranges.
  for (const el of elementsOf(doc.documentElement)) {
    const tag = el.tagName
    if (tag === 'w:moveFromRangeStart' || tag === 'w:moveFromRangeEnd' || tag === 'w:moveToRangeStart' || tag === 'w:moveToRangeEnd'
      || tag === 'w:customXmlInsRangeStart' || tag === 'w:customXmlInsRangeEnd'
      || tag === 'w:customXmlDelRangeStart' || tag === 'w:customXmlDelRangeEnd'
      || tag === 'w:customXmlMoveFromRangeStart' || tag === 'w:customXmlMoveFromRangeEnd'
      || tag === 'w:customXmlMoveToRangeStart' || tag === 'w:customXmlMoveToRangeEnd') {
      el.parentNode?.removeChild(el); dirty = true
    }
  }
  for (const el of elementsOf(doc.documentElement)) {
    const tag = el.tagName
    if (tag === 'w:ins' || tag === 'w:moveTo') {
      if (accept) lift(el)
      else el.parentNode.removeChild(el)
      dirty = true
    }
    else if (tag === 'w:del' || tag === 'w:moveFrom') {
      if (accept) { el.parentNode.removeChild(el); dirty = true }
      else {
        // w:delText → w:t restores the deleted text.
        for (const t of elementsOf(el, 'w:delText')) { t.tagName = 'w:t' }
        lift(el); dirty = true
      }
    } else if (/^w:(pPrChange|rPrChange|tblPrChange|tcPrChange|trPrChange|sectPrChange|numberingChange)$/.test(tag)) {
      if (accept) { el.parentNode.removeChild(el); dirty = true }
      else {
        // Restore the stored old properties into place of the change marker.
        const parent = el.parentNode
        const stored = childrenOf(el)[0]
        if (stored) parent.replaceChild(stored.cloneNode(true), el)
        else parent.removeChild(el)
        dirty = true
      }
    } else if (tag === 'w:del' && el.parentNode?.tagName === 'w:rPr' && el.parentNode.parentNode?.tagName === 'w:pPr') {
      // handled above via generic w:del
    } else if (tag === 'w:cellIns' || tag === 'w:cellDel') {
      const tc = ancestor(el, 'w:tc')
      if (tc) {
        if (accept && tag === 'w:cellDel') tc.parentNode?.removeChild(tc)
        else if (!accept && tag === 'w:cellIns') tc.parentNode?.removeChild(tc)
        el.parentNode.removeChild(el); dirty = true
      }
    }
  }
  // Deleted paragraph marks: w:pPr/w:rPr/w:del merges the paragraph with the next
  // on accept; on reject the mark alone disappears.
  for (const p of elementsOf(doc.documentElement, 'w:p')) {
    const pPr = firstOf(p, 'w:pPr')
    const rPr = pPr && firstOf(pPr, 'w:rPr')
    const del = rPr && firstOf(rPr, 'w:del')
    if (!del) continue
    dirty = true
    if (accept) {
      const next = p.nextSibling
      if (next && next.tagName === 'w:p') {
        for (const child of [...p.childNodes]) if (child !== pPr) next.insertBefore(child, next.firstChild)
        p.parentNode.removeChild(p)
      } else {
        rPr.removeChild(del)
      }
    } else {
      rPr.removeChild(del)
    }
  }
  return dirty
}
