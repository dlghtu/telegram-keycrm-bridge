/**
 * Telegram ↔ KeyCRM bridge
 * - POST /webhooks/telegram  — команда менеджера /order → створення замовлення в KeyCRM
 * - POST /webhooks/keycrm    — вебхук CRM (ТТН / tracking_code) → повідомлення клієнту в Telegram
 *
 * Стек: Node.js 18+ / Express. Легкий для Render free tier.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  managerIds: (process.env.MANAGER_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  keycrmToken: process.env.KEYCRM_API_TOKEN || '',
  keycrmBase: (process.env.KEYCRM_API_BASE || 'https://openapi.keycrm.app/v1').replace(/\/$/, ''),
  keycrmSourceId: Number(process.env.KEYCRM_SOURCE_ID) || 0,
  keycrmNovaPoshtaServiceId: process.env.KEYCRM_NOVA_POSHTA_SERVICE_ID
    ? Number(process.env.KEYCRM_NOVA_POSHTA_SERVICE_ID)
    : null,
  keycrmWebhookSecret: process.env.KEYCRM_WEBHOOK_SECRET || '',
  ordersMapFile: process.env.ORDERS_MAP_FILE || '',
};

function assertConfig() {
  const missing = [];
  if (!config.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.keycrmToken) missing.push('KEYCRM_API_TOKEN');
  if (!config.keycrmSourceId) missing.push('KEYCRM_SOURCE_ID');
  if (missing.length) {
    console.warn(
      `[warn] Не задані змінні: ${missing.join(', ')}. Сервіс стартує, але API-виклики впадуть.`
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory / file store: orderId → { chatId, phone, fullName, notifiedTtns }
// ---------------------------------------------------------------------------

/** @type {Map<string, { chatId: string|number, phone?: string, fullName?: string, notifiedTtns: Set<string> }>} */
const ordersMap = new Map();

function loadOrdersMap() {
  if (!config.ordersMapFile) return;
  try {
    const full = path.resolve(config.ordersMapFile);
    if (!fs.existsSync(full)) return;
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const [id, row] of Object.entries(raw)) {
      ordersMap.set(String(id), {
        chatId: row.chatId,
        phone: row.phone,
        fullName: row.fullName,
        notifiedTtns: new Set(row.notifiedTtns || []),
      });
    }
    console.log(`[orders-map] loaded ${ordersMap.size} records from ${full}`);
  } catch (err) {
    console.error('[orders-map] load failed:', err.message);
  }
}

function persistOrdersMap() {
  if (!config.ordersMapFile) return;
  try {
    const full = path.resolve(config.ordersMapFile);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const obj = {};
    for (const [id, row] of ordersMap.entries()) {
      obj[id] = {
        chatId: row.chatId,
        phone: row.phone,
        fullName: row.fullName,
        notifiedTtns: [...(row.notifiedTtns || [])],
      };
    }
    fs.writeFileSync(full, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[orders-map] persist failed:', err.message);
  }
}

function saveOrderLink(orderId, meta) {
  const key = String(orderId);
  const prev = ordersMap.get(key);
  ordersMap.set(key, {
    chatId: meta.chatId,
    phone: meta.phone,
    fullName: meta.fullName,
    notifiedTtns: prev?.notifiedTtns || new Set(),
  });
  persistOrdersMap();
}

function findOrderByPhone(phone) {
  if (!phone) return null;
  const normalized = normalizePhone(phone);
  for (const [id, row] of ordersMap.entries()) {
    if (row.phone && normalizePhone(row.phone) === normalized) {
      return { orderId: id, ...row };
    }
  }
  return null;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function telegramApi(method, payload) {
  const url = `https://api.telegram.org/bot${config.telegramToken}/${method}`;
  return httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    return await telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// KeyCRM API
// ---------------------------------------------------------------------------

async function keycrmRequest(method, endpoint, body) {
  const url = `${config.keycrmBase}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  return httpJson(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.keycrmToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * Створює замовлення в KeyCRM.
 *
 * Списання залишків: передавайте products[].sku, який уже є в каталозі KeyCRM
 * (артикул офера/варіанту). CRM зв'яже рядок замовлення з товаром складу і
 * спише quantity за правилами складу (резерв/відвантаження — налаштування CRM).
 * Без валідного sku товар піде як «разовий» і залишки не зміняться.
 *
 * @see https://docs.keycrm.app/  POST /order
 */
async function createKeyCrmOrder(orderData) {
  return keycrmRequest('POST', '/order', orderData);
}

// ---------------------------------------------------------------------------
// /order parser
// ---------------------------------------------------------------------------

/**
 * Формати команди (будь-який з них):
 *
 * 1) З chat_id клієнта (рекомендовано):
 *    /order 123456789 | Іван Петренко | +380501112233 | Київ | Відділення №5 | TSHIRT-M:1:450:Футболка M
 *
 * 2) Reply на повідомлення клієнта + без chat_id:
 *    /order Іван Петренко | +380501112233 | Київ | Відділення №5 | TSHIRT-M:1:450:Футболка M
 *
 * 3) Кілька товарів через «;»:
 *    ... | SKU1:2:100:Name1; SKU2:1:200:Name2
 *
 * Поля через «|»:
 *   [chat_id] | full_name | phone | city | warehouse | products
 *
 * product: sku:qty:price[:name]
 */
function parseOrderCommand(text, replyFromChatId) {
  const cleaned = text.replace(/^\/order(@\w+)?\s*/i, '').trim();
  if (!cleaned) {
    throw new Error(
      'Порожня команда. Приклад:\n' +
        '/order chat_id | ПІБ | +380... | Місто | Відділення №N | SKU:qty:price:Назва'
    );
  }

  const parts = cleaned.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 5) {
    throw new Error(
      'Очікується мінімум 5 полів через «|»:\n' +
        'ПІБ | телефон | місто | відділення | sku:qty:price:назва\n' +
        'Або з chat_id:\n' +
        'chat_id | ПІБ | телефон | місто | відділення | sku:qty:price:назва'
    );
  }

  let offset = 0;
  let clientChatId = replyFromChatId || null;

  // Якщо перше поле — число (chat_id / user id)
  if (/^-?\d+$/.test(parts[0]) && parts.length >= 6) {
    clientChatId = parts[0];
    offset = 1;
  }

  const fullName = parts[offset];
  const phone = parts[offset + 1];
  const city = parts[offset + 2];
  const warehouse = parts[offset + 3];
  const productsRaw = parts.slice(offset + 4).join('|');

  if (!fullName || !phone) {
    throw new Error('ПІБ і телефон обовʼязкові.');
  }
  if (!clientChatId) {
    throw new Error(
      'Невідомий chat_id клієнта. Передайте його першим полем або зробіть reply на повідомлення клієнта.'
    );
  }

  const products = productsRaw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseProductToken);

  if (!products.length) {
    throw new Error('Додайте хоча б один товар: sku:qty:price:назва');
  }

  return { clientChatId, fullName, phone, city, warehouse, products };
}

function parseProductToken(token) {
  // sku:qty:price[:name...]
  const segs = token.split(':').map((s) => s.trim());
  if (segs.length < 3) {
    throw new Error(`Невірний товар «${token}». Формат: sku:qty:price:назва`);
  }
  const sku = segs[0];
  const quantity = Number(segs[1]);
  const price = Number(segs[2]);
  const name = segs.slice(3).join(':') || sku;

  if (!sku || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Невірна кількість у «${token}»`);
  }
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`Невірна ціна у «${token}»`);
  }

  return { sku, quantity, price, name };
}

/**
 * Payload для KeyCRM POST /order
 */
function buildKeyCrmPayload(parsed, managerTelegramId) {
  /** @type {Record<string, unknown>} */
  const payload = {
    source_id: config.keycrmSourceId,
    // Унікальний id у джерелі — щоб не дублювати при ретраях (опційно)
    source_uuid: `tg-${managerTelegramId}-${Date.now()}`,
    buyer_comment: `Замовлення з Telegram (manager ${managerTelegramId})`,
    manager_comment: [
      `TG client chat_id: ${parsed.clientChatId}`,
      `Місто: ${parsed.city}`,
      `Відділення НП: ${parsed.warehouse}`,
    ].join('\n'),
    buyer: {
      full_name: parsed.fullName,
      phone: parsed.phone.startsWith('+') ? parsed.phone : `+${parsed.phone.replace(/\D/g, '')}`,
    },
    shipping: {
      shipping_address_city: parsed.city,
      shipping_receive_point: parsed.warehouse,
      shipping_address_country: 'UA',
      recipient_full_name: parsed.fullName,
      recipient_phone: parsed.phone.startsWith('+')
        ? parsed.phone
        : `+${parsed.phone.replace(/\D/g, '')}`,
    },
    // Важливо для списання: sku має існувати в каталозі KeyCRM
    products: parsed.products.map((p) => ({
      sku: p.sku,
      quantity: p.quantity,
      price: p.price,
      name: p.name,
      // unit_type: 'шт', // за потреби
    })),
  };

  if (config.keycrmNovaPoshtaServiceId) {
    payload.shipping.delivery_service_id = config.keycrmNovaPoshtaServiceId;
    payload.shipping.shipping_service = 'Nova Poshta';
  }

  return payload;
}

// ---------------------------------------------------------------------------
// KeyCRM webhook: extract tracking / TTN
// ---------------------------------------------------------------------------

/**
 * KeyCRM шле різні форми payload залежно від налаштувань вебхука.
 * Дістаємо tracking_code і ідентифікатори максимально толерантно.
 */
function extractFromKeyCrmWebhook(body) {
  const root = body?.context || body?.data || body?.order || body || {};
  const shipping =
    root.shipping ||
    body?.shipping ||
    root.delivery ||
    body?.context?.shipping ||
    {};

  const trackingCode =
    shipping.tracking_code ||
    shipping.trackingCode ||
    root.tracking_code ||
    root.trackingCode ||
    body?.tracking_code ||
    body?.trackingCode ||
    null;

  const orderId =
    root.id ||
    root.order_id ||
    body?.order_id ||
    body?.id ||
    body?.context?.id ||
    null;

  const phone =
    root.buyer?.phone ||
    root.client?.phone ||
    root.phone ||
    shipping.recipient_phone ||
    body?.buyer?.phone ||
    null;

  const fullName =
    root.buyer?.full_name ||
    root.buyer?.fullName ||
    shipping.recipient_full_name ||
    null;

  // Іноді TTN лише в products/shipping history
  const altTracking =
    root.shipping?.lastHistory?.tracking_code ||
    root.shipping?.last_history?.tracking_code ||
    null;

  return {
    orderId: orderId != null ? String(orderId) : null,
    trackingCode: trackingCode || altTracking || null,
    phone,
    fullName,
    event: body?.event || body?.type || body?.action || null,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));

// Healthcheck (Render / UptimeRobot)
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'telegram-keycrm-bridge',
    time: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

/**
 * Telegram webhook
 * Документація: https://core.telegram.org/bots/api#setwebhook
 */
app.post('/webhooks/telegram', async (req, res) => {
  // Завжди 200 швидко — Telegram ретраїть при non-2xx
  res.status(200).json({ ok: true });

  try {
    if (config.telegramWebhookSecret) {
      const header = req.get('X-Telegram-Bot-Api-Secret-Token');
      if (header !== config.telegramWebhookSecret) {
        console.warn('[telegram] invalid secret token');
        return;
      }
    }

    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const fromId = message.from?.id;
    const text = message.text.trim();

    if (text === '/start' || text.startsWith('/start ')) {
      await sendTelegramMessage(
        chatId,
        [
          '👋 <b>Бот інтеграції з KeyCRM</b>',
          '',
          'Менеджер створює замовлення командою:',
          '<code>/order chat_id | ПІБ | +380... | Місто | Відділення | SKU:qty:price:Назва</code>',
          '',
          'Або reply на повідомлення клієнта без chat_id.',
          `Ваш Telegram id: <code>${fromId}</code>`,
        ].join('\n')
      );
      return;
    }

    if (text === '/help') {
      await sendTelegramMessage(
        chatId,
        [
          '<b>Формат /order</b>',
          '<code>/order 123456789 | Іван Петренко | +380501112233 | Київ | Відд. №5 | TSHIRT-M:1:450:Футболка</code>',
          '',
          'Кілька товарів: <code>SKU1:1:100:A; SKU2:2:50:B</code>',
          '',
          'SKU має збігатися з артикулом у KeyCRM — тоді CRM спише залишки.',
        ].join('\n')
      );
      return;
    }

    if (!/^\/order(@\w+)?(\s|$)/i.test(text)) {
      return; // ігноруємо інші повідомлення
    }

    // Доступ лише менеджерам (якщо список заданий)
    if (config.managerIds.length && !config.managerIds.includes(Number(fromId))) {
      await sendTelegramMessage(chatId, '⛔ Немає прав на створення замовлень.');
      return;
    }

    const replyFrom =
      message.reply_to_message?.from?.id && !message.reply_to_message.from.is_bot
        ? message.reply_to_message.from.id
        : message.reply_to_message?.chat?.id || null;

    let parsed;
    try {
      parsed = parseOrderCommand(text, replyFrom);
    } catch (parseErr) {
      await sendTelegramMessage(chatId, `⚠️ ${parseErr.message}`);
      return;
    }

    const payload = buildKeyCrmPayload(parsed, fromId);
    console.log('[keycrm] create order payload:', JSON.stringify(payload, null, 2));

    let created;
    try {
      created = await createKeyCrmOrder(payload);
    } catch (apiErr) {
      console.error('[keycrm] create failed:', apiErr.message, apiErr.body);
      await sendTelegramMessage(
        chatId,
        `❌ KeyCRM не прийняла замовлення:\n<code>${escapeHtml(apiErr.message.slice(0, 400))}</code>`
      );
      return;
    }

    const orderId = created?.id ?? created?.data?.id ?? null;
    if (orderId != null) {
      saveOrderLink(orderId, {
        chatId: parsed.clientChatId,
        phone: parsed.phone,
        fullName: parsed.fullName,
      });
    }

    await sendTelegramMessage(
      chatId,
      [
        '✅ <b>Замовлення створено в KeyCRM</b>',
        orderId != null ? `ID: <code>${orderId}</code>` : '',
        `Клієнт: ${escapeHtml(parsed.fullName)}`,
        `Тел: ${escapeHtml(parsed.phone)}`,
        `Доставка: ${escapeHtml(parsed.city)}, ${escapeHtml(parsed.warehouse)}`,
        `Товарів: ${parsed.products.length}`,
        '',
        'Коли в CRM натиснете «Створити ТТН», клієнт отримає повідомлення з номером.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (err) {
    console.error('[telegram] handler error:', err);
  }
});

/**
 * KeyCRM webhook
 * Налаштування в KeyCRM: Settings → Webhooks / Automations → URL:
 *   https://YOUR_HOST/webhooks/keycrm?secret=YOUR_SECRET
 * Події: зміна замовлення / додавання tracking (order.change тощо).
 */
app.post('/webhooks/keycrm', async (req, res) => {
  // CRM теж любить швидкий 2xx
  res.status(200).json({ ok: true });

  try {
    if (config.keycrmWebhookSecret) {
      const q = req.query.secret;
      const header = req.get('X-Webhook-Secret') || req.get('X-Keycrm-Secret');
      if (q !== config.keycrmWebhookSecret && header !== config.keycrmWebhookSecret) {
        console.warn('[keycrm-webhook] unauthorized');
        return;
      }
    }

    const body = req.body || {};
    console.log('[keycrm-webhook] payload:', JSON.stringify(body).slice(0, 2000));

    const extracted = extractFromKeyCrmWebhook(body);
    if (!extracted.trackingCode) {
      console.log('[keycrm-webhook] no tracking_code — skip');
      return;
    }

    let link = null;
    if (extracted.orderId && ordersMap.has(String(extracted.orderId))) {
      link = { orderId: String(extracted.orderId), ...ordersMap.get(String(extracted.orderId)) };
    } else if (extracted.phone) {
      link = findOrderByPhone(extracted.phone);
    }

    if (!link?.chatId) {
      console.warn(
        '[keycrm-webhook] no telegram mapping for order',
        extracted.orderId,
        extracted.phone
      );
      return;
    }

    // Анти-дубль: один TTN — одне повідомлення
    const row = ordersMap.get(String(link.orderId || extracted.orderId)) || link;
    if (!row.notifiedTtns) row.notifiedTtns = new Set();
    if (row.notifiedTtns.has(extracted.trackingCode)) {
      console.log('[keycrm-webhook] already notified for', extracted.trackingCode);
      return;
    }

    const ttn = extracted.trackingCode;
    const trackUrl = `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}`;
    const clientText = [
      '📦 <b>Ваш заказ оформлен.</b>',
      `ТТН: <code>${escapeHtml(ttn)}</code>`,
      '',
      `Відстежити: ${trackUrl}`,
    ].join('\n');

    const sent = await sendTelegramMessage(link.chatId, clientText);
    if (sent) {
      row.notifiedTtns.add(ttn);
      if (link.orderId || extracted.orderId) {
        ordersMap.set(String(link.orderId || extracted.orderId), {
          chatId: link.chatId,
          phone: link.phone || extracted.phone,
          fullName: link.fullName || extracted.fullName,
          notifiedTtns: row.notifiedTtns,
        });
        persistOrdersMap();
      }
      console.log('[keycrm-webhook] notified chat', link.chatId, 'ttn', ttn);
    }
  } catch (err) {
    console.error('[keycrm-webhook] handler error:', err);
  }
});

// Debug: ручна перевірка маппінгу (захистіть у проді або вимкніть)
app.get('/debug/orders-map', (req, res) => {
  if (config.keycrmWebhookSecret && req.query.secret !== config.keycrmWebhookSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const out = {};
  for (const [id, row] of ordersMap.entries()) {
    out[id] = {
      chatId: row.chatId,
      phone: row.phone,
      fullName: row.fullName,
      notifiedTtns: [...(row.notifiedTtns || [])],
    };
  }
  res.json(out);
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

assertConfig();
loadOrdersMap();

app.listen(config.port, () => {
  console.log(`Listening on :${config.port}`);
  if (config.publicBaseUrl) {
    console.log(`Telegram webhook URL: ${config.publicBaseUrl}/webhooks/telegram`);
    console.log(
      `KeyCRM webhook URL:   ${config.publicBaseUrl}/webhooks/keycrm?secret=${config.keycrmWebhookSecret || 'YOUR_SECRET'}`
    );
  }
});

// Не валимо процес на необроблених помилках мережі
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
