---
name: "make-meta-amocrm"
description: "Работа с Make.com (сценарии, коннекторы, вебхуки) для Unicorn Property — хранит API-токен, зону, ID организации/команды, синтаксис маппинга полей и диагностику связки Meta Lead Ads → amoCRM. Использовать при ЛЮБОЙ задаче про Make, сценарии автоматизации, замену Albato, потерянные или пустые лиды, самовыключающиеся сценарии, ошибку Not Authorized от amoCRM."
---

# Make.com — Unicorn Property

## Доступ

- Зона / базовый URL: **`https://us2.make.com`**, API `https://us2.make.com/api/v2/{endpoint}`
- Заголовок: `Authorization: Token <токен>`

```
de7f6ce0-3371-4869-a6f6-53a705ebea30
```

- Организация **3974318**, команда (teamId) **891458**, тариф Core ($9/мес).

Запросы — через `javascript_tool` из вкладки на `us2.make.com` (same-origin,
относительный путь `/api/v2/...`). MCP-инструменты Make тоже работают, но
периодически отваливаются — REST из вкладки надёжнее.

## Боевой сценарий Meta → amoCRM

**Сценарий 6054295** «Meta Lead Ads -> amoCRM (Rental)».
- flow[0] = `facebook-lead-ads:NewLeadMultiple` (instant, вебхук по СТРАНИЦЕ)
- flow[1] = `http:MakeRequest` → `POST https://unicornproperty.amocrm.ru/api/v4/leads/complex`
- **Вебхук 2748135** (`Meta Lead Ads hook (clean)`), connection `10665190`, страница `321159424422341`
- Старый вебхук 2735334 — ОТРАВЛЕН, отцеплен, не переиспользовать.
- Фильтр по формам снят намеренно, чтобы лид не отбрасывался молча. Вернуть,
  только если снова запустят параллельную группу на Albato (иначе дубли).
- `dlq: true`, `maxErrors: 1000000`.

---

# ТРИ ГРАБЛИ, НА КОТОРЫХ ЭТА СВЯЗКА ЛОМАЛАСЬ

## 1. Неправильный хост amoCRM → «Not Authorized»

**Использовать `https://unicornproperty.amocrm.ru/api/v4/...`**

`https://api-b.amocrm.ru` с этим токеном отдаёт **401**, хотя в самом JWT поле
`api_domain` указано именно `api-b.amocrm.ru`. Проверено 30.08.2026 прямым
GET `/api/v4/account`: api-b → «Not Authorized», домен аккаунта → 200 и 1476 байт.
`User-Agent` на результат не влияет.

**Ловушка при диагностике:** ручное создание сделок из вкладки браузера
`unicornproperty.amocrm.ru` идёт по СЕССИИ, а не по токену — поэтому оно
работает даже когда токен/хост в Make сломаны. Не считать это доказательством
работоспособности связки. Проверять только серверным вызовом из Make.

## 2. `switch(map(...))` всегда возвращает пусто

**Симптом:** лид доезжает, но карточка полупустая — заполнены только имя,
примечание и источник, а бюджет/район/спальни/сроки пустые.

**Причина:** `map()` возвращает МАССИВ. При подстановке прямо в текстовое поле
Make приводит массив из одного элемента к строке — поэтому имя и примечание
заполнялись. Но `switch()` сравнивает массив со строкой `'b2'` и НИКОГДА
не совпадает → пусто.

**Правильно — вынуть первый элемент:**
```
{{switch(get(map(2.mappable_field_data; 'value'; 'name'; 'budget'); 1); 'b1'; '...'; 'b2'; '...')}}
```

Проверено экспериментом 30.08.2026: в одной сделке оба варианта рядом —
`switch(map(...))` дал пусто, `switch(get(map(...); 1))` дал совпадение.

Плейн-`map` без switch (имя, телефон, примечание) трогать не нужно — работает.

## 3. Название сделки: `2.ad_name` пустой

У модуля `NewLeadMultiple` на верхнем уровне доступны только: `leadgenId`,
`formId`, `dateCreated`, `adId`, `pageId`, `adgroupId`, `mappable_field_data`,
`data`. **`ad_name` там НЕТ** — сделка получалась безымянной («Lead #12345»).

**Решение — собирать название из `formId`:**
```
{{switch(2.formId; '1067879148952558'; 'R-DESTI-007'; ... ; 'FB Lead')}} - qualification
```

Таблица форм v4 → код листинга:
| formId | код |
|---|---|
| 1067879148952558 | R-DESTI-007 |
| 2701207580277512 | R-MER-040 |
| 37858583193789630 | R-YUD-050 |
| 1092925090095096 | R-YUD-043 |
| 28703350259256976 | R-AME-030 |
| 1688004475621647 | R-DESTI-008 |
| 4544280872488477 | R-UM-024 |
| 2122389728654272 | R-YUD-036 |
| 2375662966296598 | R-DESTI-009 |
| 1813504786307192 | R-YUD-001 |

При добавлении нового листинга — дописать пару в этот switch, иначе название
станет «FB Lead - qualification».

---

## Ловушка 4: «отравленная» очередь выключает сценарий

**Симптом:** сценарий сам уходит в `isActive: false` через секунды после
включения. В логе `warning` «Fix the error or clear the queue», причина
`GraphMethodException (100)` «Object with ID … does not exist».

**Причина:** в очереди вебхука (`hooks_get` → `queueCount`) висят ID тестовых
лидов из **Meta Lead Ads Testing Tool**. Meta не отдаёт их сторонним
приложениям никогда.

**Что НЕ помогает:** поднятие `maxErrors` (Make гасит мгновенный сценарий при
сбое элемента очереди независимо от настройки; минимум `maxErrors` = 1).

**Решение — пересоздать вебхук:**
1. `hooks_create`: `typeName: "facebook-lead-ads-new-event"`,
   `data: {"__IMTCONN__": 10665190, "pageId": "321159424422341", "formId": null}`
2. Заменить `flow[0].parameters.__IMTHOOK__` на новый hookId
3. `scenarios_activate`, проверить `queueCount: 0` и `scenarioIsActive: true`
4. Старый хук НЕ удалять — удаление может снять подписку страницы в Facebook.

**ПРАВИЛО: НИКОГДА не пользоваться Meta Lead Ads Testing Tool.**

---

## Реальные имена полей HTTP-модуля (не совпадают с подписями в UI)

`url`, `method`, `headers` (массив `{name,value}`), `contentType: "json"`,
`inputMethod: "jsonString"`, **`jsonStringBodyContent`** (тело, НЕ `data`),
`parameters.authenticationType: "noAuth"` (не верхнеуровневый `authType`).

## Как безопасно править блюпринт

Не собирать JSON руками — читать, править программно, писать обратно:
```js
const bp = (await (await fetch('/api/v2/scenarios/6054295/blueprint',{headers:H})).json()).response.blueprint;
bp.flow[1].mapper.jsonStringBodyContent = /* правка строки */;
await fetch('/api/v2/scenarios/6054295',{method:'PATCH',headers:H,
  body: JSON.stringify({blueprint: JSON.stringify(bp)})});
```
После записи перечитать и убедиться, что тело всё ещё парсится как JSON.

## Как проверить выражение, не дожидаясь живого лида

Временный сценарий: `json:ParseJSON` с массивом-заглушкой той же формы, что
`mappable_field_data`, → `http:MakeRequest` POST в amoCRM, где в `name` записаны
СРАЗУ ОБА варианта выражения. Прогнать `scenarios_run` с `responsive: true`,
прочитать имя сделки из amoCRM — видно, какой вариант сработал. Потом удалить
сценарий и закрыть тестовую сделку (`status_id: 143`).
Это единственный способ проверить синтаксис маппинга детерминированно.

## Диагностика: порядок

```
scenarios_get 6054295   → isActive, isinvalid, dlqCount
hooks_get 2748135       → queueCount, scenarioIsActive
executions_list 6054295 → status 3 = ошибка, смотреть causeModule
```
`status`: `1` = успех, `3` = ошибка.
`operations: 1` при успехе = отработал только триггер, второй модуль отсечён
фильтром → лид в CRM НЕ попал.

Работающие REST-эндпоинты:
```
GET    /api/v2/scenarios/{id}/blueprint
PATCH  /api/v2/scenarios/{id}            {"blueprint": "<JSON-строка>"}
GET    /api/v2/hooks/{id}/logs           доставки вебхука (payload скрыт)
GET    /api/v2/dlqs?scenarioId=6054295
POST   /api/v2/dlqs/{dlqId}/retry        ставит в очередь, но на практике НЕ срабатывает
DELETE /api/v2/dlqs/{dlqId}              убрать запись, чтобы не было дублей
```
Очистки очереди вебхука, реплея выполнений и просмотра bundles в API **нет**
(404/400) — не тратить попытки.

## Сторож

Ежечасная задача `make-leads-watchdog`: проверяет активность сценария, сверяет
Meta Leads Center с amoCRM за сутки, добирает пропущенные сделки И дозаполняет
карточки с пустыми полями. Проверять её наличие через `list_scheduled_tasks` —
однажды задача пропала из списка.

## Зачем уходили с Albato

Albato: одна связка = одна форма Meta; копия формы — лид теряется; запись в API
заблокирована, всё правится кликами. Make: instant-триггер слушает всю страницу,
один сценарий вместо 12, полноценный API на запись. Минус — нужна зарубежная карта.

