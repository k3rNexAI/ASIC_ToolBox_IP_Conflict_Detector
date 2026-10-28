# Разбор внутренних и внешних API ASIC ToolBox

## Область и способ чтения

Документ описывает фактические вызовы в исходниках репозитория. Номера строк относятся к актуальному `server.js`, `miner-compat.js`, `mix-algorithm.js` и `public/*.js` на момент анализа. Внешние Braiins-методы показаны в той мере, в которой их вызывают и разбирают исходники; это не замена официальным protobuf/REST спецификациям. Там, где код читает только часть JSON-ответа, полная внешняя схема обозначена как неизвестная, а не восстановлена догадками. Зависимости `node_modules` отдельно не разбираются.

## Общая схема вызова

```text
Браузер public/*.js
  └─ fetch /api/...                         внутренний HTTP API
      └─ server.js route handler
          ├─ данные: state.json, maps.json, saves/
          ├─ scanIps → scanOne
          │    ├─ REST → Braiins ASIC
          │    ├─ grpcurl → Braiins Public gRPC
          │    ├─ TCP JSON → BOSminer/CGMiner API
          │    └─ SSH → NoPIC настройка (отдельные условия)
          ├─ normalizeCgminerResult (miner-compat.js)
          └─ mixes (mix-algorithm.js)
```

Внутренний маршрут — HTTP API локального процесса, доступное браузеру приложения. Внешнее API — исходящий запрос от Node-сервера непосредственно к IP майнера. Внешний трафик не идёт напрямую из браузера к ASIC: credentials и протокольные запросы обрабатывает сервер.

## Внутренний HTTP API

По умолчанию сервер слушает `127.0.0.1:4180`. Общая развилка маршрутов находится в `server.js:1302–1305`; JSON helper `json()` задаёт `Content-Type: application/json; charset=utf-8` и `Cache-Control: no-store` (`488–494`). Тело читается `body()` целиком и парсится JSON без явного ограничения размера (`495–499`). Не-API запросы передаются `serveFile()` для отдачи UI (`1219–1245`). Маршрут сравнивается с `req.method` и `req.url`.

### Каталог внутренних маршрутов

| Метод и путь | Назначение и вызывающий код | Основной результат / эффект |
|---|---|---|
| `GET /api/scanner-settings` | Первичная загрузка панели `public/scanner-settings.js:188–200` | Текущие настройки сканера и `passwordConfigured`; см. замечание о секрете ниже. |
| `POST /api/scanner-settings` | Submit панели `scanner-settings.js:151–185` | Валидирует/сохраняет настройки, перестраивает REST agent. |
| `GET /api/scan-all/progress` | Polling `public/maps.js:553–569` | Снимок текущего состояния пакетного скана. |
| `POST /api/scan/cancel` | Кнопки отмены `public/app.js:465–475`, `public/maps.js:804` | Abort текущего scan/scan-all. |
| `GET /api/health` | Внешний health-check / локальная диагностика | Статус процесса и флаги блокировок, не здоровье ASIC. |
| `GET /api/backup/export` | Скачать резервную копию | JSON attachment с конфигурацией и сохранениями; импорта нет. |
| `GET /api/cods` | Стартовые загрузки `app.js`, `guide.js`, `map-builder.js`, `maps.js` | Список ЦОДов. |
| `GET /api/state-diagnostics` | При пустом списке ЦОДов `public/app.js:957–962` | Отчёт о чтении `state.json`/`state.js`. |
| `POST /api/cods` | Создать ЦОД из формы `public/app.js:344–376` | Валидация имени/IP; запись в `state.json`. |
| `PATCH /api/cods/:id` | Сохранить редактирование формы | Частичное обновление и запись состояния. |
| `POST /api/cods/reorder` | `moveCod()` в `public/app.js:135–153` | Проверка полного набора ID и сохранение порядка. |
| `DELETE /api/cods/:id` | Кнопка удаления в `public/app.js:46–111` | Удаляет запись ЦОДа из state. |
| `GET /api/maps` | Получить все карты | Возвращает содержимое `maps.json` или `{}`. |
| `GET /api/maps/:id` | Редактор/карты, `map-builder.js:121–140`, `maps.js:419–435` | Возвращает сохранённую или default-карту. |
| `PUT /api/maps/:id` | Сохранение карты `map-builder.js:151–166`, `app.js:879–896` | Нормализует ячейки, записывает карту. |
| `POST /api/scan` | Одиночное сканирование из `public/app.js:414–464` | Скан одного ЦОДа, сводка и миксы. |
| `POST /api/scan-all` | Массовый скан из `public/maps.js:438–503`; также `app.js:914–948` | Скан карт нескольких ЦОДов, общий прогресс и миксы. |
| `POST /api/monitor` | Циклический мониторинг `app.js:562–614`, `maps.js:745–788` | Повторно проверяет переданные устройства. |
| `GET /api/saves` | `refreshSavedSets()` в `public/app.js:654–668` | Перечень сохранённых наборов. |
| `POST /api/saves` | Кнопка сохранения в `public/app.js:670–696` | Создаёт набор JSON-файлов сохранения. |
| `GET /api/saves/:id` | Кнопка загрузки `public/app.js:698–718` | Загружает manifest, recipients, donors, mixes. |
| `POST /api/boards/configure` | Управление платами/NoPIC из UI, `app.js:720–752`, `maps.js:688–724` | Включает/отключает платы через gRPC, может менять NoPIC по SSH. |
| `POST /api/boards/enable` | Серверная вспомогательная операция; прямой caller не найден в `app.js`/`maps.js` | Включает все платы через gRPC. |
| `POST /api/miner/resume` | Resume-кнопка карт `public/maps.js:659–677` | Авторизуется и посылает внешний Braiins REST Resume. |

### Настройки, диагностика и отмена

**`GET /api/scanner-settings` (`server.js:1306–1307`).** Панель создаётся в `public/scanner-settings.js`; начальный GET выполняется при загрузке, и Promise сохраняется как `window.scannerSettingsReady` (`188–200`). Ответ формируется `publicScannerSettings()` (`server.js:179–182`). В нём spread всех `scannerSettings` плюс `passwordConfigured: Boolean(password)`. Это означает, что код фактически отправляет клиенту и `password`, хотя README утверждает обратное (`README.md:69–71`). Это приоритетное исправление безопасности.

**`POST /api/scanner-settings` (`server.js:1308–1360`).** UI отправляет `protocol`, числовые batch/max-IP, timeout-ы и порты для REST/gRPC/legacy, `restSocketsPerDevice`, boolean `restKeepAlive`, `username`, `password`, `clearPassword` (`scanner-settings.js:151–180`). Сервер разрешает протоколы `rest|grpc|legacy|auto|hybrid`; проверяет диапазоны и типы (`server.js:80–132,1310–1335`), сохраняет пустой пароль как старый, если не запрошено `clearPassword` (`1347`), пишет `scan-settings.json`, пытается поставить chmod 0600 и меняет runtime настройки/REST agent (`1349–1359`). Ответ — обновлённые настройки и `applied:true`. Некорректные поля дают 400 `{error}`.

**`GET /api/scan-all/progress` (`1362–1363`).** Отдаёт копию внутреннего `scanProgress` (`186–196`): состояние, completed/total, индекс/имя текущего ЦОДа, `startedAt`, cancel flags, а после завершения — `finishedAt`. UI `maps.js` опрашивает endpoint каждые 450 мс, исключая параллельные запросы и устаревший `startedAt` (`553–569`). Это process-global состояние, не отдельное на браузерную сессию.

**`POST /api/scan/cancel` (`1364–1370`).** Тела не требует. Нет активного scan — 409; иначе помечает отмену и вызывает `AbortController.abort()`, ответ 200 `{ok:true,cancelRequested:true}`. Controller устанавливается в `/api/scan` и `/api/scan-all` и очищается в `finally`. Abort передаётся сетевым запросам сканирования; уже начатые отдельные операции управления платами не обязательно принимают этот signal.

**`GET /api/health` (`1371–1378`).** Возвращает `ok`, имя приложения, время и boolean `scanRunning`/`monitorRunning`. Эти флаги — блокировки процесса, а не состояние майнеров. Не требует тела и не инициирует сетевых вызовов к ASIC.

**`GET /api/state-diagnostics` (`1400–1418`).** Отдаёт наличие/путь/число записей/ошибку чтения у `state.json` и `state.js`, и `selected` источник. Вызывается UI, если `/api/cods` вернул пустой список. Ошибки чтения отражаются полем `error`, а не обязательно HTTP 500. Фактический парсер `state.js` ограничен: комментарии и JS-литералы с одинарными кавычками могут не пройти JSON.parse (`server.js:203–261`).

### ЦОДы и карты

**`GET /api/cods` (`server.js:1389–1399`).** Возвращает распознанные записи, дополненные `ec` и `order`, сортирует по порядку. Источник читается из `state.json`, при необходимости пробуется legacy `state.js` (`241–272`).

**`POST /api/cods` (`1420–1442`).** UI-форма посылает `name,start,end,cidr,ec`. Требуется валидное имя; адрес задаётся либо диапазоном, либо CIDR, который проверяет `expandRange`. Успех 201: новая запись с UUID, нормализованными полями, order и createdAt; она сохраняется в state. Ошибка имени/IP/слишком большого диапазона — 400.

**`PATCH /api/cods/:id` (`1443–1471`).** Обновляет существующую запись; неизвестный id — 404. Имя и адреса валидируются при передаче, `ec` обрезается, `order` принимается как целое; успех — обновлённая запись. **`POST /api/cods/reorder` (`1472–1484`)** принимает `{ids:[...]}`; после удаления неизвестных и дублей список обязан содержать все ID ровно по одному, иначе 400. **`DELETE /api/cods/:id` (`1485–1489`)** отвечает `{ok:true}` и фильтрует запись; код маршрута не проверяет, существовал ли ID, и не удаляет связанную карту из `maps.json`.

**`GET /api/maps` (`1490–1493`).** Отдаёт весь объект карты; ошибка чтения `maps.json` у `readMaps` превращается в `{}`. **`GET /api/maps/:id` (`1494–1500`)** отдаёт сохранённую карту или объект по умолчанию, если ЦОД существует, иначе 404. **`PUT /api/maps/:id` (`1501–1531`)** принимает JSON с размерами и ячейками. Сервер понимает `racks`, `shelves`, `devicesPerShelf`, преобразует их к целым минимум 1, ограничивает список cells вместимостью, вычисляет slot/rack/shelf/position и нормализует ip. Сохраняет `maps.json` атомарно и оставляет `.bak`.

Несоответствие: UI `app.js:883–891` может отправлять `columns` и `rows`, тогда как серверный PUT читает `racks/shelves/devicesPerShelf`. Для этого caller будут применены default-размеры. Builder `map-builder.js` использует rack-поля и соответствует контракту. DELETE ЦОДа не удаляет карту.

### Сканирование и мониторинг

**`POST /api/scan` (`server.js:1819–1870`).** UI отправляет `{codId, protocol}` (`app.js:432–436`). Сервер находит ЦОД и, если у него есть валидные уникальные IP карты, сканирует их; иначе разворачивает CIDR/range. Вызывает `scanIps`, добавляет `scanScope`, сводку и `mixes`. Ответ 200 включает поля результата; 404 — нет ЦОДа, 409 — другой scan/monitor держит lock, 400 — лимит/входная ошибка, 500 — необработанная ошибка.

**`POST /api/scan-all` (`1533–1642`).** Принимает опциональные `codIds`, `protocol`, `demo`; пустой `codIds` означает все ЦОДы. Live-режим использует IP из карт (в отличие от `/api/scan`, он не обязан fallback-иться к IP диапазону). Demo использует шаблонные результаты. ЦОДы обрабатываются последовательно, IP внутри каждого ЦОДа — ограниченным пулом worker-ов. Ответ содержит `{scannedAt, protocol, results, cancelled}`; каждый result включает данные ЦОДа, devices, summary, mixes и признаки карты. Блокировка/progress гарантированно сбрасываются через `finally`.

**`POST /api/monitor` (`1777–1817`).** Принимает `{recipients:[Device], protocol?}`, дедуплицирует записи по IP и вызывает `scanOne` для каждого. Пустой список — 400; параллельный scan/monitor — 409. Ответ 200 `{checkedAt,protocol,devices}`. Периодические 5-секундные таймеры находятся в `app.js` и `maps.js`, а не на сервере. В режиме hybrid сервер отдельно выбирает протокол по `firmwareFamily`: Braiins/unknown проверяется REST, прочее legacy; если Braiins/unknown остаётся offline, делается legacy fallback (`1791–1810`).

Маршруты скана не возвращают HTTP-ошибку за каждый неответивший ASIC: `scanOne()` после исчерпания протоколов возвращает offline-record с `error`. Отдельно HTTP 500 означает необработанную ошибку обработчика. `/api/scan` строит IP из карты или диапазона; live `/api/scan-all` работает с картой; это важное различие.

### Сохранения и backup

`GET /api/saves` (`1643–1644`) обходит `saves/`, читает manifest-ы и сортирует по времени. `POST /api/saves` (`1645–1689`) принимает `codId`, `codName`, `ec`, массивы `recipients`, `donors` и `mixes`; проверяет только массивы recipients/donors, создаёт `saves/YYYY-MM-DD/<имя>/save-NNN/` и пишет `manifest.json`, `recipients.json`, `donors.json`, `mixes.json`. Ответ 201 — manifest. `GET /api/saves/:id` (`1691–1704`) читает эти четыре файла; ошибка/недостающий файл даёт 404.

`GET /api/backup/export` (`1379–1388`) собирает backup через `buildBackup()` (`1271–1301`): state, maps, legacy state text и JSON-дерево saves. Отдаёт JSON как attachment, исключая `.bak`/`.tmp`. Автоматического импорта нет. Сохранение отдельных файлов набора выполняется последовательно, поэтому при ошибке возможна частично созданная папка. `savePath()` предотвращает выход за корень saves (`325–332`).

### Управление оборудованием

**`POST /api/boards/configure` (`1706–1756`).** Body `{devices:[{ip,boards:[{id,enabled}],nopicMode?}]}`. Каждый ASIC обрабатывается независимо и параллельно. Сначала gRPC Login, затем `EnableHashboards` и/или `DisableHashboards` с `saveAction: SAVE_ACTION_SAVE_AND_APPLY`. При `nopicMode` строго `enabled|disabled` дополнительно меняется конфиг по SSH. Ответ 200 `{results:[...]}` может включать per-device ошибки; HTTP 400 — пустой набор устройств. Валидация формата IP/id и rollback транзакции ограничены.

**`POST /api/boards/enable` (`1758–1763`).** Body `{recipients:[...]}`; вызывает `enableAllBoards()` (`359–395`): login; если список плат пуст, gRPC `GetHashboards`; затем `EnableHashboards` для всех полученных IDs. Пустой recipients — 400; результат — `{results:[...]}` с успехами/ошибками по устройствам. Прямой browser caller в `public/app.js`/`maps.js` не найден; основные кнопки используют `/api/boards/configure`.

**`POST /api/miner/resume` (`1764–1775`).** UI присылает `{ip}`. Сервер проверяет IPv4, логинится по Braiins REST, извлекает токен и вызывает внешний `PUT /api/v1/actions/resume` без тела. Успех 200 `{ok:true,result}`; некорректный IP — 400, сетевой/API отказ обычно становится 500. Это команда с реальным побочным эффектом на ASIC.

## Внешние API ASIC

Внешние запросы исходящие: server соединяется с адресом ASIC на соответствующем порту. Стандартные настройки: REST HTTP/80, Braiins gRPC/50051, legacy TCP/4028, username/password `root/root`, REST timeout 4500 ms, gRPC 6000 ms, legacy timeout 1300 ms, batch concurrency 12, max IP 4096 (`server.js:80–99`). Значения нормализуются/ограничиваются в `server.js:101–132`.

### Braiins REST API — HTTP

Клиент `restCall()` (`server.js:598–671`) использует Node `http.request` к `ip:restPort`, общий keep-alive agent и HTTP без TLS. Payload сериализуется в JSON; задаются content-type/length. Ответ UTF-8 ограничен 2 MiB, требуется 2xx, пустое тело становится `{}`, непустое разбирается как JSON. Timeout/abort закрывает запрос; неверный статус или JSON — ошибка. Авторизационный токен кладётся в заголовок `authorization` как есть (`627–645`); код не добавляет видимый `Bearer ` префикс.

| ASIC method/path | Caller и назначение | Payload/результат, обязательность |
|---|---|---|
| `POST /api/v1/auth/login` | `restScanOne()` перед каждым REST scan (`673–680`); также `/api/miner/resume` (`1768–1773`) | JSON `{username,password}`; токен читается из `token`, `sessionToken` или `session_token`. Нет токена — ошибка. |
| `GET /api/v1/miner/details` | `restScanOne()` параллельно с hashboards/errors/cooling (`681–690`) | Без тела; обязательный запрос. Модель/версия/состояние извлекаются из нескольких полей, указанных в `691,720–726,753–759`. |
| `GET /api/v1/miner/hw/hashboards` | Та же параллельная группа (`682–684`) | Без тела; обязательный запрос. Код ищет `hashboards`, `hashBoards` или `boards`, использует максимум три платы (`692–715`). |
| `GET /api/v1/miner/errors` | Та же группа (`685–688`) | Best effort: ошибка превращается в пустой список плюс диагностическая заметка. Извлекаются messages/errors/reasons, timestamp/components (`728–750`). |
| `GET /api/v1/cooling/state` | Та же группа (`689–690`) | Best effort; ошибка -> `{fans:[]}`. Код читает массив `fans` и передаёт к UI (`770`, `public/maps.js:153`). Не описан в `docs/BRAIINS_API.md`. |
| `PUT /api/v1/actions/resume` | Внутренний `POST /api/miner/resume` (`1774`) | Без тела, после login; успех обёрнут в `{ok:true,result}`. Не описан в `docs/BRAIINS_API.md`. |

Основные запросы details/hashboards нужны для записи скана; errors и cooling необязательны. Они выполняются параллельно после одного login (`server.js:681–690`). `restScanOne()` преобразует внешние данные в единый объект: модель, версию, максимум 3 платы, chips/hashrate/working, ошибки, fans, `workingBoards`, `ratio`, `failedBoards`, `status` (`691–786`). Схема ответа ASIC полностью не фиксируется приложением — перечислены лишь поля, которые код фактически читает.

### Braiins Public API — gRPC

`grpcCall()` (`server.js:580–595`) запускает `grpcurl -plaintext -format json`, указывает `ip:grpcPort` и fully qualified service/method, передаёт тело через `-d` только если оно задано, токен через `-H authorization:...`. Timeout ограничен `grpcTimeoutMs` (минус небольшая поправка для grpcurl max-time), `maxBuffer=1 MiB`; Signal может остановить process. Stdout парсится как JSON, пустой — `{}`. Нет внешней TLS-команды: transport явно `-plaintext`.

| Braiins gRPC method | Где вызывается | Request, обработка |
|---|---|---|
| `braiins.bos.v1.AuthenticationService/Login` | `gRPCScanOne()` (`811–820`), `enableAllBoards()` (`365–370`), `/api/boards/configure` (`1715–1720`) | JSON credentials `{username,password}`, без token. Ответ ожидается с `token` либо `sessionToken`; отсутствующий токен — ошибка. |
| `braiins.bos.v1.MinerService/GetMinerDetails` | `gRPCScanOne()` (`821–824`) | Без явного тела, с token и abort signal; обязательный запрос. |
| `braiins.bos.v1.MinerService/GetHashboards` | `gRPCScanOne()` (`821–824`); при пустом списке в `enableAllBoards()` (`373–378`) | Без тела при scan; обязательный запрос scan. При enable используется список для определения IDs. |
| `braiins.bos.v1.MinerService/GetErrors` | `gRPCScanOne()` (`824–826`) | Необязательный; ошибка заменяется `{errors:[]}`. |
| `braiins.bos.v1.CoolingService/GetCoolingState` | `gRPCScanOne()` (`827–829`) | Необязательный; ошибка заменяется `{fans:[]}`. |
| `braiins.bos.v1.MinerService/EnableHashboards` | `/api/boards/enable` через `enableAllBoards()` (`384–388`); `/api/boards/configure` (`1726–1731`) | `{saveAction:'SAVE_ACTION_SAVE_AND_APPLY',hashboardIds:[...]}` плюс token. |
| `braiins.bos.v1.MinerService/DisableHashboards` | `/api/boards/configure` (`1733–1738`) | Та же форма, список отключаемых ID плюс token. |

`gRPCScanOne()` запускает login, затем details/hashboards/errors/cooling параллельно; login, details и hashboards критические, errors/cooling — best-effort. Результат преобразуется в тот же объект device, что и REST: максимум три платы, температуры, состояние, скорость и error logs (`server.js:811–892`). Управление платами возвращает сырые JSON-ответы gRPC в result, а не ту scan-модель.

В `docs/BRAIINS_API.md:25–27` перечислены Login, GetMinerDetails, GetHashboards, GetErrors. В исполняемом коде есть ещё `GetCoolingState`, `EnableHashboards`, `DisableHashboards`. Полные proto message schemas из вызовов не извлекаются, потому что grpcurl используется без reflection/schema файлов в этой части; не следует считать приведённые ожидаемые поля исчерпывающим API контрактом Braiins.

### BOSminer / CGMiner-compatible legacy API — TCP

Внешняя сторона — raw TCP на `ip:legacyPort` (обычно 4028), а не HTTP и не gRPC. `apiCall()` (`server.js:539–574`) открывает сокет, отправляет `JSON.stringify({command}) + '\n'`, накапливает chunks, удаляет NUL, выбирает от первого `{` до последнего `}` и парсит JSON (`530–563`). По окончании сокета выполняется последняя попытка parse. Таймаут применяется к каждой команде отдельно; отмена уничтожает socket. Отдельного login/TLS в этом коде нет.

`scanOneLegacy()` (`895–940`) запускает параллельно пять команд: `version`, `summary`, `devs`, `devdetails`, `stats` (`901–907`). Ошибка отдельной команды обычно заменяется `{}`, кроме abort. Для продолжения нужны некоторые данные SUMMARY/DEVS/DEVDETAILS/STATS; иначе весь legacy scan отклоняется (`908–918`). Документация `docs/BRAIINS_API.md:29–31` упоминает `version`, `devdetails`, `devs`, `edevs`, но код фактически не вызывает `edevs`, вместо него вызывает `summary` и `stats`.

`normalizeCgminerResult()` (`miner-compat.js:115–245`) принимает варианты регистра/формата блоков, соотносит плату и детали по ID либо индексу, определяет model, chips, status и hashrate. `cgminerHashrateGh()` распознаёт известные rate fields/единицы и переводит их в GH/s (`47–90`). Плохие статусы/нулевой rate делают плату неисправной; firmware family и miner state вычисляются эвристиками (`179–216`). Нормализованная запись получает `ratio`, failedBoards и errorLogs. В коде нет схемы ответа для всех CGMiner-клонов; поддерживается ожидаемый набор массивов/ключей.

### SSH для NoPIC — чтение и изменение

SSH реализован через библиотеку `ssh2` (`server.js:9`), credentials из настроек scanner, TCP/22. Это вспомогательный путь, а не один из трёх протоколов сканирования.

- `readNoPicExperimentalMode(ip, signal)` (`397–437`) читает `/etc/bosminer-experimental.toml`, ищет последний ключ `allow_disabling_hashboards_on_nopic_miners`, нормализует `true` к `enabled`, `false`/пустое — `disabled`, другое — `unknown`. Есть timeout 7 секунд, `readyTimeout` 5 секунд и abort.
- `attachNoPicMode(device, ip, signal)` (`438–454`) опрашивает лишь online Braiins-устройства некоторых проблемных статусов; SSH ошибка не делает ASIC offline, а даёт `unknown`.
- `setNoPicExperimental(ip, enabled)` (`455–487`) через SSH создаёт временный конфиг и перемещает его поверх файла; общий timeout 12 секунд. Вызывается при `/api/boards/configure`, если передан режим `enabled` или `disabled`.

Чтение запускается после успешного scan в `scanOne()` (не для legacy) и при REST enrichment (`server.js:983–984,1051–1059`). Запись выполняется после gRPC enable/disable в `boards/configure` (`1742–1743`). Изменения gRPC не откатываются, если SSH write завершится неудачно; endpoint возвращает ошибки по каждому ASIC. Команда работает с удалённым файлом от учётной записи SSH, поэтому это реальный side effect.

Код не показывает настройки SSH key или явную pinning-проверку host key. Файл TOML правится заменой строк и добавлением параметра в конец; код не подтверждает последующим чтением, что прошивка приняла новое значение. Эти замечания относятся к аудиту реализации, не к утверждению о слабости самого протокола SSH.

## Правила fallback и нормализация

`scanProtocolOrder()` из `miner-compat.js:11–17`:

- `auto` → `rest`, затем `grpc`, затем `legacy`;
- `hybrid` → `legacy` (название может быть неочевидно; после быстрого legacy предусмотрен REST enrichment для подходящих устройств);
- иное выбранное значение → один протокол.

`scanOne()` последовательно пробует выбранные варианты, возвращает первый успех, накапливает текст ошибок; если всё не удалось, возвращает offline device, а не HTTP error (`server.js:955–992`). `scanIps()` ограничивает входные IP и concurrency, добавляет время ответа/скана (`1011–1088`). Для hybrid/legacy кандидаты `needsRestBoardDetails()` могут получить REST enrichment (`miner-compat.js:19–26`, `server.js:1041–1075`). Авто-режим может занимать дольше из-за последовательных неудачных попыток.

## Ошибки и семантика ответов

- HTTP 400 — серверная валидация запроса; 404 — отсутствующая запись/сохранение; 409 — конфликт блокировок или отмены; 500 — исключение в обработчике (все ветки точнее описаны выше).
- Ошибка одного ASIC часто отражается как device `online:false` или как per-device `ok:false`, при этом общий маршрут может вернуть 200.
- Ошибки внешних optional endpoints Braiins errors/cooling подавляются как пустые данные; ошибка основного login/details/hashboards обычно влияет на попытку протокола и fallback.
- Ответы внутренних scan endpoints формируются spread-ом объектов, а не отдельными версиями OpenAPI; формальная схема не определена.
- Внешние REST/gRPC ответы нормализуются только по конкретным доступным полям; полную схему официального Braiins API нужно сверять с версией firmware и актуальными proto/API definitions.

## Находки и рекомендации для следующего этапа

1. **Секрет в ответе настроек.** `publicScannerSettings()` возвращает `...scannerSettings`, включая пароль (`server.js:179–182`); исправить до дальнейшего расширения API.
2. **У внутреннего API нет формального описания.** Зафиксировать схемы OpenAPI/JSON Schema, статусы, error shape и лимиты тел запросов.
3. **POST body без верхнего лимита.** `body()` копит произвольные chunks (`server.js:495–499`); добавить maxBytes и 400/413.
4. **Несогласованность карты.** `app.js` отправляет `columns/rows`, серверный PUT читает rack-поля; согласовать контракт.
5. **Legacy route semantics.** Документация перечисляет `edevs`, код вызывает `summary/stats`; синхронизировать.
6. **Braiins docs неполны.** Добавить cooling, resume и gRPC enable/disable, отметить какие ответы best-effort.
7. **Проверка management payload.** Строго валидировать IP, board IDs и допустимые значения enable/nopicMode до внешнего вызова.
8. **Побочные эффекты без транзакции.** gRPC board changes и SSH NoPIC write могут частично примениться; определить стратегию подтверждения/компенсации.
9. **Нет тестов API-маршрутов.** Добавить тесты для contracts, auth, abort, fallback, offline vs HTTP error, частичного отказа ASIC и файловых операций.
10. **Безопасность локального API.** Сервер по умолчанию слушает loopback, но `HOST` переопределяем; при non-loopback bind требуется явно продумать auth/CSRF и сетевую модель.

## Источники в репозитории

- `server.js` — внутренние HTTP маршруты и исходящие REST/gRPC/TCP/SSH запросы.
- `miner-compat.js` — порядок протоколов и нормализация legacy-ответа.
- `mix-algorithm.js` — локальный алгоритм миксов; сетевых API не вызывает.
- `public/app.js`, `public/maps.js`, `public/map-builder.js`, `public/scanner-settings.js`, `public/guide.js` — callers внутренних HTTP маршрутов.
- `docs/API.md`, `docs/BRAIINS_API.md` — проектные описания API; фактический код может быть новее описаний.
