/*
 * PostCSS pipeline for the content-script bundle.
 *
 * style-loader injects the bundled CSS into the host page's <head> as
 * soon as the content script runs, so any unscoped rule leaks into
 * every site the extension matches. The `prefix-overlay-selectors`
 * plugin below rewrites every selector to live under
 * `#designjs-capture-root`, so the stylesheet is inert until our
 * overlay container is mounted and only ever matches our subtree.
 *
 * Authoring rules (see overlay.css for examples):
 * - Don't use CSS nesting — every nested rule would be re-prefixed and
 *   stop matching once the parent already carries the prefix.
 * - Use bare `:root` to mean "the overlay container itself"; the
 *   transform rewrites `:root` and `:host` (which Tailwind v4 emits
 *   for `@theme` blocks) to the bare prefix.
 * - Don't author selectors that already include `#designjs-capture-root`;
 *   the prefixer adds it.
 *
 * Caveat: `@property --tw-*` declarations are document-scoped by spec
 * and cannot be confined to the overlay. They're left alone — the
 * names are tw-internal so collisions with a host page are implausible.
 */

const ROOT_SELECTOR = '#designjs-capture-root';

const SKIP_PARENT_ATRULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  '-o-keyframes',
  'font-face',
  'property',
  'counter-style',
]);

const prefixOverlaySelectors = () => ({
  postcssPlugin: 'prefix-overlay-selectors',
  // OnceExit runs after every other plugin has finished its visitors,
  // so Tailwind's @theme/@import expansion is fully materialised by
  // the time we walk the tree.
  OnceExit(root) {
    root.walkRules((rule) => {
      // Skip rules whose ancestor is a non-selector at-rule (e.g.
      // `0% { ... }` inside `@keyframes`, or any rule inside
      // `@font-face` / `@property` / `@counter-style`).
      let parent = rule.parent;
      while (parent && parent.type !== 'root') {
        if (parent.type === 'atrule' && SKIP_PARENT_ATRULES.has(parent.name.toLowerCase())) {
          return;
        }
        parent = parent.parent;
      }

      const transformed = rule.selectors.map((selector) => {
        const trimmed = selector.trim();
        if (!trimmed) return trimmed;
        // Idempotency: hand-authored selectors that already include the
        // prefix pass through unchanged. Means safe to re-run, and lets
        // us keep e.g. an `&:disabled` nested under a prefixed parent.
        if (trimmed.includes(ROOT_SELECTOR)) return trimmed;
        // `:root` and `:host` map TO the prefix, not under it — Tailwind
        // v4 emits `:root, :host { --... }` for `@theme`, and we want
        // those custom properties defined on the overlay container so
        // they cascade to its descendants without polluting the host.
        if (trimmed === ':root' || trimmed === ':host' || trimmed === ':host(*)') {
          return ROOT_SELECTOR;
        }
        return `${ROOT_SELECTOR} ${trimmed}`;
      });

      // Dedupe — `:root, :host` would otherwise become two identical
      // `#designjs-capture-root` selectors after the transform.
      rule.selector = [...new Set(transformed)].join(', ');
    });
  },
});
prefixOverlaySelectors.postcss = true;

module.exports = {
  plugins: [
    require('@tailwindcss/postcss'),
    prefixOverlaySelectors(),
  ],
};
