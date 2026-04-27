// Simmer — /api/subscribe
// Stores email signups in the shared `subscribers` table on Turso.
// Sends a welcome email via Resend (best-effort, non-blocking).

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 200, body: '' });
  if (event.httpMethod !== 'POST') return cors({ statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return cors({ statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return cors({ statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email' }) });
  }
  const source = (body.source || 'tool').toString().slice(0, 32);
  const session_id = (body.session_id || '').toString().slice(0, 64);

  const url = process.env.TURSO_DB_URL?.replace(/^libsql:\/\//, 'https://');
  const token = process.env.TURSO_DB_TOKEN;
  if (!url || !token) {
    return cors({ statusCode: 500, body: JSON.stringify({ error: 'Server is missing DB configuration' }) });
  }

  const slug = process.env.IDEA_SLUG || 'simmer';

  const requests = [
    {
      type: 'execute',
      stmt: {
        sql: 'INSERT OR IGNORE INTO subscribers (email, idea_slug, source, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        args: [
          { type: 'text', value: email },
          { type: 'text', value: slug },
          { type: 'text', value: source },
        ],
      },
    },
    { type: 'close' },
  ];

  try {
    const res = await fetch(`${url}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    if (!res.ok) {
      const text = await res.text();
      return cors({ statusCode: 500, body: JSON.stringify({ error: 'DB error', detail: text.slice(0, 200) }) });
    }
  } catch (err) {
    return cors({ statusCode: 500, body: JSON.stringify({ error: 'DB unreachable' }) });
  }

  // Best-effort welcome email — never block the signup on Resend
  sendWelcome(email).catch(() => {});

  return cors({ statusCode: 200, body: JSON.stringify({ ok: true, email }) });
};

async function sendWelcome(email) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromDomain = process.env.RESEND_FROM_DOMAIN || 'majorsolutions.studio';
  if (!apiKey) return;
  const html = `<!DOCTYPE html><html><body style="margin:0;font-family:Georgia,serif;background:#FBF7F2;color:#2B1F1A;">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
      <p style="font-size:14px;letter-spacing:.1em;text-transform:uppercase;color:#6B8F71;margin:0 0 12px;">SIMMER</p>
      <h1 style="font-style:italic;font-weight:500;font-size:28px;margin:0 0 16px;">You're in.</h1>
      <p style="font-size:16px;line-height:1.6;color:#5C4A3E;">Thanks for signing up. We'll send you a weekly trigger report once you've logged a handful of meals.</p>
      <p style="font-size:16px;line-height:1.6;color:#5C4A3E;">Until then, you can keep using the free Trigger Finder — your entries stay private.</p>
      <p style="font-size:14px;color:#5C4A3E;margin-top:32px;">Quietly,<br/>Simmer</p>
    </div>
  </body></html>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `Simmer <hello@${fromDomain}>`,
      to: [email],
      subject: 'You\'re in. — Simmer',
      html,
    }),
  });
}

function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  };
}
