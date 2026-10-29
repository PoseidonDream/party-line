/* The /delete-account page: sign in, then delete the account (POST /api/account/delete). */
const $ = (id) => document.getElementById(id);
const post = async (path, body, token) => {
  const r = await fetch(path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'That didn’t work. Try again.');
  return d;
};
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true; $('go').disabled = true;
  try {
    const login = await post('/api/login', { name: $('name').value, password: $('pass').value, code: $('code').value, device: 'Account deletion page' });
    if (login.needCode) { $('codeRow').hidden = false; $('code').focus(); return; }
    await post('/api/account/delete', { password: $('pass').value }, login.token);
    $('form').hidden = true; $('done').hidden = false;
  } catch (ex) { $('error').textContent = ex.message; $('error').hidden = false; }
  finally { $('go').disabled = false; }
});
