---
name: "listing-manager"
description: "Работа с листингами Unicorn Property — база сайта, админка, фото, публикация на FB Marketplace от лица Putu Anandita. Использовать при любых задачах про листинги, аренду, карточки объектов на unicorn-properties.com."
---

# Listing Manager — Unicorn Property

Навык для работы с листингами недвижимости Unicorn Property (Бали): база сайта, админка, фото, публикация на Facebook Marketplace от лица бизнес-персоны Putu Anandita.

## ШАГ 0 (ОБЯЗАТЕЛЬНО): браузер и аккаунт

**Только Brave** для всех задач Putu Anandita (Marketplace, стена, группы, аутрич). В **Chrome** работают другие коворкеры — их сессию не трогать.

**Рабочее окно: 12:05–13:55.** Оно выделено специально под задачи Путу, чтобы не пересекаться с другими задачами в Chrome. Начинать в начале окна, заканчивать и освобождать браузер до 13:55. Если к 13:45 не всё сделано — доложить остаток и остановиться, а не залезать в следующий час.

**КРИТИЧНО: Brave на этой машине программно неотличим от Chrome.** `navigator.brave` отсутствует, `userAgent` и `userAgentData.brands` отдают «Google Chrome». Любые JS-проверки движка бесполезны — не тратить на них прогоны. Метка в `localStorage` тоже не годится: Brave чистит её при перезапуске.

**Протокол подключения:**
1. `list_connected_browsers` — подключение Brave обычно называется «Brave Putu», но имена периодически слетают на «Browser 1/2/3». Имени одного недостаточно.
2. `switch_browser` — рассылает диалог во все браузеры. Явно попросить пользователя нажать **Connect именно в окне Brave**. Классическая ошибка: диалог висит в нескольких браузерах, Connect жмётся в Chrome, работа уходит не туда. Часто в Brave уже висит незакрытый диалог с именем «Brave Putu» — достаточно нажать в нём Connect.
3. Визуальное подтверждение: `request_access` для «Brave Browser 2» → `open_application` → `screenshot`. В окне Brave должен быть баннер «'Claude' started debugging this browser», в menu bar macOS — «Brave».
4. Открыть `facebook.com`, убедиться, что аккаунт — **Putu Anandita**. Аккаунт залогинен и в Chrome тоже, поэтому проверка аккаунта НЕ заменяет проверку браузера — нужны обе.

**Признак перехвата сессии Chrome:** `tabs_context_mcp` вернул новую пустую tab group, вкладка исчезла, или tabId сменил префикс. Остановиться, вернуться на Brave по протоколу выше, и только потом продолжать. Chrome перехватывает сессию каждые несколько минут, пока подключён к расширению.

## Доступы и идентификаторы

**Сайт:** `unicorn-properties.com`, админка `/admin`, вход `info@unicorn-property.com`. Пароль вводит только пользователь.

**Движок:** Lovable, проект `unicorn-property`.
- `project_id` = `2206c216-9a00-4955-9783-f78ef9c87e40`
- workspace `lENWEUQAEGHXJueKHyrw`
- Прямой SQL к боевой базе — `query_database`. Самый быстрый путь для чтения и правки.
- Правки кода — `send_message` агенту Lovable, затем `deploy_project`.
- **Доступ коллегам:** это не отдельный Supabase, а проект Lovable. Владелец добавляет коллегу в Lovable (Settings → Members/Invite), коллега подключает коннектор Lovable у себя в Cowork и выбирает тот же проект.

**База:** Supabase `yrtteclvrtqobjnpxqck`, бакет `property-images` (публичный). Загрузка в него — только через админку.

**FB-профиль Путу:** `facebook.com/profile.php?id=61592028086850`

## Таблица properties — ключевые поля

`id` (text, `R-MER-008`), `title`, `area`, `type`, `bedrooms`, `bathrooms`, `land_size`, `build_size`, `status`, `ownership`, `purpose`, `zone`, `listing_type` (`sale`/`rent`), `is_draft`, `images` (text[]), `description`, `features` (text[]), `monthly_price_idr`, `yearly_price_idr`, `min_stay_months`, `rental_included`, `rental_excluded`.

Enum: `property_type` villa/apartment/land/townhouse · `property_status` ready/off-plan/under-construction/sold · `property_ownership` freehold/leasehold/freehold & leasehold · `property_purpose` living/investment/living & investment · `property_zone` residential/touristic/mixed/green · `listing_purpose` sale/rent.

Скрыть листинг = `is_draft = true` (обратимо). Не удалять.

## Соглашения по кодам

- Префикс `R-` = арендный дубликат продаваемого объекта. `R-MER-008` ↔ `MER-008`.
- Агенты: MER, SAI, AME, YUD, UM, CA, DES, PE, UB, BU, CE, SA, SER, UL, NIK, FER.
- **MER = Мэри** — перерабатывала чужие листинги и ставила свой код поверх исходного. В папке `MER-006` документ может указывать `Property ID: DES-006` — это не ошибка.
- Встречаются битые ID вида `R-2-BR--CANGGUBALI--189000` — папку по ним не найти.

## ФОТО: стандарт 10 штук на листинг

**Категорически нельзя** публиковать листинг с фотографиями другого объекта. Не удалось достать настоящие — пропустить листинг и доложить.

Галерея на сайте грузится лениво, из DOM фото собрать не получается (`document.images` отдаёт 1 штуку). Рабочий способ — брать URL прямо из базы:

1. ```sql
   SELECT unnest(images[1:10]) AS img FROM properties WHERE id = '<КОД>';
   ```
   URL вида `https://yrtteclvrtqobjnpxqck.supabase.co/storage/v1/object/public/property-images/...` — публичные, без токенов, их можно свободно передавать.

2. В отдельной вкладке открыть страницу сайта и рендерить по одному во весь экран:
   ```js
   window.__p=[...массив URL...];
   document.documentElement.innerHTML='<body style="margin:0;background:#fff"><img id="solo" src="'+window.__p[0]+'" style="position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#fff"></body>';
   ```
   Листать: `document.getElementById('solo').src = window.__p[N]`, пауза между кадрами ~1400 мс.

3. После каждого кадра — `computer` screenshot → `imageId`. **Всё одним `browser_batch`** — вдвое быстрее, чем по одному вызову.

4. В форме найти input через `find` («hidden file input for adding photos»), грузить по одному через `upload_image`. Перед каждой загрузкой заново получать `ref` — протухает.

`imageId` живут только внутри текущей сессии расширения. Оборвалась сессия — переснимать.

**Что не работает** (не тратить прогоны): `fetch` картинки со страницы Facebook (CSP), скачивание из песочницы (нет сети наружу), `BroadcastChannel` между доменами, Clipboard API из автоматизации, Google Drive (копии есть не у всех объектов).

## Публикация на FB Marketplace

Норма — **3 листинга в день**, только `listing_type = 'rent'`. Приоритет: самые свежие по `created_at`, при прочих равных — 2BR (лучше конвертятся). Перед публикацией сверяться с `facebook.com/marketplace/you/selling`, чтобы не дублировать.

Форма: `https://www.facebook.com/marketplace/create/rental`

Все выпадающие списки — кастомные, не `<select>` (`document.querySelectorAll('select')` возвращает пусто). Кликать мышью по координатам после скриншота.

Поля:
- Property for sale or to let → **Rent**
- Type of property for rent → **House**
- Number of bedrooms / bathrooms — из базы
- Price per month — `monthly_price_idr` без разделителей
- Адрес — ввести район («Pererenan», «Umalas», «Tabanan»), выбрать вариант из автоподсказки
- Description — заголовок объекта, 2-3 предложения из описания, помесячная и годовая цена, финал: «Message me for the full photo set, availability and to arrange a viewing.»

**Телефон и WhatsApp не указывать никогда** — только «Message me», контакт клиент оставляет сам.

**Next** → экран «List in more places»: Marketplace отмечен по умолчанию, здесь же секция «List in your groups» — самый быстрый способ постинга в группы, отдельно постить не нужно. Затем **Publish**, дождаться тоста «Listing published». Новый листинг какое-то время висит с плашкой «This listing is being reviewed» — это нормально.

## Репост на стену — обязательная часть публикации

Каждый опубликованный листинг сразу репостить на стену Путу, **без текста в подписи**. Это не отдельная задача по запросу, а второй шаг публикации.

На `facebook.com/marketplace/you/selling` у листинга: **Share** → в диалоге **Share now** (Feed, Public).

Если координатный клик не срабатывает (страница дёргается при ленивой подгрузке фото) — программно:
```js
const b=[...document.querySelectorAll('div[role=button],span[role=button]')].find(e=>/^Share/.test(e.getAttribute('aria-label')||'')); if(b){b.click(); 'clicked'} else 'not found'
```
```js
const b=[...document.querySelectorAll('div[role=button],span[role=button]')].find(e=>e.textContent.trim()==='Share now'); if(b){b.click(); 'shared'} else 'no share-now'
```

После — проверить `get_page_text` на профиле Путу, что пост реально появился. Не полагаться на то, что диалог закрылся.

## Группы: лимиты и приоритет

Список с приоритетами: `bali_rental_groups_priority_putu.xlsx`.

**Лимиты (чтобы не словить блок):**
- Не больше **2 групп в день** суммарно и не больше 2 групп на один листинг.
- Одна и та же группа — не чаще **раза в 7 дней**.
- Интервал между постами в разные группы — от 45 минут (если постить не через форму Marketplace, а вручную).
- Только группы, где Путу состоит, тематика совпадает (long-term/monthly rental) и нет зависшего неодобренного поста.

**Проверено по факту:**
- «Bali Long Term Villa Rentals» (96.8K, Public) — состоим, чисто, только long-term, daily удаляют и банят. Админ: «If you want quick approval please contact me».
- «Bali MONTHLY YEARLY Rental villas» (17.8K, Private) — состоим, правил нет, модерации нет, пост появляется сразу. Самая свободная.
- «Bali MONTHLY Rental Villas» (92.8K) — состоим, но **висит неодобренный пост с 16 июля**. Только monthly, за daily/yearly/sale бан без предупреждения. Не добавлять, пока не разгребут.
- «CANGGU HOUSE, VILLA SHARES, MONTHLY RENT AND SITTING» (26.1K) — состоим, **висит неодобренный пост**, в правилах «No promotions or spam». Не добавлять.
- «Canggu Community Bali ❤» (101K) — Путу НЕ состоит (кнопка Join), хотя в базе Никиты отмечена как вступленная.

**Механика:** ни в одной группе нет прописанного лимита частоты. Реальный тормоз — ручное одобрение админом: во многих группах пост уходит в очередь и появляется только после решения модератора (встречались посты, зависшие на месяц). Facebook тут ни при чём — блокирует человек.

**Проверка членства:** только через `facebook.com/groups/joins` (поиск там ищет по своим группам и даёт URL). Глобальный поиск FB не годится — ранжирует по общим друзьям и подсовывает одноимённую, но другую группу (искали «BALI RENTAL ROOMS & VILLAS» 153K — нашлась другая на 1.7K).

Правила группы: `facebook.com/groups/<id>/rules`. Своя очередь на модерацию: `facebook.com/groups/<id>/my_pending_content` (дата видна через `find`, в `get_page_text` время обфусцировано).

## Админка: известные баги

**Main Area стирается при сохранении** — форма не подставляет текущее значение и пишет пустую строку. Перед сохранением:
```js
const sel = document.querySelectorAll('select')[0];
if (sel && !sel.value) {
  const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  s.call(sel, 'Pererenan');
  sel.dispatchEvent(new Event('change',{bubbles:true}));
}
```
Порядок select-ов: [0] area, [1] type, [2] status, [3] ownership, [4] zone, [5] purpose.

**Monthly rent IDR обязателен** — если есть только годовая цена, ставить 1/12 от годовой.

**Загрузка фото:** input через `find`, затем `file_upload`. Лимит 10 МБ на вызов. Не трогать input через JS.

**Публикация:** снять «Save as Draft» → кнопка станет «Save & Publish». До 10 секунд.

**Замена всех фото:** сначала `UPDATE properties SET images='{}'::text[]`, потом залить через форму.

## Правила по фото на сайте

- 10–20 фото на карточку.
- Максимум 1920 px по длинной стороне, JPEG quality 82, progressive. Кадры с телефона 4032×3024 обязательно пережимать.
- Порядок: фасад → кухня → гостиная → спальня → санузел → прочее.

```python
from PIL import Image, ImageOps
im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
w,h = im.size
if max(w,h) > 1920:
    nw,nh = (1920, round(h*1920/w)) if w>=h else (round(w*1920/h), 1920)
    im = im.resize((nw,nh), Image.LANCZOS)
im.save(dst, 'JPEG', quality=82, optimize=True, progressive=True)
```

## Валюта

Базовая — **IDR**. Геодетект по IP из `CurrencyContext.tsx` удалён. Порядок: `?currency=` → ручной выбор пользователя → IDR. Старый выбор в `localStorage` (`preferred_currency`) сохраняется — переключить вручную один раз. Курс ~16 000 IDR за 1 USD.

## Контакты владельцев на Google Drive

Код объекта без префикса `R-` → найти папку → прочитать документ.
1. `search_files` с `title contains 'КОД'` или `fullText contains 'КОД'`
2. `search_files` с `parentId = '<id папки>'`
3. `read_file_content`

Названия документов разные: `Deskripsi.docx`, `Information`, `INFO`, гуглдок с названием виллы. Внутри — контакт, телефон, пин Google Maps, характеристики.

Родительские папки: MER `1OlOEZ_ERv5LHgw4I5qZETy7pe0f3vwmN` · YUD `11AkbjzO9AniMS6jiLVe9_JA2F4m-lj7I` · SAI и общие `1KTOfq44cknAiAqCsZggxGARx_mqwV8Aw`

Мастер-таблица **PROPERTY LISTINGS26**: `1HN0e5uPufy68V7cZXVNR23EeSSbFDQsf0WV-gtCjIxE` (32 МБ, целиком не читать).

Достоверность привязки указывать всегда: код подтверждён внутри документа — надёжно · ссылка на листинг сайта — надёжно · код только в названии папки — допущение.

## Выгрузка фото из WhatsApp

Веб-версия, чат открыт. Полноразмерные кадры только через просмотрщик (превью в ленте 512 px).
1. Кликнуть по альбому («+N») — откроется просмотрщик
2. Листать стрелкой вправо, забирать самый крупный `img` с `blob:`-ссылкой
3. Конвертировать в base64, собрать в JSON, скачать одним файлом
4. Разобрать в песочнице, записать jpg

Ограничения: Chrome блокирует массовые загрузки (нужно разрешение для `web.whatsapp.com`); не искать кнопки по `aria-label` для перехода вперёд — рядом «Переслать», можно случайно отправить сообщение.

## Сеть и ограничения

- Из песочницы недоступны: `supabase.co`, `drive.google.com`, `storage.googleapis.com`, сам сайт. Всё внешнее — через браузер или MCP.
- Домены сайта должны быть разрешены в настройках расширения (`chrome://extensions` → Site access).

## Актуальные документы

- Контакты владельцев, найдено (28): `16t3Ky_hpLYUT3V2PCx1FzHLgXUbmTvI61AQ83tw5AyI`
- Контакты владельцев, не найдено (15): `1TyU5r5YYg09e-W2AZLhgfeya_iMvuo3FH1pvnkjGmqU`
- Приоритет FB-групп (Putu): `bali_rental_groups_priority_putu.xlsx`

## Порядок работы

- Шаг 0 (браузер + аккаунт) — всегда до всего остального и заново после каждого переподключения.
- Работать в окне 12:05–13:55, освобождать браузер вовремя.
- 10 фото на листинг, только настоящие фото объекта.
- Публикация на Marketplace **всегда** включает репост на стену — это один шаг из двух частей.
- Перед массовыми правками читать состояние через SQL, не полагаться на память.
- Изменения обратимые: `is_draft`, а не удаление.
- Всё неподтверждённое помечать явно, а не додумывать.
- При любом признаке блокировки или лимита от Facebook — остановиться и доложить, не обходить.

