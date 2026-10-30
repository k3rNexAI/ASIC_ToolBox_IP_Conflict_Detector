# Техническая документация ASIC Mix Control

## Журнал и выпуск

- [Журнал проекта, принципы, проверки и дорожная карта](PROJECT_LOG.md)
- [История изменений](../CHANGELOG.md)

## Файлы

1. [Технический обзор и архитектура](TECHNICAL_OVERVIEW.md)
2. [HTTP API приложения](API.md)
3. [Конфигурация и все изменяемые параметры](CONFIGURATION.md)
4. [Модель данных](DATA_MODEL.md)
5. [Алгоритм расчёта микса](MIX_ALGORITHM.md)
6. [Braiins OS API и сеть](BRAIINS_API.md)
7. [Эксплуатация и Windows-развёртывание](OPERATIONS.md)
8. [Проверка задвоений IP](IP_CONFLICTS.md)

## Быстрые ссылки

- Сервер: `../server.js`
- Клиент: `../public/app.js`
- Инструмент IP: `../public/ip-conflicts.html` и `../public/ip-conflicts.js`
- HTML: `../public/index.html`
- Стили: `../public/styles.css`
- Переменные запуска Windows: `../run-windows.cmd`
- Состояние ЦОДов: `../state.json`
- Команды npm: `../package.json`

## Быстрый запуск

Windows:

```text
run-windows.cmd
```

Linux/macOS:

```bash
npm start
```

Проверка:

```bash
npm run check
```
