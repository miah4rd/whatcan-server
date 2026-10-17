---
name: "shanti-village-ig-publish"
description: "Полный цикл по Shanti Village (@shanti.village): публикация ролика в Instagram как Reel + Stories и запуск его в ретаргет-кампанию Meta Ads кабинета Sitara. Хранит все токены, ID, журнал опубликованных роликов и порядок еженедельного прогона. Использовать когда пользователь присылает ролик для Shanti, говорит «опубликуй в шанти», «новый ролик для шанти», «добавь в рекламу», просит описание к видео Shanti, и в еженедельной автозадаче проверки /Shanti Videos."
---

# Shanti Village — публикация в Instagram и запуск в рекламу

Две части: (1) публикация Story + Reel через Make, (2) добавление Reel
в ретаргет-кампанию Meta Ads. Вторая часть делается **ТОЛЬКО через интерфейс
Ads Manager** — см. «Часть 2», это критично.

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
| Make team / org | `891458` / `3974318` (план Core, 10 000 кредитов/мес) |

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

## Журнал публикаций (ОБНОВЛЯТЬ после каждого прогона)

Продюсер кладёт в `/Shanti Videos` примерно по ролику в неделю, имена
`shanti_<номер>.mp4`. Новый = номер больше последнего опубликованного.

| Файл | Reel/Story | Реклама |
|---|---|---|
| IMG_1232.MP4 | 31.08.2026 | ad 1-9 (ранние) |
| shanti_11.mp4 | 11.09.2026 | ad 10 |
| shanti_12.mp4 | 23.09.2026 | ad 11 (reel от 31.08 дублем) → см. примечание |
| shanti_13.mp4 | 30.09.2026 | ad 12 |
| shanti_14.mp4 | 05.10.2026 | ad 13 |
| shanti_15.mp4 | 17.10.2026 | ad 14 (`120251609180110189`) |
| **shanti_16.mp4** | **ждёт публикации** (лежит с 15.10.2026) | — |

Последнее объявление для дубликата: ad 14, id `120251609180110189`.
Следующее будет «ad 15».

---

# Часть 0. Еженедельный прогон (автозадача)

1. `list_folder` `/Shanti Videos`, `recursive: false`. Взять файлы `shanti_N.mp4`
   с N больше последнего в журнале. Нет новых — ответить «новых роликов нет»
   и закончить, ничего не публиковать.
2. Есть новые — взять ОДИН, с наименьшим N (остальные ждут следующей недели).
3. Выполнить Часть 1 и Часть 2 целиком.
4. Обновить журнал выше через `save_skill` (`overwrite: true`, весь текст).
5. Отчёт пользователю — 2-3 строки: какой файл, ссылка на рилс, имя нового ad,
   сколько роликов ещё в очереди.

Если на каком-то шаге блокер (Chrome не подключён, Ads Manager не пускает,
IG отказал) — остановиться, написать что сделано и что нет. Не публиковать
повторно «для проверки».

---

# Часть 1. Публикация Story + Reel

## 1. Файл в Dropbox

Лежит в `/Shanti Videos`. Загрузить файл самостоятельно НЕЛЬЗЯ — у песочницы
нет сети. Не класть в `/Ready Videos` (там ежедневная ротация Unicorn Property).

## 2. Story (первый прогон), затем кадры

`scenarios_update` сценария `6104059` — блюпринт с тремя общими модулями
(trigger → Dropbox refresh `id 10` → temp link `id 11` с путём
`/Shanti Videos/shanti_N.mp4`) и создание контейнера `id 2` с
`media_type: STORIES`, без `caption`, Sleep `id 3` = **240 сек** (файлы 75-120 МБ),
publish `id 4`. `scenarios_run`, `responsive: false`, затем ждать ~250 сек
(`sleep` в bash не больше ~175 сек за вызов — делать два) и проверить
`executions_get`: `status: 1`.

Посмотреть ролик для описания: встроенный браузер
`https://www.instagram.com/stories/shanti.village/` → «View story» (клик по
центру кнопки) → скриншоты каждые 5 сек (`scale 0.5`). Dropbox-плеер в
браузере часто не грузит видео — не терять на нём время.

## 3. Описание

Английский, короткие строки (стиль см. ниже), крючок по реальным кадрам ролика,
факты только из ролика или списка фактов. Показывать пользователю до публикации
не обязательно, если он сказал «опубликуй как обычно».

## 4. Reel (второй прогон)

Тот же блюпринт, но `id 2`: `media_type: REELS` + `caption`. Sleep 240.
Публикуется отдельным прогоном: Story и Reel вместе — это ~8 минут,
в лимит Core (на Free было 5 минут) помещается, но раздельно надёжнее.

## 5. После

Вернуть сценарий `6104059` в базовый вид (путь `/Shanti Videos/FILENAME.MP4`,
`caption: CAPTION HERE`, REELS, Sleep 180, Break-retry на publish).

---

# Часть 2. Реклама — ТОЛЬКО через Ads Manager

## ⛔ Через API не работает. Не пытаться.

Создание ad creative через Graph API упирается в `error_code 2016153`,
`HARD_ERROR`: «Ad account isn't eligible for Profile Visit ads». Перепробовано
и не работает: creative с `source_instagram_media_id`, то же без
`asset_feed_spec`, без `call_to_action`, заливка видео в кабинет, токены Unicorn.
Дубликат с выбором уже опубликованного поста через UI проходит без ошибок.

## ✅ Рабочий путь — дубликат в интерфейсе

Браузер: Claude in Chrome. После долгой работы вкладка часто зависает
(`Script injection timed out`) — открыть новую через `tabs_context_mcp`
(`createIfEmpty: true`) и работать в ней. ID вкладок меняются, брать из ответа.

1. Открыть с выделенным последним объявлением:
   `https://adsmanager.facebook.com/adsmanager/manage/ads?act=1596119741936973&business_id=630506660084098&selected_ad_ids=<ID последнего ad>`
   Подождать ~18 сек. Все клики — `find` → `ref`, не по координатам.
2. `find` «Duplicate button in main toolbar» → клик → диалог «Duplicate your ad»
   («Original campaign» стоит по умолчанию) → `find` кнопку Duplicate в диалоге →
   клик. Появится черновик «... ad N - Copy».
   **Грабля:** иногда при клике раскрывается левая навигация Ads Manager и
   диалог не открывается / дубликат не создаётся. Тогда `hover` в пустое место
   (например 900,680) и повторить Duplicate. Проверить, что в списке нет лишнего
   черновика, иначе удалить.
3. В черновике прокрутить вниз до «Ad creative» → кнопка **Select posts**
   (не радиокнопка «Use existing posts» и не чекбокс «select all»).
4. В диалоге отметить нужный Reel и **снять** прежний. Строки различать по
   дате и тексту: после публикации есть и Reel, и Story с той же датой —
   Story («This post has no text», Source: Stories) НЕ брать, брать Source: Reels.
   Счётчик внизу должен показать «1 of 5 selected» (проверять скриншотом;
   если «2 of 5» — второй клик по старому не сработал, кликнуть ещё раз).
5. **Continue** → подождать ~20 сек (Meta показывает «video post is processing»,
   ошибка «Instagram Video Must Be Uploaded To Facebook» уходит сама) →
   **Preview to publish** → в диалоге сверить текст поста и Source Media →
   **Publish**. Тост «Ad published», счётчик ads вырос на 1.
6. Переименовать (это разрешено через API): временно переписать сценарий `6104059`
   на один HTTP-модуль `POST https://graph.facebook.com/v21.0/<ad_id>` с
   `name=New Followers Bali (for Brokers) ad N` и `access_token` Shanti System User,
   `scenarios_run` (`responsive: true`), затем вернуть сценарий (Часть 1, п.5).
   ID нового ad виден в URL черновика (`selected_ad_ids=...`).
7. Проверить в списке, отсортированном по дате создания:
   `.../manage/ads?act=1596119741936973&business_id=630506660084098&sort=created_time~0`
   Новое объявление первой строкой; сначала «Processing», затем «Active».
   Сортировка по Delivery прячет новое объявление.

---

# Стиль описаний

Английский, короткие строки, каждая с новой:

1. Эмоциональный крючок — про ощущение или про то, что в кадре
2. `Balangan, Bali. 16 private villas, 5 minutes to the beach and golf.`
3. `Show unit opening soon.`
4. `🔗 Link in bio.`
5. `#ShantiBali #BalanganBeach #BaliLife #LuxuryVilla #NewKutaGolf`

Примеры крючков:

> Some places you visit. Others you come home to.

> Morning light, afternoon swims, sunsets you don't want to end.

> A home starts as a drawing. Then someone wakes up in it.

> It starts with a quiet walk down the street. Then the door opens and you are home.

> Quiet, private, and still close to everything. 30 minutes from the airport, minutes from the golf.

**Факты о проекте:** 16 вилл в закрытом посёлке · Balangan Beach, Badung, Bali ·
5 минут до пляжа и New Kuta Golf · 30 минут от аэропорта Нгурах-Рай ·
право до 82 лет · PT Sitara Property Estate · shanti-village.com

---

# Рабочие приёмы и грабли

- **Своей сети у песочницы нет.** Graph API — только через HTTP-модуль Make:
  временно переписать сценарий `6104059`, прогнать, **вернуть обратно**.
- Make Core: 10 000 кредитов/мес (один прогон публикации ≈ 6 кредитов).
- Инструменты Make не показывают вход/выход модулей — только `datastore:AddRecord`
  + `data-store-records_list` (если нужно прочитать ответ API).
- Индексы массивов в IML с 1: `{{2.data.data[1].id}}`.
- Удалять посты в Instagram через API нельзя, только руками. Дубль рилса от
  31.08 (https://www.instagram.com/reel/Dcsu3H9ijrc/) пользователь должен
  удалить вручную.
- Ads Manager зависает — лечится новой вкладкой, черновик сохраняется.
- Повторно НЕ выкладывать ролик «на проверку» — дубли удаляются только вручную.
- В примечании к журналу: ad 11 сделан из reel от 31.08 (до этого shanti_12
  вышел отдельным reel от 23.09 без своего ad; его ad не создавали).

