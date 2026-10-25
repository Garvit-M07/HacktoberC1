// Gemma 4 via the Gemini API (REST, no SDK needed).
// Gemma doesn't reliably support system instructions / JSON mode, so
// instructions are inlined in the user turn and JSON is extracted from text.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const FALLBACK_MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it'];

export const status = { ok: null, model: null, lastError: null };

function models() {
  const primary = process.env.GEMMA_MODEL || FALLBACK_MODELS[0];
  return [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
}

async function call(model, contents, temperature, timeoutMs = 45000) {
  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMMA_API_KEY,
    },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
}

/**
 * @param {string|Array} prompt  plain text, or Gemini-style contents array
 */
export async function gemma(prompt, { temperature = 0.4, timeoutMs } = {}) {
  if (!process.env.GEMMA_API_KEY) throw new Error('GEMMA_API_KEY is not set (.env)');
  const contents = Array.isArray(prompt) ? prompt : [{ role: 'user', parts: [{ text: prompt }] }];
  let lastErr;
  for (const model of models()) {
    try {
      const text = await call(model, contents, temperature, timeoutMs);
      Object.assign(status, { ok: true, model, lastError: null });
      return stripThinking(text);
    } catch (e) {
      lastErr = e;
      // only fall through to the next model on "model not found / unsupported"
      if (![400, 404].includes(e.status)) break;
    }
  }
  Object.assign(status, { ok: false, lastError: lastErr?.message });
  throw lastErr;
}

export async function gemmaJSON(prompt, opts) {
  const text = await gemma(prompt, { temperature: 0.2, ...opts });
  return extractJSON(text);
}

function stripThinking(t) {
  return t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
}

export function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[{[]/);
  if (start < 0) throw new Error('No JSON in model output');
  const open = src[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error('Unterminated JSON in model output');
}
