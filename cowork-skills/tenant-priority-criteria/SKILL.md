---
name: "tenant-priority-criteria"
description: "KEY FEATURES — четыре клиентских поля листинга Unicorn Property: garden, workspace, living_room, quiet_area, плюс внутренние construction_nearby и construction_checked_on. Что означают значения, откуда берутся, как спрашиваются у владельца, как подсвечиваются фотографиями в первых пяти кадрах и как учитываются при поиске новых листингов. Использовать при ЛЮБОЙ задаче про новый листинг, квалификацию карточки, добор данных по существующим объектам, отбор и порядок фотографий, подбор виллы под запрос клиента и при анализе дефицита каталога."
---

# KEY FEATURES — четыре критерия арендатора

Указание владельца бизнеса 16.09.2026, по итогам разбора переписок за весь период.
Это не «дополнительные удобства», а **четыре причины, по которым клиент говорит нет**.

## Поля

Клиентские, в `public.properties`:

| Поле | Значения | Смысл |
|---|---|---|
| `garden` | `none` · `small` · `large` | `small` — зелёный дворик, полоска газона. `large` — газон, где поместятся дети или собака |
| `workspace` | `none` · `desk` · `office_room` | `desk` — нормальное место для работы. `office_room` — отдельная комната |
| `living_room` | `open` · `enclosed` | `open` — open-plan или открытая наружу. `enclosed` — стены и двери, можно кондиционировать |
| `quiet_area` | `true` · `false` | `true` — тихая улица: ни баров, ни главной дороги, ни стройки по соседству |

Внутренние, в `public.property_private`, **только для брокеров, наружу не выводятся**:

| Поле | Смысл |
|---|---|
| `construction_nearby` | стройка по соседству |
| `construction_checked_on` | дата, когда вопрос реально проверяли |

## ⛔ NULL = не проверяли. Никогда не угадывать

`NULL` — нормальное состояние для pre-listed объекта, а не дефект. Объект с `NULL`
из выдачи не исключается, он показывается с пометкой «не уточнено».

Проставлять значение «по логике», «по умолчанию» или «раз не написано, значит нет»
запрещено. Пустое поле честнее выдуманного.

Почему это жёстко. `construction_nearby` изначально было `NOT NULL DEFAULT false`:
130 строк утверждали «стройки нет», хотя никто не смотрел. 16.09.2026 поле
сделано nullable, недатированные `false` сброшены.

## ⛔ «Стройки нет» — только с датой

`construction_nearby = false` ставится **только** по осмотру, подтверждению
владельца или отзыву не старше 3 месяцев, и **всегда вместе с датой**:

```sql
UPDATE public.property_private
   SET construction_nearby = false, construction_checked_on = '2026-09-16'
 WHERE property_id = 'R-YUD-091';
```

Без даты триггер понижает значение до `NULL` — база хранит это как «не проверено».

Упоминание стройки в примечании, red flag или отзыве → `construction_nearby = true`.

**База отказывает в `quiet_area = true`, пока `construction_nearby = true`.**
Триггер бросает исключение; сначала снимается стройка, с датой.

---

## ОТКУДА БЕРЁМ, В ЭТОМ ПОРЯДКЕ

### 1. Вилла осмотрена
Google-док Юди в Drive-папке листинга (`property_private.drive_folder_url`) и
блок Internal data: `property_private.notes`, `red_flags`, `green_flags`.

**Известная поломка процесса, проверено 16.09.2026:** `green_flags` пуст у всех
95 живых арендных листингов, `red_flags` заполнен у двух. Данные осмотра в базу
фактически не попадают — живут только в доках. Поэтому док читается напрямую, а
после каждого осмотра значения пишутся в `properties` сразу.

### 2. Вилла на стадии pre-listed
Её собственные **Airbnb и Booking**: фотографии и **отзывы за последние 6 месяцев**.
Отзывы — недооценённый источник: про шум, стройку и открытую гостиную гости
пишут прямым текстом.

### 3. Ни один источник не показывает ясно
Оставляем `NULL`.

### Что читается надёжно, а что нет
- **`living_room`.** «enclosed living», «fully enclosed», «air-conditioned living
  room» → `enclosed`. «open-plan», «open living», «open-air living» → `open`.
- **`garden`.** ⛔ **Садовник — не сад.** «gardener», «garden staff», «pool and
  garden staff», «garden maintenance» — строки из списка услуг, дают ложное
  срабатывание, отсекать до поиска. Замер 16.09.2026: из 72 совпадений по слову
  `garden` восемнадцать были садовником. Размерный класс `small` / `large` из
  текста не выводится почти никогда — смотреть фото.
- **`workspace`.** «office room», «study room», «home office» → `office_room`.
  «work desk», «workspace», «desk» → `desk`. Упоминается редко.
- **`quiet_area` и стройка.** ⛔ Из описания OTA не выводятся **никогда**. Только
  осмотр, слова владельца, свежий отзыв или спутник Google Maps.

---

## ВОПРОСЫ ВЛАДЕЛЬЦУ ПЕРВЫМ КАСАНИЕМ

Добавляются к спальням, метражу, цене и дате из `listing-qualification-standard`,
одним сообщением.

**English:**
```
A few more things our clients always ask about:
5. Is the living room enclosed and air-conditioned, or open-plan?
6. Is there a garden, and roughly how many m2?
7. Is there a separate room that can be used as a home office, or a desk?
8. Is there any construction going on next to the villa right now?
```

**Bahasa Indonesia:**
```
Beberapa hal lagi yang selalu ditanyakan klien kami:
5. Ruang tamunya tertutup dan pakai AC, atau open-plan?
6. Ada taman tidak kak, kira-kira berapa m2?
7. Ada ruangan terpisah yang bisa dipakai buat home office, atau meja kerja?
8. Saat ini ada pembangunan atau proyek di sebelah villa tidak?
```

**Эти вопросы не блокируют QUALIFIED.** Базовые условия прежние: спальни, цена с
позицией по комиссии, право сдавать, долгосрок.

---

## ⛔ ФОТО: ДОКАЗАТЕЛЬСТВО — В ПЕРВЫХ ПЯТИ КАДРАХ

Есть сад, рабочее место или закрытая гостиная — кадр, который это показывает,
обязан стоять **среди первых пяти фотографий галереи**.

Обложка выбирается по прежнему правилу (`listing-photo-standard`): бассейн или
фасад, здание виллы в кадре. Доказательные кадры идут сразу за ней.

| Критерий | Что должно быть на кадре |
|---|---|
| `garden` | зелень общим планом, газон, деревья — не угол клумбы |
| `workspace` | стол, стул, розетки; отдельная комната лучше стола в спальне |
| `living_room = enclosed` | гостиная со стенами и дверями, видно кондиционер или закрытую стеклянную стену |

**Кадр рабочего места ценнее пятой почти одинаковой спальни.** При урезании
набора до 20 эти сюжеты оставляем в первую очередь.

Значение стоит `true`, а кадра нет — пишем в `property_private.notes`, что
доказательства нет, и просим у владельца или снимаем на выезде.

---

## ПОИСК НОВЫХ ЛИСТИНГОВ

Работает вместе с `bali-catalog-sourcing-rule`, `listing-card-standard`,
`bali-demand-matrix`.

Критерий добора формулируется **парой**, не только спальнями и ценой:
не «2BR за 30–40», а **«2BR за 30–40 с закрытой гостиной»**.

Замер 16.09.2026 показал, почему: в самой дефицитной ячейке — 2BR за 30–40 млн
по Pererenan, Canggu и Seseh — шесть живых объектов, `enclosed` ровно у одного,
три явно `open`. Дефицит по спальням и цене считается оптимистично: часть стока
клиенту не подойдёт по причине, которую мы не видим.

Новый объект без ответов листится нормально, с `NULL`. Молчание не повод не листить.

## ПОДБОР ПОД ЗАПРОС КЛИЕНТА

Клиент назвал критерий — показываем совпадения, следом отдельной группой объекты
с `NULL` и пометкой «не уточнено, проверим». Объекты с противоположным значением
убираем.

⛔ Не подставлять `NULL` под совпадение. Клиент, просивший закрытую гостиную и
получивший три открытые коробки, — это и есть та потеря, ради которой поля
заводились.

## ЗАПРОСЫ

Беклог:
```sql
SELECT id, title, area, garden, workspace, living_room, quiet_area
  FROM public.properties
 WHERE listing_type = 'rent' AND is_draft = false
   AND (garden IS NULL OR workspace IS NULL OR living_room IS NULL OR quiet_area IS NULL)
 ORDER BY id;
```

Заполнение:
```sql
UPDATE public.properties
   SET garden = 'large', workspace = 'office_room',
       living_room = 'enclosed', quiet_area = true
 WHERE id = 'R-YUD-091';
```

Состояние на 16.09.2026, 95 живых объектов: `living_room` известен у 61
(32 enclosed, 29 open), `quiet_area` у 12 (все `false`), `garden` и `workspace`
не заполнены — предыдущая булева версия полей не давала размерного класса и
не различала стол и комнату, поэтому переносить её было бы угадыванием.

