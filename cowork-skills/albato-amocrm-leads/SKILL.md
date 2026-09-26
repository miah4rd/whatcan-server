---
name: "albato-amocrm-leads"
description: "Диагностика и настройка цепочки Facebook Lead Ads → Albato → amoCRM для Unicorn Property. Хранит долгоживущий API-токен amoCRM. Использовать при ЛЮБОЙ задаче про пропавшие/некорректные лиды, связки Albato, воронки amoCRM, создание/чтение сделок и контактов, дедупликацию, квалификационные формы Meta."
---


# Facebook Lead Ads → Albato → amoCRM (Unicorn Property)

## Архитектура цепочки

```
Meta Instant Form (Lead Ad)
  └─ Albato bundle (3 шага)
       Step 1  Facebook: Lead Ad (Deprecated)   triggerActionId 23001
       Step 2  amoCRM: New contact (Deprecated) triggerActionId 16002
       Step 3  amoCRM: New lead                 triggerActionId 16004
            └─ amoCRM
```

Триггер **не webhook, а поллинг ~раз в 5 минут**. Лид появляется в CRM через 1–6 минут после отправки формы, не мгновенно. Это норма, не баг.

## Токен amoCRM (долгоживущий, scope crm, действует до 31.12.2029)

```
eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjQwZDdhZTNmMmM4ZjlmZGFhYjdlZTA0MDg1OThlNjkxNDk3ZThlMDUyZTVmMjQ1MjI4Mjk2ZjY1MzY5MmYzYmQ3YjM5N2FkNWVlYzE2ZjhjIn0.eyJhdWQiOiI4N2MzOTEwMi0xMDVjLTQ4OWMtOGZlMi02YjE1OGZjN2E2MDEiLCJqdGkiOiI0MGQ3YWUzZjJjOGY5ZmRhYWI3ZWUwNDA4NTk4ZTY5MTQ5N2U4ZTA1MmU1ZjI0NTIyODI5NmY2NTM2OTJmM2JkN2IzOTdhZDVlZWMxNmY4YyIsImlhdCI6MTc4NzcxMTI5NiwibmJmIjoxNzg3NzExMjk2LCJleHAiOjE4NzIyMDE2MDAsInN1YiI6IjExMjMwMzg2IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMxODMwODU0LCJiYXNlX2RvbWFpbiI6ImFtb2NybS5ydSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iXSwiaGFzaF91dWlkIjoiMjJhNDVjMTktZWQxMi00OTMwLWJkZDktZmQxZTNiOGJjNmNjIiwiYXBpX2RvbWFpbiI6ImFwaS1iLmFtb2NybS5ydSJ9.SlFyY8oLI7IJ1ywH_k4LaRQFFx43U3pmed0vpYiBACrvHbd-HAl9G-nO_sY5ERPUheN96nSbnlaW5LNJlngZnutRdj726AWxXmpXhEk5HdaOs3116erelcsaHdf7lLjfel_qaiHyIUzMnKb5NzH-Jor4VxRbUA3gOPLBa_ximb0Z2y52xtvUFpNvliKumwY8ws2mhstM0uvAQcLzXT49ypK-0e9jb3NW1xipfrHQ_mApioKDV470pCoh68AbCinLhj2JxjU9M5rh9qTIhBf1o_QZ_VOG_PRiFsmVNbbXf4smNGGGdSgWl6EeXtJry1vawO3ASlNfBv3nGys39qgIuQ
```

- Хост API: `https://api-b.amocrm.ru`, версия `/api/v4/`
- Авторизация: заголовок `Authorization: Bearer <токен>`
- account_id `31830854`, пользователь `11230386`, домен `unicornproperty.amocrm.ru`
- Запросы выполнять через `javascript_tool` из вкладки браузера (у песочницы агента нет исходящей сети).
  Токен передавать переменной и в заголовке, **не** в query-параметрах URL — иначе режется фильтром инструмента.

Если токен перестанет работать (401 / `Unauthorised`) — попросить у пользователя новый и заменить эту секцию через `save_skill` с `overwrite: true`.

## Ключевые ID

| Объект | ID |
|---|---|
| amoCRM воронка **Rental** | `11119150` |
| Rental → этап **New LEAD** | `87301078` |
| Воронка UNICORN (продажа/инвестиции) | `8347534` |
| Воронка Rental Listings | `11180334` |
| Rental → Closed-lost | `143` |
| Рекламный кабинет Meta | `778356744500892` |
| FB-страница Monthly/Yearly Properties | `321159424422341` |

Связки в Albato называются по коду листинга: `R-AME-031`, `R-YUD-048` и т.д. Связки с суффиксом ` Q` (`R-AME-031 Q`) — это версии под формы с квалификационными вопросами.

## Создание лида вручную (когда связка не сработала)

Порядок: сначала контакт, потом сделка, потом привязка, потом примечание.

```js
const T = "<токен из секции выше>";
const H = {"Authorization":"Bearer "+T, "Content-Type":"application/json"};
const API = "https://api-b.amocrm.ru/api/v4";

// 1. Проверить дубль по телефону (без плюса и разделителей)
const dup = await (await fetch(`${API}/contacts?query=6285958925071`, {headers:H})).json();

// 2. Создать контакт (если дубля нет)
const c = await (await fetch(`${API}/contacts`, {method:"POST", headers:H, body: JSON.stringify([{
  name: "Margarita Belka",
  custom_fields_values: [{ field_code: "PHONE", values: [{ value: "+6285958925071", enum_code: "WORK" }] }]
}])})).json();
const contactId = c._embedded.contacts[0].id;

// 3. Создать сделку в Rental / New LEAD и сразу привязать контакт
const l = await (await fetch(`${API}/leads`, {method:"POST", headers:H, body: JSON.stringify([{
  name: "R-AME-031 - 3BR Riverfront Villa with Jungle Views in Pererenan",
  pipeline_id: 11119150,
  status_id: 87301078,
  _embedded: { contacts: [{ id: contactId }] }
}])})).json();
const leadId = l._embedded.leads[0].id;

// 4. Примечание — ТОЛЬКО ответы формы, на английском
await fetch(`${API}/leads/notes`, {method:"POST", headers:H, body: JSON.stringify([{
  entity_id: leadId,
  note_type: "common",
  params: { text: "What is your monthly budget?\nRp 30-50 million\n\n..." }
}])});
```

## ГЛАВНОЕ ПРАВИЛО: дедупликация

В шаге 3 «amoCRM: New lead» настройка **Duplicate Search setting** должна быть:

- **`Do not check for duplicates, always create a record`** → в API это `dupAction: 1`

Если стоит `dupAction: 3` («Update an existing record if a duplicate is found») с поиском по **Contact ID** — система работает так: *один контакт = максимум одна сделка в воронке навсегда*. Любой повторный отклик того же человека **не создаёт сделку**, а молча перезаписывает старую. Лид исчезает.

В шаге 2 «amoCRM: New contact» `dupAction: 3` — **правильно и менять не надо**: дубли контактов нам не нужны.

Симптом в логах Albato: `Deal has been updated: ID=...` вместо `New lead created: ID=...`.

## Как менять настройку через интерфейс

Записывающие запросы к API Albato блокируются защитным фильтром — только через UI.

1. Открыть `https://new.albato.ru/bundle/edit/{bundleId}`
2. Подождать ~6 сек (иначе первый клик не регистрируется)
3. Нажать **Pause** (пока связка запущена, редактирование заблокировано)
4. У шага 3 нажать иконку дубликатов — CSS-класс `.icon-search-duplicate` (не путать с шестерёнкой `.icon-setting` справа от неё)
5. В модалке открыть выпадающий список, выбрать первый пункт
6. **Save**
7. **Start** — обязательно вернуть связку в работу

Модалка при открытии списка сдвигается по вертикали — кликать по координатам со скриншота ненадёжно, между шагами делать свежий скриншот. Координату элемента можно посчитать из DOM: `screenX = elementX * (1568 / window.innerWidth)`.

## Диагностика: полезные API-эндпоинты

**Albato** (`https://new.albato.ru`) — читать через `fetch(..., {credentials:'include'})` из авторизованной вкладки:
```
GET /api/bundle?page=1&perPage=100          список связок (постранично, есть дубли — фильтровать по id)
GET /api/bundle/{id}/steps                   шаги; здесь же поле dupAction
GET /api/bundle/{id}/steps/{stepId}/data     маппинг полей шага
GET /api/bundle/events?page=1&per-page=200&sort=-dateCreated
      &filter[bundleId]={id}
      &filter[dateCreated][gte]=YYYY-MM-DD 00:00:00
      &expand=steps                          ЛОГИ ВЫПОЛНЕНИЯ — главный инструмент
```
В событиях: `status: 0` — поллинг без данных, `status: 1` — лид пришёл и обработан. В `steps[].resultMessage` видно, что именно произошло с контактом и сделкой.

Время в Albato — **московское (UTC+3)**. Бали — UTC+8. Разница +5 часов.

**amoCRM** (`https://api-b.amocrm.ru`):
```
GET  /api/v4/leads?order[created_at]=desc&limit=50
GET  /api/v4/leads/{id}
GET  /api/v4/leads/pipelines
GET  /api/v4/contacts?query=<номер без плюса>
GET  /api/v4/leads/{id}/links
GET  /api/v4/events?filter[entity]=lead&filter[entity_id]={id}&limit=250
POST /api/v4/leads            создать (массив объектов)
POST /api/v4/contacts         создать (массив объектов)
POST /api/v4/leads/notes      примечания (нужно поле note_type:"common")
PATCH /api/v4/leads/notes     правка примечаний (note_type обязателен и при PATCH)
```
Не добавлять параметр `with=contacts` — ответ режется фильтром безопасности. Для связей использовать `/leads/{id}/links`.

## Как отличить источник лида

| Признак | Откуда |
|---|---|
| Заголовок вида `R-AME-031 - 3BR Villa...` | Albato / Instant Form |
| Заголовок `New lead from the new site`, тег `Website_Unicorn` | форма на сайте, интеграция «Команда F5» |
| UTM с числовыми ID (`utm_campaign=1202513...`) | это ID объектов Meta, а не классические UTM |

Сайтовые лиды по умолчанию падают в **UNICORN**, а не в Rental — это настройка виджета «Команда F5», не Albato.

## ЯЗЫК

**Всё, что попадает в amoCRM — только на английском.** Названия сделок, примечания, любой текст в карточке. Клиенты общаются на английском, и карточку читают и брокеры, и AI-ассистент (Amelia/Copilot).

Отдельно критично: примечания в сделке подтягиваются ботом. Правило — **в карточку клиента попадают только ответы формы, ничего больше**. Служебные комментарии на русском ломают бота: он читает их как реплику клиента.

## Известная проблема: коды вместо текста

Meta отдаёт ответы квалификационных форм не подписями, а ключами вариантов:

```
What is your monthly budget?   -> b2      (= 30–50 млн IDR)
When do you want to move in?   -> m3      (= 3–6 месяцев)
How many bedrooms do you need? -> r4      (= 4 спальни)
Which area are you looking in? -> a5      (= Kerobokan / Babakan / Semer / Umalas)
```

Albato тут ни при чём: для системных полей он отдаёт пары «значение + подпись» (`Page` / `Page - Title`), а для вопросов формы подписи нет — Meta её просто не возвращает. Ключи прописаны в самих формах при их создании через Marketing API.

Два пути решения: пересоздать варианты ответов с осмысленными ключами (разово, но меняются form_id) либо держать таблицу расшифровки на своей стороне (вечная поддержка).

## Известная проблема: размножение форм у одного листинга

У одного листинга может накопиться несколько ACTIVE-форм с почти одинаковыми именами
(`R-AME-031 - qualification`, `... -v2`, `... -v2-copy`, `... - whatsapp2`). Тогда возможен
рассинхрон: лид падает в одну форму, Albato слушает вторую, объявление показывает третью —
и лид не доезжает до CRM.

Диагностика: `GET /{page_id}/leadgen_forms?fields=id,name,status,leads_count` (нужен Page token),
затем сверить с формой в живом объявлении
(`creative.object_story_spec.link_data.call_to_action.value.lead_gen_form_id`)
и с формой, настроенной в связке Albato. Все три должны совпадать.

Важно: старые формы остаются доступными людям, которые видели объявление раньше —
лид может прийти в форму выключенного объявления спустя дни.

## Тестирование цепочки

`https://developers.facebook.com/tools/lead-ads-testing`

Page → **Monthly/Yearly Properties** (выбирается кликом по радиокнопке слева, не по тексту) → Form → **Create lead**. Одна форма = один тестовый лид, для повтора сначала **Delete lead**.

Проверка дедупа: создать лид, удалить, создать ещё раз. Оба раза контакт один и тот же. В логах Albato должно быть **два** `New lead created` с разными ID. Если второй `Deal has been updated` — дедуп не починен.

После теста закрывать тестовые сделки (`status_id: 143`) и удалять лид в Meta.

## Методика разбора «лид не дошёл»

Не гадать. Порядок такой:

1. Найти конкретные события в логах Albato за день (`/api/bundle/events`, `status: 1`).
2. Посмотреть `resultMessage` каждого шага — created или updated.
3. Сверить ID сделки с amoCRM: есть ли она, что с ней стало, какие события в её истории.
4. Только после этого строить общую гипотезу.

Не считать паузу на связке автоматически поломкой: часть листингов на паузе законно — объект уже сдан или не проходит по бюджету.

