(function () {
  var THEME_STORAGE_KEY = 'knas-theme';
  var DARK_BACKGROUND = 'hsl(0 0% 3.9%)';
  var DARK_FOREGROUND = 'hsl(0 0% 98%)';
  var LIGHT_BACKGROUND = 'hsl(0 0% 100%)';
  var LIGHT_FOREGROUND = 'hsl(0 0% 3.9%)';

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function resolveTheme(theme) {
    return theme === 'dark' || (theme !== 'light' && prefersDark()) ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    var resolvedTheme = resolveTheme(theme);
    var root = document.documentElement;
    var background = resolvedTheme === 'dark' ? DARK_BACKGROUND : LIGHT_BACKGROUND;
    var foreground = resolvedTheme === 'dark' ? DARK_FOREGROUND : LIGHT_FOREGROUND;

    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;
    root.style.backgroundColor = background;
    root.style.color = foreground;

    if (document.body) {
      document.body.style.backgroundColor = background;
      document.body.style.color = foreground;
    }
  }

  function applyBodyTheme(theme) {
    if (document.body) {
      applyTheme(theme);
      return;
    }

    document.addEventListener(
      'DOMContentLoaded',
      function () {
        applyTheme(theme);
      },
      { once: true },
    );
  }

  var cachedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'system';

  applyTheme(cachedTheme);
  applyBodyTheme(cachedTheme);

  if (!chrome.storage?.local) {
    return;
  }

  chrome.storage.local.get('app-settings', function (items) {
    var theme = items['app-settings']?.theme || 'system';
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
    applyBodyTheme(theme);
  });
})();
