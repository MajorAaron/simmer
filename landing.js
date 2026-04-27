// Landing page email capture handler.
(function () {
  const form = document.getElementById('join-form');
  const btn = document.getElementById('join-btn');
  const confirm = document.getElementById('join-confirm');
  if (!form) return;

  function setLoading(on) {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('join-email').value.trim();
    if (!email) return;
    setLoading(true);
    confirm.classList.add('hidden');
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'landing' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      confirm.textContent = "You're in. Check your inbox.";
      confirm.classList.remove('hidden');
      try { window.posthog?.capture('email_captured', { source: 'landing' }); } catch {}
      document.getElementById('join-email').value = '';
    } catch (err) {
      confirm.textContent = err.message || 'Could not sign up. Try again.';
      confirm.classList.remove('hidden');
    } finally {
      setLoading(false);
    }
  });
})();
