/**
 * KeyCRM companion
 *
 * Проблема «вручну переносити дані» вирішується так:
 *  1) Менеджер у чаті KeyCRM кидає клієнту посилання на форму:
 *       https://YOUR.onrender.com/order?chat_id=TELEGRAM_CHAT_ID
 *  2) Клієнт сам заповнює ПІБ, телефон, місто, відділення, товар
 *  3) Сервіс створює замовлення в KeyCRM через API — менеджер НЕ перебиває
 *  4) У CRM: перевірити → «Створити ТТН» → (опційно) webhook шле ТТН клієнту
 *
 * Чати лишаються в KeyCRM (webhook бота на messaging.keycrm.app).
 * Цей сервіс НЕ перехоплює вхідні повідомлення Telegram.
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
  keycrmBase: (process.env.KEYCRM_API_BASE || 'https://openapi.keycrm.app/v1').replace(
    /\/$/,
    ''
  ),
  keycrmSourceId: Number(process.env.KEYCRM_SOURCE_ID) || 1,
  keycrmNovaPoshtaServiceId: process.env.KEYCRM_NOVA_POSHTA_SERVICE_ID
    ? Number(process.env.KEYCRM_NOVA_POSHTA_SERVICE_ID)
    : 2,
  keycrmWebhookSecret: process.env.KEYCRM_WEBHOOK_SECRET || '',
  ordersMapFile: process.env.ORDERS_MAP_FILE || '',
  shopName: process.env.SHOP_NAME || 'Магазин',
};

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
  } catch (err) {
    console.error('[orders-map] load:', err.message);
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
    console.error('[orders-map] save:', err.message);
  }
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('380')) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  if (digits.length === 9) return `+380${digits}`;
  if (String(phone || '').startsWith('+')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
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
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function keycrmPost(endpoint, body) {
  return httpJson(`${config.keycrmBase}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.keycrmToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function keycrmGet(endpoint) {
  return httpJson(`${config.keycrmBase}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.keycrmToken}`,
      Accept: 'application/json',
    },
  });
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
    console.error('[telegram]', err.message);
    return null;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Order form HTML (клієнт заповнює сам → API KeyCRM)
// ---------------------------------------------------------------------------

function orderFormPage({ chatId = '', prefill = {} } = {}) {
  const shop = escapeHtml(config.shopName);
  const cid = escapeHtml(chatId || '');
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>Оформлення замовлення — ${shop}</title>
  <style>
    :root { --bg:#0f1419; --card:#1a2332; --text:#e7ecf3; --muted:#8b9bb4; --acc:#3d8bfd; --ok:#3dd68c; --err:#ff6b6b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    .wrap { max-width:480px; margin:0 auto; padding:20px 16px 40px; }
    h1 { font-size:1.35rem; margin:0 0 6px; }
    p.sub { color:var(--muted); margin:0 0 20px; font-size:.95rem; line-height:1.4; }
    label { display:block; font-size:.8rem; color:var(--muted); margin:14px 0 6px; }
    input, textarea, select { width:100%; padding:12px 14px; border-radius:10px; border:1px solid #2a3548; background:#121a26; color:var(--text); font-size:16px; }
    input:focus, textarea:focus { outline:2px solid var(--acc); border-color:transparent; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    button { width:100%; margin-top:22px; padding:14px; border:0; border-radius:12px; background:var(--acc); color:#fff; font-weight:600; font-size:1rem; cursor:pointer; }
    button:disabled { opacity:.55; cursor:wait; }
    .msg { margin-top:16px; padding:12px 14px; border-radius:10px; display:none; line-height:1.45; }
    .msg.ok { display:block; background:rgba(61,214,140,.12); color:var(--ok); border:1px solid rgba(61,214,140,.35); }
    .msg.err { display:block; background:rgba(255,107,107,.12); color:var(--err); border:1px solid rgba(255,107,107,.35); }
    .hint { font-size:.75rem; color:var(--muted); margin-top:4px; }
    .card { background:var(--card); border-radius:16px; padding:18px 16px 22px; border:1px solid #243044; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>📦 Оформлення замовлення</h1>
    <p class="sub">${shop}. Заповніть дані один раз — менеджер отримає їх у CRM і створить ТТН.</p>
    <div class="card">
      <form id="f" autocomplete="on">
        <input type="hidden" name="chat_id" value="${cid}" />

        <label>ПІБ отримувача *</label>
        <input name="full_name" required placeholder="Іван Петренко" value="${escapeHtml(prefill.full_name || '')}" />

        <label>Телефон *</label>
        <input name="phone" required type="tel" inputmode="tel" placeholder="+380501112233" value="${escapeHtml(prefill.phone || '')}" />

        <label>Місто *</label>
        <input name="city" required placeholder="Київ" value="${escapeHtml(prefill.city || '')}" />

        <label>Відділення / поштомат Нової Пошти *</label>
        <input name="warehouse" required placeholder="Відділення №5, вул. …" value="${escapeHtml(prefill.warehouse || '')}" />

        <label>Товар (назва) *</label>
        <input name="product_name" required placeholder="Футболка чорна M" value="${escapeHtml(prefill.product_name || '')}" />

        <label>Артикул SKU (якщо знаєте)</label>
        <input name="sku" placeholder="TSHIRT-M" value="${escapeHtml(prefill.sku || '')}" />
        <p class="hint">Якщо SKU збігається з каталогом KeyCRM — спишуться залишки. Інакше менеджер підправить у CRM.</p>

        <div class="row">
          <div>
            <label>Кількість *</label>
            <input name="quantity" type="number" min="1" step="1" value="${escapeHtml(String(prefill.quantity || '1'))}" required />
          </div>
          <div>
            <label>Ціна, грн *</label>
            <input name="price" type="number" min="0" step="0.01" value="${escapeHtml(String(prefill.price || ''))}" required placeholder="450" />
          </div>
        </div>

        <label>Коментар</label>
        <textarea name="comment" rows="2" placeholder="Колір, розмір, побажання…">${escapeHtml(prefill.comment || '')}</textarea>

        <button type="submit" id="btn">Надіслати замовлення</button>
        <div id="msg" class="msg"></div>
      </form>
    </div>
  </div>
  <script>
    const form = document.getElementById('f');
    const btn = document.getElementById('btn');
    const msg = document.getElementById('msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg';
      msg.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Надсилаємо…';
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || ('Помилка ' + res.status));
        msg.className = 'msg ok';
        msg.innerHTML = '✅ Замовлення прийнято' + (json.orderId ? ' (№ <b>' + json.orderId + '</b>)' : '') +
          '.<br>Менеджер підтвердить і відправить ТТН у цей чат.';
        form.querySelectorAll('input:not([type=hidden]),textarea').forEach(el => { if (el.name !== 'quantity') el.value = el.name === 'quantity' ? '1' : ''; });
      } catch (err) {
        msg.className = 'msg err';
        msg.textContent = '❌ ' + (err.message || 'Не вдалося надіслати');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Надіслати замовлення';
      }
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'keycrm-companion',
    order_form: '/order',
    hint: 'Менеджер кидає клієнту /order?chat_id=... — клієнт заповнює сам, замовлення в KeyCRM.',
  });
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

/** Форма для клієнта */
app.get('/order', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(
    orderFormPage({
      chatId: String(req.query.chat_id || req.query.tg || ''),
      prefill: {
        full_name: req.query.name || '',
        phone: req.query.phone || '',
        product_name: req.query.product || '',
        sku: req.query.sku || '',
        price: req.query.price || '',
      },
    })
  );
});

/** Швидке посилання для менеджера (з chat_id) */
app.get('/link', (req, res) => {
  const chatId = String(req.query.chat_id || '').trim();
  if (!chatId) {
    return res.status(400).json({
      error: 'Додайте ?chat_id=TELEGRAM_ID',
      example: '/link?chat_id=123456789',
    });
  }
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/order?chat_id=${encodeURIComponent(chatId)}`;
  res.json({
    order_form_url: url,
    for_manager:
      'Скопіюй order_form_url і надішли клієнту в чаті KeyCRM. Після заповнення з’явиться замовлення в CRM.',
  });
});

/**
 * Створення замовлення в KeyCRM (з форми клієнта)
 * Списання залишків: передайте реальний sku з каталогу.
 */
app.post('/api/orders', async (req, res) => {
  try {
    if (!config.keycrmToken) {
      return res.status(500).json({ error: 'KEYCRM_API_TOKEN не налаштований на сервері' });
    }

    const body = req.body || {};
    const fullName = String(body.full_name || '').trim();
    const phone = normalizePhone(body.phone);
    const city = String(body.city || '').trim();
    const warehouse = String(body.warehouse || '').trim();
    const productName = String(body.product_name || body.name || '').trim();
    const sku = String(body.sku || '').trim() || `FORM-${Date.now()}`;
    const quantity = Math.max(1, Number(body.quantity) || 1);
    const price = Number(body.price);
    const comment = String(body.comment || '').trim();
    const chatId = String(body.chat_id || body.chatId || '').trim();

    if (!fullName || !phone || !city || !warehouse || !productName) {
      return res.status(400).json({ error: 'Заповніть ПІБ, телефон, місто, відділення і товар' });
    }
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Вкажіть коректну ціну' });
    }

    const payload = {
      source_id: config.keycrmSourceId,
      source_uuid: `webform-${chatId || phoneDigits(phone)}-${Date.now()}`,
      buyer_comment: comment || undefined,
      manager_comment: [
        chatId ? `tg_chat_id:${chatId}` : null,
        'Джерело: веб-форма замовлення (клієнт заповнив сам)',
        `Місто: ${city}`,
        `НП: ${warehouse}`,
      ]
        .filter(Boolean)
        .join('\n'),
      buyer: {
        full_name: fullName,
        phone,
      },
      shipping: {
        delivery_service_id: config.keycrmNovaPoshtaServiceId || undefined,
        shipping_service: 'Nova Poshta',
        shipping_address_city: city,
        shipping_address_country: 'UA',
        shipping_receive_point: warehouse,
        recipient_full_name: fullName,
        recipient_phone: phone,
      },
      products: [
        {
          sku,
          name: productName,
          quantity,
          price,
          comment: comment || undefined,
        },
      ],
    };

    console.log('[order] create', JSON.stringify(payload));
    const created = await keycrmPost('/order', payload);
    const orderId = created?.id ?? created?.data?.id ?? null;

    if (orderId != null && chatId) {
      ordersMap.set(String(orderId), {
        chatId,
        phone,
        notifiedTtns: new Set(),
      });
      persistOrdersMap();
    }

    // Підтвердження клієнту в Telegram (якщо знаємо chat_id)
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        [
          '✅ <b>Дякуємо!</b> Замовлення прийнято.',
          orderId != null ? `Номер у CRM: <code>${orderId}</code>` : '',
          'Менеджер перевірить і надішле ТТН Нової Пошти.',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    res.json({ ok: true, orderId, message: 'created' });
  } catch (err) {
    console.error('[order] failed:', err.message, err.body);
    res.status(502).json({
      error: 'KeyCRM не прийняла замовлення. Перевірте SKU/API або спробуйте пізніше.',
      detail: err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// KeyCRM webhook → TTN notify
// ---------------------------------------------------------------------------

function extractFromKeyCrmWebhook(body) {
  const root = body?.context || body?.data || body?.order || body || {};
  const shipping = root.shipping || body?.shipping || root.delivery || {};
  const trackingCode =
    shipping.tracking_code ||
    shipping.trackingCode ||
    root.tracking_code ||
    body?.tracking_code ||
    null;
  const orderId =
    root.id ?? root.order_id ?? body?.order_id ?? body?.id ?? body?.context?.id ?? null;
  const phone =
    root.buyer?.phone || shipping.recipient_phone || body?.buyer?.phone || null;
  const comment = String(root.manager_comment || body?.manager_comment || '');
  const chatFromComment = comment.match(/tg_chat_id\s*[:=]\s*(-?\d+)/i);
  return {
    orderId: orderId != null ? String(orderId) : null,
    trackingCode: trackingCode || null,
    phone,
    chatIdFromComment: chatFromComment ? chatFromComment[1] : null,
  };
}

app.post('/webhooks/keycrm', async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    if (config.keycrmWebhookSecret) {
      const q = req.query.secret;
      const header = req.get('X-Webhook-Secret');
      if (q !== config.keycrmWebhookSecret && header !== config.keycrmWebhookSecret) {
        console.warn('[keycrm-webhook] unauthorized');
        return;
      }
    }

    let extracted = extractFromKeyCrmWebhook(req.body || {});
    let order = null;

    if (extracted.orderId && !extracted.trackingCode) {
      try {
        order = await keycrmGet(
          `/order/${extracted.orderId}?include=buyer,shipping,custom_fields`
        );
        const more = extractFromKeyCrmWebhook(order);
        extracted = {
          ...extracted,
          trackingCode: extracted.trackingCode || more.trackingCode,
          phone: extracted.phone || more.phone || order?.buyer?.phone,
          chatIdFromComment: extracted.chatIdFromComment || more.chatIdFromComment,
        };
      } catch (e) {
        console.error('[keycrm-webhook] fetch order:', e.message);
      }
    }

    if (!extracted.trackingCode) return;

    let chatId = extracted.chatIdFromComment;
    if (!chatId && extracted.orderId && ordersMap.has(extracted.orderId)) {
      chatId = ordersMap.get(extracted.orderId).chatId;
    }
    if (!chatId && extracted.phone) {
      const n = phoneDigits(extracted.phone);
      for (const row of ordersMap.values()) {
        if (row.phone && phoneDigits(row.phone) === n) {
          chatId = row.chatId;
          break;
        }
      }
    }

    if (!chatId) {
      console.warn('[keycrm-webhook] no chat_id for', extracted.orderId);
      return;
    }

    const key = extracted.orderId || `p:${phoneDigits(extracted.phone || '')}`;
    const prev = ordersMap.get(key) || {
      chatId,
      phone: extracted.phone,
      notifiedTtns: new Set(),
    };
    if (!prev.notifiedTtns) prev.notifiedTtns = new Set();
    if (prev.notifiedTtns.has(extracted.trackingCode)) return;

    const ttn = extracted.trackingCode;
    const trackUrl = `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}`;
    const sent = await sendTelegramMessage(
      chatId,
      [
        '📦 <b>Ваш заказ оформлен.</b>',
        `ТТН: <code>${escapeHtml(ttn)}</code>`,
        '',
        `Відстежити: ${trackUrl}`,
      ].join('\n')
    );

    if (sent) {
      prev.notifiedTtns.add(ttn);
      prev.chatId = chatId;
      ordersMap.set(key, prev);
      persistOrdersMap();
      console.log('[keycrm-webhook] TTN sent', chatId, ttn);
    }
  } catch (err) {
    console.error('[keycrm-webhook]', err);
  }
});

loadOrdersMap();
app.listen(config.port, () => {
  console.log(`Listening :${config.port}`);
  console.log('Order form: /order?chat_id=TELEGRAM_ID');
  console.log('Do NOT set Telegram bot webhook to this server (KeyCRM owns chats).');
});

process.on('unhandledRejection', (r) => console.error(r));
process.on('uncaughtException', (e) => console.error(e));
