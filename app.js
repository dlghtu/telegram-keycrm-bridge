/**
 * KeyCRM companion service (optional)
 *
 * Основний робочий процес клієнта — УСЕ в KeyCRM:
 *   Telegram-бот → канал KeyCRM (чати)
 *   Замовлення → з чату / картки в CRM
 *   ТТН → кнопка «Створити ТТН» (Нова Пошта в CRM)
 *
 * Цей мікросервіс — допоміжний:
 *   POST /webhooks/keycrm  — коли в CRM з’явився tracking_code,
 *                            надіслати клієнту ТТН у Telegram (якщо
 *                            у джерелі вимкнено send_tracking_code).
 *
 * Вхідні повідомлення Telegram ОБРОБЛЯЄ KeyCRM (webhook бота вже на
 * messaging.keycrm.app). Не став setWebhook на цей сервіс — зламаєш чати в CRM.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');

const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  keycrmToken: process.env.KEYCRM_API_TOKEN || '',
  keycrmBase: (process.env.KEYCRM_API_BASE || 'https://openapi.keycrm.app/v1').replace(/\/$/, ''),
  keycrmWebhookSecret: process.env.KEYCRM_WEBHOOK_SECRET || '',
  ordersMapFile: process.env.ORDERS_MAP_FILE || '',
};

// orderId / phone → { chatId, notifiedTtns }
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
        notifiedTtns: new Set(row.notifiedTtns || []),
      });
    }
    console.log(`[orders-map] loaded ${ordersMap.size}`);
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
        notifiedTtns: [...(row.notifiedTtns || [])],
      };
    }
    fs.writeFileSync(full, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[orders-map] persist failed:', err.message);
  }
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('380')) return digits;
  if (digits.length === 10 && digits.startsWith('0')) return `38${digits}`;
  if (digits.length === 9) return `380${digits}`;
  return digits;
}

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
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function sendTelegramMessage(chatId, text) {
  if (!config.telegramToken || !chatId) return null;
  try {
    return await httpJson(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err.message);
    return null;
  }
}

/** Дістає order id з CRM і telegram chat_id з buyer / custom fields / коментаря */
async function fetchOrderDetails(orderId) {
  if (!config.keycrmToken || !orderId) return null;
  try {
    const q = new URLSearchParams({
      include: 'buyer,shipping,custom_fields',
    });
    return await httpJson(`${config.keycrmBase}/order/${orderId}?${q}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.keycrmToken}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error('[keycrm] get order failed:', err.message);
    return null;
  }
}

function extractFromKeyCrmWebhook(body) {
  const root = body?.context || body?.data || body?.order || body || {};
  const shipping = root.shipping || body?.shipping || root.delivery || {};

  const trackingCode =
    shipping.tracking_code ||
    shipping.trackingCode ||
    root.tracking_code ||
    body?.tracking_code ||
    root.shipping?.lastHistory?.tracking_code ||
    null;

  const orderId =
    root.id ?? root.order_id ?? body?.order_id ?? body?.id ?? body?.context?.id ?? null;

  const phone =
    root.buyer?.phone ||
    root.client?.phone ||
    shipping.recipient_phone ||
    body?.buyer?.phone ||
    null;

  // chat_id можна зберегти в manager_comment: "tg_chat_id:123456"
  const comment = String(root.manager_comment || body?.manager_comment || '');
  const chatFromComment = comment.match(/tg_chat_id\s*[:=]\s*(-?\d+)/i);

  return {
    orderId: orderId != null ? String(orderId) : null,
    trackingCode: trackingCode || null,
    phone,
    chatIdFromComment: chatFromComment ? chatFromComment[1] : null,
    event: body?.event || body?.type || body?.action || null,
  };
}

function pickChatId(order, extracted) {
  if (extracted.chatIdFromComment) return extracted.chatIdFromComment;

  // custom field telegram_chat_id / tg_chat_id
  const fields = order?.custom_fields || order?.customFields || [];
  if (Array.isArray(fields)) {
    for (const f of fields) {
      const name = String(f.name || f.uuid || f.key || '').toLowerCase();
      if (name.includes('telegram') || name.includes('tg_chat') || name.includes('chat_id')) {
        if (f.value != null && String(f.value).trim()) return String(f.value).trim();
      }
    }
  }

  if (extracted.orderId && ordersMap.has(extracted.orderId)) {
    return ordersMap.get(extracted.orderId).chatId;
  }

  if (extracted.phone) {
    const n = normalizePhone(extracted.phone);
    for (const row of ordersMap.values()) {
      if (row.phone && normalizePhone(row.phone) === n) return row.chatId;
    }
  }

  // buyer.username rarely has chat id; skip
  return null;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'keycrm-companion',
    mode: 'keycrm-first',
    hint: 'Чати і ТТН — в KeyCRM. Цей сервіс лише шле клієнту ТТН по webhook CRM (опційно).',
    time: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

/**
 * Webhook KeyCRM: зміна замовлення / поява ТТН
 * URL: https://YOUR.onrender.com/webhooks/keycrm?secret=...
 */
app.post('/webhooks/keycrm', async (req, res) => {
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
    console.log('[keycrm-webhook]', JSON.stringify(body).slice(0, 1500));

    let extracted = extractFromKeyCrmWebhook(body);

    // Якщо в payload немає tracking — підтягнемо замовлення з API
    let order = null;
    if (extracted.orderId && (!extracted.trackingCode || !extracted.phone)) {
      order = await fetchOrderDetails(extracted.orderId);
      if (order) {
        const fromApi = extractFromKeyCrmWebhook(order);
        extracted = {
          ...extracted,
          trackingCode: extracted.trackingCode || fromApi.trackingCode,
          phone: extracted.phone || fromApi.phone || order.buyer?.phone,
          chatIdFromComment: extracted.chatIdFromComment || fromApi.chatIdFromComment,
        };
      }
    }

    if (!extracted.trackingCode) {
      console.log('[keycrm-webhook] no tracking_code — skip');
      return;
    }

    const chatId = pickChatId(order, extracted);
    if (!chatId) {
      console.warn(
        '[keycrm-webhook] no telegram chat_id for order',
        extracted.orderId,
        '— увімкніть send_tracking_code у джерелі CRM або додайте custom field / tg_chat_id у коментар'
      );
      return;
    }

    const key = extracted.orderId || `phone:${normalizePhone(extracted.phone || '')}`;
    const prev = ordersMap.get(key) || { chatId, phone: extracted.phone, notifiedTtns: new Set() };
    if (!prev.notifiedTtns) prev.notifiedTtns = new Set();
    if (prev.notifiedTtns.has(extracted.trackingCode)) {
      console.log('[keycrm-webhook] already sent', extracted.trackingCode);
      return;
    }

    const ttn = extracted.trackingCode;
    const trackUrl = `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}`;
    const text = [
      '📦 <b>Ваш заказ оформлен.</b>',
      `ТТН: <code>${escapeHtml(ttn)}</code>`,
      '',
      `Відстежити: ${trackUrl}`,
    ].join('\n');

    const sent = await sendTelegramMessage(chatId, text);
    if (sent) {
      prev.notifiedTtns.add(ttn);
      prev.chatId = chatId;
      prev.phone = extracted.phone || prev.phone;
      ordersMap.set(key, prev);
      persistOrdersMap();
      console.log('[keycrm-webhook] notified', chatId, ttn);
    }
  } catch (err) {
    console.error('[keycrm-webhook] error:', err);
  }
});

/**
 * Реєстрація chat_id (для тестів / ручного зв’язування)
 * POST /map { "orderId": 123, "chatId": 456, "phone": "+380..." }
 */
app.post('/map', (req, res) => {
  if (config.keycrmWebhookSecret) {
    const secret = req.query.secret || req.get('X-Webhook-Secret');
    if (secret !== config.keycrmWebhookSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }
  const { orderId, chatId, phone } = req.body || {};
  if (!orderId || !chatId) {
    return res.status(400).json({ error: 'orderId and chatId required' });
  }
  ordersMap.set(String(orderId), {
    chatId: String(chatId),
    phone: phone || '',
    notifiedTtns: new Set(),
  });
  persistOrdersMap();
  res.json({ ok: true });
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

loadOrdersMap();

app.listen(config.port, () => {
  console.log(`keycrm-companion listening on :${config.port}`);
  console.log('Mode: KeyCRM-first (чати/ТТН в CRM). Do NOT set Telegram webhook here.');
  if (config.publicBaseUrl) {
    console.log(
      `KeyCRM webhook: ${config.publicBaseUrl}/webhooks/keycrm?secret=${config.keycrmWebhookSecret || 'SECRET'}`
    );
  }
});

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
