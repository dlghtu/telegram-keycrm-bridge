/**
 * KeyCRM companion — менеджер вносить дані 1 раз, клієнт майже нічого не заповнює.
 *
 * Потік:
 *  1) Клієнт спілкується в Telegram → чат у KeyCRM
 *  2) Менеджер відкриває швидку форму /m (на телефоні/ПК)
 *  3) За 20–30 сек вбиває те, що вже дізнався з чату → замовлення в KeyCRM
 *  4) Кнопка «Створити ТТН» у CRM
 *
 * Опційно клієнт лише тапає «Підтверджую» за готовим посиланням (0 полів).
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
  managerSecret:
    process.env.MANAGER_FORM_SECRET ||
    process.env.KEYCRM_WEBHOOK_SECRET ||
    'change_me',
  ordersMapFile: process.env.ORDERS_MAP_FILE || '',
  shopName: process.env.SHOP_NAME || 'Магазин',
};

const ordersMap = new Map();
/** draftId → order draft for one-tap client confirm */
const drafts = new Map();

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
    console.error('[orders-map]', err.message);
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
    console.error('[orders-map] save', err.message);
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

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function requireManager(req, res) {
  const secret =
    req.query.secret ||
    req.headers['x-manager-secret'] ||
    req.body?.secret ||
    '';
  if (secret !== config.managerSecret) {
    res.status(401).json({ error: 'Невірний secret. Відкрий /m?secret=...' });
    return false;
  }
  return true;
}

async function createKeyCrmOrder(data) {
  const fullName = String(data.full_name || '').trim();
  const phone = normalizePhone(data.phone);
  const city = String(data.city || '').trim();
  const warehouse = String(data.warehouse || '').trim();
  const productName = String(data.product_name || data.name || '').trim();
  const sku = String(data.sku || '').trim() || `MANUAL-${Date.now()}`;
  const quantity = Math.max(1, Number(data.quantity) || 1);
  const price = Number(data.price);
  const comment = String(data.comment || '').trim();
  const chatId = String(data.chat_id || data.chatId || '').trim();

  if (!fullName || !phone || !city || !warehouse || !productName) {
    const err = new Error('Потрібні: ПІБ, телефон, місто, відділення, товар');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(price) || price < 0) {
    const err = new Error('Невірна ціна');
    err.status = 400;
    throw err;
  }
  if (!config.keycrmToken) {
    const err = new Error('KEYCRM_API_TOKEN не задано');
    err.status = 500;
    throw err;
  }

  const payload = {
    source_id: config.keycrmSourceId,
    source_uuid: `mgr-${chatId || phoneDigits(phone)}-${Date.now()}`,
    buyer_comment: comment || undefined,
    manager_comment: [
      chatId ? `tg_chat_id:${chatId}` : null,
      'Швидке замовлення менеджера',
      `Місто: ${city}`,
      `НП: ${warehouse}`,
    ]
      .filter(Boolean)
      .join('\n'),
    buyer: { full_name: fullName, phone },
    shipping: {
      delivery_service_id: config.keycrmNovaPoshtaServiceId || undefined,
      shipping_service: 'Nova Poshta',
      shipping_address_city: city,
      shipping_address_country: 'UA',
      shipping_receive_point: warehouse,
      recipient_full_name: fullName,
      recipient_phone: phone,
    },
    products: [{ sku, name: productName, quantity, price, comment: comment || undefined }],
  };

  const created = await keycrmPost('/order', payload);
  const orderId = created?.id ?? created?.data?.id ?? null;

  if (orderId != null && chatId) {
    ordersMap.set(String(orderId), { chatId, phone, notifiedTtns: new Set() });
    persistOrdersMap();
  }

  return { orderId, payload, chatId };
}

// ---------------------------------------------------------------------------
// HTML: manager form (primary) + client confirm (one tap)
// ---------------------------------------------------------------------------

const CSS = `
:root { --bg:#0f1419; --card:#1a2332; --text:#e7ecf3; --muted:#8b9bb4; --acc:#3d8bfd; --ok:#3dd68c; --err:#ff6b6b; }
* { box-sizing:border-box; }
body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
.wrap { max-width:440px; margin:0 auto; padding:16px 14px 36px; }
h1 { font-size:1.2rem; margin:0 0 4px; }
.sub { color:var(--muted); font-size:.88rem; margin:0 0 14px; line-height:1.4; }
.card { background:var(--card); border:1px solid #243044; border-radius:14px; padding:14px; }
label { display:block; font-size:.72rem; color:var(--muted); margin:10px 0 4px; text-transform:uppercase; letter-spacing:.03em; }
input, textarea { width:100%; padding:11px 12px; border-radius:10px; border:1px solid #2a3548; background:#121a26; color:var(--text); font-size:16px; }
.row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
button, .btn { display:block; width:100%; margin-top:12px; padding:13px; border:0; border-radius:12px; background:var(--acc); color:#fff; font-weight:600; font-size:.95rem; cursor:pointer; text-align:center; text-decoration:none; }
button.sec { background:#2a3548; margin-top:8px; }
button:disabled { opacity:.55; }
.msg { margin-top:12px; padding:10px 12px; border-radius:10px; display:none; font-size:.9rem; line-height:1.4; word-break:break-word; }
.msg.ok { display:block; background:rgba(61,214,140,.12); color:var(--ok); }
.msg.err { display:block; background:rgba(255,107,107,.12); color:var(--err); }
.big { font-size:1.05rem; line-height:1.5; margin:12px 0; }
.muted { color:var(--muted); }
`;

function managerPage(secret) {
  const s = escapeHtml(secret);
  return `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Швидке замовлення</title><style>${CSS}</style>
</head><body><div class="wrap">
<h1>⚡ Швидке замовлення</h1>
<p class="sub">Клієнт лише спілкується в чаті. Ти вбиваєш дані <b>один раз</b> сюди → одразу KeyCRM. Без форм для клієнта.</p>
<div class="card">
<form id="f">
  <input type="hidden" name="secret" value="${s}"/>
  <label>ПІБ</label>
  <input name="full_name" required placeholder="Іван Петренко" autocomplete="name"/>
  <label>Телефон</label>
  <input name="phone" required type="tel" placeholder="0501112233" inputmode="tel"/>
  <div class="row">
    <div><label>Місто</label><input name="city" required placeholder="Київ"/></div>
    <div><label>Відд. НП</label><input name="warehouse" required placeholder="№5 / адреса"/></div>
  </div>
  <label>Товар</label>
  <input name="product_name" required placeholder="Футболка M чорна"/>
  <div class="row">
    <div><label>SKU</label><input name="sku" placeholder="опційно"/></div>
    <div><label>К-сть</label><input name="quantity" type="number" min="1" value="1"/></div>
  </div>
  <label>Ціна, грн</label>
  <input name="price" required type="number" min="0" step="1" placeholder="450" inputmode="numeric"/>
  <label>Telegram chat_id клієнта (для ТТН пізніше)</label>
  <input name="chat_id" placeholder="не обовʼязково" inputmode="numeric"/>
  <label>Коментар</label>
  <input name="comment" placeholder="розмір, колір…"/>
  <button type="submit" id="btn">Створити в KeyCRM</button>
  <button type="button" class="sec" id="btnDraft">Лише посилання «Підтвердити» клієнту</button>
  <div id="msg" class="msg"></div>
</form>
</div>
</div>
<script>
const form=document.getElementById('f');
const msg=document.getElementById('msg');
const btn=document.getElementById('btn');
function data(){return Object.fromEntries(new FormData(form).entries());}
function show(ok,t){msg.className='msg '+(ok?'ok':'err');msg.innerHTML=t;}
form.addEventListener('submit',async e=>{
  e.preventDefault(); btn.disabled=true; btn.textContent='Створюємо…';
  try{
    const r=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data(), mode:'create'})});
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||r.status);
    show(true,'✅ Замовлення в KeyCRM'+(j.orderId?' № <b>'+j.orderId+'</b>':'')+'. Відкрий CRM → Створити ТТН.');
  }catch(err){show(false,'❌ '+(err.message||'помилка'));}
  finally{btn.disabled=false;btn.textContent='Створити в KeyCRM';}
});
document.getElementById('btnDraft').onclick=async()=>{
  try{
    const r=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data(), mode:'draft'})});
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||r.status);
    show(true,'Посилання клієнту (1 тап, без полів):<br><a style="color:#7eb6ff" href="'+j.confirm_url+'">'+j.confirm_url+'</a><br>Кинь у чат KeyCRM.');
  }catch(err){show(false,'❌ '+(err.message||'помилка'));}
};
</script>
</body></html>`;
}

function confirmPage(draft) {
  const d = draft;
  return `<!DOCTYPE html>
<html lang="uk"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Підтвердження</title><style>${CSS}</style>
</head><body><div class="wrap">
<h1>Підтвердіть замовлення</h1>
<p class="sub">Нічого вводити не потрібно — лише перевірте і натисніть кнопку.</p>
<div class="card">
  <div class="big">
    <div><b>${escapeHtml(d.product_name)}</b> × ${escapeHtml(d.quantity)} — ${escapeHtml(d.price)} грн</div>
    <div class="muted" style="margin-top:10px">${escapeHtml(d.full_name)}</div>
    <div class="muted">${escapeHtml(d.phone)}</div>
    <div class="muted">${escapeHtml(d.city)}, ${escapeHtml(d.warehouse)}</div>
  </div>
  <button type="button" id="ok">Так, усе вірно</button>
  <p class="sub" style="margin-top:12px">Якщо помилка — просто напишіть менеджеру в чат.</p>
  <div id="msg" class="msg"></div>
</div>
</div>
<script>
document.getElementById('ok').onclick=async()=>{
  const btn=document.getElementById('ok'); const msg=document.getElementById('msg');
  btn.disabled=true; btn.textContent='…';
  try{
    const r=await fetch('/api/confirm/${escapeHtml(d.id)}',{method:'POST'});
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||r.status);
    msg.className='msg ok'; msg.textContent='✅ Готово! Менеджер оформить відправку.';
    btn.style.display='none';
  }catch(e){ msg.className='msg err'; msg.textContent='❌ '+(e.message||'помилка'); btn.disabled=false; btn.textContent='Так, усе вірно'; }
};
</script>
</body></html>`;
}

function loginPage() {
  return `<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Вхід</title><style>${CSS}</style></head><body><div class="wrap">
<h1>Менеджер</h1>
<p class="sub">Встав secret з Render (MANAGER_FORM_SECRET або KEYCRM_WEBHOOK_SECRET).</p>
<div class="card">
<form method="get" action="/m">
<label>Secret</label>
<input name="secret" required/>
<button type="submit">Відкрити форму</button>
</form>
</div></div></body></html>`;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'keycrm-companion',
    client_does: 'тільки спілкується (опційно 1 тап «Підтверджую»)',
    manager: '/m?secret=YOUR_SECRET — швидка форма → KeyCRM',
  });
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

/** Швидка форма менеджера */
app.get('/m', (req, res) => {
  const secret = String(req.query.secret || '');
  if (!secret) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(loginPage());
  }
  if (secret !== config.managerSecret) {
    return res.status(401).send('Невірний secret');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(managerPage(secret));
});

/** Стара /order — редірект на пояснення + confirm якщо draft */
app.get('/order', (req, res) => {
  if (req.query.d) {
    return res.redirect(`/c/${encodeURIComponent(req.query.d)}`);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Замовлення</title><style>${CSS}</style></head><body><div class="wrap">
<h1>Замовлення оформлює менеджер</h1>
<p class="sub">Вам нічого заповнювати. Напишіть менеджеру в чат — він усе зробить. Якщо надіслали посилання «підтвердити» — відкрийте його.</p>
</div></body></html>`);
});

/** One-tap confirm for client */
app.get('/c/:id', (req, res) => {
  const draft = drafts.get(req.params.id);
  if (!draft) {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(
      `<!DOCTYPE html><html lang="uk"><body style="font-family:system-ui;padding:24px;background:#0f1419;color:#e7ecf3">Посилання недійсне або вже використане. Напишіть менеджеру.</body></html>`
    );
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(confirmPage({ ...draft, id: req.params.id }));
});

app.post('/api/confirm/:id', async (req, res) => {
  try {
    const draft = drafts.get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Посилання недійсне' });
    const { orderId, chatId } = await createKeyCrmOrder(draft);
    drafts.delete(req.params.id);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `✅ Замовлення підтверджено${orderId != null ? ` (№ ${orderId})` : ''}. Очікуйте ТТН.`
      );
    }
    res.json({ ok: true, orderId });
  } catch (err) {
    console.error('[confirm]', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.secret !== config.managerSecret) {
      return res.status(401).json({ error: 'Невірний secret' });
    }

    const mode = body.mode || 'create';

    if (mode === 'draft') {
      // validate lightly
      const fullName = String(body.full_name || '').trim();
      const phone = normalizePhone(body.phone);
      const city = String(body.city || '').trim();
      const warehouse = String(body.warehouse || '').trim();
      const productName = String(body.product_name || '').trim();
      const price = Number(body.price);
      if (!fullName || !phone || !city || !warehouse || !productName || !Number.isFinite(price)) {
        return res.status(400).json({ error: 'Заповніть поля перед створенням посилання' });
      }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const draft = {
        full_name: fullName,
        phone,
        city,
        warehouse,
        product_name: productName,
        sku: String(body.sku || '').trim(),
        quantity: Math.max(1, Number(body.quantity) || 1),
        price,
        comment: String(body.comment || '').trim(),
        chat_id: String(body.chat_id || '').trim(),
        createdAt: Date.now(),
      };
      drafts.set(id, draft);
      // auto-expire 24h
      setTimeout(() => drafts.delete(id), 24 * 3600 * 1000).unref?.();

      const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      const confirm_url = `${base}/c/${id}`;
      return res.json({ ok: true, draft_id: id, confirm_url });
    }

    const { orderId, chatId } = await createKeyCrmOrder(body);
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `✅ Замовлення прийнято${orderId != null ? ` (№ ${orderId})` : ''}. Менеджер надішле ТТН.`
      );
    }
    res.json({ ok: true, orderId });
  } catch (err) {
    console.error('[order]', err.message, err.body);
    res.status(err.status || 502).json({ error: err.message || 'KeyCRM error' });
  }
});

// ---------------------------------------------------------------------------
// KeyCRM webhook → TTN
// ---------------------------------------------------------------------------

function extractFromKeyCrmWebhook(body) {
  const root = body?.context || body?.data || body?.order || body || {};
  const shipping = root.shipping || body?.shipping || {};
  const trackingCode =
    shipping.tracking_code || shipping.trackingCode || root.tracking_code || body?.tracking_code;
  const orderId = root.id ?? root.order_id ?? body?.order_id ?? body?.id ?? body?.context?.id;
  const phone = root.buyer?.phone || shipping.recipient_phone || body?.buyer?.phone;
  const comment = String(root.manager_comment || body?.manager_comment || '');
  const m = comment.match(/tg_chat_id\s*[:=]\s*(-?\d+)/i);
  return {
    orderId: orderId != null ? String(orderId) : null,
    trackingCode: trackingCode || null,
    phone,
    chatIdFromComment: m ? m[1] : null,
  };
}

app.post('/webhooks/keycrm', async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    if (config.keycrmWebhookSecret) {
      const q = req.query.secret;
      const header = req.get('X-Webhook-Secret');
      if (q !== config.keycrmWebhookSecret && header !== config.keycrmWebhookSecret) return;
    }
    let extracted = extractFromKeyCrmWebhook(req.body || {});
    if (extracted.orderId && !extracted.trackingCode) {
      try {
        const order = await keycrmGet(
          `/order/${extracted.orderId}?include=buyer,shipping`
        );
        const more = extractFromKeyCrmWebhook(order);
        extracted = {
          ...extracted,
          trackingCode: extracted.trackingCode || more.trackingCode,
          phone: extracted.phone || more.phone,
          chatIdFromComment: extracted.chatIdFromComment || more.chatIdFromComment,
        };
      } catch (_) {
        /* ignore */
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
    if (!chatId) return;

    const key = extracted.orderId || `p:${phoneDigits(extracted.phone || '')}`;
    const prev = ordersMap.get(key) || {
      chatId,
      phone: extracted.phone,
      notifiedTtns: new Set(),
    };
    if (!prev.notifiedTtns) prev.notifiedTtns = new Set();
    if (prev.notifiedTtns.has(extracted.trackingCode)) return;

    const ttn = extracted.trackingCode;
    const sent = await sendTelegramMessage(
      chatId,
      [
        '📦 <b>Ваш заказ оформлен.</b>',
        `ТТН: <code>${escapeHtml(ttn)}</code>`,
        `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}`,
      ].join('\n')
    );
    if (sent) {
      prev.notifiedTtns.add(ttn);
      prev.chatId = chatId;
      ordersMap.set(key, prev);
      persistOrdersMap();
    }
  } catch (err) {
    console.error('[keycrm-webhook]', err);
  }
});

loadOrdersMap();
app.listen(config.port, () => {
  console.log(`Listening :${config.port}`);
  console.log('Manager form: /m?secret=...');
  console.log('Client: only chat + optional one-tap /c/:id');
});

process.on('unhandledRejection', (r) => console.error(r));
process.on('uncaughtException', (e) => console.error(e));
