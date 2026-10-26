window.overlay.onState((st) => {
  document.getElementById('head').textContent = st ? `🔊 ${st.channel}` : '';
  const ul = document.getElementById('list'); ul.textContent = '';
  for (const p of (st && st.people) || []) {
    const li = document.createElement('li'); if (p.talking) li.className = 'talking';
    const av = document.createElement('span'); av.className = 'av'; av.style.background = p.color; av.textContent = p.name.slice(0, 1).toUpperCase();
    const n = document.createElement('span'); n.className = 'name'; n.textContent = p.name;
    li.append(av, n);
    if (p.muted) { const m = document.createElement('span'); m.className = 'muted'; m.textContent = '🔇'; li.appendChild(m); }
    ul.appendChild(li);
  }
});
