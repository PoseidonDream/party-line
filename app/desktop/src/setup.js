const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
window.partyLineDesktop.currentServer().then((s) => { $('#url').value = q.get('server') || s || ''; $('#url').focus(); });
$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#go').disabled = true; $('#go').textContent = 'Connecting…'; $('#err').hidden = true;
  const r = await window.partyLineDesktop.saveServer($('#url').value.trim());
  if (r && r.error) { $('#err').textContent = r.error; $('#err').hidden = false; $('#go').disabled = false; $('#go').textContent = 'Connect'; }
});
