// Vercel Function: распознаёт постановление через Gemini и возвращает поля в JSON.
// Ключ хранится в переменной окружения GEMINI_API_KEY (Vercel → Project → Settings → Environment Variables).

export const config = { maxDuration: 60 };

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Необязательная запасная модель: на неё переключаемся, если основная перегружена.
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL;
const BUSY = new Set([500, 503, 504]);
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
  const call = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body,
    });

  // Gemini периодически отвечает 503 «high demand»: повторяем с паузой, последняя попытка — на запасной модели.
  const plan = [[MODEL, 0], [MODEL, 1500], [MODEL, 4000]];
  if (FALLBACK) plan.push([FALLBACK, 0]);
  let r;
  for (const [model, wait] of plan) {
    if (wait) await sleep(wait);
    try {
      r = await call(model);
    } catch (e) {
      r = null;
      continue;
    }
    if (r.ok || !BUSY.has(r.status)) break;
    console.warn('Gemini busy', model, r.status);
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
