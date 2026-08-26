/* GENESIS Bezel Roundel — the single source for the brand mark.
 *
 * Both webviews inject this same symbol set, so the mark can only ever change
 * in one place. It is loaded as its own nonced script before the surface
 * scripts and hangs one object off `window`; there is no bundler in the
 * webview layer and adding one for a single shared constant is not worth it.
 *
 * Four variants, one geometry (24x24, square — never stretch it):
 *   g-roundel      full mark: cream ring + four oxide notches + solid core glyph
 *   g-roundel-dim  same ring/core, notches recessed to --slate — the "idle" plate
 *   g-roundel-sm   heavier 3px ring with the notches cut through as gaps, for
 *                  16-24px sizes (activity bar) where a filled notch disappears
 *   g-notch        one notch alone, used as the sweeping index on the ring
 *                  during the streaming/working state
 */
(function () {
  "use strict";

  var DEFS =
    '<symbol id="g-roundel" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
      '<path d="M9.9 .744 A11.45 11.45 0 0 1 14.1 .744 L14.1 3.3 A8.95 8.95 0 0 0 9.9 3.3Z" fill="#E03A2F"/>' +
      '<path d="M9.9 23.256 A11.45 11.45 0 0 0 14.1 23.256 L14.1 20.7 A8.95 8.95 0 0 1 9.9 20.7Z" fill="#E03A2F"/>' +
      '<path d="M.744 9.9 A11.45 11.45 0 0 0 .744 14.1 L3.3 14.1 A8.95 8.95 0 0 1 3.3 9.9Z" fill="#E03A2F"/>' +
      '<path d="M23.256 9.9 A11.45 11.45 0 0 1 23.256 14.1 L20.7 14.1 A8.95 8.95 0 0 0 20.7 9.9Z" fill="#E03A2F"/>' +
      '<path fill-rule="evenodd" fill="currentColor" d="M12 6.4 A5.6 5.6 0 1 1 11.99 6.4 Z M9 11 H15 V13 H9 Z"/>' +
    '</symbol>' +
    '<symbol id="g-roundel-dim" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
      '<path d="M9.9 .744 A11.45 11.45 0 0 1 14.1 .744 L14.1 3.3 A8.95 8.95 0 0 0 9.9 3.3Z" fill="#2C3242"/>' +
      '<path d="M9.9 23.256 A11.45 11.45 0 0 0 14.1 23.256 L14.1 20.7 A8.95 8.95 0 0 1 9.9 20.7Z" fill="#2C3242"/>' +
      '<path d="M.744 9.9 A11.45 11.45 0 0 0 .744 14.1 L3.3 14.1 A8.95 8.95 0 0 1 3.3 9.9Z" fill="#2C3242"/>' +
      '<path d="M23.256 9.9 A11.45 11.45 0 0 1 23.256 14.1 L20.7 14.1 A8.95 8.95 0 0 0 20.7 9.9Z" fill="#2C3242"/>' +
      '<path fill-rule="evenodd" fill="currentColor" d="M12 6.4 A5.6 5.6 0 1 1 11.99 6.4 Z M9 11 H15 V13 H9 Z"/>' +
    '</symbol>' +
    '<symbol id="g-roundel-sm" viewBox="0 0 24 24">' +
      '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="butt">' +
        '<path d="M21.482 13.502 A9.6 9.6 0 0 1 13.502 21.482"/>' +
        '<path d="M10.498 21.482 A9.6 9.6 0 0 1 2.518 13.502"/>' +
        '<path d="M2.518 10.498 A9.6 9.6 0 0 1 10.498 2.518"/>' +
        '<path d="M13.502 2.518 A9.6 9.6 0 0 1 21.482 10.498"/>' +
      '</g>' +
      '<path fill-rule="evenodd" fill="currentColor" d="M12 6.9 A5.1 5.1 0 1 1 11.99 6.9 Z M9 10.9 H15 V13.1 H9 Z"/>' +
    '</symbol>' +
    '<symbol id="g-notch" viewBox="0 0 24 24"><path d="M9.9 .744 A11.45 11.45 0 0 1 14.1 .744 L14.1 3.3 A8.95 8.95 0 0 0 9.9 3.3Z" fill="#E03A2F"/></symbol>';

  /** Square 24x24 geometry — a single `size` cannot stretch it. */
  function svg(size, cls, variant) {
    var id = variant === "dim" ? "g-roundel-dim"
      : variant === "sm" ? "g-roundel-sm"
      : variant === "notch" ? "g-notch"
      : "g-roundel";
    return '<svg class="' + (cls || "") + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }

  window.__kxRoundel = { defs: DEFS, svg: svg };
})();
