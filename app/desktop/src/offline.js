const q = new URLSearchParams(location.search);
document.getElementById('detail').textContent = `${q.get('server') || ''} · ${q.get('error') || ''}`;
document.getElementById('retry').addEventListener('click', () => window.partyLineDesktop.retry());
document.getElementById('change').addEventListener('click', () => { location.href = `setup.html?server=${encodeURIComponent(q.get('server') || '')}`; });
let tries = 0;
const timer = setInterval(() => { if (++tries > 20) clearInterval(timer); else window.partyLineDesktop.retry(); }, 15000);
