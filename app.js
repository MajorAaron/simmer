/* Simmer — Trigger Finder client logic.
   Modes: free-text paste OR structured meal-by-meal.
   Submits to /api/analyze, renders trigger list. Email capture posts to /api/subscribe.
*/
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const form = $('#trigger-form');
  const freetext = $('#freetext');
  const mealRows = $('#meal-rows');
  const addMealBtn = $('#add-meal');
  const analyzeBtn = $('#analyze-btn');
  const resultCard = $('#result-card');
  const captureCard = $('#capture-card');
  const emailForm = $('#email-form');
  const emailBtn = $('#email-btn');
  const captureConfirm = $('#capture-confirm');

  let mode = 'freetext';
  let sessionId = ensureSessionId();
  let lastAnalysis = null;

  // Mode toggle
  $$('.toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      $$('.toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $('#mode-freetext').classList.toggle('hidden', mode !== 'freetext');
      $('#mode-structured').classList.toggle('hidden', mode !== 'structured');
      if (mode === 'structured' && mealRows.children.length === 0) seedMealRows();
    });
  });

  // Add meal row
  addMealBtn?.addEventListener('click', () => addMealRow());

  function seedMealRows() {
    const header = document.createElement('div');
    header.className = 'meal-row-header';
    header.innerHTML = '<span>When</span><span>What you ate</span><span>Hours after</span><span>Symptom 0-10</span><span></span>';
    mealRows.appendChild(header);
    for (let i = 0; i < 3; i++) addMealRow();
  }

  function addMealRow() {
    const row = document.createElement('div');
    row.className = 'meal-row';
    row.innerHTML = `
      <input type="text" name="when" placeholder="Tue dinner" />
      <input type="text" name="food" placeholder="pizza, red wine" />
      <input type="number" name="hours" min="0" max="24" step="0.5" placeholder="2" />
      <input type="number" name="symptom" min="0" max="10" placeholder="6" />
      <button type="button" class="row-remove" aria-label="Remove">&times;</button>
    `;
    row.querySelector('.row-remove').addEventListener('click', () => row.remove());
    mealRows.appendChild(row);
  }

  function collectStructured() {
    const rows = $$('.meal-row', mealRows);
    return rows
      .map((r) => ({
        when: r.querySelector('[name="when"]')?.value.trim() || '',
        food: r.querySelector('[name="food"]')?.value.trim() || '',
        hours: r.querySelector('[name="hours"]')?.value.trim() || '',
        symptom: r.querySelector('[name="symptom"]')?.value.trim() || '',
      }))
      .filter((m) => m.food);
  }

  function ensureSessionId() {
    let id = localStorage.getItem('simmer_session');
    if (!id) {
      id = 'sim_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('simmer_session', id);
    }
    return id;
  }

  // Submit analysis
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = mode === 'freetext'
      ? { mode: 'freetext', text: freetext.value.trim(), session_id: sessionId }
      : { mode: 'structured', meals: collectStructured(), session_id: sessionId };

    if (mode === 'freetext' && !payload.text) {
      alert('Paste some meals & symptoms first.');
      return;
    }
    if (mode === 'structured' && !payload.meals.length) {
      alert('Add at least one meal.');
      return;
    }

    setLoading(analyzeBtn, true);
    resultCard.classList.add('hidden');

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      lastAnalysis = data;
      renderResult(data);
      captureCard.classList.remove('hidden');
      try { posthog?.capture('analyze_completed', { meals: data.meals_count, top_trigger: data.top_triggers?.[0]?.name }); } catch {}
    } catch (err) {
      renderError(err.message || 'Something went wrong. Try again in a moment.');
    } finally {
      setLoading(analyzeBtn, false);
    }
  });

  function renderResult(data) {
    const { summary, top_triggers = [], observations = [], next_steps = [], meals_count } = data;
    const triggerHtml = top_triggers
      .map((t, i) => `
        <li class="trigger-item">
          <span class="trigger-rank">${i + 1}</span>
          <div>
            <p class="trigger-name">${escapeHtml(t.name)}</p>
            <p class="trigger-explanation">${escapeHtml(t.explanation)}</p>
            <span class="trigger-confidence confidence-${(t.confidence || 'medium').toLowerCase()}">${escapeHtml(t.confidence || 'Medium')} confidence</span>
          </div>
        </li>`)
      .join('');

    const observationHtml = observations.length
      ? `<div class="observation-block">
          <h3>Other patterns we noticed</h3>
          <ul>${observations.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>
        </div>` : '';

    const nextStepsHtml = next_steps.length
      ? `<div class="result-cta">
          <p><strong>Next steps Simmer suggests:</strong></p>
          <ul>${next_steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        </div>` : '';

    resultCard.innerHTML = `
      <p class="kicker">Trigger report · ${meals_count || ''} meals analyzed</p>
      <h2 class="result-title">Here's what your diary is saying</h2>
      <p class="result-summary">${escapeHtml(summary || '')}</p>
      ${top_triggers.length ? `<ul class="trigger-list">${triggerHtml}</ul>` : '<p>Not enough signal yet — log more meals.</p>'}
      ${observationHtml}
      ${nextStepsHtml}
    `;
    resultCard.classList.remove('hidden');
    resultCard.classList.remove('error-box');
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderError(msg) {
    resultCard.innerHTML = `
      <h2 class="result-title">We couldn't read that</h2>
      <p class="result-summary">${escapeHtml(msg)}</p>
      <p class="result-summary">Try again, or simplify the entries.</p>
    `;
    resultCard.classList.remove('hidden');
    resultCard.classList.add('error-box');
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setLoading(btn, on) {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Email capture
  emailForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    if (!email) return;
    setLoading(emailBtn, true);
    captureConfirm.classList.add('hidden');
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          source: 'tool',
          session_id: sessionId,
          last_analysis: lastAnalysis ? { top_triggers: lastAnalysis.top_triggers, meals_count: lastAnalysis.meals_count } : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      captureConfirm.classList.remove('hidden');
      try { posthog?.capture('email_captured', { source: 'tool' }); } catch {}
      $('#email').value = '';
    } catch (err) {
      captureConfirm.textContent = err.message || 'Could not sign up. Try again.';
      captureConfirm.classList.remove('hidden');
    } finally {
      setLoading(emailBtn, false);
    }
  });
})();
