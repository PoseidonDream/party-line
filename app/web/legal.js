/* Puts this server's contact address (CONTACT_EMAIL in deploy/.env) on the privacy policy and rules pages. */
fetch('/api/info').then((r) => r.json()).then((i) => {
  const box = document.getElementById('contact');
  if (!box || !i.contact) return;
  box.textContent = 'Questions about your data or these rules: write to ';
  const a = document.createElement('a'); a.href = `mailto:${i.contact}`; a.textContent = i.contact;
  box.appendChild(a); box.append(', or ask an admin of this Party Line in the app.');
}).catch(() => {});

/* The same links at the bottom of every page: the policies, the rules and deleting your account. */
(function legalNav() {
  const main = document.querySelector('main');
  if (!main) return;
  const nav = document.createElement('nav'); nav.className = 'legal-nav'; nav.setAttribute('aria-label', 'Policies');
  for (const [href, label] of [['/privacy', 'Privacy policy'], ['/terms', 'Terms of service'], ['/rules', 'Community rules'], ['/cookies', 'Cookie policy'], ['/delete-account', 'Delete my account']]) {
    const a = document.createElement('a'); a.href = href; a.textContent = label;
    if (location.pathname.replace(/\.html$/, '') === href) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  main.appendChild(nav);
})();
