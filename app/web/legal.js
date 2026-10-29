/* Puts this server's contact address (CONTACT_EMAIL in deploy/.env) on the privacy policy and rules pages. */
fetch('/api/info').then((r) => r.json()).then((i) => {
  const box = document.getElementById('contact');
  if (!box || !i.contact) return;
  box.textContent = 'Questions about your data or these rules: write to ';
  const a = document.createElement('a'); a.href = `mailto:${i.contact}`; a.textContent = i.contact;
  box.appendChild(a); box.append(', or ask an admin of this Party Line in the app.');
}).catch(() => {});
