// The server includes this exact warning in the execution preview. Its text
// and version are bound into the confirmation digest; changing either makes
// every older execution preview invalid.
export const ISOLATED_REDO_WARNING = Object.freeze({
  version:'new-operation-may-repeat-v1',
  zh:'这会按所示内容发起一次新操作。原工作的结果未知，外部操作可能再次发生；原中断记录不会自动关闭。',
  en:'This starts a new operation using the displayed input. The original outcome is unknown, external actions may happen again, and the interrupted record will remain open.',
})
