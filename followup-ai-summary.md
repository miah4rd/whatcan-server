# FollowUp AI — техническое резюме проекта

## Что это
AI-копилот для брокеров по недвижимости Unicorn Property (Бали). Состоит из:
- **API-сервер** (`artifacts/api-server`) — Express 5, Node 24, TypeScript
- **Chrome-расширение** (ZIP-файл в корне репо, текущий: `copilot-extension-v64.zip`) — overlay поверх `unicornproperty.amocrm.ru`
- **Landing** (`artifacts/landing`) — дашборд аналитики

## Прод URL
`https://what-can-info13961.replit.app`

## Стек
- PostgreSQL + Drizzle ORM (база в Replit)
- amoCRM API (токен в `AMOCRM_LONG_LIVED_TOKEN`) для синка лидов и задач
- OpenAI API для генерации сообщений

## Брокеры
Сейчас: **Robert** и **Amelia** (поле `responsible_user` в amoCRM). Расширение позволяет выбрать брокера внутри — лиды и inbox фильтруются по выбору.

## Ключевые файлы
| Файл | Назначение |
|---|---|
| `lib/db/src/schema/copilot.ts` | Схема БД (все таблицы) |
| `artifacts/api-server/src/lib/amo-sync.ts` | Синк лидов из amoCRM (Pass 1 = task-driven, Pass 2 = REACH) |
| `artifacts/api-server/src/lib/followup-scheduler.ts` | Планировщик: генерирует push-подсказки каждые 5 мин |
| `artifacts/api-server/src/lib/followup-templates.ts` | Шаблонные сообщения (Touch 0–3), плейсхолдеры `[Name]`, `[BrokerName]` |
| `artifacts/api-server/src/routes/public/suggestions.ts` | GET /suggestions — отдаёт inbox расширению |
| `artifacts/api-server/src/lib/stage-routing.ts` | PUSH_STAGE_WHITELIST, маршрутизация стейджей |
| `artifacts/api-server/src/routes/amocrm-webhook.ts` | Вебхук от amoCRM (смена стейджа, ответственного) |

## Логика PUSH-таба
- Стейджи: **Contact Established, Needs Assessed, Options Sent** (не REACH)
- Фильтр: лиды за последние 3 месяца, Robert + Unicorn
- Сортировка: сегодняшние задачи → просроченные по возрастанию → без задачи
- `nextFollowupAt` = now (сегодня), actualTaskDate (overdue), null (нет / старше 3 мес)
- Stale guard в scheduler **удалён** — overdue лиды тоже обрабатываются

## Логика REACH-таба
- Стейджи: **1st / 2nd / Final Follow Up**
- `nextFollowupAt` всегда = now (немедленно в scheduler)
- Шаблонные сообщения без AI, строгая последовательность Touch 1 → 2 → 3

## Admin эндпоинты (только POST)
- `/api/admin/sync-tasks` — пересчёт nextFollowupAt из amoCRM (запускать после каждого деплоя)
- `/api/admin/run-scheduler` — ручной запуск scheduler
- `/api/admin/clean-stale-pushes` — очистка устаревших push
- **НЕ вызывать** `/api/admin/refresh-push` — создаёт массовые дубли

## Расширение (Chrome Extension)
- `brokerName` хранится в `chrome.storage.local`
- Переключатель Robert / Amelia в шапке панели (выпадающий список)
- `/api/suggestions?responsibleUser=Robert` — фильтр inbox по брокеру
- Системный промпт динамический: `[BROKER_NAME]` заменяется на имя выбранного брокера
- Скачать актуальный ZIP: `/api/download/extension` (сервер отдаёт максимальный номер версии)

## Важные особенности и правила
- Все логи на сервере только через `req.log` / `logger` (не `console.log`)
- После любого деплоя вызывать POST `/api/admin/sync-tasks`
- `executeSql` в Replit → только dev БД; для состояния прода — curl к prod URL
- `amoCreatedAt` есть в schema `leadsSyncTable` (нужен для 3-месячного фильтра)
- amoCRM userMap динамический (fetchUserMap из API) — новые брокеры подхватываются автоматически

## Env-переменные (секреты в Replit)
| Переменная | Назначение |
|---|---|
| `AMOCRM_CLIENT_ID` | ID OAuth-приложения amoCRM |
| `AMOCRM_LONG_LIVED_TOKEN` | Долгоживущий токен доступа к amoCRM |
| `OPENAI_API_KEY` | OpenAI для генерации сообщений |
| `SESSION_SECRET` | Секрет сессий Express |
| `DATABASE_URL` | PostgreSQL connection string |

## Текущее состояние (на момент создания резюме — 18 июля 2026)
- Dev содержит изменения для Амелии (broker selector в расширении, динамические шаблоны), которые ещё не задеплоены в прод
- Последний прод-деплой: фикс PUSH-сортировки (сегодня → overdue → без задачи) + удаление stale guard из scheduler
