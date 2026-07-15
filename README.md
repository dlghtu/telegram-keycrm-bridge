# Telegram ↔ KeyCRM bridge (Express)

Легкий мікросервіс для інтернет-магазину:

1. Менеджер у Telegram шле `/order …` → сервіс створює замовлення в **KeyCRM**.
2. У KeyCRM менеджер натискає **«Створити ТТН»** (Нова Пошта інтегрована в CRM).
3. KeyCRM шле webhook → сервіс пише клієнту в Telegram: **«Ваш заказ оформлен. ТТН: …»**.

**Чому Node.js + Express:** один файл, мінімум залежностей, стабільний long-running процес на **Render free** (Vercel serverless гірше підходить для постійних вебхуків без cold start / таймаутів).

Офіційна документація KeyCRM: [docs.keycrm.app](https://docs.keycrm.app/)  
Base URL API: `https://openapi.keycrm.app/v1`  
Авторизація: `Authorization: Bearer <API_KEY>`

---

## Швидкий старт локально

```bash
npm install
cp .env.example .env
# заповніть .env
npm start
```

Для локальних вебхуків потрібен публічний HTTPS-тунель, наприклад [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

---

## Змінні оточення (`.env`)

| Змінна | Обовʼязково | Опис |
|--------|-------------|------|
| `PORT` | ні | Порт (Render підставить сам) |
| `PUBLIC_BASE_URL` | так (після деплою) | `https://xxx.onrender.com` |
| `TELEGRAM_BOT_TOKEN` | так | Токен від [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | рекомендується | Секрет `secret_token` для `setWebhook` |
| `MANAGER_TELEGRAM_IDS` | рекомендується | `111,222` — хто може `/order` |
| `KEYCRM_API_TOKEN` | так | API key з KeyCRM |
| `KEYCRM_API_BASE` | ні | default `https://openapi.keycrm.app/v1` |
| `KEYCRM_SOURCE_ID` | так | ID джерела замовлень |
| `KEYCRM_NOVA_POSHTA_SERVICE_ID` | ні | ID служби доставки НП у CRM |
| `KEYCRM_WEBHOOK_SECRET` | рекомендується | Секрет у query вебхука CRM |
| `ORDERS_MAP_FILE` | ні | Файл маппінгу order → chat_id |

### Як взяти `KEYCRM_SOURCE_ID`

```http
GET https://openapi.keycrm.app/v1/order/source
Authorization: Bearer YOUR_TOKEN
```

### Як взяти ID Нової Пошти

```http
GET https://openapi.keycrm.app/v1/order/delivery-service
Authorization: Bearer YOUR_TOKEN
```

---

## Роути

| Method | Path | Призначення |
|--------|------|-------------|
| `GET` | `/` , `/health` | Healthcheck |
| `POST` | `/webhooks/telegram` | Вхідні оновлення Telegram |
| `POST` | `/webhooks/keycrm?secret=…` | Вебхук KeyCRM (ТТН) |
| `GET` | `/debug/orders-map?secret=…` | Дивитись маппінг (debug) |

---

## Команда менеджера `/order`

```text
/order <chat_id> | <ПІБ> | <+телефон> | <місто> | <відділення НП> | <sku:qty:price:назва>
```

Приклад:

```text
/order 987654321 | Іван Петренко | +380501112233 | Київ | Відділення №5 (вул. Хрещатик) | TSHIRT-M:1:450:Футболка чорна M
```

Кілька товарів через `;`:

```text
... | TSHIRT-M:1:450:Футболка; SOCKS-L:2:120:Шкарпетки
```

**Або** reply на повідомлення клієнта — тоді `chat_id` можна не вказувати.

`chat_id` потрібен, щоб після створення ТТН бот міг написати **клієнту**, а не менеджеру.

---

## Payload KeyCRM: створення замовлення

`POST https://openapi.keycrm.app/v1/order`

```json
{
  "source_id": 1,
  "source_uuid": "tg-manager-1710000000000",
  "buyer_comment": "Замовлення з Telegram",
  "manager_comment": "TG client chat_id: 987654321\nМісто: Київ\nВідділення НП: Відділення №5",
  "buyer": {
    "full_name": "Іван Петренко",
    "phone": "+380501112233"
  },
  "shipping": {
    "delivery_service_id": 1,
    "shipping_service": "Nova Poshta",
    "shipping_address_city": "Київ",
    "shipping_address_country": "UA",
    "shipping_receive_point": "Відділення №5 (вул. Хрещатик)",
    "recipient_full_name": "Іван Петренко",
    "recipient_phone": "+380501112233"
  },
  "products": [
    {
      "sku": "TSHIRT-M",
      "quantity": 1,
      "price": 450,
      "name": "Футболка чорна M"
    },
    {
      "sku": "SOCKS-L",
      "quantity": 2,
      "price": 120,
      "name": "Шкарпетки"
    }
  ]
}
```

### Як KeyCRM списує залишки

- У масиві `products` головне поле — **`sku`** (артикул офера/варіанту з каталогу KeyCRM).
- Якщо `sku` **збігається** з товаром на складі, CRM прив’яже позицію до каталогу і **спише/зарезервує** `quantity` згідно налаштувань складу (резерв при створенні / списання при статусі «відправлено» тощо).
- Якщо `sku` **немає** в каталозі — позиція стане «разовою» (`name` + `price`), **залишки не зміняться**.
- `price` — ціна продажу в замовленні (може перевизначити каталожну).
- `quantity` — кількість до списання/резерву.

Мінімальний товар для списання:

```json
{
  "sku": "EXISTING-SKU-IN-CRM",
  "quantity": 1,
  "price": 450
}
```

Опційно можна передати `warehouse_ref` (UUID складу НП) у `shipping`, якщо працюєте з API НП через CRM:

```json
"shipping": {
  "delivery_service_id": 1,
  "warehouse_ref": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "shipping_address_city": "Київ",
  "shipping_receive_point": "Відділення №5"
}
```

---

## Приклад тіла вебхука KeyCRM (ТТН)

Фактична форма залежить від налаштувань CRM. Сервіс парсить гнучко. Типовий вигляд:

```json
{
  "event": "order.change",
  "context": {
    "id": 15234,
    "buyer": {
      "full_name": "Іван Петренко",
      "phone": "+380501112233"
    },
    "shipping": {
      "tracking_code": "20450123456789",
      "shipping_address_city": "Київ",
      "shipping_receive_point": "Відділення №5"
    }
  }
}
```

Після отримання `tracking_code` клієнт отримає:

```text
📦 Ваш заказ оформлен.
ТТН: 20450123456789

Відстежити: https://novaposhta.ua/tracking/?cargo_number=...
```

> **Нова Пошта API напряму** у цьому флоу **не обовʼязкова**: ТТН створює KeyCRM (кнопка в інтерфейсі). Мікросервіс лише ловить номер і шле в Telegram.

---

## Прив’язка вебхуків

### 1) Telegram

Після деплою (замініть URL і токен):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://YOUR-SERVICE.onrender.com/webhooks/telegram\",
    \"secret_token\": \"YOUR_TELEGRAM_WEBHOOK_SECRET\",
    \"allowed_updates\": [\"message\"]
  }"
```

Перевірка:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

### 2) KeyCRM

У KeyCRM → **Автоматизації / Webhooks**:

- URL: `https://YOUR-SERVICE.onrender.com/webhooks/keycrm?secret=YOUR_KEYCRM_WEBHOOK_SECRET`
- Події: зміна замовлення, оновлення доставки / tracking (залежить від UI CRM)
- Method: `POST`, JSON

---

## Деплой безкоштовно на Render

1. Завантажте код у **GitHub** (публічний або приватний репозиторій).
2. [render.com](https://render.com) → **New → Web Service** → підключіть репо.
3. Налаштування:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance:** Free
4. **Environment** → додайте всі змінні з `.env.example`.
5. Після деплою скопіюйте URL сервісу в `PUBLIC_BASE_URL`.
6. Викличте `setWebhook` (див. вище).
7. Налаштуйте webhook у KeyCRM.

### Важливо про free tier Render

- Сервіс **засинає** після ~15 хв без трафіку; перший запит будить його (cold start 30–60 с).
- Для «не засинав» можна пінгувати `/health` раз на 10–14 хв (UptimeRobot free).
- Файлова система **ефемерна**: маппінг `order → chat_id` на free tier краще тримати в зовнішній БД (Upstash Redis free) у продакшені; для MVP файл/`Map` достатньо, поки процес живий.

### Чому не Vercel

Vercel орієнтований на **serverless**: холодний старт, ліміти часу, немає інстанс-пам’яті для `Map`. Для webhook-bridge зручніше **Render / Railway / Fly.io**.

---

## Потік даних (схема)

```text
Менеджер ──/order──► Telegram ──webhook──► цей сервіс ──POST /order──► KeyCRM
                                                                    │
Клієнт ◄── «ТТН: …» ── Telegram API ◄── webhook ◄── KeyCRM (Створити ТТН / НП)
```

---

## Безпека (мінімум)

- Не комітьте `.env`.
- Обмежте `/order` через `MANAGER_TELEGRAM_IDS`.
- Ставте `TELEGRAM_WEBHOOK_SECRET` і `KEYCRM_WEBHOOK_SECRET`.
- У проді приберіть або захистіть `/debug/orders-map`.

---

## Ліцензія

MIT — використовуйте як шаблон під свій магазин.
