/* GENESIS Bezel Roundel, published under main's existing brand-mark API.
 *
 * Drop-in replacement for `media/webview/crystal.js` on current `main`.
 *
 * main's two surface scripts consume the mark through exactly two members —
 * `window.__kxCrystal.defs` and `window.__kxCrystal.svg(height, cls)` — and
 * reference the symbol id `i-kx` in their endpoint-icon table. Keeping that
 * contract byte-for-byte means every call site in the 4,550-line sidebar.js
 * and the 1,813-line controlCenter.js draws the roundel instead of the
 * crystal with no edit to either file.
 *
 * THE NOTCHES ARE COLOURED AND MUST STAY COLOURED. The four cardinal notches
 * are oxide #E03A2F and the dim variant's are #2C3242; they are the only
 * part of the mark that is not `currentColor`, and they are what makes it a
 * bezel rather than a generic ring. Do not "simplify" them to currentColor —
 * the mark loses its identity and reads as a donut. The sole exception is
 * `media/icon.svg`, the activity-bar icon, which VS Code masks to a flat
 * monochrome silhouette regardless of what the file says.
 *
 * Geometry is square 24x24. The old crystal was portrait 42:48 and derived
 * its width from the height it was given; `svg(h)` here returns h x h, so a
 * call site that passes only a height still cannot stretch it.
 */
(function () {
  "use strict";

  var RING  = '<circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" stroke-width="2.4"/>';
  var CORE  = '<path fill-rule="evenodd" fill="currentColor" d="M12 6.4 A5.6 5.6 0 1 1 11.99 6.4 Z M9 11 H15 V13 H9 Z"/>';
  function notches(fill) {
    return '<path d="M9.9 .744 A11.45 11.45 0 0 1 14.1 .744 L14.1 3.3 A8.95 8.95 0 0 0 9.9 3.3Z" fill="' + fill + '"/>' +
           '<path d="M9.9 23.256 A11.45 11.45 0 0 0 14.1 23.256 L14.1 20.7 A8.95 8.95 0 0 1 9.9 20.7Z" fill="' + fill + '"/>' +
           '<path d="M.744 9.9 A11.45 11.45 0 0 0 .744 14.1 L3.3 14.1 A8.95 8.95 0 0 1 3.3 9.9Z" fill="' + fill + '"/>' +
           '<path d="M23.256 9.9 A11.45 11.45 0 0 1 23.256 14.1 L20.7 14.1 A8.95 8.95 0 0 0 20.7 9.9Z" fill="' + fill + '"/>';
  }

  var DEFS =
    /* `i-kx` is the id main's call sites already use — the full mark. */
    '<symbol id="i-kx" viewBox="0 0 24 24">' + RING + notches("#E03A2F") + CORE + '</symbol>' +
    '<symbol id="g-roundel" viewBox="0 0 24 24">' + RING + notches("#E03A2F") + CORE + '</symbol>' +
    /* Idle/resting plate: same ring and core, notches recessed. */
    '<symbol id="g-roundel-dim" viewBox="0 0 24 24">' + RING + notches("#2C3242") + CORE + '</symbol>' +
    /* 16-24px: the notches become gaps cut through a heavier ring, because a
       filled notch at that size disappears into the stroke. */
    '<symbol id="g-roundel-sm" viewBox="0 0 24 24">' +
      '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="butt">' +
        '<path d="M21.482 13.502 A9.6 9.6 0 0 1 13.502 21.482"/>' +
        '<path d="M10.498 21.482 A9.6 9.6 0 0 1 2.518 13.502"/>' +
        '<path d="M2.518 10.498 A9.6 9.6 0 0 1 10.498 2.518"/>' +
        '<path d="M13.502 2.518 A9.6 9.6 0 0 1 21.482 10.498"/>' +
      '</g>' +
      '<path fill-rule="evenodd" fill="currentColor" d="M12 6.9 A5.1 5.1 0 1 1 11.99 6.9 Z M9 10.9 H15 V13.1 H9 Z"/>' +
    '</symbol>' +
    /* One notch alone — the index that sweeps the ring while a turn runs. */
    '<symbol id="g-notch" viewBox="0 0 24 24"><path d="M9.9 .744 A11.45 11.45 0 0 1 14.1 .744 L14.1 3.3 A8.95 8.95 0 0 0 9.9 3.3Z" fill="#E03A2F"/></symbol>';

  /** Square by construction: a call site passing only a height cannot stretch it. */
  function svg(size, cls, variant) {
    var id = variant === "dim" ? "g-roundel-dim"
      : variant === "sm" ? "g-roundel-sm"
      : variant === "notch" ? "g-notch"
      : "i-kx";
    return '<svg class="' + (cls || "") + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }

  window.__kxCrystal = { defs: DEFS, svg: svg };
  window.__kxRoundel = { defs: DEFS, svg: svg };  /* the name the port uses */
})();
