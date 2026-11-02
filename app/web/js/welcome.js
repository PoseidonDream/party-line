/* The welcome page: which system this is (its download goes first and is highlighted), the newest version's number
   and sizes from the server, and the language picker (the same translations as the app). */
import { LANGS, setLang, startI18n, currentLang } from './i18n.js';

/* This device: Windows, Mac, Linux, Android, or (iPhone, iPad, anything else) the browser. */
export function detectOs(ua = navigator.userAgent, platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '') {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Windows/i.test(ua) || /Win/i.test(platform)) return 'windows';
  if (/Mac/i.test(ua) || /Mac/i.test(platform)) return 'mac';
  if (/CrOS/i.test(ua)) return 'browser';
  if (/Linux/i.test(ua) || /Linux/i.test(platform)) return 'linux';
  return 'browser';
}

const os = detectOs();
const pick = os === 'ios' ? 'browser' : os;
const picker = document.getElementById('get');
const card = picker.querySelector(`.pk[data-os="${pick}"]`);
if (card) {
  card.classList.add('rec');
  picker.insertBefore(card, picker.querySelector('.pk'));
  const b = card.querySelector('.btn');
  b.classList.replace('ghost', 'lamp');
  if (b.classList.contains('dl')) b.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>');
}
document.documentElement.dataset.os = os;

/* Version and sizes. A download the newest release doesn't have yet sends people to the releases page instead. */
const mb = (n) => `${Math.max(1, Math.round(n / 1048576))} MB`;
fetch('/api/downloads').then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !d.version) return;
  const ver = document.getElementById('ver');
  ver.textContent = `Version ${d.version}`; ver.hidden = false;
  for (const a of picker.querySelectorAll('.dl[data-what]')) {
    const f = d.files[a.dataset.what];
    if (f) a.title = mb(f.size);
  }
}).catch(() => {});

/* Language */
const sel = document.getElementById('lang');
for (const [code, name] of LANGS) { const o = document.createElement('option'); o.value = code; o.textContent = name; o.dataset.own = '1'; sel.appendChild(o); }
sel.value = currentLang();
sel.addEventListener('change', () => setLang(sel.value));
startI18n();
