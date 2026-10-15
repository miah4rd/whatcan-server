---
name: "listing-run-completeness"
description: "Обязательный чеклист завершённости прогона листинга аренды Unicorn Property (unicorn-properties.com + Unicorn OS). Прогон не считается законченным, пока не закрыты все пункты: полный охват QUALIFIED/Inspection (не только вход в стадию за 3 суток), листинги, снятые в драфт без причины, хвост анонсов по журналу 900002826, фото в Drive-папке каждого листинга (сценарий Make 6640772), отчёт с числом новых квалифицированных. Дополняет listing-upload-regulation и listing-internal-data-gate; где они говорят «copy_file» для фото — читать «сценарий Make 6640772». Использовать в КАЖДОМ прогоне листинга и при любой публикации или правке галереи."
---

# Прогон листинга: что значит «доделано»

Указание владельца 15.10.2026, после прогона, который опубликовал 1 объект,
не отправил анонсы и оставил Drive-папки пустыми: **«Ты не доделал работу.
Доделывай. Пиши скиллы».**

Прогон закончен только когда закрыты ВСЕ пункты ниже. Что-то закрыть нельзя —
в отчёте строкой: что, почему, какой конкретный вопрос к владельцу.
«Не успел», «коннектора не было на первом поиске», «сеть не пускает» —
не причина: у каждого из этих случаев ниже есть рабочий путь.

---

## 1. Охват — две выборки, не одна

**А. Вход в стадию за 3 суток** (`stage_changes` / `stageEvents`) — как в задаче.

**Б. Полная сверка стадий QUALIFIED `87763162` и Inspection `87763170`** —
каждая карточка против сайта по телефону (последние 9 цифр
`property_private.owner_phone`) и по номеру карточки в `notes`.
Без выборки Б карточки, квалифицированные давно, но так и не залистенные,
висят неделями (прецедент 15.10: Body Nature Mind 900006010 вошла в QUALIFIED
в 03:52 UTC, уже после старта прогона; Villa Sesari 23608439 и Villa Jasmine
23614205 стояли в QUALIFIED с 27–29.09 без листинга).

Через браузер OS (`/os/api/leads?pipeline=rental-listings&active=all`,
телефон — в `/os/api/leads/<id>`, поле `phone`):

```js
const a=await (await fetch('/os/api/leads?pipeline=rental-listings&active=all')).json();
const c=[...new Map(a.items.filter(l=>['87763162','87763170'].includes(String(l.stageId))).map(l=>[l.leadId,l])).values()];
const res=[]; for(const l of c){const d=await (await fetch('/os/api/leads/'+l.leadId)).json();
  res.push([l.leadId,(d.phone||'').replace(/\D/g,'').slice(-9)]);}
"values "+res.map(r=>`('${r[0]}','${r[1]}')`).join(',')
```

Потом в Supabase:

```sql
WITH c(lead,ph) AS (<values из шага выше>),
s AS (SELECT p.id, p.is_draft, right(regexp_replace(coalesce(pp.owner_phone,''),'\D','','g'),9) ph, pp.notes
      FROM properties p JOIN property_private pp ON pp.property_id=p.id WHERE p.listing_type='rent')
SELECT c.lead, (SELECT string_agg(s.id||CASE WHEN s.is_draft THEN '(D)' ELSE '' END, ',')
                FROM s WHERE s.ph=c.ph OR s.notes LIKE '%'||c.lead||'%') hits
FROM c;
```

`hits` пустой → карточку читать (переписка — источник): листить, или вернуть в
TAKEN TO WORK с заметкой, чего не хватает. Перед финальным отчётом выборку Б
повторить — за время прогона в QUALIFIED могут войти новые карточки.

**Карточка в QUALIFIED, но спальни или цену назвал НЕ владелец** (спальни только
из заголовка OTA, цена только из поста агентства) — не листить, `move_stage` в
TAKEN TO WORK `87795530` + заметка, что спросить. Прецеденты 15.10: Sesari
(спальни только из OTA), Jasmine (OTA 1BR, сайт виллы 3BR).

## 2. Листинги, снятые в драфт без причины

Каждый прогон:

```sql
SELECT p.id, p.updated_at, array_length(p.images,1) n
FROM properties p JOIN property_private pp ON pp.property_id=p.id
WHERE p.listing_type='rent' AND p.is_draft AND p.updated_at > now()-interval '3 days'
  AND pp.notes !~* '(draft|hidden|not available|duplicate|rejected)';
```

Прецедент 14.10 11:50–11:52 UTC: R-YUD-161/163/164/165/078/118/087 сняты в драфт
подряд с интервалом 5 с, без записи. Владелец 15.10: **«Ищи фото и публикуй»**.
Порядок: добрать фото (пин через Places API — все кадры, включая вертикальные;
Booking; Airbnb), убрать дубли глазами, вернуть `is_draft=false`, первой строкой в
`notes` — `REPUBLISHED <дата> ...`. Повторно НЕ анонсировать, если в журнале
900002826 уже есть id анонса. Исключение — цена не от владельца (R-YUD-087:
цена из поста агентства The House Bali) — остаётся драфтом, строкой в отчёт.

## 3. Анонсы — по журналу, не по памяти

- Перед хвостом прочитать журнал: `crm_request GET /api/v4/leads/900002826/notes?limit=50`.
  Листинг с id анонса там — не слать повторно (прецедент 11.10: семь дублей).
- Коннектор Unicorn_OS появляется с задержкой (15.10 — через ~10 минут после
  отчёта). Если после 4 поисков его нет — НЕ сдаваться и не считать работу
  сделанной: отчёт с текстами, а в следующем ходе/прогоне первым делом
  ToolSearch `+Unicorn_OS` и отправить.
- Каждый отправленный id → заметкой в журнал 900002826 (через коннектор; браузер
  на эту карточку отдаёт 404).

## 4. Фото в Drive-папке — сценарий Make 6640772

`property_private.drive_folder_url` есть, а в папке только док — **гейт не
пройден**. 13–14.10 так остались пустыми папки R-YUD-159…166.

Облачная сессия не скачивает картинки (curl → connect_rejected), Drive-коннектор
умеет только копировать файлы, уже лежащие в Drive. Поэтому фото кладёт сценарий
Make **6640772 «Listing photos -> Drive folder (Unicorn listings)»**
(команда 891458, подключение Google Drive 11268631; включён 15.10 с согласия
владельца): итератор по `files` → HTTP get → upload в `folderId`.

```
mcp__Make__scenarios_run(scenarioId=6640772, responsive=false,
  data={"folderId":"<id папки>",
        "files":[{"url":"<images[1]>","name":"01 <ID>.jpg"}, ...]})
```

Список `files` — из базы, в порядке галереи:

```sql
SELECT p.id, substring(pp.drive_folder_url from 'folders/([A-Za-z0-9_-]+)') fid,
  (SELECT json_agg(json_build_object('url',u,'name',lpad(o::text,2,'0')||' '||p.id||'.jpg') ORDER BY o)
     FROM unnest(p.images) WITH ORDINALITY t(u,o)) files
FROM properties p JOIN property_private pp ON pp.property_id=p.id WHERE p.id='<ID>';
```

- `responsive=false` — на 10+ файлах `true` отдаёт Bad Gateway (работа при этом идёт).
- Запуски подряд встают в очередь, ~5 с на файл.
- Проверка: Drive `search_files` `parentId = '<fid>' and mimeType contains 'image/'`
  → число файлов = `array_length(images,1)`. В отчёт: «Drive: N из N».
- Вебхук сценария 6374601 напрямую не дёргать (там секрет) — только `scenarios_run`.
- Галерею поменяли — залить новые кадры тем же сценарием.

## 5. Отчёт владельцу — первые строки

1. **Новых квалифицированных с прошлого прогона: N** (по `stage_changes` с момента
   прошлого прогона) — и какие.
2. Опубликовано и анонсировано: ID, спальни, район, цена, дата, id анонса.
3. Возвращено на сайт из драфта (п. 2).
4. Охват Б: сколько карточек QUALIFIED/Inspection без листинга и что с каждой.
5. Drive: фото N из N по каждому новому/изменённому листингу.
6. Не сделано — строкой с причиной и одним конкретным вопросом.

Коротко, без воды. Если «опубликован 1» — сразу объяснить почему (например:
«в QUALIFIED с прошлого прогона вошла 1 карточка»), а не оставлять владельца
гадать.
