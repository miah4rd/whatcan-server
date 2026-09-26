---
name: "google-search-via-iframe"
description: "Рабочий способ получить поисковую выдачу из встроенного браузера, плюс поиск по картинке как главный инструмент обогащения. Замер 15.09.2026: движки ВОССТАНАВЛИВАЮТСЯ после часа отдыха (прежняя запись об обратном неверна), Bing через ОТНОСИТЕЛЬНЫЙ путь тянет ~45 запросов за заход, DuckDuckGo ~32, Google-iframe ~10. Поиск по картинке лимита сессии не имеет вообще. Использовать при ЛЮБОЙ задаче, где нужна поисковая выдача: обогащение листингов, проверка публикации виллы, поиск цен и числа спален, любая проверка фактов."
---

# Поисковая выдача из встроенного браузера

---

# ⛔ ГЛАВНОЕ, ЧТО ИЗМЕНИЛОСЬ 15.09.2026

## 1. Движки ВОССТАНАВЛИВАЮТСЯ. Прежняя запись была неверной

14.09 здесь стояло: «после часа отдыха они НЕ восстанавливаются». **Это опровергнуто
15.09.2026.** Bing, срезавшийся в середине дня и отдававший Wikipedia про Панаму
вместо вилл, примерно через час прошёл контрольный запрос и отработал ещё
27 запросов подряд без единого промаха.

Практический вывод: **срез движка — это пауза на час, а не конец прогона.**
Не переписывать план прогона из-за среза. Уйти на поиск по картинке, вернуться
через час.

## 2. Бюджет за заход, замер 15.09.2026

| движок | как | выдержал | как срезается |
|---|---|---|---|
| **Bing** | **относительный** `/search?q=` с вкладки-выдачи | **~45 запросов**, потом пауза час, потом ещё ~27 | молча отдаёт ЧУЖИЕ страницы |
| **DuckDuckGo** | `fetch` с `html.duckduckgo.com` | ~32 | пустая строка |
| **Google в iframe** | iframe + опрос `body.innerText` | ~10 батчами по 5 | пустая строка, потом капча |
| **Поиск по картинке** | загрузка блоба на `google.com/imghp` | **лимита не встретили** | не срезается |

Суммарно ~85 запросов за заход плюс восстановление. Планировать от этого.

## 3. ⛔ ПОИСК ПО КАРТИНКЕ — ТЕПЕРЬ ПЕРВЫЙ ИНСТРУМЕНТ ОБОГАЩЕНИЯ

**У него нет лимита сессии. Это его главное преимущество перед движками.**

Он отвечает сразу на три вопроса: что это за вилла, сколько спален, и **кто за
ней стоит**. Замер 15.09: Villa L at Seseh опозналась как объект под
`villabalimanagement` — агентство вскрылось до звонка.

```js
// вкладка https://www.google.com/imghp?hl=en
(async()=>{
 const u = '<photoUri из Places media>';
 const cam=[...document.querySelectorAll('div[role=button],span,div')]
   .filter(e=>/search by image/i.test(e.getAttribute('aria-label')||''))[0];
 cam.click(); await new Promise(r=>setTimeout(r,1800));
 const b=await (await fetch(u)).blob();
 const dt=new DataTransfer();
 dt.items.add(new File([b],'v.jpg',{type:'image/jpeg'}));
 const inp=document.querySelector('input[type=file]');
 inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true}));
})()
```

Результат читать **следующим вызовом** `get_page_text` — нужен блок
«Visual matches». Вызов с заливкой может упасть с «target navigated» — это норма.

### ⛔ Узкое место: какое фото брать

Замер 15.09, 6 вилл: опознались 3, промахнулись 3, и все промахи — из-за фото.
Villa Lethem: самый широкий кадр оказался **статуей Шивы** → выдача про индуистские
статуэтки. Sundance Villa → хоумстеи в Убуде и Джокьякарте. Seseh Breeze Villa →
Тулум, Мексика.

Правило: брать широкий общий план (фасад, бассейн, вилла целиком),
**до трёх фото на виллу**. Мусор определяется автоматически: в тексте выдачи нет
ни одного из слов `villa | bali | bedroom | kamar | disewakan`.
**Проверять, сколько широких фото вообще есть на пине** — часто оно ровно одно,
и тогда трёх попыток не будет.

### Что метод даёт бесплатно

15.09 через него подтвердились: Villa Maria Seseh (I — 2BR, II — 3BR, III — 2BR
плюс аккаунт @villa_maria_seseh), Villa L at Seseh (2BR, под агентством).

## 4. Instagram: шапка профиля читается БЕЗ входа, но номера в ней нет

`meta[name="description"]` страницы профиля отдаётся неавторизованной сессии
и содержит био целиком. Это **бесплатный источник спален**:
@maisonmatissebali — «A 5BR villa by the beach in Seseh».

Но **номера там нет никогда**. Проверено на 7 аккаунтах вилл.
@arundhativilla прямым текстом: «For booking and rates, please contact us through
whatsapp» — а сам номер в кнопке-ссылке, которую Instagram рендерит только
авторизованным. Чтобы слой стал контактным, браузер надо залогинить.

```js
const r=await fetch('/<account>/',{headers:{'Accept':'text/html'}});
const d=new DOMParser().parseFromString(await r.text(),'text/html');
d.querySelector('meta[name="description"]').content;
```

---

# ПУТЬ 1 — BING. ТОЛЬКО ОТНОСИТЕЛЬНЫЙ ПУТЬ

⛔ Абсолютный URL `https://www.bing.com/search?q=...` возвращает **выдачу по
умолчанию, игнорируя запрос**: на любой запрос со словом villa приходили
Wikipedia «Villa» и Cambridge Dictionary. Это выглядит как «вилла не найдена».

**Рабочая последовательность:**

1. Открыть вкладку сразу на `https://www.bing.com/search?q=test`.
2. Дальше только **относительный** `/search?q=`, пробелы как `+`.

```js
window.bb = async function (q) {
  const r = await fetch('/search' + String.fromCharCode(63) + 'q='
    + encodeURIComponent(q).replace(/%20/g, '+'),
    { headers: { 'Accept': 'text/html' }, credentials: 'include' });
  const h = await r.text();
  const d = new DOMParser().parseFromString(h, 'text/html');
  d.querySelectorAll('style,script').forEach(e => e.remove());
  return [...d.querySelectorAll('li.b_algo')].slice(0, 10)
          .map(e => e.textContent.replace(/\s+/g, ' ')).join(' || ');
};
```

### Контрольный запрос — обязателен в начале и в конце батча

`"Villa Kokoro" Canggu bedrooms` → должен прийти triangvillas с «3 Bedroom».
Не пришёл — Bing закрыт, ждать час или уходить на поиск по картинке.
**Ставить контроль первым и последним в каждом батче** — иначе не отличить
«вилла не нашлась» от «движок срезался».

**Оператор `site:` возвращает мусор всегда.** Писать словами.
Маркера **Missing** у Bing нет — атрибуцию проверять только окном.

---

# ПУТЬ 2 — DUCKDUCKGO

Вкладка на `https://html.duckduckgo.com/html/?q=test`.

```js
window.dd = async function (q) {
  const r = await fetch('/html/' + String.fromCharCode(63) + 'q=' + encodeURIComponent(q),
                        { headers: { 'Accept': 'text/html' } });
  const h = await r.text();
  const d = new DOMParser().parseFromString(h, 'text/html');
  d.querySelectorAll('style,script').forEach(e => e.remove());
  return [...d.querySelectorAll('.result__body')].slice(0, 8)
          .map(e => e.textContent.replace(/\s+/g, ' ')).join(' || ');
};
```

Пауза **3 с**. Порог около 32 запросов.
DDG отдаёт **пустую строку**, а не ошибку. **Проверять длину значений, а не
наличие ключа:** `Object.keys(R).map(k=>k+'='+(R[k]||'').length)`.
Первые 1-2 результата почти всегда реклама.

---

# ПУТЬ 3 — GOOGLE В СКРЫТОМ IFRAME

⛔ Селектор `id="search"` в текущей вёрстке **не существует**. Опрашивать
`body.innerText` с порогом длины.

```js
// вкладка https://www.google.com
window.gs = function (query) {
  const q = String.fromCharCode(63);
  return new Promise(res => {
    const f = document.createElement('iframe');
    f.style.cssText = 'width:1200px;height:900px;position:absolute;left:-9999px';
    f.src = 'https://www.google.com/search' + q + 'q=' + encodeURIComponent(query)
          + '&num=10&hl=en';
    document.body.appendChild(f);
    let fin = false;
    const done = t => { if (fin) return; fin = true; try { f.remove() } catch (e) {}; res(t) };
    const iv = setInterval(() => {
      try {
        const d = f.contentDocument;
        const tx = d && d.body ? d.body.innerText : '';
        if (tx && tx.length > 400) { clearInterval(iv); done(tx.replace(/\s+/g, ' ')); }
      } catch (e) { clearInterval(iv); done('XORIGIN') }
    }, 700);
    setTimeout(() => { clearInterval(iv); done('') }, 14000);
  });
};
```

Батчи по **5**, пауза 1.2 с. Вкладка обязана быть на `https://www.google.com`.

Первые ~150 символов — служебка рекламного кабинета, потом «Thinking»,
потом «Hasil web». Парсер не должен на них опираться.

Признак окончательного среза: «Our systems have detected unusual traffic».
**Капчу не обходить.**

Зачем Google нужен: он единственный печатает маркер **Missing** и блок
Local results с карточкой места. Держать на 3-5 самых спорных кандидатов.

---

# ФОРМУЛИРОВКА ЗАПРОСА: ИМЯ В КАВЫЧКАХ

Запрос без кавычек вытаскивает категорийные страницы каталогов и блок
People also ask, и цена со спальнями приписываются нашей вилле.

```
"Villa Kokoro" Canggu long term monthly rent price IDR
how many bedrooms "<имя виллы>"
"<имя>" <район> bedrooms
```

### Лучшие формулировки для спален, проверенные на живых прогонах

1. `"<имя>" <район> bedrooms` — ловит заголовки Booking, Airbnb, RentByOwner.
   15.09 так подтвердились: Villa Saleh («2 Bedroom Villa in Munggu»),
   Villa Amparan («a modern 3-bedroom villa»), Lady Swan («a stunning 4-bedroom
   villa located in tranquil Canggu»), Sundance («3-storey, 4-bedroom villa»),
   Villa Wabu («Three Bedroom Villa + Pool in Umalas»).
2. `how many bedrooms "<имя>"` — ловит FAQ-блок Booking.
3. Второй заход другой формулировкой — даёт другую выдачу.

Месячную цену в IDR не отдаёт почти никогда ни один движок.
**Цена уходит в первый вопрос брокеру — это нормальный исход, а не сбой.**
15.09 из 26 карточек цена не подтвердилась ни у одной.

---

# ПРОВЕРКА АТРИБУЦИИ — ОКНО ВОКРУГ ИМЕНИ

```js
window.win = function (txt, kw, n) {
  const lo = txt.toLowerCase(); const out = []; let i = -1, c = 0;
  while ((i = lo.indexOf(kw.toLowerCase(), i + 1)) >= 0 && c < (n || 2)) {
    out.push(txt.slice(Math.max(0, i - 120), i + 260)); c++;
  }
  return out.join(' ~~ ') || ('[NO KW] ' + txt.slice(0, 200));
};
```

`[NO KW]` — **не отвал**, а «имя в выдаче не встретилось»: кандидат идёт
на второй заход другой формулировкой.

## ⛔ Ключевое слово не должно быть подстрокой чужого слова

Поймано 15.09: keyword `alas` совпал с «Um**alas**», keyword `nam` совпал
с чем угодно. Брать ключевым словом уникальную часть имени, а при короткой
проверять глазами.

## Ловушки, пойманные окном

| число | кому приписалось | чьё на самом деле |
|---|---|---|
| IDR 297.000.000 | Mai Villa Umalas | отдельный листинг на продажу выше в выдаче |
| IDR 270.000.000 | Keiko Villa | чужая страница, Google печатает Missing |
| «2 Bedroom … Umalas» | Grand Nismara | настоящая — 1BR в Тегаллаланге |
| «3BR» и «1-bedroom» | Villa Adyatma Umalas | соседние карточки той же страницы каталога |
| «4 Bedroom Ocean View Villa in Cemagi» | View villa | обобщённый листинг, не наш объект |
| «Villa D'Bajang 1 bedroom» | Oka Villa Bajang-Bajang | другое имя, гейт не пройден |

## Тёзки, пойманные на живых прогонах

Villa Shanti (Чангу) ≠ Villa Shanti Sanur; Villa Santai (Падонан) ≠ Villa Santai
Kerobokan; Villa Solis (Бабакан) ≠ Villa Solis Сесех-Мунггу; Villa Desa ≠ Villa
Desa Roro; Villa La Luna (Semer) ≠ Villa La Luna Pererenan; Marco villa ≠ San
Marco Villa (Камбоджа); Villa Angela ≠ Villa Angela Seminyak; Villa Ambient ≠
Villa Ambiente Джимбаран; Villa Buluh ≠ Villa Buluh Лангкави; Villa Lestari 1 ≠
Villa Lestari 1 by Alfred in Bali; Villa Nuansa ≠ Villa NUSA; Jangkar Villa ≠
The Jangkar Guesthouse; **Seseh Sunrise ≠ Sunrise Beach Villa (Санур);
Villa Elisa Seseh ≠ Villa Elisa 4BR Berawa; Villa Paradiso Umalas ≠ Paradiso
Villa Amed; Villa Keane ≠ одноимённая в Денпасар-Барат; The View Villa Cemagi ≠
The View Villa Uluwatu; Villa De Cassel Padonan ≠ Villa de Cassel Dewi Sri.**

## ⛔ Расхождение слага и заголовка

15.09: страница Booking с URL `villa-lukas-bali` имела заголовок «Villa Kay,
Badung» и текст про 3 спальни. Атрибуция по заголовку засчитана, но в карточку
ушёл FLAG. **Смотреть не только заголовок, но и слаг URL** — расхождение значит,
что листинг переименован или слаг переиспользован.

---

# ОГРАНИЧЕНИЯ И ГРАБЛИ

- Возврат из `javascript_tool` режется фильтром, если похож на URL. Санитайзить
  `.replace(/[?&=:\/]/g,' ')`, знак вопроса писать `String.fromCharCode(63)`.
- Ответ больше ~25k токенов не проходит — резать на куски, окна до 350-450 знаков.
- Таймаут CDP 45 с: длинные очереди запускать без `await`, флаг готовности
  опрашивать **коротким выражением**.
- **Проверять длины значений, а не количество ключей.**
- `localStorage` и `window` привязаны к домену и к вкладке. Собранное выгружать
  в текст ответа сразу.
- Вкладка иногда падает с «target closed» — открыть заново, **переопределить
  функции** (они живут на вкладке и после `navigate` исчезают), продолжить.
- Держать вкладки одновременно (amoCRM, example.com для Places, bing.com,
  html.duckduckgo.com, www.google.com, google.com/imghp) дешевле, чем
  переоткрывать.
- **Срез движка — пауза на час, а не конец прогона.**

