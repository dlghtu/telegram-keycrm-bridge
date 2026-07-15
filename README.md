# KeyCRM companion (Telegram + ТТН)

## Головне для бізнесу

**Уся робота менеджера — в KeyCRM**, не в окремому бот-скрипті:

1. **Чати** — Telegram-бот підключений у KeyCRM (Комунікації).
2. **Замовлення** — з чату / картки в CRM.
3. **ТТН** — кнопка в замовленні (Нова Пошта в KeyCRM).

Покрокова інструкція: **[KEYCRM_SETUP.md](./KEYCRM_SETUP.md)**

## Що робить цей сервіс (опційно)

`POST /webhooks/keycrm` — якщо CRM шле webhook про появу `tracking_code`, сервіс може написати клієнту в Telegram «Ваш заказ оформлен. ТТН: …».

**Не** став Telegram `setWebhook` на цей сервіс — чати в KeyCRM перестануть приходити.

## Deploy (Render)

- Build: `npm install`
- Start: `npm start`
- Live example: `https://telegram-keycrm-bridge.onrender.com`

### Env

Див. `.env.example`. Обов’язкові для companion: `TELEGRAM_BOT_TOKEN`, `KEYCRM_API_TOKEN`, `KEYCRM_WEBHOOK_SECRET`.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/`, `/health` | Healthcheck |
| POST | `/webhooks/keycrm?secret=` | TTN notify (optional) |
| POST | `/map?secret=` | Link orderId → telegram chatId |

## License

MIT
