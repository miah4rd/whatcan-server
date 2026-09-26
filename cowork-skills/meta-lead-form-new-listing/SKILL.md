---
name: "meta-lead-form-new-listing"
description: "Создание квалификационной Meta Lead Form для нового листинга Unicorn Property и привязка её к объявлению — полностью через Graph API, без кликов. ХРАНИТ СТАНДАРТ ТЕКСТА ОБЪЯВЛЕНИЯ: один район, короткое название, без двойных географий. Также хранит оба долгоживущих System User токена (обычный + admin второго бизнеса) для каталога/кампаний Meta Ads. Использовать при ЛЮБОЙ задаче про новую форму, новое объявление, текст объявления, новый листинг, каталог или рекламные кампании в Meta Ads."
---

# Новая квалификационная форма Meta для листинга Unicorn Property

## Главное правило

Делать ТОЛЬКО через Graph API. Руками в интерфейсе — нельзя, это дорого и долго.

Эталон для копирования — форма с предупреждением в тексте варианта бюджета,
а НЕ старая форма с нативной conditional logic. Логику ветвления Meta через API
не отдаёт, поэтому копировать формы с ней бессмысленно.

**Эталонная форма-донор:** `R-DESTI-007 - qual` (ID 1533633488568098)
Любая из `* - qual` подойдёт — они идентичны.

---

# СТАНДАРТ ТЕКСТА ОБЪЯВЛЕНИЯ (согласован с владельцем 09.09.2026)

Это правило обязательно для КАЖДОГО нового объявления. Нарушение = переделка.

## Формат — ровно две строки

```
<СПАЛЬНИ>BR VILLA IN <ОДИН РАЙОН>
Monthly Rp <цена> million
```

Первая строка КАПСОМ. Вторая — как написано, с большой буквы только Monthly и Rp.

## Правило одного района — ЖЁСТКОЕ

**Пишется ТОЛЬКО крупный узнаваемый район. Второй, более мелкий, НЕ пишется никогда.**

| Писать | НЕ писать |
|---|---|
| `2BR VILLA IN CANGGU` | ~~2BR VILLA IN PADONAN, CANGGU~~ |
| `2BR VILLA IN UMALAS` | ~~2BR VILLA IN BUMBAK, UMALAS~~ |
| `2BR VILLA IN SESEH` | ~~2BR VILLA IN SESEH BEACH, MENGWI~~ |

Причина: аудитория — иностранцы. Они знают Чангу, Умалас, Семиньяк, Сесех, Убуд,
Улувату. Названия вроде Паданан, Бумбак, Тумбак Баюх, Бабакан, Паданг Линджонг им
ничего не говорят и работают как шум. Плюс в Marketplace заголовок объявления
не отображается вообще — виден только этот текст, и он должен читаться мгновенно.

**Крупные районы, которые допустимо писать:**
Canggu, Pererenan, Umalas, Kerobokan, Seminyak, Seseh, Berawa, Ubud, Uluwatu, Sanur, Jimbaran, Nusa Dua.

**Мелкие локации, которые сворачиваются к крупному:**
Padonan, Bumbak, Babakan, Tumbak Bayuh, Padang Linjong, Batu Bolong, Batu Mejan,
Semer, Buduk, Munggu, Cemagi, Nyanyi, Tibubeneng, Kayu Tulang, Dalung, Padonan → пишем ближайший крупный.

## Чего в тексте быть не должно

- Двух географий через запятую
- Длинных описательных названий вилл (`Antique Rumah Barong Villa with Pool and Spacious Tropical Garden`) — это худший формат, писать по шаблону
- Эпитетов вместо сути: `BRAND NEW`, `PREMIUM`, `LUXURY` допустимы ТОЛЬКО как приставка перед `<N>BR`, и только если реально отличают объект
- Названия виллы вместо района

## Наблюдение по конверсии (09.09.2026, выборка малая, но однонаправленная)

| Текст | Клик→лид |
|---|---|
| `PREMIUM 2BR VILLA IN SESEH` | 25,0% |
| `2BR VILLA IN UMALAS` | 15,3% |
| `2BR VILLA IN BUMBAK, UMALAS` | 9,1% |
| `Antique Rumah Barong Villa with Pool…` | 8,6% |
| `BRAND NEW 2BR LOFT VILLA IN UMALAS` | 7,3% |
| `2BR VILLA IN PADONAN, CANGGU` | 4,9% |

Оба объявления с двойным районом — в самом низу. Оба лидера — с одним районом.

## Когда править существующие объявления

Правка только текста (без замены картинок) считается мелким изменением и обучение
обычно НЕ сбрасывает. Но с апреля 2026 Meta ужесточила правила (Andromeda), и есть
сообщения о сбросах на ранее безопасных правках. Гарантий нет.

**Правило: существующие объявления с неправильным текстом НЕ трогать, пока группа
в фазе обучения или даёт лиды.** Исправлять только при плановой пересборке креатива.
Новые объявления — сразу по стандарту.

---

## Ключевые константы

- Page ID: `321159424422341` (Monthly/Yearly Properties)
- Ad account: `act_778356744500892`
- Business (владелец ad account и каталога): `475616281812243` ("Unicorn Properties Estate")
- Другой business (владелец первого/старого System User): `1883511718826235`
- Follow-up URL: `https://unicorn-properties.com/`
- Privacy policy: `https://unicorn-properties.com/privacy`
- Home Listings каталог: `1895464271415071` ("Unicorn Property Rentals (home listings)", vertical `home_listings`)
- Основной product set: `1423204113010393` ("All Rental Listings")

## Токены (System User, долгоживущие)

### Токен 1 — обычный (business 1883511718826235, shared/partial доступ к ad account)

```
EAATrZBEOvUDQBSc1ZADjPHulSWD01jma1r8tZCjA18dZBvp4qfUOwZAZCGrmz5wpQUrNPoG8XNfpbZC1LUl2cRxWdB1cuMOYrj0yVVQXGBjZBTG4lfftVM140I27MlWmje1vii8gcTDBKwN71kXZBBQEMJjKvsDH9HEH2k38ag2pO1Tq1JuGC44z6ockNN5XDxAZDZD
```

Использовать для операций с ad account (`act_778356744500892`) — кампании, ad sets,
ads, adcreatives, custom conversions, pixels, leadgen_forms (через Page token).
**НЕ видит** объекты каталога/catalog/product_sets, созданные в бизнесе 475616281812243 —
на них он выдаёт `GraphMethodException` subcode 33 ("does not exist or missing permissions"),
хотя объекты реальны. Также не имеет прав менять billing/spend_cap на ad account
(subcode 1487828 "You do not have permissions to update the ad account").

### Токен 2 — admin второго business (475616281812243), System User "1", id `122093645721464710`

```
EAAO8QvLOYD8BSXkET1g02slPVft9vkZAuOZCPxVu2yPMRopv3JNIF8kfULnCjoWzvAEZBEZBqqZC5be9h8TtsPTnj3p1kzIIZALxzS9AWERqpctxekd4sZCWax5iJ9RT8UxJC2XHsall2XeHdjutegSrX7ZB1DZA7oS0ot3jEB47L4vQYWHSpRCUjEljnvbiqIQZDZD
```

Использовать для всего, что токен 1 не видит: каталог (`1895464271415071`), product sets,
product feeds/data sources, диагностика каталога, и потенциально billing/аккаунт-левел
настройки ad account (сам ad account тоже принадлежит business 475616281812243).
Если появится новая задача с ошибкой subcode 33 или "missing permissions" на объекте
каталога/бизнеса 475616281812243 — сразу пробовать этим токеном, не эскалировать
к пользователю раньше времени.

**Ограничение токена 2:** его приложение в режиме разработки, создавать adcreatives
им нельзя («Ads creative post was created by an app that is in development mode»).
Схема: креатив создавать токеном 1, а сам ad (со ссылкой на готовый creative_id) —
токеном 2, если в креативе есть product_set_id.

Оба токена читают/пишут в один и тот же ad account `act_778356744500892`, т.к. он
принадлежит business 475616281812243, а токен 1 имеет туда только shared-доступ.

Для операций с `leadgen_forms` (создание/чтение форм) нужен **Page token**,
не User token — получить так (выполнять из вкладки браузера, песочница агента
к graph.facebook.com не пускает):

```js
const T = "<токен 1>";
const acc = await (await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,access_token&access_token=${T}`)).json();
const PT = acc.data.find(x => x.id === "321159424422341").access_token;  // Page token
```

Если какой-то токен перестанет работать (`OAuthException`, `Error validating
access token`) — попросить у пользователя новый System User токен и заменить
соответствующую секцию через `save_skill` с `overwrite: true`.

**Чтение лидов через API недоступно:** у обоих токенов нет права `leads_retrieval`,
`GET /{form_id}/leads` отдаёт `(#200) Requires leads_retrieval permission`.
Сверять лиды — через amoCRM или Leads Center в интерфейсе.

## Шаг 1: скопировать структуру с эталона

```js
const src = await (await fetch(`https://graph.facebook.com/v21.0/1533633488568098?fields=questions,context_card,locale,legal_content&access_token=${PT}`)).json();

// снять все id — Meta не принимает их при создании
const strip = o => Array.isArray(o) ? o.map(strip)
  : (o && typeof o === "object"
      ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "id").map(([k,v]) => [k, strip(v)]))
      : o);

// у не-CUSTOM вопросов (FULL_NAME, PHONE) нельзя передавать label
const qs = strip(src.questions).map(q =>
  q.type && q.type !== "CUSTOM" ? { type: q.type, ...(q.key ? {key: q.key} : {}) } : q);
```

## Шаг 2: создать форму

```js
const body = {
  name: "<CODE> - qual",                 // напр. "R-XXX-123 - qual"
  locale: "en_US",
  questions: qs,
  context_card: strip(src.context_card),
  follow_up_action_url: "https://unicorn-properties.com/",
  privacy_policy: strip(src.legal_content.privacy_policy),
  access_token: PT
};
const f = await (await fetch(`https://graph.facebook.com/v21.0/321159424422341/leadgen_forms`,
  {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)})).json();
// f.id — ID новой формы
```

## Шаг 3: привязать к объявлению

```js
const T = "<токен 1>";
const ads = (await (await fetch(`https://graph.facebook.com/v21.0/act_778356744500892/ads?fields=id,name,creative{object_story_spec}&limit=50&access_token=${T}`)).json()).data;
const ad = ads.find(a => a.name === "<AD NAME>");

const spec = JSON.parse(JSON.stringify(ad.creative.object_story_spec));
const ld = spec.link_data || spec.video_data;
ld.call_to_action.value.lead_gen_form_id = f.id;
ld.message = "<ТЕКСТ ПО СТАНДАРТУ ВЫШЕ>";   // один район, две строки

const cr = await (await fetch(`https://graph.facebook.com/v21.0/act_778356744500892/adcreatives`,
  {method:"POST", headers:{"Content-Type":"application/json"},
   body: JSON.stringify({name: ad.name + " (qual)", object_story_spec: spec, access_token: T})})).json();

await fetch(`https://graph.facebook.com/v21.0/${ad.id}`,
  {method:"POST", headers:{"Content-Type":"application/json"},
   body: JSON.stringify({creative:{creative_id: cr.id}, access_token: T})});
```

**ВАЖНО про карусель:** у каждого элемента `child_attachments` СВОЙ
`call_to_action.value.lead_gen_form_id`, отдельный от верхнеуровневого.
При смене формы менять ОБА, иначе лиды молча уходят в старую форму.

Несколько листингов — прогонять циклом в одном вызове, не по одному.

## Текст отсечки бюджета

Вариант `b1` в вопросе `budget` должен быть:

```
Under Rp 30 million — unfortunately we have no options in this range
```

Остальные варианты без изменений: `Rp 30-50 million`, `Rp 50-80 million`, `Rp 80 million or more`.

## Что НЕЛЬЗЯ

- Опубликованную форму нельзя ни редактировать, ни переименовать, ни удалить —
  ни через API, ни руками. Только создавать новую и перепривязывать объявление.
- Поля `conditional_questions_*` через API пустые всегда. Нативную отсечку
  (окно «вы не подходите») API не поддерживает — не пытаться.
- Meta Lead Ads Testing Tool использовать НЕЛЬЗЯ — тестовые лиды намертво
  забивают очередь вебхука в Make и выключают сценарий.

## После создания формы

Не забыть дописать новый `formId` в маппинг сценария Make 6054295 (switch по `2.formId`),
иначе сделка приедет в amoCRM без названия листинга.

## Каталог / Advantage+ Catalog Ads

- Каталог `1895464271415071` (vertical `home_listings`), product set `1423204113010393`
  ("All Rental Listings", фильтр `availability=for_rent`), 58 товаров.
- Фид: XML (НЕ CSV/TSV/JSON), генерируется edge-функцией Supabase
  `supabase/functions/meta-rent-xml/index.ts` в Lovable-проекте
  `2206c216-9a00-4955-9783-f78ef9c87e40`, отдаётся по адресу
  `https://yrtteclvrtqobjnpxqck.supabase.co/functions/v1/meta-rent-xml`.
  Отдаёт до 10 фото на листинг (правка 09.09.2026).
- **Фид читает БАЗУ СТАРОГО проекта**, а сайт работает на `zveamkyyzfztzppwavws`.
  Базы разъезжаются: в фид попадают черновики, а часть живых листингов не попадает.
  Это известная нерешённая проблема.
- Кампания под лид-формы: "Rental Listings (Catalog + Lead Form)" `120252164523320530`,
  ad set `120252164523410530`, ad `120252164528380530`, форма `2142015873861851`.
  Проверено: каталог + `destination_type: ON_AD` + `LEAD_GENERATION` Meta принимает.
- Динамические теги — `{{home_listing.name}}`, `{{home_listing.price}}`, НЕ `{{product.*}}`.
  Верхнеуровневый `link` динамику НЕ принимает — только статический fallback.
- `format_option: carousel_images_single_item` — карусель фото ОДНОГО объекта
  (как в обычных объявлениях). `carousel_images_multi_items` — витрина разных вилл.
- Листинг без координат в каталог не попадёт: ошибка `property_value_missing`,
  «Without the required field latitude, longitude».

