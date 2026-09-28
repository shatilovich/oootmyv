// Vercel Function: распознаёт постановление через Gemini и возвращает поля в JSON.
// Ключ хранится в переменной окружения GEMINI_API_KEY (Vercel → Project → Settings → Environment Variables).

export const config = { maxDuration: 60 };

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Запасные модели через запятую. Если не заданы, берём их из списка моделей, доступных ключу.
const FALLBACK = (process.env.GEMINI_FALLBACK_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean);
const API = 'https://generativelanguage.googleapis.com/v1beta';
const BUSY = new Set([500, 503, 504]);
// При этих ответах есть смысл попробовать другую модель: перегрузка, квота модели, модель недоступна ключу.
const NEXT = new Set([...BUSY, 404, 429]);
const DEADLINE = 50_000; // запас до maxDuration
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
    const rank = (n) => (/-preview/.test(n) ? 4 : 0) + (/-pro/.test(n) ? 2 : /-lite/.test(n) ? 1 : 0);
    discovered = models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => n !== MODEL && /^gemini-[\d.]+-(flash|pro)/.test(n) && !/tts|image|live|audio|embed|exp|computer|robotics/.test(n))
      .sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a))
      .slice(0, 4);
  } catch (e) {
    console.warn('Gemini: list models failed', String(e));
    return [];
  }
  return discovered;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'no_key' });

  const { mime, data } = req.body || {};
  if (!MIME.test(mime || '') || typeof data !== 'string') return res.status(400).json({ error: 'bad_file' });
  if (data.length * 0.75 > MAX_BYTES) return res.status(413).json({ error: 'too_big' });

  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  });
  const started = Date.now();
  const call = (model) =>
    fetch(`${API}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body,
      signal: AbortSignal.timeout(Math.max(1000, DEADLINE - (Date.now() - started))),
    });

  // Gemini периодически отвечает 503 «high demand»: повторяем основную модель, затем идём по запасным
  // и напоследок ещё раз пробуем основную. Ошибку отдаём от основной модели: она информативнее 404 запасной.
  const attempt = async (model, wait) => {
    if (Date.now() - started + wait > DEADLINE) return null;
    if (wait) await sleep(wait);
    try {
      const resp = await call(model);
      if (!resp.ok) console.warn('Gemini unavailable', model, resp.status);
      return resp;
    } catch (e) {
      console.warn('Gemini fetch failed', model, String(e));
      return null;
    }
  };
  let r = await attempt(MODEL, 0);
  if (!r || NEXT.has(r.status)) r = (await attempt(MODEL, 1500)) || r;
  if (!r || NEXT.has(r.status)) {
    for (const [model, wait] of [...(await fallbacks(key)).map((m) => [m, 0]), [MODEL, 3000]]) {
      const resp = await attempt(model, wait);
      if (resp?.ok || (model === MODEL && resp)) r = resp;
      if (resp?.ok) break;
    }
  }
  if (!r) return res.status(502).json({ error: 'upstream' });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('Gemini', r.status, detail.slice(0, 500));
    const error = r.status === 429 ? 'quota' : BUSY.has(r.status) ? 'busy' : 'upstream';
    return res.status(error === 'upstream' ? 502 : r.status).json({ error });
  }

  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  try {
    return res.status(200).json(JSON.parse(text));
  } catch (e) {
    console.error('Gemini: bad JSON', String(text).slice(0, 500));
    return res.status(502).json({ error: 'parse' });
  }
}
