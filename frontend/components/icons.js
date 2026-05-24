(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  const paths = {
    "archive": "<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\" /><path d=\"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8\" /><path d=\"M10 12h4\" />",
    "arrow-left": "<path d=\"m12 19-7-7 7-7\" /><path d=\"M19 12H5\" />",
    "book-open": "<path d=\"M12 7v14\" /><path d=\"M3 18a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3Z\" /><path d=\"M21 18a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3Z\" />",
    "bookmark": "<path d=\"m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z\" />",
    "bookmark-check": "<path d=\"m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z\" /><path d=\"m9 10 2 2 4-4\" />",
    "chevron-down": "<path d=\"m6 9 6 6 6-6\" />",
    "chevron-up": "<path d=\"m18 15-6-6-6 6\" />",
    "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 6v6l4 2\" />",
    "file-text": "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\" /><path d=\"M14 2v6h6\" /><path d=\"M16 13H8\" /><path d=\"M16 17H8\" /><path d=\"M10 9H8\" />",
    "log-in": "<path d=\"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4\" /><path d=\"m10 17 5-5-5-5\" /><path d=\"M15 12H3\" />",
    "message-circle": "<path d=\"M7.9 20A9 9 0 1 0 4 16.1L2 22z\" />",
    "refresh-cw": "<path d=\"M21 12a9 9 0 0 0-15-6.7L3 8\" /><path d=\"M3 3v5h5\" /><path d=\"M3 12a9 9 0 0 0 15 6.7l3-2.7\" /><path d=\"M21 21v-5h-5\" />",
    "reply": "<path d=\"m9 17-5-5 5-5\" /><path d=\"M20 18v-2a4 4 0 0 0-4-4H4\" />",
    "search": "<circle cx=\"11\" cy=\"11\" r=\"8\" /><path d=\"m21 21-4.3-4.3\" />",
    "send": "<path d=\"m22 2-7 20-4-9-9-4Z\" /><path d=\"M22 2 11 13\" />",
    "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /><circle cx=\"9\" cy=\"7\" r=\"4\" /><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /><path d=\"M16 3.13a4 4 0 0 1 0 7.75\" />",
    "x": "<path d=\"M18 6 6 18\" /><path d=\"m6 6 12 12\" />"
  };

  App.components.renderIcon = function renderIcon(name) {
    const path = paths[name];
    if (!path) {
      return "";
    }
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
  };
})();
