const $ = (s) => document.querySelector(s);
let cods = [],
  fleetResults = [],
  mapCache = {};
let pinnedRedIps = new Set(),
  recoveredRedIps = new Set();
let collapseRedAccordionsOnNextRender = false;
/** Отправляет запрос к серверу и читает ответ как JSON. При HTTP-ошибке выбрасывает исключение с текстом сервера, чтобы вызывающая функция могла показать его пользователю; иначе возвращает разобранные данные. */
const api = async (u, o) => {
  const r = await fetch(u, o),
    d = await r.json();
  if (!r.ok) throw Error(d.error || 'Ошибка');
  return d;
};
/** Отбирает онлайн-устройства Braiins с нулём рабочих хэш-плат для отдельного мониторинга. */
const isProblemDevice = (d) =>
  Boolean(
    d &&
    d.firmwareFamily === 'braiins' &&
    d.online !== false &&
    d.status !== 'offline' &&
    d.status !== 'sleep' &&
    d.ratio === '0/3',
  );
/** Превращает значение в безопасный текст для вставки в HTML: специальные символы не дадут данным стать разметкой. Используется при построении карточек и таблиц. */
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c],
  );
const toast = (m) => {
  const x = $('#toast');
  x.textContent = m;
  x.classList.add('show');
  setTimeout(() => x.classList.remove('show'), 2500);
};
const suffix = (ip) =>
  String(ip || '')
    .split('.')
    .pop() || '—';
/** Ищет устройство по IP и в обычном списке результатов, и внутри групп с полем devices; возвращает найденную запись или undefined. */
const resultDevice = (results, ip) =>
  (Array.isArray(results)
    ? results.flatMap((r) => (Array.isArray(r?.devices) ? r.devices : [r]))
    : []
  ).find((d) => d?.ip === ip);
/** Присваивает устройству имя визуального состояния по статусу, прошивке и доле работающих плат. Результат используется как CSS-класс ячейки карты. */
const deviceState = (d) => {
  if (!d) return 'unknown';
  if (d.status === 'offline') return 'offline';
  if (d.status === 'sleep') return 'sleep';
  if (d.firmwareFamily !== 'braiins') return 'other-firmware';
  return d.ratio === '3/3'
    ? 'healthy'
    : d.ratio === '0/3'
      ? 'check'
      : d.ratio === '1/3' || d.ratio === '2/3'
        ? 'degraded'
        : d.status === 'healthy'
          ? 'healthy'
          : d.status === 'check'
            ? 'check'
            : d.status === 'degraded'
              ? 'degraded'
              : 'unknown';
};
const cap = (m) => (+m.racks || 11) * (+m.shelves || 6) * (+m.devicesPerShelf || 4);
const mapCells = (m) => (Array.isArray(m?.cells) ? m.cells.slice(0, cap(m)) : []);
const mapLegend =
  '<div class="map-legend"><span class="legend healthy">Braiins 3/3</span><span class="legend degraded">Braiins 1/3 или 2/3</span><span class="legend check">Braiins 0/3</span><span class="legend sleep">SLEEP · подтверждённая пауза</span><span class="legend other-firmware">Другие прошивки · фиолетовый</span><span class="legend offline">OFFLINE</span><span class="legend empty">пусто</span></div>';
/** Находит температуру в разных форматах ответа API и превращает её в короткую подпись. Для неизвестного значения возвращает прочерк; текстовые данные экранируются перед показом в HTML. */
const temperatureText = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return `${v}°C`;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? `${n}°C` : esc(v);
  }
  if (typeof v === 'object') {
    for (const k of ['degree_c', 'celsius', 'value', 'degrees_celsius', 'temperature', 'temp'])
      if (v[k] !== undefined) return temperatureText(v[k]);
    for (const x of Object.values(v))
      if (typeof x === 'number' || typeof x === 'string') {
        const t = temperatureText(x);
        if (t !== '—') return t;
      }
  }
  return '—';
};
const DEFECTS_KEY = 'asicToolboxManualDefects';
const ipSortValue = (ip) =>
  String(ip || '')
    .split('.')
    .reduce((n, x) => n * 256 + (Number(x) || 0), 0);
const sortManualDefects = () => manualDefects.sort((a, b) => ipSortValue(a.ip) - ipSortValue(b.ip));
/** Читает сохранённый в браузере список ручных неисправностей, убирает устаревшее поле boards и сортирует IP. Если хранилище пустое или JSON повреждён, возвращает пустой список, не ломая страницу. */
const readDefects = () => {
  try {
    return JSON.parse(localStorage.getItem(DEFECTS_KEY) || '[]')
      .map(({ boards, ...x }) => x)
      .sort((a, b) => ipSortValue(a.ip) - ipSortValue(b.ip));
  } catch {
    return [];
  }
};
let manualDefects = readDefects();
localStorage.setItem(DEFECTS_KEY, JSON.stringify(manualDefects));
const formatGh = (v) =>
  Number.isFinite(Number(v)) && Number(v) > 0
    ? `${(Number(v) / 1000).toFixed(2).replace('.', ',')} TH/s`
    : '0,00 TH/s';
const formatCompactHashrate = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return `${Math.round(n / 1000)}T`;
  if (n >= 1) return `${Math.round(n)}G`;
  return `${Math.round(n * 1000)}M`;
};

/** Получает список проблемных устройств, карту ЦОДа и его ID; возвращает HTML раскрываемой секции с карточками, телеметрией, журналом ошибок и элементами управления. События для созданных элементов подключает bindDeviceActions после отрисовки. */
function renderRedDevices(redDevices, m, codId) {
  if (!redDevices?.length) return '';
  const cs = mapCells(m);
  const cards = redDevices
    .map((d) => {
      const cell = cs.find((x) => x.ip === d.ip);
      const pos = cell
        ? `Стеллаж ${cell.rack}, Полка ${cell.shelf}, Позиция ${cell.position}`
        : 'Позиция на карте не привязана';
      const boards = Array.from(
        { length: 3 },
        (_, i) =>
          d.boards?.[i] || {
            number: i + 1,
            enabled: false,
            working: false,
            hashrateGh: 0,
            chips: 0,
            model: d.boardModel || '—',
          },
      );
      const enabled = boards.filter((b) => b.enabled !== false && b.disabled !== true).length;
      const logs = d.errorLogs || [];
      const recovered = recoveredRedIps.has(d.ip) || d.status === 'healthy' || d.ratio === '3/3';
      const status = recovered
        ? 'ВОССТАНОВИЛАСЬ'
        : d.status === 'offline'
          ? 'OFFLINE'
          : d.status === 'degraded'
            ? 'НЕИСПРАВНАЯ ПЛАТА'
            : 'ПРОВЕРИТЬ';
      const mode = ['enabled', 'disabled'].includes(d.nopicMode) ? d.nopicMode : 'unknown';
      return `<article class="red-device-card ${recovered ? 'recovered' : ''}" data-monitor-ip="${esc(d.ip)}"><header class="red-card-header"><div class="red-device-id"><a class="ip-link red-ip" href="http://${esc(d.ip)}" target="_blank" rel="noopener"><strong>${esc(d.ip)}</strong></a><span class="red-pill-ratio">${esc(d.ratio || '—')}</span><span class="red-pill-status">${status}</span><span class="map-live-pill">● 5 сек</span></div><div class="red-device-meta"><span><b>Модель:</b> ${esc(d.model || 'ASIC')}</span><span><b>Платы:</b> ${esc(d.boardModel || '—')}</span><span><b>Позиция:</b> ${esc(pos)}</span><span><b>Отклик:</b> ${Number.isFinite(Number(d.responseTimeMs ?? d.scanDurationMs)) ? `${Math.round(Number(d.responseTimeMs ?? d.scanDurationMs))} мс` : '—'}</span><button type="button" class="unpin-red-device" data-ip="${esc(d.ip)}" title="Убрать ASIC из списка до следующего скана">Убрать из списка</button></div></header><form class="map-defect-form" data-ip="${esc(d.ip)}"><label>Дефект устройства<input type="text" name="defect" placeholder="Введите описание неисправности" autocomplete="off" required></label><button class="button primary small-button" type="submit">Сохранить в список</button><span class="defect-form-state"></span></form><div class="map-device-columns"><section class="map-board-controls"><div class="map-subhead">Состояние хэш-плат <small>Включено: ${enabled} из 3</small></div><div class="map-board-stack">${boards.map((b, i) => `<label class="map-board-row ${b.working ? 'working' : 'fault'}"><span><b>HB ${i + 1}</b><small>${Number(b.chips || 0)} чипов · ${esc(b.model || d.boardModel || '—')}</small><small class="map-board-temperature"><span>Плата <b>${temperatureText(b.boardTemperature ?? b.board_temp)}</b></span><span>Чип <b>${temperatureText(b.chipTemperature ?? b.highest_chip_temp)}</b></span></small></span><strong>${formatGh(b.hashrateGh)}</strong><input type="checkbox" class="map-board-toggle" data-board="${i}" ${b.enabled !== false && b.disabled !== true ? 'checked' : ''} aria-label="Включить плату ${i + 1}"></label>`).join('')}</div><div class="map-telemetry"><div class="map-fan-chips">${(d.fans || []).length ? (d.fans || []).map((f, i) => `<span class="sensor-chip fan-chip"><small>FAN${f.position ?? i + 1}</small><b>${Number(f.rpm || 0).toLocaleString('ru-RU')} rpm</b></span>`).join('') : '<span class="sensor-chip fan-chip"><small>FAN</small><b>—</b></span>'}</div></div><div class="map-nopic nopic-${mode}"><b>Hashboard disabling on NoPIC miners</b><select class="map-nopic-mode" data-dirty="false"><option value="unknown" ${mode === 'unknown' ? 'selected' : ''}>не получено</option><option value="disabled" ${mode === 'disabled' ? 'selected' : ''}>disabled</option><option value="enabled" ${mode === 'enabled' ? 'selected' : ''}>enabled</option></select><small class="map-nopic-current">Текущее значение <strong>${mode}</strong></small></div><div class="map-control-actions"><button class="button primary small-button map-save-device">Save and Apply</button><button type="button" class="button secondary small-button map-resume-device" data-ip="${esc(d.ip)}">Resume</button></div><span class="map-device-save-state"></span></section><section class="map-log-panel"><div class="map-subhead">Журнал ошибок Braiins OS (errors) <small>${logs.length} записей</small><label class="map-wrap-toggle"><input type="checkbox" checked> Перенос</label></div><div class="map-errors">${
        logs.length
          ? logs
              .map((err) => {
                const m = String(err).match(
                  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*[—-]?\s*(.*)$/,
                );
                return `<div class="map-log-entry"><span class="map-log-marker">›</span>${m ? `<time class="map-log-time">${esc(m[1])}</time><span class="map-log-message">${esc(m[2])}</span>` : `<span class="map-log-message">${esc(err)}</span>`}</div>`;
              })
              .join('')
          : '<div class="log-empty">В окне errors активных записей нет</div>'
      }</div><small class="map-log-hint">Нажмите по строке, чтобы развернуть или скопировать текст</small></section></div></article>`;
    })
    .join('');
  return `<details class="cod-red-devices" data-cod-id="${esc(codId)}"><summary class="cod-red-summary"><div class="cod-red-summary-left"><span class="red-warn-icon">⚠</span><strong>Проблемные ASIC: ${redDevices.length}</strong><span class="red-summary-hint">мониторинг · обновление каждые 5 секунд</span></div><span class="red-chevron">⌄</span></summary><div class="cod-red-content">${cards}</div></details>`;
}

/** Принимает сведения о ЦОДе, его карте и результатах скана. Для каждого места на карте находит устройство, рассчитывает класс состояния и подписи, а затем возвращает HTML карты и карточек закреплённых проблемных ASIC. */
function mapHtml(c, m, results) {
  const rs = +m.racks || 11,
    ss = +m.shelves || 6,
    pp = +m.devicesPerShelf || 4,
    cs = mapCells(m);
  const cells = Array.from(
    { length: rs },
    (_, r) =>
      `<section class="rack"><header><b>Стеллаж ${r + 1}</b></header>${Array.from(
        { length: ss },
        (_, s) =>
          `<div class="shelf"><div class="shelf-devices">${Array.from({ length: pp }, (_, p) => {
            const i = r * ss * pp + s * pp + p,
              x = cs[i] || {},
              d = resultDevice(results, x.ip),
              cl = deviceState(d),
              lat = Number(d?.responseTimeMs ?? d?.scanDurationMs);
            const isOther = d?.firmwareFamily !== 'braiins';
            const hasBoardState = /^\d+\/3$/.test(String(d?.ratio || ''));
            const value =
              d?.status === 'sleep'
                ? 'SLEEP'
                : isOther && !hasBoardState
                  ? formatCompactHashrate(d?.hashrateGh)
                  : d?.ratio || '—';
            const firmware = d?.firmwareName || d?.api || '';
            const rate = Number(d?.hashrateGh) > 0 ? formatGh(d.hashrateGh) : '';
            const title = `Открыть ${x.ip || ''}${firmware ? ` · ${firmware}` : ''}${rate ? ` · хешрейт ${rate}` : ''}${d?.status === 'sleep' ? ' · состояние SLEEP' : ''}${Number.isFinite(lat) ? ` · отклик ${lat} мс` : ''}`;
            return x.ip
              ? `<a class="map-device ${cl}" href="http://${esc(x.ip)}" target="_blank" rel="noopener" title="${esc(title)}"><b>${esc(suffix(x.ip))}</b><span class="map-device-value">${esc(value)}</span><small class="device-latency">${Number.isFinite(lat) ? `${lat} мс` : '— мс'}</small></a>`
              : `<span class="map-device empty"><b>—</b><small>пусто</small></span>`;
          }).join('')}</div></div>`,
      ).join('')}</section>`,
  ).join('');
  const ds = Array.isArray(results) ? results : [];
  const redDevices = ds.filter((d) => isProblemDevice(d) && pinnedRedIps.has(d.ip));
  const redSection = redDevices.length ? renderRedDevices(redDevices, m, c.id) : '';
  return `<article class="cod-map-result"><div class="map-cod-meta"><strong>${esc(c.name)}</strong><span>Диапазон: ${esc(c.cidr || `${c.start || ''}${c.end ? ' — ' + c.end : ''}`)}</span><span>${rs} стеллажей × ${ss} полок × ${pp} ASIC · ${cs.filter((x) => x.ip).length} IP на карте</span></div>${mapLegend}<div class="rack-map result-map" style="--rack-min-width:${Math.max(162, pp * 30 + 12)}px">${cells}</div>${redSection}</article>`;
}
/** Полностью обновляет область карт из последних результатов. Перед заменой HTML запоминает раскрытые секции, настройки элементов, фокус и введённый текст, а после отрисовки восстанавливает их и заново подключает обработчики. При пустых результатах показывает заглушку и реестр неисправностей. */
function renderFleetMaps() {
  const box = $('#fleetMaps');
  const savedRedAccordions = collapseRedAccordionsOnNextRender
    ? new Map()
    : new Map(
        [...document.querySelectorAll('.cod-red-devices')].map((el) => [el.dataset.codId, el.open]),
      );
  collapseRedAccordionsOnNextRender = false;
  const savedDefectRegistryOpen = document.querySelector('.manual-defect-registry')?.open ?? false;
  const savedControls = new Map(
    [...document.querySelectorAll('.red-device-card')].map((card) => [
      card.dataset.monitorIp,
      {
        boards: [...card.querySelectorAll('.map-board-toggle')].map((x) => x.checked),
        nopic: card.querySelector('.map-nopic-mode')?.value,
        nopicDirty: card.querySelector('.map-nopic-mode')?.dataset.dirty === 'true',
      },
    ]),
  );
  const activeInput = document.activeElement;
  const savedDefectForms = new Map(
    [...document.querySelectorAll('.map-defect-form')].map((form) => {
      const input = form.elements.defect;
      return [
        form.dataset.ip,
        {
          open: !form.classList.contains('hidden'),
          text: input?.value || '',
          focused: input === activeInput,
          start: input?.selectionStart ?? 0,
          end: input?.selectionEnd ?? 0,
        },
      ];
    }),
  );
  if (!fleetResults.length) {
    box.innerHTML =
      '<div class="empty"><div class="empty-icon">▦</div><h3>Результаты появятся после сканирования</h3></div>' +
      renderDefectRegistry();
    renderGlobalRecoveredList();
    bindDeviceActions();
    return;
  }
  box.innerHTML = fleetResults
    .map((r) => {
      const c = cods.find((x) => x.id === r.codId) || { id: r.codId, name: r.codName };
      const m = mapCache[r.codId];
      return m
        ? mapHtml(c, m, r.devices || [])
        : `<article class="cod-map-result"><div class="empty compact"><h3>${esc(c.name)}</h3><p>Карта для этого ЦОДа не настроена.</p></div></article>`;
    })
    .join('');
  box.insertAdjacentHTML('beforeend', renderDefectRegistry());
  const defectRegistry = document.querySelector('.manual-defect-registry');
  if (defectRegistry) defectRegistry.open = savedDefectRegistryOpen;
  renderGlobalRecoveredList();
  bindDeviceActions();
  document.querySelectorAll('.cod-red-devices').forEach((el) => {
    if (savedRedAccordions.has(el.dataset.codId))
      el.open = savedRedAccordions.get(el.dataset.codId);
  });
  document.querySelectorAll('.red-device-card').forEach((card) => {
    const ip = card.dataset.monitorIp,
      control = savedControls.get(ip);
    if (control) {
      card.querySelectorAll('.map-board-toggle').forEach((x, i) => {
        if (control.boards[i] !== undefined) x.checked = control.boards[i];
      });
      const mode = card.querySelector('.map-nopic-mode');
      if (mode && control.nopicDirty) {
        mode.value = control.nopic;
        mode.dataset.dirty = 'true';
      }
    }
  });
  document.querySelectorAll('.map-defect-form').forEach((form) => {
    const saved = savedDefectForms.get(form.dataset.ip);
    if (saved) {
      const input = form.elements.defect;
      form.classList.toggle('hidden', !saved.open);
      input.value = saved.text;
      if (saved.focused) {
        input.focus({ preventScroll: true });
        try {
          input.setSelectionRange(saved.start, saved.end);
        } catch {}
      }
    }
  });
  document.querySelectorAll('.map-errors').forEach((x) => {
    x.scrollTop = x.scrollHeight;
  });
}

/** Создаёт список ЦОДов с флажками и связывает флажок «Все» с отдельными флажками. Меняет только состояние выбора в интерфейсе; выбранные ID позднее читает chosen для сканирования. */
function renderChecks() {
  const box = $('#codCheckList');
  box.innerHTML = cods.length
    ? '<label class="cod-check-all"><input id="selectAllCods" type="checkbox" checked> Все ЦОДы</label>' +
      cods
        .map(
          (c) =>
            `<label class="cod-check"><input class="cod-choice" type="checkbox" value="${esc(c.id)}" checked><span>${esc(c.name)}</span><small>${esc(c.cidr || (c.start || '') + (c.end ? ' — ' + c.end : ''))}</small></label>`,
        )
        .join('')
    : 'Нет ЦОДов';
  const all = $('#selectAllCods');
  if (all)
    all.onchange = () =>
      document.querySelectorAll('.cod-choice').forEach((x) => (x.checked = all.checked));
  box.querySelectorAll('.cod-choice').forEach(
    (x) =>
      (x.onchange = () => {
        if (all)
          all.checked = [...document.querySelectorAll('.cod-choice')].every((y) => y.checked);
      }),
  );
}

const chosen = () => [...document.querySelectorAll('.cod-choice:checked')].map((x) => x.value);

/** Собирает закреплённые устройства, которые мониторинг отметил как восстановившиеся, и показывает общий список без повторов по IP. */
function renderGlobalRecoveredList() {
  const box = $('#globalRecoveredList');
  if (!box) return;
  const restored = new Map();
  for (const r of fleetResults)
    for (const d of r.devices || [])
      if (pinnedRedIps.has(d.ip) && recoveredRedIps.has(d.ip) && !restored.has(d.ip))
        restored.set(d.ip, { ...d, codName: r.codName });
  const items = [...restored.values()].sort((a, b) => ipSortValue(a.ip) - ipSortValue(b.ip));
  box.innerHTML = items.length
    ? `<section class="recovered-global-list"><header><strong>Восстановленные ASIC</strong><span>${items.length} устройств</span></header><div class="recovered-global-items">${items.map((d) => `<span class="recovered-green-chip"><b>${esc(d.ip)}</b><small>${esc(d.codName || 'ЦОД')} · ${esc(d.ratio || '')}</small></span>`).join('')}</div></section>`
    : '';
}
/** Строит сводку по текущим результатам: считает состояния устройств и длительность сканов, а отклик суммирует только для устройств с корректным числовым временем ответа. Исключение офлайн-устройств из онлайн-подсчётов не позволяет записать их одновременно в другие категории. Вставляет итоговую таблицу в #fleetSummary. */
function summary() {
  const rows = fleetResults.map((r) => {
    const ds = Array.isArray(r.devices) ? r.devices : [];
    const isOffline = (d) => d?.online === false || d?.status === 'offline';
    const online = ds.filter((d) => !isOffline(d));
    const g = online.filter((d) => d.firmwareFamily === 'braiins' && d.status === 'healthy').length;
    const y = online.filter(
      (d) => d.firmwareFamily === 'braiins' && d.status === 'degraded',
    ).length;
    // Offline devices must be counted only in OFFLINE, even if they also carry ratio 0/3.
    const red = online.filter((d) => isProblemDevice(d)).length;
    const recovered = new Set(
      ds.filter((d) => pinnedRedIps.has(d.ip) && recoveredRedIps.has(d.ip)).map((d) => d.ip),
    ).size;
    const sleep = online.filter((d) => d.status === 'sleep').length;
    const o = ds.filter(isOffline).length;
    const latencies = online
      .map((d) => Number(d.responseTimeMs ?? d.scanDurationMs))
      .filter((n) => Number.isFinite(n) && n >= 0);
    const min = latencies.length ? Math.min(...latencies) : null;
    const max = latencies.length ? Math.max(...latencies) : null;
    const avg = latencies.length ? latencies.reduce((a, n) => a + n, 0) / latencies.length : null;
    return {
      name: r.codName,
      total: r.mapIps?.length ?? ds.length,
      connected: online.length,
      g,
      y,
      red,
      recovered,
      sleep,
      o,
      map: r.mapConfigured,
      durationMs: Number(r.scanDurationMs) || 0,
      protocol: r.protocol || '—',
      latencies,
      min,
      max,
      avg,
    };
  });
  const allLatencies = rows.flatMap((r) => r.latencies);
  const totalMin = allLatencies.length ? Math.min(...allLatencies) : null;
  const totalMax = allLatencies.length ? Math.max(...allLatencies) : null;
  const totalAvg = allLatencies.length
    ? allLatencies.reduce((a, n) => a + n, 0) / allLatencies.length
    : null;
  const totalDuration = rows.reduce((sum, r) => sum + r.durationMs, 0);
  const t = rows.reduce(
    (a, r) => ({
      total: a.total + r.total,
      connected: a.connected + r.connected,
      g: a.g + r.g,
      recovered: a.recovered + r.recovered,
      y: a.y + r.y,
      red: a.red + r.red,
      sleep: a.sleep + r.sleep,
      o: a.o + r.o,
    }),
    { total: 0, connected: 0, g: 0, recovered: 0, y: 0, red: 0, sleep: 0, o: 0 },
  );
  const latencyCell = (r) =>
    r.avg === null
      ? '<span class="latency-empty">нет ответов</span>'
      : `<span class="latency-stats" title="Минимум / среднее / максимум, по ответившим устройствам"><span class="latency-min"><small>MIN</small><b>${r.min.toFixed(0)}</b></span><span class="latency-avg"><small>СР.</small><b>${r.avg.toFixed(0)}</b></span><span class="latency-max"><small>MAX</small><b>${r.max.toFixed(0)}</b></span></span>`;
  const totalLatency = latencyCell({ min: totalMin, max: totalMax, avg: totalAvg });
  $('#fleetSummary').innerHTML = rows.length
    ? `<table class="fleet-table"><thead><tr><th>ЦОД</th><th>IP на карте</th><th class="t-green">Ответили</th><th class="t-green">Зелёные</th><th class="t-green">Восстановлено</th><th class="t-yellow">Жёлтые</th><th class="t-red">Красные</th><th class="t-sleep">SLEEP</th><th>Офлайн</th><th>Время скана</th><th>Отклик, мс<br><small>мин / среднее / макс</small></th><th>Протокол</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.map ? r.total : 'карта не настроена'}</td><td class="t-green">${r.connected}</td><td class="t-green">${r.g}</td><td class="t-green">${r.recovered}</td><td class="t-yellow">${r.y}</td><td class="t-red">${r.red}</td><td class="t-sleep">${r.sleep}</td><td>${r.o}</td><td>${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)} с` : '—'}</td><td>${latencyCell(r)}</td><td>${esc(r.protocol)}</td></tr>`).join('')}<tr class="fleet-total"><th>ИТОГО ПО ВСЕМ ЦОД</th><th>${t.total}</th><th class="t-green">${t.connected}</th><th class="t-green">${t.g}</th><th class="t-green">${t.recovered}</th><th class="t-yellow">${t.y}</th><th class="t-red">${t.red}</th><th class="t-sleep">${t.sleep}</th><th>${t.o}</th><th>${totalDuration ? `${(totalDuration / 1000).toFixed(1)} с` : '—'}</th><th>${totalLatency}</th><th>—</th></tr></tbody></table>`
    : '';
}

/** Загружает карты для переданных ID ЦОДов параллельными запросами и сохраняет ответы в mapCache. Если у старой карты нет размеров, подставляет стандартную сетку; сбой отдельной загрузки пропускается, чтобы не прерывать остальные. */
async function loadMaps(ids) {
  await Promise.all(
    ids.map(async (id) => {
      try {
        mapCache[id] = await api('/api/maps/' + encodeURIComponent(id));
        if (!mapCache[id].racks)
          mapCache[id] = {
            ...mapCache[id],
            racks: 11,
            shelves: 6,
            devicesPerShelf: 4,
            cells: mapCache[id].cells || [],
          };
      } catch {}
    }),
  );
}

/** Сканирует выбранные ЦОДы (или загружает демо-данные), обновляет результаты и запускает периодическое наблюдение за проблемными ASIC. Блокирует кнопки на время операции; блок finally возвращает управление даже после ошибки или отмены. */
async function scan(isDemo = false) {
  const ids = chosen();
  if (!ids.length) return toast('Отметьте хотя бы один ЦОД');
  const b = $('#scanAllBtn');
  const bDemo = $('#scanDemoBtn');
  const cancelBtn = $('#cancelScanBtn');
  if (b) b.disabled = true;
  if (bDemo) bDemo.disabled = true;
  if (cancelBtn) {
    cancelBtn.classList.toggle('hidden', Boolean(isDemo));
    cancelBtn.disabled = Boolean(isDemo);
  }
  startScanProgress();
  await window.scannerSettingsReady;
  const applied = window.appliedScanSettings;
  const protocolLabels = {
    hybrid: 'быстрый CGMiner + детали проблемных',
    rest: 'REST API',
    auto: 'Braiins REST/gRPC → CGMiner TCP (4028)',
    grpc: 'gRPC',
    legacy: 'TCP 4028',
  };
  $('#scanAllState').textContent = isDemo
    ? 'Загрузка демонстрационных данных…'
    : `Сканируем IP из карт · ${protocolLabels[applied?.protocol] || 'быстрый CGMiner + детали проблемных'}…`;
  try {
    const d = await api('/api/scan-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codIds: ids, demo: Boolean(isDemo) }),
    });
    fleetResults = d.results || [];
    recoveredRedIps = new Set();
    pinnedRedIps = new Set(
      fleetResults
        .flatMap((r) => r.devices || [])
        .filter(isProblemDevice)
        .map((x) => x.ip),
    );
    await loadMaps(ids);
    summary();
    collapseRedAccordionsOnNextRender = true;
    renderFleetMaps();
    bindDeviceActions();
    if (mapPollTimer) clearInterval(mapPollTimer);
    mapPollTimer = setInterval(pollMaps, 5000);
    const elapsed = fleetResults.reduce((sum, r) => sum + (Number(r.scanDurationMs) || 0), 0);
    $('#scanAllState').textContent =
      `${d.cancelled ? 'Отменено · частичный результат' : 'Готово'} · ${fleetResults.length} ЦОД · ${(elapsed / 1000).toFixed(1)} с суммарно`;
    $('#lastFleetScan').textContent =
      `Последний скан: ${new Date(d.scannedAt).toLocaleString('ru-RU')}${isDemo ? ' (демо)' : ''}${d.cancelled ? ' · отменён' : ''}`;
  } catch (e) {
    // Сообщаем об ошибке запроса; finally ниже гарантирует восстановление интерфейса.
    toast(e.message);
    $('#scanAllState').textContent = 'Ошибка';
  } finally {
    stopScanProgress();
    if (b) b.disabled = false;
    if (bDemo) bDemo.disabled = false;
    if (cancelBtn) {
      cancelBtn.classList.add('hidden');
      cancelBtn.disabled = false;
    }
  }
}

function renderSidebarCods() {
  const box = $('#railCods');
  if (!box) return;
  const groups = new Map();
  cods.forEach((c) => {
    const g = c.ec || 'Без группы';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  });
  box.innerHTML = cods.length
    ? [...groups.entries()]
        .map(
          ([g, items]) =>
            `<details class="rail-ec"><summary><span>${esc(g)}</span><b>${items.length}</b></summary><div class="rail-ec-items">${items.map((c) => `<a class="rail-cod" href="/#cods" title="${esc(c.name)}"><strong>${esc(c.name)}</strong><small>${esc(c.cidr || `${c.start || ''}${c.end ? ' — ' + c.end : ''}`)}</small></a>`).join('')}</div></details>`,
        )
        .join('')
    : '<div class="rail-empty">Нет ЦОДов</div>';
}

let mapPollTimer = null,
  mapPollBusy = false;
let scanProgressTimer = null,
  scanProgressBusy = false,
  scanClientStartedAt = 0;
/** Показывает этап и долю выполненного сканирования по данным сервера. Защищает вычисляемый процент диапазоном 0–100 и обновляет также значение доступности progressbar. */
function drawScanProgress(progress, preparing = false) {
  const box = $('#mapScanProgress');
  if (!box) return;
  box.classList.remove('hidden');
  const label = $('#mapScanProgressLabel'),
    count = $('#mapScanProgressCount'),
    bar = $('#mapScanProgressBar'),
    track = box.querySelector('[role="progressbar"]');
  const total = Math.max(0, Number(progress?.total) || 0),
    done = Math.max(0, Number(progress?.completed) || 0);
  const pct = total ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
  box.classList.toggle('preparing', preparing || total === 0);
  label.textContent = progress?.cancelRequested
    ? 'Отмена сканирования…'
    : preparing
      ? 'Подготовка сканирования'
      : progress?.currentCod
        ? `ЦОД ${progress.codIndex || 1}/${progress.codTotal || 1} · ${progress.currentCod}`
        : 'Сканирование устройств';
  count.textContent = total ? `${done} / ${total} · ${pct}%` : 'Подготовка…';
  bar.style.width = `${pct}%`;
  track?.setAttribute('aria-valuenow', String(pct));
}
/** Запускает обновление индикатора каждые 450 мс. Флаг busy не даёт начать новый запрос, пока не завершился предыдущий; время старта отбрасывает запоздавший ответ от более старого скана. Ошибка опроса не ломает основной скан, а finally освобождает флаг для следующей попытки. */
function startScanProgress() {
  scanClientStartedAt = Date.now();
  drawScanProgress({ completed: 0, total: 0 }, true);
  if (scanProgressTimer) clearInterval(scanProgressTimer);
  scanProgressTimer = setInterval(async () => {
    if (scanProgressBusy) return;
    scanProgressBusy = true;
    try {
      const p = await api('/api/scan-all/progress');
      if (p.startedAt && Date.parse(p.startedAt) >= scanClientStartedAt)
        drawScanProgress(p, !p.total && p.running);
    } catch {
    } finally {
      scanProgressBusy = false;
    }
  }, 450);
}
/** Останавливает таймер обновления прогресса, сбрасывает флаг запроса и скрывает индикатор с кнопкой отмены. Вызывается после завершения сканирования. */
function stopScanProgress() {
  if (scanProgressTimer) clearInterval(scanProgressTimer);
  scanProgressTimer = null;
  scanProgressBusy = false;
  $('#mapScanProgress')?.classList.add('hidden');
  $('#cancelScanBtn')?.classList.add('hidden');
}

function drawMonitoredResults() {
  renderFleetMaps();
  bindDeviceActions();
}
/** Возвращает HTML раскрываемого реестра из manualDefects. Если записей нет, показывает пояснение; кнопки печати и очистки в этом случае отключены. */
function renderDefectRegistry() {
  return `<details class="manual-defect-registry"><summary><strong>Список неисправных устройств</strong><span class="manual-defect-count">${manualDefects.length} устройств · нажмите, чтобы развернуть</span></summary><div class="manual-defect-content"><header><div class="defect-list-actions"><button type="button" class="button secondary small-button print-defects" ${manualDefects.length ? '' : 'disabled'}>Печать списка</button><button type="button" class="button secondary small-button clear-defects" ${manualDefects.length ? '' : 'disabled'}>Очистить список неисправных</button></div></header>${manualDefects.length ? manualDefects.map((x, i) => `<div class="manual-defect-row"><b>${esc(x.ip)}</b><span>${esc(x.models || 'Модель платы не определена')}</span><p>${esc(x.defect)}</p><button type="button" class="remove-manual-defect" data-index="${i}">Убрать</button></div>`).join('') : '<p class="defect-list-empty">Список пока пуст. Введите описание на красной карточке и нажмите «Сохранить в список».</p>'}</div></details>`;
}
/** Заменяет реестр свежей версией после изменения списка, сохраняя его раскрытое/свёрнутое состояние и повторно подключая обработчики кнопок. */
function refreshDefectRegistry() {
  const old = document.querySelector('.manual-defect-registry');
  if (!old) return;
  const wasOpen = old.open;
  old.outerHTML = renderDefectRegistry();
  const next = document.querySelector('.manual-defect-registry');
  if (next) next.open = wasOpen;
  bindDefectRegistryActions();
}
function bindDefectRegistryActions() {
  document.querySelectorAll('.clear-defects').forEach(
    (b) =>
      (b.onclick = () => {
        manualDefects = [];
        localStorage.setItem(DEFECTS_KEY, '[]');
        refreshDefectRegistry();
      }),
  );
  document.querySelectorAll('.print-defects').forEach((b) => (b.onclick = printDefectStickers));
  document.querySelectorAll('.remove-manual-defect').forEach(
    (b) =>
      (b.onclick = () => {
        manualDefects.splice(Number(b.dataset.index), 1);
        localStorage.setItem(DEFECTS_KEY, JSON.stringify(manualDefects));
        refreshDefectRegistry();
      }),
  );
}
/** Открывает отдельное окно с этикетками из сохранённого списка и запускает печать после загрузки страницы. Проверка пустого списка и блокировки окна предотвращает бессмысленное действие и сообщает о запрете браузера. */
function printDefectStickers() {
  if (!manualDefects.length) return;
  const w = window.open('', '_blank', 'width=600,height=800');
  if (!w) return toast('Браузер заблокировал окно печати');
  const printedAt = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Неисправные устройства</title><style>@page{size:58mm auto;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}.label{width:58mm;min-height:32mm;padding:2.5mm 3mm 2mm;border-bottom:1px dashed #999;page-break-after:always}.label-head{display:flex;justify-content:space-between;align-items:flex-start}.ip{font-size:14pt;font-weight:800}.models{font-size:9pt;font-weight:700;margin-top:3mm}.failed{font-size:12pt;font-weight:800;line-height:1.1;margin-top:3mm;word-wrap:break-word}@media screen{body{background:#eee}.label{background:#fff;margin:8px auto;box-shadow:0 1px 5px #999}}@media print{.label:last-child{page-break-after:auto}}</style></head><body>${manualDefects.map((x) => `<div class="label"><div class="label-head"><div class="ip">${esc(String(x.ip).split('.').slice(-2).join('.'))}</div></div><div class="models">${esc(x.models || 'Модель платы не определена')}</div><div class="failed">${esc([...(x.boards || []), x.defect].filter(Boolean).join(' — '))}</div><div style="margin-top:1.5mm;font-size:6pt;line-height:1">${esc(printedAt)}</div></div>`).join('')}<script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`,
  );
  w.document.close();
}
/** Назначает действия элементам, которые renderFleetMaps каждый раз создаёт заново: сохранение дефекта и настроек плат, Resume, копирование строк журнала и другие переключатели. Сетевые действия показывают результат или ошибку и возвращают кнопки в рабочее состояние. */
function bindDeviceActions() {
  document.querySelectorAll('.map-nopic-mode').forEach(
    (select) =>
      (select.onchange = () => {
        select.dataset.dirty = 'true';
        const badge = select.closest('.map-nopic');
        badge.classList.remove('nopic-enabled', 'nopic-disabled', 'nopic-unknown');
        badge.classList.add('nopic-' + select.value);
        badge.querySelector('.map-nopic-current strong').textContent = select.value;
      }),
  );
  bindDefectRegistryActions();
  document.querySelectorAll('.map-defect-form').forEach(
    (form) =>
      (form.onsubmit = (e) => {
        e.preventDefault();
        const ip = form.dataset.ip,
          d = resultDevice(fleetResults, ip),
          defect = form.elements.defect.value.trim();
        if (!defect) return;
        manualDefects = manualDefects.filter((x) => x.ip !== ip);
        manualDefects.push({
          ip,
          defect,
          models: d?.boardModel || d?.model || 'Модель платы не определена',
        });
        sortManualDefects();
        localStorage.setItem(DEFECTS_KEY, JSON.stringify(manualDefects));
        refreshDefectRegistry();
        form.elements.defect.value = '';
      }),
  );
  document.querySelectorAll('.map-resume-device').forEach(
    (b) =>
      (b.onclick = async () => {
        const ip = b.dataset.ip;
        b.disabled = true;
        try {
          await api('/api/miner/resume', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ip }),
          });
          b.textContent = 'Отправлено';
          toast(`${ip}: Resume отправлен`);
          setTimeout(pollMaps, 1500);
        } catch (e) {
          toast(`${ip}: ${e.message}`);
          b.disabled = false;
        }
      }),
  );
  document.querySelectorAll('.unpin-red-device').forEach(
    (btn) =>
      (btn.onclick = () => {
        pinnedRedIps.delete(btn.dataset.ip);
        recoveredRedIps.delete(btn.dataset.ip);
        summary();
        renderFleetMaps();
      }),
  );
  document.querySelectorAll('.map-save-device').forEach(
    (btn) =>
      (btn.onclick = async () => {
        const card = btn.closest('.red-device-card'),
          ip = card.dataset.monitorIp,
          d = resultDevice(fleetResults, ip);
        const config = {
          ip,
          boards: [...card.querySelectorAll('.map-board-toggle')].map((el, i) => ({
            id: d?.boards?.[i]?.id ?? String(i),
            enabled: el.checked,
          })),
          nopicMode: card.querySelector('.map-nopic-mode').value,
        };
        const state = card.querySelector('.map-device-save-state');
        btn.disabled = true;
        state.textContent = 'Применение…';
        try {
          const r = await api('/api/boards/configure', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ devices: [config] }),
          });
          const result = r.results?.[0];
          state.textContent = result?.ok
            ? `Платы сохранены${result.nopicApplied ? ` · NoPIC: ${result.nopicMode}` : ' · NoPIC не изменён (значение не получено)'}`
            : `Ошибка: ${result?.error || 'неизвестно'}`;
          if (result?.ok) {
            card.querySelector('.map-nopic-mode').dataset.dirty = 'false';
            await pollMaps();
          }
        } catch (e) {
          state.textContent = `Ошибка: ${e.message}`;
        } finally {
          btn.disabled = false;
        }
      }),
  );
  document.querySelectorAll('.map-wrap-toggle input').forEach(
    (x) =>
      (x.onchange = () => {
        const panel = x.closest('.map-log-panel');
        panel.classList.toggle('wrap-off', !x.checked);
      }),
  );
  document.querySelectorAll('.map-log-entry').forEach(
    (x) =>
      (x.onclick = async () => {
        try {
          await navigator.clipboard.writeText(x.innerText.replace(/^›\s*/, ''));
          x.classList.toggle('expanded');
        } catch {
          x.classList.toggle('expanded');
        }
      }),
  );
}
/** Повторно проверяет закреплённые проблемные ASIC через сервер, заменяет устаревшие сведения и обновляет карту со сводкой. Параллельные вызовы блокируются флагом busy; если устройство больше не проблемное, оно убирается из наблюдения. Ошибка фонового запроса отображается, но не прекращает будущие интервальные попытки. */
async function pollMaps() {
  if (mapPollBusy || !fleetResults.length) return;
  mapPollBusy = true;
  try {
    const devices = fleetResults.flatMap((r) => r.devices || []);
    const targets = devices.filter((d) => pinnedRedIps.has(d.ip) && isProblemDevice(d));
    if (!targets.length) return;
    const out = await api('/api/monitor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipients: targets, protocol: 'hybrid' }),
    });
    const fresh = new Map((out.devices || []).map((d) => [d.ip, d]));
    for (const d of targets) {
      const n = fresh.get(d.ip);
      // Если мониторинг не сообщил режим NoPIC, сохраняем последнее достоверное значение.
      if (
        n &&
        !['enabled', 'disabled'].includes(n.nopicMode) &&
        ['enabled', 'disabled'].includes(d.nopicMode)
      )
        n.nopicMode = d.nopicMode;
      if (!n) continue;
      if (!isProblemDevice(n)) {
        pinnedRedIps.delete(d.ip);
        recoveredRedIps.delete(d.ip);
      }
    }
    fleetResults = fleetResults.map((r) => ({
      ...r,
      devices: (r.devices || []).map((d) => fresh.get(d.ip) || d),
    }));
    summary();
    renderFleetMaps();
  } catch (e) {
    // Ошибка фонового опроса не останавливает цикл: следующая итерация повторит запрос.
    const st = $('#scanAllState');
    if (st) st.textContent = `Ошибка мониторинга: ${e.message}`;
  } finally {
    mapPollBusy = false;
  }
}

/** При старте страницы получает список ЦОДов с сервера, рисует список и карту, затем назначает действия кнопкам сканирования и отмены. Ошибка загрузки показывается уведомлением вместо необработанного сбоя. */
async function init() {
  try {
    cods = await api('/api/cods');
    renderSidebarCods();
    renderChecks();
    renderFleetMaps();
    const b = $('#scanAllBtn');
    if (b) b.onclick = () => scan(false);
    const cancel = $('#cancelScanBtn');
    if (cancel)
      cancel.onclick = async () => {
        cancel.disabled = true;
        $('#scanAllState').textContent = 'Отмена сканирования…';
        try {
          await api('/api/scan/cancel', { method: 'POST' });
        } catch (e) {
          cancel.disabled = false;
          toast(e.message);
        }
      };
    const bDemo = $('#scanDemoBtn');
    if (bDemo) bDemo.onclick = () => scan(true);
  } catch (e) {
    toast(e.message);
  }
}
init();
