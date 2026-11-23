/**
 * Keep a context menu opened at `pos` (viewport px) inside the window: a menu
 * that would run past the right or bottom edge is pulled back so it ends 4 px
 * before it. Shared by the Git Tree menus and the header's stack menu.
 */
export function clampMenuToWindow(pos: { x: number; y: number }, menu: HTMLElement): { x: number; y: number } {
  const { offsetWidth: width, offsetHeight: height } = menu;
  const { innerWidth, innerHeight } = window;
  return {
    x: pos.x + width > innerWidth ? innerWidth - width - 4 : pos.x,
    y: pos.y + height > innerHeight ? innerHeight - height - 4 : pos.y,
  };
}
