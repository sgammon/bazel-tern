/**
 * Retained surfaces cannot ask the exited process to recalculate a row budget.
 * Keep the native body scroller flexible when the window shrinks, leaving the
 * header, log tail, handoff, and shell prompt outside it. The body's native
 * max.h still supplies the tighter pane-specific bound while the process runs.
 * Tern scopes this sheet to the surface; a region ancestor selector would not
 * match after that automatic scoping. vh is window-relative, not pane-relative.
 */
export const responsiveLayout = `
[data-role="build-layout"] {
  max-height: max(calc(6 * var(--sf-lh)), calc(100vh / var(--sf-zoom) - 120px));
}
[data-role="build-layout"] > * { flex-shrink: 0; }
[data-role="build-layout"] > [data-role="build-body"] {
  flex-shrink: 1;
  min-height: 0;
}
`;
