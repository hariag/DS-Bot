// Select the language from the imported charter, independent of browser locale.
export const chineseRolePrompt = instructions => /^(?:#{1,3}[ \t]+)?团队章程 v1\.2(?:[ \t]*｜[^\r\n]*)?[ \t]*\r?$/m.test(instructions ?? '')
