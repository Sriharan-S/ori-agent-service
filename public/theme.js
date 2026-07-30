/* Applies the saved theme before the first paint.
 *
 * Loaded synchronously in <head>. Everything else in the console is a module,
 * which defers — and a deferred theme is a white flash on every reload for
 * anyone who chose dark.
 */
(function () {
  try {
    var saved = localStorage.getItem('ori-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (error) {
    // Storage is unavailable in private mode in some browsers. The OS
    // preference still applies through the media query.
  }
})();
