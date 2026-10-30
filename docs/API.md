# ASIC Mix Control — API

Базовый адрес по умолчанию: `http://127.0.0.1:4180`.

Все API-ответы имеют `Content-Type: application/json; charset=utf-8` и `Cache-Control: no-store`.

## GET `/api/cods`

Возвращает сохранённые ЦОДы.

Ответ `200`:

```json
[
  {
    "id": "uuid",
    "name": "ЦОД 1",
    "start": "10.0.12.1",
    "end": "10.0.12.254",
    "cidr": "",
    "createdAt": "2026-10-04T00:00:00.000Z"
  }
]
```

## POST `/api/cods`

Добавляет ЦОД.

Тело запроса — JSON:

```json
{
  "name": "ЦОД 1",
  "start": "10.0.12.1",
  "end": "10.0.12.254",
  "cidr": ""
}
```

Можно использовать либо `start` + `end`, либо `cidr`:

```json
{
  "name": "ЦОД 1",
  "cidr": "10.0.12.0/24"
}
```

Успешный ответ: `201` и созданный объект ЦОДа.

Ошибки:

- `400` — пустое/короткое/длинное имя;
- `400` — некорректный IPv4 или CIDR;
- `400` — диапазон больше 4096 адресов.

## DELETE `/api/cods/:id`

Удаляет ЦОД из `state.json`.

Успешный ответ:

```json
{ "ok": true }
```

## POST `/api/scan`

Сканирует один выбранный ЦОД и возвращает устройства и миксы.

Тело запроса:

```json
{
  "codId": "uuid",
  "protocol": "grpc"
}
```

`protocol` — необязательный параметр:

| Значение | Поведение                                                               |
| -------- | ----------------------------------------------------------------------- |
| `grpc`   | использовать только Braiins Public API на TCP 50051; режим по умолчанию |
| `legacy` | использовать только legacy API на TCP 4028                              |
| `auto`   | сначала gRPC 50051, затем TCP 4028 только если gRPC не ответил          |

Протоколы не запускаются одновременно для одного ASIC. Значение `auto` означает последовательный fallback, а не параллельный скан.

Для демонстрационного режима:

```json
{
  "codId": "uuid",
  "demo": true,
  "protocol": "grpc"
}
```

Успешный ответ:

```json
{
  "codId": "uuid",
  "codName": "ЦОД 1",
  "protocol": "grpc",
  "scannedAt": "2026-10-04T00:00:00.000Z",
  "devices": [],
  "mixes": []
}
```

Ошибки:

- `404` — ЦОД не найден;
- `409` — другой скан уже выполняется;
- `500` — внутренняя ошибка сервера.

## POST `/api/ip-conflicts`

Повторно опрашивает IP одного ЦОДа и сопоставляет доступные идентификаторы устройств. Если у ЦОДа настроена карта с адресами, используется валидный список IP из карты; иначе разворачивается сохранённый диапазон/CIDR. Повторные запросы используют обычные учётные данные, протоколы, таймауты и параллельность сканера.

Тело запроса:

```json
{
  "codId": "uuid",
  "rounds": 3,
  "protocol": "rest"
}
```

`rounds` обязателен (целое 2–6); `protocol` необязателен и принимает допустимые протоколы scanner settings. Число запросов — `число IP × rounds`.

Ответ содержит имя/ID ЦОДа, протокол, число раундов, `scanSummary`, массив `results` с классами `confirmed`, `possible` или `clear`, массив `observations` и флаг `cancelled`. Серийный номер — наиболее сильный идентификатор, если прошивка передала его; отличия MAC имеют смысл прежде всего в том же L2-сегменте; различие модели/версии/плат является лишь поводом для проверки. MAC считывается из локальной таблицы соседей ОС, которая может содержать MAC шлюза или закэшированное значение.

Ошибки:

- `400` — число раундов вне диапазона или слишком много IP;
- `404` — ЦОД не найден;
- `409` — выполняется другой скан или мониторинг;
- `500` — внутренняя ошибка сервера.

Операция использует `/api/scan-all/progress` для прогресса и общий `POST /api/scan/cancel` для отмены.

## Объект устройства

```json
{
  "ip": "10.0.12.42",
  "online": true,
  "api": "gRPC 50051",
  "model": "Antminer S19j Pro",
  "boardModel": "BM1362",
  "boards": [
    {
      "number": 1,
      "id": "0",
      "model": "BM1362",
      "chips": 76,
      "hashrateGh": 40000,
      "working": true
    }
  ],
  "version": "26.08",
  "workingBoards": 2,
  "totalBoards": 3,
  "failedBoards": [3],
  "ratio": "2/3",
  "status": "degraded"
}
```

Возможные значения `status`:

| Значение   | Значение для пользователя          |
| ---------- | ---------------------------------- |
| `healthy`  | все 3 платы рабочие                |
| `degraded` | рабочие 1 или 2 платы              |
| `check`    | 0 рабочих плат, требуется проверка |
| `offline`  | ASIC недоступен                    |

Для offline-устройства дополнительно возвращается:

```json
{
  "error": "4028: timeout; 50051: connection refused"
}
```

## Объект группы микса

```json
{
  "boardModel": "BM1362",
  "devices": [],
  "donors": [],
  "recipients": [],
  "usedDonors": [],
  "usedRecipients": [],
  "unusedDonors": [],
  "unusedRecipients": [],
  "unused": [],
  "availableBoards": 2,
  "boardTransfers": 1,
  "suggestedMixes": 1
}
```

`boardTransfers` — количество передаваемых рабочих плат.

`usedDonors` и `usedRecipients` — устройства, которые попадут в печать результата.

`unused` — устройства, не вошедшие в текущий расчёт; в печать результата группы не попадают.

## Обслуживающие API Braiins OS

Приложение само обращается к ASIC:

### Legacy TCP 4028

Запросы JSON Lines:

```json
{"command":"version"}
{"command":"devdetails"}
{"command":"devs"}
```

В текущем коде подготовлен также запрос `stats` в описании интерфейса, но расчёт плат использует `version`, `devdetails` и `devs`.

### Braiins Public API gRPC 50051

Используется `grpcurl` с plaintext:

```text
braiins.bos.v1.AuthenticationService/Login
braiins.bos.v1.MinerService/GetMinerDetails
braiins.bos.v1.MinerService/GetHashboards
```

Авторизация выполняется логином и паролем из переменных `ASIC_USER` и `ASIC_PASSWORD`.

## Служебные endpoints (версия 1.1.0)

### `GET /api/health`

Возвращает статус локального процесса. Пример:

```json
{
  "ok": true,
  "app": "asic-toolbox",
  "time": "2026-10-19T10:00:00.000Z",
  "scanRunning": false,
  "monitorRunning": false
}
```

Поля `scanRunning` и `monitorRunning` отражают блокировки текущего процесса, а не состояние ASIC.

### `GET /api/backup/export`

Возвращает JSON-файл с заголовком `Content-Disposition` для скачивания. Включает текущие `state.json`, `maps.json`, содержимое legacy `state.js` и JSON-файлы из `saves/`. Файлы `.bak` и `.tmp` не включаются. Экспорт не является полным дистрибутивом приложения и пока не импортируется автоматически.
