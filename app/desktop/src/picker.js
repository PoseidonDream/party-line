let all = [], kind = 'screen';
function render() {
  const grid = document.getElementById('grid');
  grid.textContent = '';
  for (const s of all.filter((x) => (kind === 'screen') === x.screen)) {
    const b = document.createElement('button'); b.className = 'src';
    const img = document.createElement('img'); img.src = s.thumb; img.alt = '';
    const n = document.createElement('span'); n.textContent = s.name;
    b.append(img, n);
    b.addEventListener('click', () => window.picker.choose(s.id));
    grid.appendChild(b);
  }
  document.querySelectorAll('.tabs button').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.k === kind)));
}
document.querySelectorAll('.tabs button').forEach((t) => t.addEventListener('click', () => { kind = t.dataset.k; render(); }));
document.getElementById('cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
window.picker.list().then((l) => { all = l; render(); });
