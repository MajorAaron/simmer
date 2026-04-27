// Simmer — /api/analyze
// Accepts free-text or structured meal+symptom logs and asks Gemini 2.0 Flash
// to identify the user's most likely GERD/reflux triggers.
//
// Env vars: GEMINI_API_KEY, TURSO_DB_URL, TURSO_DB_TOKEN

const SYSTEM_PROMPT = `You are Simmer, a careful pattern-reader for chronic acid reflux / GERD self-trackers.
You receive a list of meals and symptoms a user has logged. Your job is to identify the FOODS, TIMINGS, and behaviors most strongly correlated with their reflux flare-ups, and explain it in plain, calm language.

Rules:
- Never give medical advice. Never recommend medications, diagnoses, or treatments.
- Phrase everything as observed correlations, not causes ("X correlates with...", not "X causes...").
- Use the user's own words for foods when possible.
- If data is sparse (fewer than 3 meals or unclear), say so honestly and ask them to log more.
- Confidence levels: HIGH only if a food appears in 3+ flare-ups, MEDIUM for 2, LOW for 1 or partial signal.
- Keep tone quiet, supportive, observational — like a friend reading their own journal back to them.

Output strict JSON matching this schema:
{
  "summary": "2-3 sentence plain-language overview of what stood out",
  "meals_count": <integer count of meals you parsed>,
  "top_triggers": [
    { "name": "<food/behavior/timing>", "explanation": "1-2 sentences citing how often it appeared and severity", "confidence": "High|Medium|Low" }
  ],
  "observations": [
    "<other interesting pattern, e.g. timing, sleep position, portion size>"
  ],
  "next_steps": [
    "<concrete suggestion, e.g. 'Try a 7-day eliminate-and-reintroduce trial with tomatoes' — never medical>"
  ]
}

Return ONLY the JSON object, no prose, no markdown fences.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return cors({ statusCode: 200, body: '' });
  }
  if (event.httpMethod !== 'POST') {
    return cors({ statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return cors({ statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return cors({ statusCode: 500, body: JSON.stringify({ error: 'Server is missing AI configuration' }) });
  }

  const userPrompt = buildUserPrompt(body);
  if (!userPrompt) {
    return cors({ statusCode: 400, body: JSON.stringify({ error: 'Provide some meals & symptoms to analyze' }) });
  }

  let aiData;
  try {
    aiData = await callGemini(apiKey, userPrompt);
  } catch (err) {
    return cors({ statusCode: 502, body: JSON.stringify({ error: 'AI is unavailable right now. Try again in a moment.' }) });
  }

  // Best-effort log to Turso (non-blocking — analysis still returns if log fails)
  try {
    await logToTurso({
      session_id: body.session_id || null,
      input_data: JSON.stringify(body).slice(0, 8000),
      ai_analysis: JSON.stringify(aiData).slice(0, 8000),
      top_triggers: JSON.stringify(aiData.top_triggers || []).slice(0, 4000),
      meals_count: aiData.meals_count || 0,
    });
  } catch (err) {
    // swallow
  }

  return cors({ statusCode: 200, body: JSON.stringify(aiData) });
};

function buildUserPrompt(body) {
  if (body.mode === 'structured') {
    if (!Array.isArray(body.meals) || body.meals.length === 0) return null;
    const lines = body.meals
      .filter((m) => m && m.food)
      .map((m) => `- ${m.when || '(time unknown)'}: ate ${m.food}; ${m.hours ? `${m.hours} hours later` : 'later'} symptom intensity ${m.symptom || '?'}/10`)
      .join('\n');
    return `Here is the user's meal & symptom log (structured):\n\n${lines}\n\nAnalyze and return the JSON.`;
  }
  const text = (body.text || '').trim();
  if (!text) return null;
  return `Here is the user's meal & symptom diary (free text):\n\n${text}\n\nAnalyze and return the JSON.`;
}

async function callGemini(apiKey, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // best-effort cleanup if model leaks markdown fences
    const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(cleaned);
  }
  // Defensive defaults
  parsed.summary = parsed.summary || '';
  parsed.top_triggers = Array.isArray(parsed.top_triggers) ? parsed.top_triggers.slice(0, 6) : [];
  parsed.observations = Array.isArray(parsed.observations) ? parsed.observations.slice(0, 5) : [];
  parsed.next_steps = Array.isArray(parsed.next_steps) ? parsed.next_steps.slice(0, 4) : [];
  parsed.meals_count = Number(parsed.meals_count) || 0;
  return parsed;
}

async function logToTurso({ session_id, input_data, ai_analysis, top_triggers, meals_count }) {
  const url = process.env.TURSO_DB_URL?.replace(/^libsql:\/\//, 'https://');
  const token = process.env.TURSO_DB_TOKEN;
  if (!url || !token) return;
  const stmt = {
    sql: 'INSERT INTO simmer_logs (session_id, input_data, ai_analysis, top_triggers, meals_count) VALUES (?, ?, ?, ?, ?)',
    args: [
      { type: 'text', value: session_id || '' },
      { type: 'text', value: input_data || '' },
      { type: 'text', value: ai_analysis || '' },
      { type: 'text', value: top_triggers || '' },
      { type: 'integer', value: String(meals_count || 0) },
    ],
  };
  await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt }, { type: 'close' }] }),
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
