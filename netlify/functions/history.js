// Simmer — /api/history
// Returns recent analyses for a session_id (used to show "your past reports" in V2).
// Read-only.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({ statusCode: 200, body: '' });
  if (event.httpMethod !== 'GET') return cors({ statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) });

  const session_id = (event.queryStringParameters?.session_id || '').toString().slice(0, 64);
  if (!session_id) return cors({ statusCode: 400, body: JSON.stringify({ error: 'session_id required' }) });

  const url = process.env.TURSO_DB_URL?.replace(/^libsql:\/\//, 'https://');
  const token = process.env.TURSO_DB_TOKEN;
  if (!url || !token) return cors({ statusCode: 500, body: JSON.stringify({ error: 'Missing DB config' }) });

  try {
    const res = await fetch(`${url}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            type: 'execute',
            stmt: {
              sql: 'SELECT id, top_triggers, meals_count, created_at FROM simmer_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 20',
              args: [{ type: 'text', value: session_id }],
            },
          },
          { type: 'close' },
        ],
      }),
    });
    if (!res.ok) return cors({ statusCode: 500, body: JSON.stringify({ error: 'DB error' }) });
    const data = await res.json();
    const result = data?.results?.[0]?.response?.result;
    const cols = (result?.cols || []).map((c) => c.name);
    const rows = (result?.rows || []).map((row) => {
      const o = {};
      row.forEach((v, i) => {
        const val = v && typeof v === 'object' ? v.value : v;
        o[cols[i]] = val;
      });
      try { o.top_triggers = JSON.parse(o.top_triggers || '[]'); } catch { o.top_triggers = []; }
      return o;
    });
    return cors({ statusCode: 200, body: JSON.stringify({ history: rows }) });
  } catch (err) {
    return cors({ statusCode: 500, body: JSON.stringify({ error: 'DB unreachable' }) });
  }
};

function cors(res) {
  return {
    ...res,
    headers: {
      ...(res.headers || {}),
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  };
}
