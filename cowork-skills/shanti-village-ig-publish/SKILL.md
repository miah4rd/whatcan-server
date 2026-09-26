---
name: "shanti-village-ig-publish"
description: "Полный цикл по Shanti Village (@shanti.village): публикация ролика в Instagram как Reel + Stories и запуск его в ретаргет-кампанию Meta Ads кабинета Sitara. Хранит все токены и ID. Использовать когда пользователь присылает ролик для Shanti, говорит «опубликуй в шанти», «новый ролик для шанти», «добавь в рекламу», просит описание к видео Shanti."
---

# Shanti Village — публикация в Instagram и запуск в рекламу

Две части: (1) публикация Reel + Stories через Make, (2) добавление ролика
в ретаргет-кампанию Meta Ads. Вторая часть делается **ТОЛЬКО через интерфейс
Ads Manager** — см. раздел «Реклама», это критично.

## Ключевые ID

| Что | Значение |
|---|---|
| Make сценарий (публикация) | `6104059`, `on-demand`, активен |
| Instagram Business ID | `17841463959062446` (@shanti.village) |
| Facebook Page ID | `178827695314527` (Sitara Property Estate) |
| Meta App (публикация в IG) | `1063206226435516` "Unicorn Stories Autopost" |
| Meta App (реклама) | `3174604046082844` "Shanti" |
| Business portfolio | `630506660084098` (PT Sitara Property Estate) |
| Ad account | `act_1596119741936973` (Sitara Ads Account) |
| Кампания | `120247775124180189` "New Followers Bali (for Brokers)" |
| Ad set (все объявления тут) | `120247775124170189` |
| Dropbox папка | `/Shanti Videos` |
| Make team | `891458` |

## Токены

**Meta Ads — System User "Shanti"** (бессрочный, права ads_management, ads_read,
business_management, pages_show_list, pages_read_engagement, instagram_content_publish):

```
EAAtHSRp4IxwBSVnDQJT5b2vXNzp4AENfH9v9DMRg0CCJkTCm2nXY9QWccQbhcuKXrLWrECzx8uNkIfqETWk12moG09KTYcWrkaDHJnMH46iQevIZBBfEH18wWPoWbrIoOd2hpjc0ZBXg6rvFLYpTxyjTdCyYhderDK8AUqonn7VqqZB0t3ie7ZCgnwbJlAZDZD
```

**Instagram** (публикация в @shanti.village):

```
IGAAUOynljq1RBZAFlCWHZANVDJhNHk1S19iUFR4MFhoVFVHQkJBSUZACeVNwUXpIamJUbGhUNmRGRm16SVhJbm52QkVJNFZAmNEVKNUJ5RlRtbXVDRHhRVVJWaTFpSjBYYmVoeGE1VzFuRFdjSEdsOW9ZAWWNuVUFFM0JTaU1tMGI4OAZDZD
```

**Dropbox** (refresh token, самообновляемый внутри сценария):

```
refresh_token: aasb64i1CIsAAAAAAAAAAel5Pomsx25BhfQ1celXu1uHgYfxOYhU-BFZEC1EJmbH
client_id:     wozdceqrq181yub
client_secret: fwg67a1c6iamkiw
```

---

# Часть 1. Публикация Reel + Stories

## 1. Файл в Dropbox

Должен лежать в `/Shanti Videos`. Проверить: Dropbox MCP `list_folder`,
`path: "/Shanti Videos"`, `recursive: false`.

Загрузить файл самостоятельно НЕЛЬЗЯ — у песочницы нет сети, `file_upload`
в браузере ограничен 10 МБ и часто отключён вовсе. Если файла нет, попросить
перетащить: https://www.dropbox.com/home/Shanti%20Videos

Не класть в `/Ready Videos` — оттуда ежедневная ротация Unicorn Property.

## 2. Посмотреть ролик перед описанием

Обязательно, иначе описание будет выдуманным.

Если файл загружен в чат — вытащить кадры:
```
ffmpeg -ss <сек> -i <файл> -frames:v 1 -vf scale=360:-1 frame.jpg
```

Если есть только ссылка Dropbox — открыть её во **встроенном браузере**
(`mcp__Claude_Browser__navigate`, выбора браузера не требует), нажать play,
делать скриншоты через каждые 8-10 сек, кнопкой «+10 сек» доматывать до конца.

## 3. Описание — показать пользователю до публикации

## 4. Запуск

`scenarios_update` сценария `6104059`: модуль id=11 — путь к файлу,
модуль id=2 — текст в `caption`. Затем `scenarios_run`, `responsive: false`.

**Reel и Stories — двумя отдельными прогонами.** Вместе не помещаются
в 5-минутный лимит выполнения Make Free (файл 85 МБ = ~185 сек на прогон).
Сначала Reel (`media_type: REELS` + caption), потом отдельным прогоном
Stories (`media_type: STORIES`, без caption).

Sleep между создания контейнера и publish — 180 сек для файлов ~85 МБ,
90 сек хватает для ~20 МБ.

## 5. Проверка

`executions_get` — `status: 1`. Плюс профиль:
https://www.instagram.com/shanti.village/ — счётчик постов вырос, обводка аватарки.

---

# Часть 2. Реклама — ТОЛЬКО через Ads Manager

## ⛔ Через API не работает. Не пытаться.

Создание ad creative через Graph API упирается в
`error_code 2016153`, `error_type: HARD_ERROR`:

> Ad account isn't eligible for Profile Visit ads.

Ad set оптимизируется под `PROFILE_AND_PAGE_ENGAGEMENT` с destination
`INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE`. Кабинету Sitara Meta закрыла создание
новых Profile Visit ads. Ad 1–9 работают, потому что созданы до ограничения.

Перепробовано и НЕ работает:
- креатив с `source_instagram_media_id` + CTA VIEW_INSTAGRAM_PROFILE — блок при создании ad
- то же без `asset_feed_spec` — ad создаётся, но `WITH_ISSUES`, не крутится
- без `call_to_action` — «Your call to action can't be used for your performance goal»
- заливка видео в кабинет (`advideos` + `object_story_spec`) — тот же 2016153
- токены Unicorn — вообще нет доступа к кабинету Sitara

## ✅ Рабочий путь — дубликат в интерфейсе

Meta не считает это новым Profile Visit ad, если креатив выбирается
из **уже опубликованных постов** через UI. Проходит без ошибок.

Браузер: Claude in Chrome. Если подключено несколько инстансов — спросить
пользователя и вызвать `switch_browser` либо `select_browser`.

1. Открыть с уже выделенным последним объявлением:
   `https://adsmanager.facebook.com/adsmanager/manage/ads?act=1596119741936973&business_id=630506660084098&selected_ad_ids=<ID последнего ad>`
2. **Duplicate** в тулбаре (искать через `find`, не по координатам — layout плывёт) →
   «Original campaign» → **Duplicate**. Откроется черновик «... ad N - Copy».
3. Прокрутить до блока **Ad creative** → **Select posts**.
4. В диалоге отметить чекбокс нужного Reel (по дате) и **снять** чекбокс старого.
   Счётчик внизу должен показать «1 of 5 selected». Кликать чекбоксы строго
   через `find` → ref, координатные клики промахиваются и цепляют соседние строки.
5. **Continue** → в диалоге «Preview ad setup» сверить текст поста и превью →
   **Preview to publish** → **Publish**. Появится тост «Ad published».
6. Если страница зависла (скриншоты таймаутят) — открыть новую вкладку
   `tabs_create_mcp`, перейти в Ads Manager, там наверху будет
   **Review and publish (1)** → нажать → в диалоге «Review draft items»
   проверить колонку Errors (должно быть «—») → **Publish**.
7. Переименовать через API (это разрешено):
   `POST /<ad_id>` с `{"name": "New Followers Bali (for Brokers) ad N"}`.
   Сеть только через Make — временно переписать сценарий `6104059` на один
   HTTP-модуль с этим POST, `scenarios_run`, дождаться `status: 1`,
   **вернуть сценарий обратно**. Datastore для этого не нужен.
8. Проверить в списке ads, отсортировав по дате создания:
   `https://adsmanager.facebook.com/adsmanager/manage/ads?act=1596119741936973&business_id=630506660084098&sort=created_time~0`
   Новое объявление должно быть первой строкой, Delivery — `Active`.
   Сортировка по Delivery прячет новое объявление, таблица виртуализирована.

История:
- ad 10 (`120251092335920189`) — 11.09.2026, ролик `17990482731101988`
- ad 11 (`120251111476630189`) — 12.09.2026, ролик от 31.08 (`18137175631559783`,
  reel DcspxP5Av0V), дубликат ad 10, Active

---

# Стиль описаний

Английский, короткие строки, каждая с новой:

1. Эмоциональный крючок — про ощущение, не про характеристики
2. `Balangan, Bali. 16 private villas, 5 minutes to the beach and golf.`
3. `Show unit opening soon.`
4. `🔗 Link in bio.`
5. `#ShantiBali #BalanganBeach #BaliLife #LuxuryVilla #NewKutaGolf`

Примеры:

> This is the magic of Shanti Village where every detail was chosen to make you feel something.

> Some places you visit. Others you come home to.

> Morning light, afternoon swims, sunsets you don't want to end.

**Факты о проекте:** 16 вилл в закрытом посёлке · Balangan Beach, Badung, Bali ·
5 минут до пляжа и New Kuta Golf · право до 82 лет · PT Sitara Property Estate ·
shanti-village.com

---

# Рабочие приёмы и грабли

- **Своей сети у песочницы нет.** Graph API — только через HTTP-модуль Make:
  временно переписать сценарий `6104059`, прогнать, **обязательно вернуть
  сценарий обратно**. Если нужен ответ тела — писать в datastore и потом удалять его.
- Make Free: максимум **2 активных сценария**, **1 datastore**, **5 минут** на прогон.
- Инструменты Make не показывают вход/выход модулей — только `datastore:AddRecord`
  + `data-store-records_list`.
- `data-store-records_list` возвращает записи от старых к новым и режет выдачу —
  удалять отработанные ключи, иначе новых не видно.
- Индексы массивов в IML с 1: `{{2.data.data[1].id}}` — это ПЕРВЫЙ элемент.
  Легко взять не тот ролик, перепроверять по `caption`/`timestamp`.
- Удалять посты в Instagram через API нельзя, только руками.
- Ads Manager регулярно зависает — лечится новой вкладкой, состояние черновика
  сохраняется.
- Перед публикацией повторно НЕ выкладывать ролик «на проверку» — дубли
  в аккаунте потом удаляются только вручную.

