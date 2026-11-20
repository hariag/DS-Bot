// A marker belongs to the speaker's own final reply. An observation about another
// worker or an instruction for after a blocker clears is not an execution claim.
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g
const AFTER_DONE = /^[\s\S]*(?:已完成|已经完成|完成了|已导出|已生成|已保存|做好了|搞定|finished|completed|here (?:is|are)\b)/i
const CONDITION = /^(?:如果|假如|若|一旦|(?:待|等).*(?:后|再)|(?:if|once|when|unless|after)\b)/i
const ZH_CLAIM = /^(?:(?:我(?:们)?(?:这边)?|本轮我)\s*)?(?:(?:目前|现在)\s*)?(?:(?:正在|还在|仍在)(?:导出|生成|处理|整理|制作|编写|准备|检查|调查|运行|执行|做|写|搜索|分析)|(?:会)?(?:稍后|待会|马上|一会儿|等下)(?:汇报|回复|发|给你|回来|完成)|进行中|处理中)/
const EN_CLAIM = /^(?:(?:(?:i(?:'m| am)|we(?:'re| are))\s+(?:(?:still|currently)\s+)?|(?:still|currently)\s+)(?:working|running|exporting|generating|building|preparing|processing|checking|investigating|researching|drafting|writing|putting together)|(?:(?:i|we)(?:'ll| will)|will|(?:(?:i(?:'m| am)|we(?:'re| are))\s+)?(?:going to|about to))\s+(?:report|send|share|finish|follow up|come back)|in progress|on it now|working on it)\b/i

export function announcesWork(text) {
  if (typeof text !== 'string') return false
  // Keep a placeholder for code: removing a quoted process name could turn the
  // rest of an observation into a subjectless claim by the speaker.
  return text.replace(CODE, '[code]').split(/(?<=[。.!?！？;；])|[\r\n]+/).some(sentence => {
    if (/[?？]\s*$/.test(sentence)) return false
    return sentence.replace(AFTER_DONE, '').split(/(?:但是|不过|但)(?=我)|\b(?:but|however)\b/i).some(statement => {
      for (const part of statement.split(/[，,]/)) {
        const clause = part.trim().replace(/^[-*]\s+/, '')
        if (CONDITION.test(clause)) return false
        if (ZH_CLAIM.test(clause) || EN_CLAIM.test(clause)) return true
      }
      return false
    })
  })
}
