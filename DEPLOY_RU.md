# Покроковий деплой (GitHub + Render) — простою мовою

## Що ми робимо і навіщо

1. **GitHub** — хмарна «папка» з кодом (без секретів).
2. **Render** — безкоштовний сервер, який 24/7 запускає твій `app.js` і дає URL `https://….onrender.com`.
3. На Render вводимо **секрети** (токени) вручну — вони **не** лежать у GitHub.

`.env` на комп’ютері **ніколи** не заливаємо в GitHub. У репозиторій потрапляє лише `.env.example` (порожній шаблон).

---

## ЧАСТИНА A — GitHub (5–10 хвилин)

### A1. Акаунт
1. Відкрий https://github.com  
2. Увійди або зареєструйся.

### A2. Новий репозиторій
1. Кнопка **+** (зверху справа) → **New repository**  
2. **Repository name:** `telegram-keycrm-bridge` (або будь-яка назва)  
3. **Public**  
4. **НЕ** став галочки «Add README / .gitignore / license» (код уже є локально)  
5. **Create repository**

### A3. Залити код з твого ПК

Відкрий **PowerShell** і виконай (підстав свій логін GitHub замість `ТВІЙ_ЛОГІН`):

```powershell
$env:Path = "C:\Program Files\Git\cmd;" + $env:Path
cd D:\Basic_tekstil_example2

git branch -M main
git remote add origin https://github.com/ТВІЙ_ЛОГІН/telegram-keycrm-bridge.git
git push -u origin main
```

GitHub попросить увійти (браузер або Personal Access Token).

**Перевірка:** на сторінці репозиторію мають бути файли `app.js`, `package.json`, `README.md`.  
Файлу **`.env` НЕ повинно бути** — це правильно.

---

## ЧАСТИНА B — Render (10 хвилин)

### B1. Акаунт
1. https://render.com → **Get Started**  
2. Увійди через **GitHub** (найпростіше) і дозволь доступ до репозиторіїв.

### B2. Створити Web Service
1. **Dashboard** → **New +** → **Web Service**  
2. Підключи репозиторій `telegram-keycrm-bridge` → **Connect**  
3. Заповни:

| Поле | Що вписати |
|------|------------|
| Name | `telegram-keycrm-bridge` (Render зробить URL з цієї назви) |
| Region | Frankfurt (або будь-який EU) |
| Branch | `main` |
| Runtime | **Node** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

4. Поки **не** тисни Create — спочатку Environment.

### B3. Environment Variables (секрети)

На тій же сторінці секція **Environment** → **Add Environment Variable** — додай **по одній**:

| Key | Value |
|-----|--------|
| `TELEGRAM_BOT_TOKEN` | токен від BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | `tg_wh_sec_change_me_9f2a` |
| `MANAGER_TELEGRAM_IDS` | `7563290520` |
| `KEYCRM_API_TOKEN` | твій API ключ KeyCRM |
| `KEYCRM_API_BASE` | `https://openapi.keycrm.app/v1` |
| `KEYCRM_SOURCE_ID` | `1` |
| `KEYCRM_NOVA_POSHTA_SERVICE_ID` | `2` |
| `KEYCRM_WEBHOOK_SECRET` | `kcrm_wh_sec_change_me_7b1c` |

`PUBLIC_BASE_URL` поки **не** додавай — URL з’явиться після деплою.

5. **Create Web Service**

Чекай 2–5 хвилин, поки статус стане **Live**.

### B4. Скопіюй URL сервісу

Зверху на сторінці сервісу буде посилання на кшталт:

`https://telegram-keycrm-bridge-xxxx.onrender.com`

1. Відкрий його в браузері — має бути JSON: `{"ok":true,...}`  
2. У Render → **Environment** → додай:

| Key | Value |
|-----|--------|
| `PUBLIC_BASE_URL` | `https://telegram-keycrm-bridge-xxxx.onrender.com` (твій реальний URL, **без** `/` в кінці) |

3. Збережи — сервіс перезапуститься.

---

## ЧАСТИНА C — Підключити Telegram і KeyCRM

### C1. Telegram webhook

У PowerShell (підстав **свій** URL і токен бота):

```powershell
curl.exe -X POST "https://api.telegram.org/botСЮДИ_ТОКЕН/setWebhook" -H "Content-Type: application/json" -d "{\"url\":\"https://ТВІЙ.onrender.com/webhooks/telegram\",\"secret_token\":\"tg_wh_sec_change_me_9f2a\",\"allowed_updates\":[\"message\"]}"
```

Очікувана відповідь: `"ok":true`

Напиши боту в Telegram: `/start` — має відповісти інструкцією.

### C2. KeyCRM webhook

У KeyCRM (Налаштування → Webhooks / Автоматизації):

```
https://ТВІЙ.onrender.com/webhooks/keycrm?secret=kcrm_wh_sec_change_me_7b1c
```

Подія: зміна замовлення / поява ТТН.

---

## Тест «як обіцяв»

1. Клієнт пише боту `/start`  
2. Ти (id `7563290520`) шлеш:

```text
/order CHAT_ID_КЛІЄНТА | ПІБ | +380... | Місто | Відділення | SKU:1:100:Назва
```

3. У KeyCRM з’являється замовлення  
4. У CRM «Створити ТТН»  
5. Клієнт отримує повідомлення з ТТН  

---

## Якщо щось не працює

| Симптом | Що перевірити |
|---------|----------------|
| Render Build failed | Логи Build — чи є `package.json` у репо |
| `/start` мовчить | `setWebhook`, чи сервіс Live, логи Render |
| KeyCRM 401 | `KEYCRM_API_TOKEN` у Environment |
| Немає замовлення | формат `/order`, твій id у `MANAGER_TELEGRAM_IDS` |
| Немає ТТН клієнту | webhook KeyCRM, чи був `chat_id` при `/order` |

Free Render «засинає» ~15 хв — перший запит може йти 30–60 сек. Для стабільності можна пінгувати `https://ТВІЙ.onrender.com/health` раз на 10 хв (UptimeRobot).
