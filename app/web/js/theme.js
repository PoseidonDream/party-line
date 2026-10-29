/* Before the page draws: the saved theme and accent, so it doesn't flash the wrong colors. (A file of its own, not
   inline, because the page only runs scripts from this server.) */
try {
  var s = JSON.parse(localStorage.getItem('pl:settings')) || {}, t = s.theme;
  if (!t || (t === 'system' && !s.themeV)) t = 'dark';
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  if (s.accent && s.accent !== 'amber') document.documentElement.dataset.accent = s.accent;
} catch (e) { document.documentElement.dataset.theme = 'dark'; }
