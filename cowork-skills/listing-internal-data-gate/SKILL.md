---
name: "listing-internal-data-gate"
description: "Жёсткий гейт публикации листинга Unicorn Property: без заполненного блока Internal data (property_private — владелец, телефон, адрес, пин, ссылка на Google Drive, notes) и без своей Drive-папки с копией ВСЕГО, что опубликовано на сайте, листинг не выкатывается. ПЕРЕОПРЕДЕЛЯЕТ послабления listing-prelisted-enrichment (они касаются метража и фото, а не внутренних данных). Использовать при ЛЮБОЙ задаче про публикацию нового листинга, снятие драфта, правку галереи, замену обложки и добор данных по существующим листингам."
---

# Internal data + Drive-папка — гейт публикации листинга

Указание владельца бизнеса от 06.09.2026.

**Листинг не переводится в `is_draft = false`, пока не заполнен блок Internal data
и пока под листинг не создана Google Drive папка с копией всего, что опубликовано
на сайте.** Ссылка на эту папку лежит в Internal data.

Приоритет: `listing-prelisted-enrichment` смягчает гейты по **метражу и фото** —
внутренних данных это не касается. Метраж может быть 0, фото могут быть временные
из интернета, но `property_private` и Drive-папка обязательны всегда.

Работает вместе с `listing-upload-regulation` (шаги D5–D7) и
`listing-photo-standard`.

---

## 1. Что такое Internal data

Таблица **`property_private`** в Supabase `zveamkyyzfztzppwavws`, на сайте — блок
Internal data в админке `unicorn-properties.com/admin`. Ключ — `property_id`.

Все колонки `NOT NULL` со значением по умолчанию `''`, поэтому **пустая строка —
это «не заполнено»**, а не «заполнено пустым».

| Поле | Обязательно к публикации | Что пишем |
|---|---|---|
| `property_id` | да | ID листинга `R-<AGENT>-<NNN>` |
| `owner_name` | **да** | имя владельца. Для co-broke — имя партнёра + в `notes` строка `co-broke partner, not the owner` |
| `owner_phone` | **да** | телефон в международном формате `+62…`. Берётся из лида amoCRM, если в доке его нет |
| `owner_email` | нет | если есть |
| `exact_address` | **да** | реальный адрес: улица, banjar, деревня, район. Не «Canggu» |
| `google_maps_url` | **да** | ссылка на пин виллы, из неё же берутся `lat`/`lng` |
| `drive_folder_url` | **да** | ссылка на **нашу** папку листинга (раздел 2) |
| `notes` | **да** | имя виллы, номер лида amoCRM, источник каждой не-владельческой цифры и фото |

`notes` — не формальность. Пустое поле уже стоило дубля: у `R-YUD-050` в `notes`
не было имени виллы, дедуп не сработал, и ту же виллу опубликовали второй раз как
`R-YUD-083` и успели анонсировать в WhatsApp.

Минимум в `notes`: имя виллы · район · лид amoCRM #<id> · откуда фото · откуда
метраж · чем подтверждена атрибуция · что выведено или аппроксимировано.

---

## 2. Google Drive папка под листинг

**Одна папка на один листинг.** Внутри — копия ровно того, что опубликовано на
сайте, чтобы карточку можно было восстановить и переиспользовать без сайта.

### Где создавать

| `listing_source` | Родительская папка | ID папки |
|---|---|---|
| `own` | **Own listings** | `1KN--pUx3ssDGdg73uT5S3UvnvdRp6VBE` |
| `co-broke` | **Co-Broke** | `15Z1VJbgU5oKHW9_kpzEKjsjuXqxXMeh5` |

Родитель решает `listing_source` на сайте — положить не туда значит подписать
листинг чужим типом.

### Имя папки

`<Имя виллы> <Район> — <ID>`, например `Amor Pererenan — R-YUD-084`.
Имя виллы здесь настоящее: папка внутренняя, в `title` листинга оно по-прежнему
не попадает никогда.

### Что кладём внутрь

1. **Все фото, которые стоят в галерее на сайте**, в том же порядке, с номерами в
   именах: `1. Facade.jpg`, `2. Pool.jpg`, `3. Living.jpg`… Первый файл — та же
   обложка, что `images[1]`.
2. **Док листинга** — по шаблону из `listing-upload-regulation` Part B, с ценами,
   спальнями, метражом, availability и контактом владельца.
3. **Видео**, если публиковали (сайт, Reels, Marketplace).
4. Ничего лишнего: черновики, чужие юниты, скриншоты переписки — не сюда.

Фото добраны из интернета (Airbnb, Booking, каталог) — **всё равно кладём копии в
папку** и пишем в `notes` источник. Папка обязана отражать сайт, а не
происхождение файлов.

### Доступ

Папка и файлы — **Anyone with the link, viewer**. Закрытая папка ломает
`import_property_images` (импортёр без Google-логина тянет HTML вместо фото) и
бесполезна для брокера.

### Папка владельца ≠ наша папка

Ссылка от владельца (поле `Listing: photos` в amoCRM, поле 968837) часто закрыта
или живёт в его аккаунте. Она не подходит: в `drive_folder_url` идёт **наша**
папка под Own listings / Co-Broke. Владельческую ссылку, если она рабочая, можно
упомянуть в `notes`.

### Как создать

Через Drive-коннектор: `create_file` с
`mimeType = application/vnd.google-apps.folder` и нужным `parentId`, затем
`copy_file` для фото и `share_file` для доступа по ссылке. Если коннектор не
отдаёт нужную операцию — сделать руками в Drive во встроенном браузере, но
папка всё равно должна появиться до публикации.

---

## 3. Порядок работы

Встраивается в `listing-upload-regulation`:

- **D5 (создание строки)** — сразу после `INSERT INTO properties` пишем
  `property_private`. Не «потом», не «когда узнаем»: заготовка со всем, что уже
  известно, и явными пометками в `notes` о недостающем.
- **D6 (фото)** — тем же составом URL, что ушёл в `import_property_images`,
  наполняем Drive-папку. Список для импорта и содержимое папки должны совпадать.
- **D7 (публикация)** — гейт из раздела 4. Ноль строк — только тогда
  `is_draft = false`.

Upsert:

```sql
INSERT INTO property_private (
  property_id, owner_name, owner_phone, owner_email,
  exact_address, google_maps_url, drive_folder_url, notes)
VALUES ('<ID>','<name>','<+62…>','',
  '<address>','<maps url>','<drive folder url>','<notes>')
ON CONFLICT (property_id) DO UPDATE SET
  owner_name       = excluded.owner_name,
  owner_phone      = excluded.owner_phone,
  exact_address    = excluded.exact_address,
  google_maps_url  = excluded.google_maps_url,
  drive_folder_url = excluded.drive_folder_url,
  notes            = excluded.notes,
  updated_at       = now();
```

Не затирать непустое поле пустым — сначала `SELECT`, потом обновлять только то,
что реально уточнили.

---

## 4. Гейт перед публикацией

Ожидаем **ноль строк**:

```sql
SELECT p.id,
  (pp.property_id IS NULL)                  AS no_private_row,
  coalesce(pp.owner_name,'')       = ''     AS no_owner,
  coalesce(pp.owner_phone,'')      = ''     AS no_phone,
  coalesce(pp.exact_address,'')    = ''     AS no_address,
  coalesce(pp.google_maps_url,'')  = ''     AS no_maps,
  coalesce(pp.drive_folder_url,'') = ''     AS no_drive,
  coalesce(pp.notes,'')            = ''     AS no_notes
FROM properties p
LEFT JOIN property_private pp ON pp.property_id = p.id
WHERE p.id = '<ID>'
  AND (pp.property_id IS NULL
       OR coalesce(pp.owner_name,'')       = ''
       OR coalesce(pp.owner_phone,'')      = ''
       OR coalesce(pp.exact_address,'')    = ''
       OR coalesce(pp.google_maps_url,'')  = ''
       OR coalesce(pp.drive_folder_url,'') = ''
       OR coalesce(pp.notes,'')            = '');
```

Вернулась строка → листинг остаётся `is_draft = true`. Единственное исключение —
письменное согласие владельца бизнеса, и тогда причина пишется в `notes`.

Плюс глазами: открыть `drive_folder_url` в режиме инкогнито (доступ по ссылке
работает) и сверить число фото в папке с `array_length(images,1)`.

Ссылка на пин из `google_maps_url` должна открывать саму виллу, а не район.

---

## 5. Существующие листинги

Правило действует и на уже опубликованные. Тронул листинг — доведи Internal data
до полного состояния.

Замена галереи или обложки → **обновить и папку**: состав и порядок файлов
должны совпасть с новым `images`.

Стоячая проверка по всей базе:

```sql
SELECT p.id, p.title, p.area,
       (pp.property_id IS NULL) no_row,
       coalesce(pp.owner_phone,'')      = '' no_phone,
       coalesce(pp.exact_address,'')    = '' no_addr,
       coalesce(pp.google_maps_url,'')  = '' no_maps,
       coalesce(pp.drive_folder_url,'') = '' no_drive,
       coalesce(pp.notes,'')            = '' no_notes
FROM properties p
LEFT JOIN property_private pp ON pp.property_id = p.id
WHERE p.listing_type = 'rent' AND coalesce(p.is_draft,false) = false
  AND (pp.property_id IS NULL
       OR coalesce(pp.owner_phone,'')      = ''
       OR coalesce(pp.exact_address,'')    = ''
       OR coalesce(pp.google_maps_url,'')  = ''
       OR coalesce(pp.drive_folder_url,'') = ''
       OR coalesce(pp.notes,'')            = '')
ORDER BY p.id;
```

**Замер на 06.09.2026** — 74 опубликованных rent-листинга:
17 вообще без строки `property_private`, 33 без `drive_folder_url`,
33 без `google_maps_url`, 28 без телефона владельца, 25 без адреса.
Это и есть бэклог, который правило закрывает; новые листинги в него не
добавляются.

---

## 6. Ловушки

| Ловушка | Что происходит | Как правильно |
|---|---|---|
| Публикация без строки `property_private` | Брокер не может работать листинг — нет контакта владельца | Строка создаётся вместе с листингом, в том же прогоне |
| Пустой `notes` | Не срабатывает дедуп, источники цифр теряются (прецедент R-YUD-050 / R-YUD-083) | Имя виллы, лид amoCRM, источники — всегда |
| В `drive_folder_url` ссылка владельца | Папка закрыта или живёт вне нашего Drive | Своя папка под Own listings / Co-Broke |
| Папка создана не в том родителе | Листинг подписан не тем `listing_source` | Родитель по `listing_source` |
| Папка без «Anyone with the link» | Импорт фото тянет HTML вместо картинок, брокер не откроет | Открыть доступ по ссылке сразу |
| Галерею на сайте поменяли, папку нет | Папка перестаёт быть копией сайта | Менять вместе |
| «Допишем Internal data потом» | Не дописывается никогда — отсюда бэклог 33 листингов | Гейт на D7 |
| В имени папки настоящее имя виллы → перенос в `title` | Конкуренты находят владельца | В папке имя настоящее, в `title` — только описательное |

