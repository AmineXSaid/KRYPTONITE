/* KRYPTONITE crystal artwork — the single source for the brand mark.
 *
 * Both webviews inject this same symbol set, so the mark can only ever change
 * in one place. It is loaded as its own nonced script before the surface
 * scripts and hangs one object off `window`; there is no bundler in the
 * webview layer and adding one for a single shared constant is not worth it.
 *
 * The artwork is a faceted crystal cluster traced from the source logo:
 * a `#03150F` union silhouette behind eighteen facets over four emerald
 * gradients, plus three highlight slivers. The silhouette matters — without
 * it the gaps between facets show the host background, and on a light theme
 * the cluster reads as shattered rather than faceted.
 *
 * Aspect ratio is 42:48 (portrait, 0.875). `kxCrystal(height)` derives the
 * width so no call site can stretch it.
 */
(function () {
  "use strict";

  var DEFS =
    '<radialGradient id="kx-halo" cx="50%" cy="50%" r="50%"><stop offset=".28" stop-color="#4AF6A4" stop-opacity=".40"/>' +
    '<stop offset=".64" stop-color="#4AF6A4" stop-opacity=".12"/><stop offset="1" stop-color="#4AF6A4" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="kx-f1" x1="0" y1="0" x2=".45" y2="1"><stop offset="0" stop-color="#D9FFEE"/><stop offset="1" stop-color="#5CF8AE"/>' +
    '</linearGradient><linearGradient id="kx-f2" x1="0" y1="0" x2=".55" y2="1"><stop offset="0" stop-color="#7DFDC3"/>' +
    '<stop offset="1" stop-color="#22C081"/></linearGradient><linearGradient id="kx-f3" x1=".1" y1="0" x2=".7" y2="1">' +
    '<stop offset="0" stop-color="#31CE90"/><stop offset="1" stop-color="#0B5B3F"/></linearGradient>' +
    '<linearGradient id="kx-f4" x1=".1" y1="0" x2=".9" y2="1"><stop offset="0" stop-color="#17A874"/><stop offset="1" stop-color="#052A1C"/>' +
    '</linearGradient><symbol id="i-kx" viewBox="0 0 42 48"><ellipse cx="21" cy="24" rx="21" ry="24" fill="url(#kx-halo)"/>' +
    '<path d="M34.4 0.6 L23.1 7.5 L20.4 11.8 L15.6 6.2 L9.6 12.5 L10.7 21.7 L1.8 17.2 L0.6 19 L1.2 29 L11.3 42.1 L19.6 47.3 L23.1 47.1 L40.4 32.9 L41 24.8 L34.4 26 L39.5 15.7 L36 1.3Z" fill="#03150F"/>' +
    '<path d="M29.3 11.9 L22.6 14 L17.1 22.8 L18.6 32.4 L23.2 33.3 L31.8 18.7Z" fill="url(#kx-f2)"/>' +
    '<path d="M9.2 21.8 L5.2 26.9 L12.3 40.1 L14.8 39.9 L14.8 38.5 L11.7 25.8Z" fill="url(#kx-f3)"/>' +
    '<path d="M35.5 1.5 L30.3 11.2 L32.8 17.9 L39 15.5Z" fill="url(#kx-f1)"/>' +
    '<path d="M18.3 33.6 L15.9 40.3 L21.3 46.9 L24.4 40 L22.9 34.8Z" fill="url(#kx-f4)"/>' +
    '<path d="M10.1 14.1 L15.7 37.5 L17.4 32.3 L14.9 17.9Z" fill="url(#kx-f2)"/><path d="M33.8 28 L24 34.4 L25.3 39.3 L35.8 32.2Z" fill="url(#kx-f4)"/>' +
    '<path d="M38.7 16.9 L32.8 19.1 L25 32.4 L33 27Z" fill="url(#kx-f3)"/><path d="M34.4 1.1 L23.4 7.9 L22.9 12.7 L29.4 10.6Z" fill="url(#kx-f2)"/>' +
    '<path d="M15.9 6.6 L10.1 12.7 L15.2 16.6 L19.3 12.9 L19.3 12.5Z" fill="url(#kx-f1)"/>' +
    '<path d="M39.1 34 L36.6 33 L26.6 39.9 L31 40.6Z" fill="url(#kx-f3)"/><path d="M1.7 28.7 L10.6 40.6 L11.3 40.5 L4.4 27.7Z" fill="url(#kx-f4)"/>' +
    '<path d="M1.7 17.7 L4.7 25.7 L8.6 20.8Z" fill="url(#kx-f2)"/><path d="M22 10.1 L20.4 13.3 L16 17.6 L16.6 21.5 L21.7 13.4Z" fill="url(#kx-f3)"/>' +
    '<path d="M29.8 41.6 L25.3 40.9 L22.5 46.9Z" fill="url(#kx-f4)"/><path d="M40.5 25 L34.8 27.3 L36.6 31.1 L36.8 31Z" fill="url(#kx-f3)"/>' +
    '<path d="M1.1 19.2 L1 27.6 L1.2 27.7 L3.3 26.8 L3.8 26.4Z" fill="url(#kx-f3)"/><path d="M11.5 41.6 L19.7 46.8 L15 41Z" fill="url(#kx-f4)"/>' +
    '<path d="M41 26.3 L37.4 32 L39.6 33 L39.8 33Z" fill="url(#kx-f4)"/><path d="M35.5 1.5 L30.3 11.2 L33.4 8.1 Z" fill="#E4FFF2" opacity=".85"/>' +
    '<path d="M15.9 6.6 L19.3 12.5 L17 10.5 Z" fill="#E4FFF2" opacity=".8"/><path d="M29.3 11.9 L22.6 14 L25.6 14.6 Z" fill="#9DFFD2" opacity=".55"/>' +
    '</symbol>';

  /** Height-driven so the 42:48 aspect ratio cannot be broken by a call site. */
  function svg(height, cls) {
    var w = Math.round(height * 42 / 48);
    return '<svg class="' + (cls || "") + '" width="' + w + '" height="' + height +
      '" aria-hidden="true"><use href="#i-kx"/></svg>';
  }

  window.__kxCrystal = { defs: DEFS, svg: svg };
})();
