// Vercel Function: распознаёт постановление через Gemini и возвращает поля в JSON.
// Ключи хранятся в переменных окружения (Vercel → Project → Settings → Environment Variables):
// GEMINI_API_KEY — основной провайдер; OPENROUTER_API_KEY — необязательный запасной (бесплатные модели OpenRouter),
// на него уходим, если Gemini перегружен. OPENROUTER_MODEL — конкретные модели через запятую,
// AI_PRIMARY=openrouter — ходить в OpenRouter первым.

export const config = { maxDuration: 60 };

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Запасные модели через запятую. Если не заданы, берём их из списка моделей, доступных ключу.
const FALLBACK = (process.env.GEMINI_FALLBACK_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
const API = 'https://generativelanguage.googleapis.com/v1beta';
const BUSY = new Set([500, 503, 504]);
// При этих ответах есть смысл попробовать другую модель: перегрузка, квота модели, модель недоступна ключу.
const NEXT = new Set([...BUSY, 404, 429]);
const DEADLINE = 55_000; // запас до maxDuration
const GEMINI_BUDGET = 25_000; // сколько отдаём Gemini, если есть запасной провайдер
const OR_API = 'https://openrouter.ai/api/v1';
const OR_MODELS = (process.env.OPENROUTER_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
// AI_PRIMARY=openrouter — сначала OpenRouter, Gemini остаётся запасным.
const OR_FIRST = process.env.AI_PRIMARY === 'openrouter';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BYTES = 4 * 1024 * 1024; // лимит тела запроса у Vercel Functions ~4.5 МБ
const MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/;

const PROMPT = `Ты извлекаешь данные из постановления по делу об административном правонарушении, зафиксированном камерой автофиксации (ЦАФАП, ГИБДД, МАДИ и т. п.).
Правила:
- Бери значения только из документа. Если поля нет или оно не читается, ставь null. Ничего не придумывай.
- Даты в формате ДД.ММ.ГГГГ.
- Сумму штрафа указывай числом в рублях без скидки.
- Статью указывай как в документе, например «ч. 2 ст. 12.9 КоАП РФ».
- plate_readable: читается ли госномер на фотоматериалах однозначно (null, если фото нет).
- sign_visible: для нарушений знаков и разметки (например, ст. 12.16, 12.15, 12.17, 12.19) — видны ли на фото знак или разметка, из-за которых выписан штраф; для остальных статей null.
- is_decree: false, если это не постановление по делу об административном правонарушении.
- quality: насколько уверенно распознан документ целиком (high, medium, low).`;

const S = (description) => ({ type: 'STRING', nullable: true, description });
const N = (description) => ({ type: 'NUMBER', nullable: true, description });
const B = (description) => ({ type: 'BOOLEAN', nullable: true, description });

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_decree: { type: 'BOOLEAN' },
    quality: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    number: S('Номер постановления (УИН), только цифры'),
    issued: S('Дата вынесения постановления'),
    violation_date: S('Дата нарушения'),
    violation_time: S('Время нарушения'),
    art: S('Статья КоАП'),
    sum: N('Сумма штрафа, руб.'),
    place: S('Место нарушения / адрес камеры'),
    authority: S('Кто вынес постановление'),
    camera_name: S('Название комплекса фотовидеофиксации'),
    camera_serial: S('Заводской номер комплекса'),
    camera_verification_until: S('Срок действия поверки комплекса'),
    vehicle: S('Марка и модель ТС'),
    plate: S('Госномер ТС'),
    speed_fact: N('Зафиксированная скорость, км/ч'),
    speed_limit: N('Разрешённая скорость, км/ч'),
    photo_present: B('Есть ли в документе фотоматериалы'),
    plate_readable: B('Читается ли госномер на фото'),
    sign_visible: B('Видны ли на фото знак или разметка'),
  },
  required: ['is_decree', 'quality'],
};

// Список запасных моделей: свежие flash-модели, доступные ключу. Кэшируется на время жизни инстанса.
let discovered;
async function fallbacks(key) {
  if (FALLBACK.length) return FALLBACK;
  if (discovered) return discovered;
  try {
    const r = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(5000) });
    const { models = [] } = await r.json();
    const ver = (n) => parseFloat(n.match(/^gemini-([\d.]+)/)[1]);
    // flash-lite у каждой версии идёт сразу за flash: у неё свой пул мощностей, и она реже перегружена.
    const rank = (n) => (/-preview/.test(n) ? 4 : 0) + (/-pro/.test(n) ? 2 : 0);
    const lite = (n) => (/-lite/.test(n) ? 1 : 0);
    discovered = models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => n !== MODEL && /^gemini-[\d.]+-(flash|pro)/.test(n) && !/tts|image|live|audio|embed|exp|computer|robotics/.test(n))
      .sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a) || lite(a) - lite(b))
      .slice(0, 5);
  } catch (e) {
    console.warn('Gemini: list models failed', String(e));
    return [];
  }
  return discovered;
}

// Модели OpenRouter: из OPENROUTER_MODEL (через запятую) или бесплатные, которые понимают картинки.
// Возможности (ответ по JSON-схеме) берём из каталога OpenRouter; кэшируется на время жизни инстанса.
let orDiscovered;
async function orModels() {
  if (orDiscovered) return orDiscovered;
  let data = [];
  try {
    const r = await fetch(`${OR_API}/models`, { signal: AbortSignal.timeout(5000) });
    ({ data = [] } = await r.json());
  } catch (e) {
    console.warn('OpenRouter: list models failed', String(e));
  }
  const info = (m) => ({
    id: m.id,
    structured: !!m.supported_parameters?.includes('structured_outputs'),
    ctx: m.context_length || 0,
  });
  if (OR_MODELS.length) {
    const byId = new Map(data.map((m) => [m.id, m]));
    const list = OR_MODELS.map((id) => (byId.has(id) ? info(byId.get(id)) : { id, structured: false }));
    if (data.length) orDiscovered = list;
    return list;
  }
  if (!data.length) return [];
  orDiscovered = data
    .filter((m) => m.id.endsWith(':free') && m.architecture?.input_modalities?.includes('image'))
    .map(info)
    .sort((a, b) => b.structured - a.structured || b.ctx - a.ctx)
    .slice(0, 4);
  return orDiscovered;
}

// Схема Gemini (OBJECT/STRING, nullable) → обычная JSON Schema для OpenAI-совместимого API.
const toJsonSchema = (s) => {
  const t = s.type.toLowerCase();
  const out = { type: s.nullable ? [t, 'null'] : t };
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = Object.keys(s.properties);
    out.additionalProperties = false;
  }
  return out;
};
const JSON_SCHEMA = toJsonSchema(SCHEMA);
const FIELDS = `Ответь только JSON-объектом без пояснений с полями:
${Object.entries(SCHEMA.properties)
  .map(([k, v]) => `- ${k} (${v.enum ? v.enum.join('|') : v.type.toLowerCase()}${v.nullable ? ' или null' : ''})${v.description ? ': ' + v.description : ''}`)
  .join('\n')}`;

// Бесплатные модели не всегда соблюдают типы: приводим ответ к схеме, которую ждёт клиент.
function normalize(x) {
  const out = {};
  for (const [k, v] of Object.entries(SCHEMA.properties)) {
    let val = x?.[k] ?? null;
    if (v.type === 'NUMBER' && val !== null) {
      val = typeof val === 'number' ? val : parseFloat(String(val).replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, ''));
      if (!Number.isFinite(val)) val = null;
    } else if (v.type === 'BOOLEAN' && val !== null) {
      val = val === true || /^(true|да|yes)$/i.test(String(val)) ? true : val === false || /^(false|нет|no)$/i.test(String(val)) ? false : null;
    } else if (v.type === 'STRING' && val !== null) {
      val = String(val).trim() || null;
      if (v.enum && !v.enum.includes(val)) val = null;
    }
    out[k] = val;
  }
  if (out.is_decree === null) out.is_decree = !!(out.number && out.art);
  if (out.quality === null) out.quality = 'medium';
  return out;
}

function parseJson(text) {
  const t = String(text || '');
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    return JSON.parse(m[0]);
  }
}

// Gemini: основная модель с повтором, затем запасные, в пределах budget мс.
// Возвращает { data } или { status, error }.
async function gemini(key, mime, data, budget) {
  const started = Date.now();
  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  });
  const attempt = async (model, wait) => {
    if (Date.now() - started + wait > budget - 2000) return null;
    if (wait) await sleep(wait);
    try {
      const resp = await fetch(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(Math.max(1000, budget - (Date.now() - started))),
      });
      if (!resp.ok) console.warn('Gemini unavailable', model, resp.status);
      return resp;
    } catch (e) {
      console.warn('Gemini fetch failed', model, String(e));
      return null;
    }
  };
  // Ошибку отдаём от основной модели: она информативнее 404 запасной.
  let r = await attempt(MODEL, 0);
  if (!r || NEXT.has(r.status)) r = (await attempt(MODEL, 1500)) || r;
  if (!r || NEXT.has(r.status)) {
    for (const [model, wait] of [...(await fallbacks(key)).map((m) => [m, 0]), [MODEL, 3000]]) {
      const resp = await attempt(model, wait);
      if (resp?.ok || (model === MODEL && resp)) r = resp;
      if (resp?.ok) break;
    }
  }
  if (!r) return { status: 502, error: 'upstream' };
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('Gemini', r.status, detail.slice(0, 500));
    const error = r.status === 429 ? 'quota' : BUSY.has(r.status) ? 'busy' : 'upstream';
    return { status: error === 'upstream' ? 502 : r.status, error };
  }
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  try {
    return { data: JSON.parse(text) };
  } catch (e) {
    console.error('Gemini: bad JSON', String(text).slice(0, 500));
    return { status: 502, error: 'parse' };
  }
}

// OpenRouter: перебираем бесплатные модели с распознаванием картинок до первого разборчивого ответа.
async function openrouter(key, mime, data, deadline) {
  // HEIC OpenRouter не принимает; PDF разбирает плагин file-parser (движок pdf-text бесплатный).
  if (/heic|heif/.test(mime)) return null;
  const pdf = mime === 'application/pdf';
  const file = pdf
    ? { type: 'file', file: { filename: 'decree.pdf', file_data: `data:${mime};base64,${data}` } }
    : { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
  for (const m of await orModels()) {
    const left = deadline - Date.now();
    if (left < 5000) break;
    try {
      const r = await fetch(`${OR_API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: m.id,
          temperature: 0,
          messages: [{ role: 'user', content: [{ type: 'text', text: `${PROMPT}\n\n${FIELDS}` }, file] }],
          ...(m.structured && { response_format: { type: 'json_schema', json_schema: { name: 'decree', strict: true, schema: JSON_SCHEMA } } }),
          ...(pdf && { plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }] }),
        }),
        signal: AbortSignal.timeout(left),
      });
      if (!r.ok) {
        console.warn('OpenRouter unavailable', m.id, r.status, (await r.text().catch(() => '')).slice(0, 300));
        continue;
      }
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content;
      try {
        return { data: normalize(parseJson(text)) };
      } catch (e) {
        console.warn('OpenRouter: bad JSON', m.id, String(text).slice(0, 300));
      }
    } catch (e) {
      console.warn('OpenRouter fetch failed', m.id, String(e));
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const key = process.env.GEMINI_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!key && !orKey) return res.status(500).json({ error: 'no_key' });

  const { mime, data } = req.body || {};
  if (!MIME.test(mime || '') || typeof data !== 'string') return res.status(400).json({ error: 'bad_file' });
  if (data.length * 0.75 > MAX_BYTES) return res.status(413).json({ error: 'too_big' });

  const started = Date.now();
  if (orKey && OR_FIRST) {
    const o = await openrouter(orKey, mime, data, started + (key ? DEADLINE - 15_000 : DEADLINE));
    if (o) return res.status(200).json(o.data);
  }
  const g = key ? await gemini(key, mime, data, orKey && !OR_FIRST ? GEMINI_BUDGET : DEADLINE - (Date.now() - started)) : { status: 503, error: 'busy' };
  if (g.data) return res.status(200).json(g.data);
  if (orKey && !OR_FIRST) {
    const o = await openrouter(orKey, mime, data, started + DEADLINE);
    if (o) return res.status(200).json(o.data);
  }
  return res.status(g.status).json({ error: g.error });
}
