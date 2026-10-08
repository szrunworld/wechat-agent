// Window-close policy: closing the main window hides it to the menu bar
// (patrol keeps running); only an explicit quit lets the window go. The
// "patrol still running" hint shows once per installation.
export interface CloseContext { quitting: boolean; hintShown: boolean }
export interface CloseDecision { action: 'hide' | 'allow'; showHint: boolean }

export function decideClose(ctx: CloseContext): CloseDecision {
  if (ctx.quitting) return { action: 'allow', showHint: false };
  return { action: 'hide', showHint: !ctx.hintShown };
}

export const CLOSE_HINT = '窗口已收进菜单栏，巡检仍在运行。要真正退出请用菜单栏的「退出」。';
