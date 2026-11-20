const $ = (s) => document.querySelector(s);
let cods = [];
let devices = [];
let mixes = [];
let selectedCod = null;
let scanStats = null;
let activeRecipients = [];
let activeDonors = [];
let savedSets = [];
let scanRunning = false;
const toast = (msg) => {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
};
// Вызывается обработчиками интерфейса для всех запросов к серверу; возвращает разобранные данные или выбрасывает ошибку.
const api = async (url, options) => {
  // Общая обёртка для HTTP-запросов: отправляет запрос, читает JSON и возвращает данные вызывающему коду. Если сервер ответил ошибкой, выбрасывает исключение с его сообщением, чтобы обработчик мог показать его пользователю.
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw Error(data.error || 'Ошибка запроса');
  return data;
};
const rangeLabel = (c) => c.cidr || `${c.start}${c.end && c.end !== c.start ? ` — ${c.end}` : ''}`;
let editingCodId = null;
let codSort = 'count-desc';
/** Собирает список ЦОДов в группы по энергокомплексу и сортирует сами группы по выбранному режиму. Возвращает пары [название группы, список ЦОДов]; renderCods использует их для построения интерфейса. */
function groupedCods() {
  const groups = new Map();
  cods.forEach((c) => {
    const group = c.ec || 'Без группы';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(c);
  });
  const entries = [...groups.entries()];
  const firstOrder = (items) => Math.min(...items.map((c) => c.order ?? cods.indexOf(c)));
  if (codSort === 'count-asc')
    entries.sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0], 'ru'));
  else if (codSort === 'name') entries.sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  else if (codSort === 'order') entries.sort((a, b) => firstOrder(a[1]) - firstOrder(b[1]));
  else entries.sort((a, b) => b[1].length - a[1].length || firstOrder(a[1]) - firstOrder(b[1]));
  return entries;
}
// Перерисовывает список ЦОДов, выпадающий список и кнопки действий по текущему массиву cods. Обработчики кликов назначаются заново, потому что HTML списка заменяется целиком.
function renderCods() {
  $('#statCods').textContent = cods.length;
  $('#emptyCods').style.display = cods.length ? 'none' : 'block';
  const entries = groupedCods();
  $('#railCods').innerHTML = cods.length
    ? entries
        .map(
          ([group, items]) =>
            `<details class="rail-ec"><summary><span>${escapeHtml(group)}</span><b>${items.length}</b></summary><div class="rail-ec-items">${items.map((c) => `<button class="rail-cod ${selectedCod?.id === c.id ? 'selected' : ''}" data-id="${c.id}"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(rangeLabel(c))}</small></button>`).join('')}</div></details>`,
        )
        .join('')
    : '<div class="rail-empty">Нет ЦОДов</div>';
  $('#codList').innerHTML = entries
    .map(
      ([group, items]) =>
        `<details class="cod-group" open><summary class="cod-group-head"><span><strong>${escapeHtml(group)}</strong><small>${items.length} ЦОД${items.length === 1 ? '' : items.length < 5 ? 'а' : 'ов'}</small></span><b>⌄</b></summary><div class="cod-group-items">${items
          .map((c) => {
            const i = cods.findIndex((x) => x.id === c.id);
            return `<article class="cod-card ${selectedCod?.id === c.id ? 'selected' : ''}" data-id="${c.id}"><div><div class="cod-name">${escapeHtml(c.name)}</div><div class="cod-range">${escapeHtml(rangeLabel(c))}</div></div><div class="cod-actions"><button class="mini-button choose-cod" title="Выбрать">→</button><button class="mini-button edit-cod" title="Редактировать">✎</button><button class="mini-button move-cod" data-dir="up" title="Переместить вверх" ${i === 0 ? 'disabled' : ''}>↑</button><button class="mini-button move-cod" data-dir="down" title="Переместить вниз" ${i === cods.length - 1 ? 'disabled' : ''}>↓</button><button class="mini-button delete-cod" title="Удалить">×</button></div></article>`;
          })
          .join('')}</div></details>`,
    )
    .join('');
  $('#codSelect').innerHTML =
    `<option value="">Выберите ЦОД</option>` +
    cods
      .map(
        (c) =>
          `<option value="${c.id}" ${selectedCod?.id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`,
      )
      .join('');
  syncMapCodSelect();
  document
    .querySelectorAll('.choose-cod,.rail-cod')
    .forEach(
      (b) => (b.onclick = () => selectCod(b.dataset.id || b.closest('.cod-card').dataset.id)),
    );
  document
    .querySelectorAll('.edit-cod')
    .forEach(
      (b) =>
        (b.onclick = () =>
          openCodDialog(cods.find((c) => c.id === b.closest('.cod-card').dataset.id))),
    );
  document
    .querySelectorAll('.move-cod')
    .forEach((b) => (b.onclick = () => moveCod(b.closest('.cod-card').dataset.id, b.dataset.dir)));
  document.querySelectorAll('.delete-cod').forEach(
    (b) =>
      (b.onclick = async () => {
        const id = b.closest('.cod-card').dataset.id;
        await api(`/api/cods/${id}`, { method: 'DELETE' });
        cods = cods.filter((c) => c.id !== id);
        if (selectedCod?.id === id) {
          selectedCod = null;
          devices = [];
          scanStats = null;
          mixes = [];
          renderResults();
          renderMixes();
        }
        renderCods();
        toast('ЦОД удалён');
      }),
  );
}
$('#codSort').onchange = (e) => {
  codSort = e.target.value;
  renderCods();
};
document
  .querySelectorAll('.close-cod-dialog')
  .forEach((button) => (button.onclick = () => $('#codDialog').close()));
function openCodDialog(cod = null) {
  editingCodId = cod?.id || null;
  const form = $('#codForm');
  form.reset();
  if (cod) {
    form.elements.name.value = cod.name;
    form.elements.ec.value = cod.ec === 'Без группы' ? '' : cod.ec || '';
    form.elements.start.value = cod.start || '';
    form.elements.end.value = cod.end || '';
    form.elements.cidr.value = cod.cidr || '';
  }
  $('#codDialogTitle').textContent = cod ? 'Редактировать ЦОД' : 'Добавить ЦОД';
  $('#codSubmit').textContent = cod ? 'Сохранить изменения' : 'Сохранить ЦОД';
  $('#formError').textContent = '';
  $('#codDialog').showModal();
}
async function moveCod(id, direction) {
  const index = cods.findIndex((c) => c.id === id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= cods.length) return;
  const ids = cods.map((c) => c.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  // Сначала отправляем новый порядок на сервер и лишь по успешному ответу заменяем локальный список: при ошибке экран не показывает порядок, который сервер не сохранил.
  try {
    cods = await api('/api/cods/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    renderCods();
    toast('Порядок ЦОДов изменён');
  } catch (err) {
    toast(err.message);
  }
}
function selectCod(id) {
  selectedCod = cods.find((c) => c.id === id) || null;
  $('#codSelect').value = selectedCod?.id || '';
  renderCods();
  $('#mixScope').textContent = selectedCod ? selectedCod.name : 'ЦОД не выбран';
  if (typeof updateProtocolControls === 'function') updateProtocolControls();
}
function escapeHtml(v) {
  // Перед вставкой внешнего текста в HTML заменяет специальные символы на безопасные текстовые формы, чтобы они не стали разметкой или исполняемым кодом.
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c],
  );
}
// По полям устройства выбирает HTML-метку состояния; текст ошибки и журнал экранируются перед вставкой в разметку.
function statusChip(d) {
  const title = d.error ? ` title="${escapeHtml(d.error)}"` : '';
  const logs = [...(d.errorLogs || [])];
  if (d.error && d.status === 'offline') logs.unshift(d.error);
  const logHtml = logs.length
    ? `<div class="error-log-list">${logs
        .slice(-5)
        .map((log) => `<div class="error-log">${escapeHtml(log)}</div>`)
        .join('')}</div>`
    : '';
  if (d.status === 'offline')
    return `<div class="check-status"><span class="status-chip bad"${title}>× OFFLINE</span>${logHtml}</div>`;
  if (d.status === 'sleep') return `<span class="status-chip sleep"${title}>SLEEP</span>`;
  if (d.firmwareFamily !== 'braiins')
    return `<span class="status-chip other-firmware"${title}>ДРУГАЯ ПРОШИВКА · ${escapeHtml(d.ratio || 'данные плат неизвестны')}</span>`;
  if (d.status === 'healthy')
    return `<span class="status-chip good"${title}><span class="dot" style="background:var(--green)"></span> OK</span>`;
  if (d.ratio === '0/3')
    return `<div class="check-status"><span class="status-chip bad"${title}>0/3 · НЕ РАБОТАЮТ ПЛАТЫ</span>${logHtml}</div>`;
  if (d.status === 'check')
    return `<div class="check-status"><span class="status-chip warn"${title}>⚠ ПРОВЕРИТЬ</span>${logHtml || '<div class="error-log-empty">Ошибки API не переданы</div>'}</div>`;
  return `<div class="check-status"><span class="status-chip warn"${title}>△ НЕРАБОЧАЯ ПЛАТА</span>${logHtml}</div>`;
}
const formatGh = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0
    ? `${(Number(value) / 1000).toFixed(2).replace('.', ',')} TH/s`
    : '0,00 TH/s';
const boardRows = (d) =>
  Array.from(
    { length: 3 },
    (_, i) =>
      d.boards?.[i] || { number: i + 1, model: 'нет данных', hashrateGh: 0, working: false },
  )
    .map((b, i) => {
      const tone = d.firmwareFamily !== 'braiins' ? 'other-firmware' : b.working ? '' : 'bad';
      return `<div class="board-line ${tone}"><span class="board-num">${i + 1}-я</span><span class="board-model">${escapeHtml(b.model || 'нет данных')}</span><span class="board-hash">${formatGh(b.hashrateGh)}</span></div>`;
    })
    .join('');
const localScanSummary = () => {
  // Запасной подсчёт по уже загруженным устройствам нужен, если ответ сервера не содержит готовой сводки. Возвращает те же основные числа, которые отображает renderScanSummary.
  const online = devices.filter((d) => d.online);
  const ratioCounts = Object.fromEntries(
    ['3/3', '2/3', '1/3', '0/3'].map((ratio) => [
      ratio,
      online.filter((d) => d.ratio === ratio).length,
    ]),
  );
  return {
    totalIps: devices.length,
    scannedIps: online.length,
    offlineIps: devices.length - online.length,
    idleIps: online.filter((d) => d.ratio !== '3/3').length,
    ratioCounts,
  };
};
function renderScanSummary() {
  const s = scanStats || localScanSummary();
  if (!devices.length) {
    $('#scanSummary').className = 'scan-summary hidden';
    $('#scanSummary').innerHTML = '';
    return;
  }
  const c = s.ratioCounts || {};
  $('#scanSummary').className = 'scan-summary';
  $('#scanSummary').innerHTML =
    `<div class="summary-heading"><strong>Итог сканирования</strong><small>Оффлайн-устройства не входят в распределение по платам</small></div><div class="summary-grid"><div class="summary-item"><span>Всего IP</span><b>${s.totalIps}</b></div><div class="summary-item good"><span>Удалось просканировать</span><b>${s.scannedIps}</b></div><div class="summary-item idle"><span>В простое, не офлайн</span><b>${s.idleIps}</b></div><div class="summary-item healthy"><span>3/3</span><b>${c['3/3'] || 0}</b></div><div class="summary-item degraded"><span>2/3</span><b>${c['2/3'] || 0}</b></div><div class="summary-item degraded"><span>1/3</span><b>${c['1/3'] || 0}</b></div><div class="summary-item check"><span>0/3</span><b>${c['0/3'] || 0}</b></div></div>`;
}
// Обновляет сводные счётчики и таблицу устройств. Флажки скрывают здоровые или офлайн-устройства только в таблице, не удаляя их из исходного списка devices.
function renderResults() {
  const visible = devices.filter(
    (d) =>
      ($('#showHealthy').checked || d.ratio !== '3/3') &&
      ($('#showOffline').checked || d.status !== 'offline'),
  );
  renderScanSummary();
  $('#statDevices').textContent = devices.filter((d) => d.status !== 'offline').length || '—';
  $('#statCheck').textContent =
    devices.filter(
      (d) => d.firmwareFamily === 'braiins' && d.ratio === '0/3' && d.status !== 'sleep',
    ).length || '0';
  $('#statBoards').textContent =
    devices
      .filter((d) => d.online && d.workingBoards < 3 && d.workingBoards > 0)
      .reduce((s, d) => s + d.workingBoards, 0) || '0';
  if (!devices.length) {
    $('#resultsBody').className = 'empty compact';
    $('#resultsBody').innerHTML =
      '<div class="empty-icon">⌁</div><h3>Результаты появятся после сканирования</h3><p>Выберите ЦОД и запустите сканирование.</p>';
    return;
  }
  $('#resultsBody').className = 'table-wrap';
  $('#resultsBody').innerHTML =
    `<table class="data-table"><thead><tr><th>IP</th><th>МОДЕЛЬ ASIC</th><th>МОДЕЛИ ПЛАТ</th><th>ПЛАТЫ / ТЕКУЩИЙ ХЕШРЕЙТ, TH/s</th><th>НЕИСПРАВНЫЕ</th><th>ИТОГ</th><th>ОТКЛИК</th><th>СТАТУС</th></tr></thead><tbody>${visible.map((d) => `<tr><td><a class="ip-link" href="http://${escapeHtml(d.ip)}" target="_blank" rel="noopener">${escapeHtml(d.ip)}</a></td><td>${escapeHtml(d.model)}</td><td class="board-model-list">${escapeHtml(d.boardModel || '—')}</td><td><div class="board-stack">${boardRows(d)}</div></td><td class="failed ${d.firmwareFamily !== 'braiins' ? 'other-firmware' : ''}">${d.failedBoards?.length ? d.failedBoards.map((n) => `${n}-я`).join(', ') : '—'}</td><td class="ratio-cell ${d.firmwareFamily !== 'braiins' ? 'other-firmware' : ''}">${escapeHtml(d.ratio)}</td><td class="device-response-time">${Number.isFinite(Number(d.responseTimeMs ?? d.scanDurationMs)) ? `${Math.round(Number(d.responseTimeMs ?? d.scanDurationMs))} мс` : '—'}</td><td>${statusChip(d)}</td></tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:30px">Сейчас нечего показывать. Включите нужный переключатель фильтра.</td></tr>'}</tbody></table>`;
  document.querySelectorAll('.error-log-list').forEach((el) => {
    el.scrollTop = el.scrollHeight;
  });
}
const roleDevice = (d, role, inMix = true) =>
  `<div class="role-device"><a class="ip-link" href="http://${escapeHtml(d.ip)}" target="_blank" rel="noopener">${escapeHtml(d.ip)}</a><span class="role-ratio">${escapeHtml(d.ratio)}${inMix ? ` → ${role === 'recipient' ? '3/3' : '0/3'}` : ''}</span><span class="role-bad">${d.failedBoards?.length ? `HB ${d.failedBoards.join(', ')}` : '—'}</span><button class="mini-button label-one" data-ip="${escapeHtml(d.ip)}" data-role="${role}" title="Печать этикетки">▣</button></div>`;
const labelPayload = (d, role) => ({
  ip: d.ip,
  role: role === 'recipient' ? 'РЕЦИПИЕНТ' : 'ДОНОР',
  models:
    [...new Set((d.boards || []).map((b) => b.model).filter(Boolean))].join(', ') ||
    d.boardModel ||
    'Модель платы не определена',
  failed: d.failedBoards?.length ? `HB ${d.failedBoards.join(', ')}` : 'HB —',
});
// Принимает уже подготовленные данные этикеток, открывает отдельное окно и печатает их; пустой список и блокировка окна обрабатываются до записи документа.
function printLabelEntries(entries) {
  if (!entries.length) return toast('Нет устройств для печати');
  const w = window.open('', '_blank', 'width=600,height=800');
  // Окно печати открывается браузером; если всплывающие окна запрещены, window.open вернёт пустое значение, поэтому показываем понятное сообщение и прекращаем печать.
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
    `<!doctype html><html><head><meta charset="utf-8"><title>Этикетки</title><style>@page{size:58mm auto;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}.label{width:58mm;min-height:32mm;padding:2.5mm 3mm 2mm;border-bottom:1px dashed #999;page-break-after:always;position:relative}.label-head{display:flex;justify-content:space-between;align-items:flex-start;gap:2mm}.ip{font-size:14pt;font-weight:800;letter-spacing:0;white-space:nowrap;line-height:1.05}.role{font-size:12pt;font-weight:800;text-align:right;line-height:1.1;word-wrap:break-word}.models{font-size:9pt;font-weight:700;line-height:1.1;margin-top:3mm;max-width:52mm;word-wrap:break-word}.failed{font-size:14pt;font-weight:800;line-height:1.1;margin-top:3mm}.hint{display:none}@media screen{body{background:#eee}.label{background:#fff;margin:8px auto;box-shadow:0 1px 5px #999}}@media print{.label:last-child{page-break-after:auto}}</style></head><body>${entries
      .map((x) => {
        const parts = x.ip.split('.');
        return `<div class="label"><div class="label-head"><div class="ip">${escapeHtml(parts.slice(-2).join('.'))}</div><div class="role">${escapeHtml(x.role)}</div></div><div class="models">${escapeHtml(x.models)}</div><div class="failed">${escapeHtml(x.failed)}</div><div style="margin-top:1.5mm;font-size:6pt;line-height:1">${escapeHtml(printedAt)}</div></div>`;
      })
      .join(
        '',
      )}<script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`,
  );
  w.document.close();
}
function printLabels(role, source) {
  printLabelEntries(source.map((d) => labelPayload(d, role)));
}
function printGroup(m) {
  const recipients = m.usedRecipients || m.recipients.slice(0, m.suggestedMixes);
  const donors = m.usedDonors || m.donors.slice(0, m.suggestedMixes);
  printLabelEntries([
    ...recipients.map((d) => labelPayload(d, 'recipient')),
    ...donors.map((d) => labelPayload(d, 'donor')),
  ]);
}
// Показывает рассчитанные группы доноров и реципиентов и связывает кнопки печати с соответствующими группами.
function renderMixes() {
  if (!mixes.length) {
    $('#mixBody').className = 'empty compact';
    $('#mixBody').innerHTML =
      '<div class="empty-icon">⊕</div><h3>Нет готовых групп для микса</h3><p>Нужны устройства с 1/3 или 2/3 рабочих плат.</p>';
    return;
  }
  $('#mixBody').className = 'mix-list';
  $('#mixBody').innerHTML = mixes
    .map((m, i) => {
      const recipients = m.usedRecipients || m.recipients.slice(0, m.suggestedMixes);
      const donors = m.usedDonors || m.donors.slice(0, m.suggestedMixes);
      const unusedRecipients = m.unusedRecipients || m.recipients.slice(m.suggestedMixes);
      const unusedDonors = m.unusedDonors || m.donors.slice(m.suggestedMixes);
      const unused = [
        ...unusedRecipients.map((d) => ({ d, role: 'recipient' })),
        ...unusedDonors.map((d) => ({ d, role: 'donor' })),
      ];
      return `<details class="mix-card" open><summary class="mix-title"><span><strong>${escapeHtml(m.boardModel)}</strong><small>${m.devices.length} ASIC в группе · ${m.suggestedMixes} реципиентов будут закрыты до 3/3</small></span><span class="mix-summary"><span class="pill">${m.suggestedMixes} MIX</span><span class="chevron">⌄</span></span></summary><div class="mix-toolbar"><span>Передаётся плат: <b>${m.boardTransfers || 0}</b> · Доноров в разбор: <b>${donors.length}</b> · Реципиентов до 3/3: <b>${recipients.length}</b>${unused.length ? ` · Не используются: <b class="unused-count">${unused.length}</b>` : ''}</span><button class="button secondary small-button print-group" data-group="${i}">▣ Печать результата группы</button></div><div class="role-grid"><section class="role-column recipient-column"><div class="role-head"><h3>Реципиенты <span>${recipients.length}</span></h3></div><p>После операции: доноры 0/3 · реципиенты 3/3</p>${recipients.length ? recipients.map((d) => roleDevice(d, 'recipient')).join('') : '<div class="role-empty">Нет реципиентов для пары</div>'}</section><section class="role-column donor-column"><div class="role-head"><h3>Доноры <span>${donors.length}</span></h3></div><p>После операции: доноры 0/3 · реципиенты 3/3</p>${donors.length ? donors.map((d) => roleDevice(d, 'donor')).join('') : '<div class="role-empty">Нет доноров для пары</div>'}</section></div>${unused.length ? `<div class="unused-block"><div class="unused-head"><strong>Не используются в текущем миксе</strong><span>${unused.length} ASIC · не попадут в печать результата</span></div><div class="unused-grid">${unused.map((x) => `<div class="unused-device"><span>${x.role === 'recipient' ? 'Реципиент' : 'Донор'}</span>${roleDevice(x.d, x.role, false)}</div>`).join('')}</div></div>` : ''}</details>`;
    })
    .join('');
  document.querySelectorAll('.print-group').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        printGroup(mixes[Number(b.dataset.group)]);
      }),
  );
  document.querySelectorAll('.label-one').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        const d = devices.find((x) => x.ip === b.dataset.ip);
        printLabels(b.dataset.role, d ? [d] : []);
      }),
  );
}
$('#addCodBtn').onclick = () => openCodDialog();
$('#codForm').onsubmit = async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (data.cidr) {
    // Если задана сеть в формате CIDR, убираем границы явного диапазона: сервер получает только один выбранный способ задания адресов.
    data.start = '';
    data.end = '';
  }
  try {
    const options = {
      method: editingCodId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    };
    const c = await api(editingCodId ? `/api/cods/${editingCodId}` : '/api/cods', options);
    if (editingCodId) {
      cods = cods.map((item) => (item.id === c.id ? c : item));
      if (selectedCod?.id === c.id) selectedCod = c;
    } else {
      cods.push(c);
      selectedCod = c;
    }
    renderCods();
    if (selectedCod) selectCod(selectedCod.id);
    $('#codDialog').close();
    toast(editingCodId ? 'ЦОД изменён' : 'ЦОД добавлен');
    editingCodId = null;
  } catch (err) {
    $('#formError').textContent = err.message;
  }
};
$('#codSelect').onchange = (e) => selectCod(e.target.value);
const selectedProtocol = () => {
  const rest = $('#useRest').checked;
  const grpc = $('#useGrpc').checked;
  const legacy = $('#useLegacy').checked;
  const selected = [rest, grpc, legacy].filter(Boolean).length;
  if (!selected) return null;
  // Возвращает выбранный режим для запроса сканирования: null означает, что ничего не выбрано, а несколько флажков включают автоматический переход между протоколами при неудаче.
  if (selected > 1) return 'auto';
  if (legacy && window.appliedScanSettings?.protocol === 'hybrid') return 'hybrid';
  return rest ? 'rest' : grpc ? 'grpc' : 'legacy';
};
const protocolLabel = (protocol) => {
  const settings = window.appliedScanSettings || {};
  return protocol === 'hybrid'
    ? `быстрый CGMiner ${settings.legacyPort || 4028} + детальный опрос проблемных`
    : protocol === 'rest'
      ? `REST API ${settings.restPort || 80}`
      : protocol === 'grpc'
        ? `gRPC ${settings.grpcPort || 50051}`
        : protocol === 'legacy'
          ? `TCP ${settings.legacyPort || 4028}`
          : `REST → gRPC → TCP ${settings.legacyPort || 4028} fallback`;
};
// Синхронизирует кнопку сканирования с выбором ЦОДа, протокола и текущим состоянием запроса.
function updateProtocolControls() {
  const protocol = selectedProtocol();
  $('#scanBtn').disabled = scanRunning || !selectedCod || !protocol;
  $('#scanBtn').title = protocol
    ? `Режим: ${protocolLabel(protocol)}`
    : 'Выберите хотя бы один протокол';
}
window.addEventListener('scanner-settings-applied', updateProtocolControls);
$('#useRest').onchange = updateProtocolControls;
$('#useGrpc').onchange = updateProtocolControls;
$('#useLegacy').onchange = updateProtocolControls;
$('#showHealthy').onchange = renderResults;
$('#showOffline').onchange = renderResults;
$('#scanBtn').onclick = async () => {
  // Настройки сканера могут применяться асинхронно. Ждём их завершения, чтобы следующий запрос использовал актуальные параметры.
  await window.scannerSettingsReady;
  if (!selectedCod || scanRunning) return;
  const protocol = selectedProtocol();
  if (!protocol) {
    toast('Выберите хотя бы один протокол');
    return;
  }
  const btn = $('#scanBtn');
  scanRunning = true;
  btn.disabled = true;
  $('#scanCancelBtn').classList.remove('hidden');
  $('#scanCancelBtn').disabled = false;
  $('#scanState').className = 'scan-state';
  $('#scanState').textContent =
    `Сканируем ${selectedCod.name} · ${protocolLabel(protocol)} · адреса из карты (если настроена), иначе диапазон ${rangeLabel(selectedCod)} …`;
  try {
    const data = await api('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codId: selectedCod.id, protocol }),
    });
    devices = data.devices;
    // Из ответа сохраняем сводку (или рассчитываем её локально) и обновлённые миксы; список целей для последующих действий строим отдельно, исключая устройства без связи.
    scanStats = data.scanSummary || localScanSummary();
    mixes = data.mixes;
    const lists = currentMixLists();
    activeRecipients = lists.recipients.filter(isOnlineDevice);
    activeDonors = lists.donors;
    selectedRecipientIps = new Set(activeRecipients.map((d) => d.ip));
    $('#lastScan').textContent =
      `Последний скан: ${new Date(data.scannedAt).toLocaleTimeString('ru-RU')} · ${protocolLabel(data.protocol)}`;
    renderResults();
    renderMixes();
    renderRecipientControl();
    startMonitoring(devices);
    $('#scanState').textContent =
      `${data.cancelled ? 'Сканирование отменено' : 'Готово'} · проверено адресов: ${devices.length}/${scanStats.totalIps ?? devices.length} · область: ${data.scanScope === 'map' ? 'карта ЦОДа' : data.scanScope === 'range' ? 'IP-диапазон' : 'демо'} · групп плат: ${mixes.length} · ${protocolLabel(data.protocol)}`;
    toast(data.cancelled ? 'Сканирование отменено' : 'Сканирование завершено');
  } catch (err) {
    $('#scanState').textContent = `Ошибка: ${err.message}`;
    toast(err.message);
  } finally {
    // Блок finally срабатывает и при успехе, и при ошибке запроса: возвращаем интерфейс из режима сканирования и снова вычисляем доступность кнопки.
    scanRunning = false;
    $('#scanCancelBtn').classList.add('hidden');
    $('#scanCancelBtn').disabled = false;
    updateProtocolControls();
  }
};
$('#scanCancelBtn').onclick = async () => {
  const button = $('#scanCancelBtn');
  button.disabled = true;
  $('#scanState').textContent = 'Отмена сканирования…';
  try {
    await api('/api/scan/cancel', { method: 'POST' });
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
};
const uniqueDevices = (items) => [
  // Удаляет записи без IP и объединяет повторы по IP; Map оставляет для каждого адреса последнее состояние. Возвращает массив для дальнейших расчётов и отображения.
  ...new Map(items.filter((d) => d?.ip).map((d) => [d.ip, d])).values(),
];
const isOnlineDevice = (d) => d?.online !== false && d?.status !== 'offline';
const currentMixLists = () => ({
  recipients: uniqueDevices(mixes.flatMap((m) => m.usedRecipients || m.recipients || [])).filter(
    isOnlineDevice,
  ),
  donors: uniqueDevices(mixes.flatMap((m) => m.usedDonors || m.donors || [])),
});
const boardGroupKey = (d) =>
  d?.boardModel ||
  [...new Set((d?.boards || []).map((b) => b.model).filter(Boolean))].join(', ') ||
  'Модель платы не определена';
let selectedRecipientIps = new Set();
let monitorTargets = [];
let monitorTimer = null;
let monitorBusy = false;
let monitorRunning = false;
const expandedMonitorLogs = new Set();
// Сверяет выбранные IP с доступными реципиентами и обновляет счётчик, чекбоксы и доступность действия.
function syncRecipientSelection() {
  const all = uniqueDevices(activeRecipients);
  const selected = all.filter((d) => selectedRecipientIps.has(d.ip));
  $('#enableBoardsBtn').disabled = !selected.length;
  $('#selectedRecipientsCount').textContent = `Выбрано: ${selected.length}`;
  const selectAll = $('#selectAllRecipients');
  if (selectAll) {
    // У чекбокса «выбрать все» есть третье состояние: indeterminate показывает, что отмечена только часть устройств.
    selectAll.checked = Boolean(all.length && selected.length === all.length);
    selectAll.indeterminate = Boolean(selected.length && selected.length < all.length);
  }
  document.querySelectorAll('.recipient-check').forEach((input) => {
    input.checked = selectedRecipientIps.has(input.dataset.ip);
  });
}
function monitorLogEntryHtml(value) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*[—-]?\s*(.*)$/);
  return `<div class="map-log-entry"><span class="map-log-marker">›</span>${match ? `<time class="map-log-time">${escapeHtml(match[1])}</time><span class="map-log-message">${escapeHtml(match[2])}</span>` : `<span class="map-log-message">${escapeHtml(text)}</span>`}</div>`;
}
// Перерисовывает список устройств под мониторингом и назначает переключатели журналов после замены HTML.
function renderMonitorList() {
  const list = $('#monitorList');
  if (!list) return;
  if ($('#enableBoardsBtn'))
    $('#enableBoardsBtn').disabled = !activeRecipients.some((d) => selectedRecipientIps.has(d.ip));
  list.innerHTML = monitorTargets.length
    ? monitorTargets
        .map(
          (d) =>
            `<article class="monitor-row"><div class="monitor-row-main"><a class="ip-link" href="http://${escapeHtml(d.ip)}" target="_blank" rel="noopener">${escapeHtml(d.ip)}</a><b class="monitor-ratio ${d.status === 'offline' ? 'bad' : d.status === 'sleep' ? 'sleep' : d.firmwareFamily !== 'braiins' ? 'other-firmware' : d.status === 'healthy' ? 'good' : d.status === 'degraded' ? 'warn' : 'bad'}">${escapeHtml(d.ratio || '—')}</b><span class="monitor-row-model">${escapeHtml(d.model || 'ASIC')}</span><span class="monitor-row-boards">${(d.boards || []).map((b, i) => `HB${i + 1} ${formatGh(b.hashrateGh)}`).join(' · ') || 'платы —'}</span><span class="monitor-row-state">${d.nopicMode ? `NoPIC: ${escapeHtml(d.nopicMode)}` : ''}${d.error ? ` · ${escapeHtml(d.error)}` : d.status ? ` · ${escapeHtml(d.status)}` : ''}</span><button class="button secondary small-button monitor-log-toggle" type="button" data-ip="${escapeHtml(d.ip)}">${expandedMonitorLogs.has(d.ip) ? 'Скрыть' : 'Показать'} логи (${(d.errorLogs || []).length})</button></div><div class="monitor-row-logs ${expandedMonitorLogs.has(d.ip) ? '' : 'hidden'}">${(d.errorLogs || []).length ? (d.errorLogs || []).map(monitorLogEntryHtml).join('') : 'Логи ошибок пусты'}</div></article>`,
        )
        .join('')
    : '<div class="empty compact">Нет неисправных устройств</div>';
  list.querySelectorAll('.monitor-row-logs:not(.hidden)').forEach((el) => {
    el.scrollTop = el.scrollHeight;
  });
  list.querySelectorAll('.monitor-log-toggle').forEach(
    (btn) =>
      (btn.onclick = () => {
        const logs = btn.closest('.monitor-row').querySelector('.monitor-row-logs');
        logs.classList.toggle('hidden');
        if (logs.classList.contains('hidden')) expandedMonitorLogs.delete(btn.dataset.ip);
        else {
          expandedMonitorLogs.add(btn.dataset.ip);
          logs.scrollTop = logs.scrollHeight;
        }
        btn.textContent = `${logs.classList.contains('hidden') ? 'Показать' : 'Скрыть'} логи (${(monitorTargets.find((x) => x.ip === btn.dataset.ip)?.errorLogs || []).length})`;
      }),
  );
}

// Останавливает периодический таймер и обновляет состояние панели; вызывается кнопкой остановки и при необходимости из логики мониторинга.
function stopMonitoring(message = 'Мониторинг остановлен') {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  monitorRunning = false;
  const panel = $('#monitorPanel');
  if (panel) panel.classList.toggle('hidden', !monitorTargets.length);
  const state = $('#monitorState');
  if (state) state.textContent = message;
}
async function runMonitorPoll() {
  // Таймер запускает опросы периодически, но медленный сетевой запрос может ещё идти. Флаг busy пропускает такой запуск, чтобы запросы не накладывались друг на друга.
  if (!monitorRunning || monitorBusy) return;
  monitorBusy = true;
  try {
    const targets = uniqueDevices(monitorTargets);
    if (!targets.length) {
      monitorTargets = [];
      renderMonitorList();
      return;
    }
    const data = await api('/api/monitor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipients: targets, protocol: 'hybrid' }),
    });
    const updated = new Map(data.devices.map((d) => [d.ip, d]));
    devices = devices.map((d) => updated.get(d.ip) || d);
    monitorTargets = uniqueDevices(devices).filter(
      (d) =>
        d.online !== false &&
        d.status !== 'sleep' &&
        (d.status !== 'healthy' || d.boards?.some((b) => !b.working)),
    );
    renderMonitorList();
    renderResults();
    const state = $('#monitorState');
    if (state)
      state.textContent = `Последнее обновление: ${new Date(data.checkedAt).toLocaleTimeString('ru-RU')} · ${monitorTargets.length} проблемных ASIC`;
  } catch (e) {
    // Ошибка текущего сетевого опроса показывается в панели; флаг занятости сбросится в finally, поэтому следующий запуск таймера сможет повторить запрос.
    const state = $('#monitorState');
    if (state) state.textContent = `Ошибка: ${e.message}`;
  } finally {
    monitorBusy = false;
  }
}
// Формирует начальный список проблемных устройств, сразу запускает первый опрос и далее повторяет его раз в пять секунд.
function startMonitoring() {
  monitorTargets = uniqueDevices(devices).filter(
    (d) =>
      d.online !== false &&
      d.status !== 'sleep' &&
      (d.status !== 'healthy' || d.boards?.some((b) => !b.working)),
  );
  monitorRunning = true;
  const panel = $('#monitorPanel');
  if (panel) panel.classList.remove('hidden');
  renderMonitorList();
  runMonitorPoll();
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(runMonitorPoll, 5000);
}

// Строит список доступных реципиентов, сгруппированный по моделям плат, и назначает обработчики выбора отдельных устройств и групп.
function renderRecipientControl() {
  const all = uniqueDevices(activeRecipients);
  activeRecipients = all;
  if (!all.length) {
    $('#recipientControlList').innerHTML =
      '<div class="empty compact"><h3>Реципиенты не выбраны</h3><p>После расчёта микса или загрузки сохранения здесь появится список устройств.</p></div>';
    $('#enableBoardsBtn').disabled = true;
    $('#selectedRecipientsCount').textContent = 'Выбрано: 0';
    return;
  }
  const groups = new Map();
  all.forEach((d) => {
    const key = boardGroupKey(d);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });
  $('#recipientControlList').innerHTML =
    `<div class="control-list-head"><strong>${all.length} ASIC · ${groups.size} моделей плат</strong><span>Выберите отдельные ASIC или используйте действие группы</span></div><div class="board-model-groups">${[...groups.entries()].map(([model, items], index) => `<details class="board-model-group" open><summary><span><b>${escapeHtml(model)}</b><small>${items.length} реципиент${items.length === 1 ? '' : items.length < 5 ? 'а' : 'ов'}</small></span><div class="group-summary-actions"><button type="button" class="button secondary small-button enable-model" data-model-index="${index}">Включить группу</button><span class="chevron">⌄</span></div></summary><div class="model-group-body">${items.map((d) => `<label class="control-device selectable-device"><input class="recipient-check" type="checkbox" data-ip="${escapeHtml(d.ip)}" ${selectedRecipientIps.has(d.ip) ? 'checked' : ''}><span class="device-main"><a class="ip-link" href="http://${escapeHtml(d.ip)}" target="_blank" rel="noopener">${escapeHtml(d.ip)}</a><em>${escapeHtml(d.model || 'ASIC')}</em></span><b>${escapeHtml(d.ratio || '—')} → 3/3</b><small>${d.failedBoards?.length ? `HB ${d.failedBoards.join(', ')}` : 'Платы к включению: ' + Math.max(0, 3 - Number(d.workingBoards || 0))}</small></label>`).join('')}</div></details>`).join('')}</div>`;
  const groupList = [...groups.values()];
  document.querySelectorAll('.recipient-check').forEach(
    (input) =>
      (input.onchange = () => {
        if (input.checked) selectedRecipientIps.add(input.dataset.ip);
        else selectedRecipientIps.delete(input.dataset.ip);
        syncRecipientSelection();
      }),
  );
  document.querySelectorAll('.enable-model').forEach(
    (button) =>
      (button.onclick = (event) => {
        event.preventDefault();
        const items = groupList[Number(button.dataset.modelIndex)] || [];
        performEnableBoards(items, `модели ${boardGroupKey(items[0])}`);
      }),
  );
  syncRecipientSelection();
}
// Запрашивает у сервера сохранённые наборы и обновляет список выбора; при сетевой ошибке оставляет понятный вариант «сохранений нет».
async function refreshSavedSets() {
  try {
    savedSets = await api('/api/saves');
    $('#saveSelect').innerHTML =
      '<option value="">Выберите сохранение</option>' +
      savedSets
        .map(
          (x) =>
            `<option value="${escapeHtml(x.id)}">${escapeHtml(x.date)} · ${escapeHtml(x.codName)} · save-${String(x.saveNumber).padStart(3, '0')} · R${x.recipientsCount}/D${x.donorsCount}</option>`,
        )
        .join('');
  } catch (e) {
    $('#saveSelect').innerHTML = '<option value="">Сохранений пока нет</option>';
  }
}
$('#saveMixBtn').onclick = async () => {
  const lists = currentMixLists();
  if (!selectedCod || (!lists.recipients.length && !lists.donors.length))
    return toast('Нет рассчитанных реципиентов и доноров для сохранения');
  try {
    const saved = await api('/api/saves', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        codId: selectedCod.id,
        codName: selectedCod.name,
        ec: selectedCod.ec,
        recipients: lists.recipients,
        donors: lists.donors,
        mixes,
      }),
    });
    activeRecipients = lists.recipients;
    activeDonors = lists.donors;
    selectedRecipientIps = new Set(activeRecipients.map((d) => d.ip));
    renderRecipientControl();
    await refreshSavedSets();
    $('#saveSelect').value = saved.id;
    toast(`Сохранено: ${saved.codName} · save-${String(saved.saveNumber).padStart(3, '0')}`);
  } catch (e) {
    toast(e.message);
  }
};
$('#loadSaveBtn').onclick = async () => {
  const id = $('#saveSelect').value;
  if (!id) return toast('Выберите сохранение');
  try {
    const data = await api(`/api/saves/${encodeURIComponent(id)}`);
    activeRecipients = uniqueDevices(data.recipients).filter(isOnlineDevice);
    activeDonors = uniqueDevices(data.donors);
    selectedRecipientIps = new Set(activeRecipients.map((d) => d.ip));
    if (Array.isArray(data.mixes) && data.mixes.length) {
      mixes = data.mixes;
      renderMixes();
    }
    renderRecipientControl();
    document
      .querySelector('#board-control')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`Загружено: ${data.codName} · save-${String(data.saveNumber).padStart(3, '0')}`);
  } catch (e) {
    toast(e.message);
  }
};
// Принимает выбранные устройства, отправляет серверу включение трёх плат каждого и показывает общий результат, включая отдельные ошибки устройств.
async function performEnableBoards(recipients, scopeLabel = 'неисправных ASIC') {
  const selected = uniqueDevices(recipients);
  if (!selected.length) return toast('Нет устройств для применения');
  const configs = selected.map((d) => ({
    // Запрос конфигурации должен содержать три платы: если сведений о плате нет, используем её позиционный ID (0, 1 или 2), иначе сохраняем ID из данных устройства.
    ip: d.ip,
    boards: Array.from({ length: 3 }, (_, i) => ({
      id: d.boards?.[i]?.id ?? String(i),
      enabled: true,
    })),
  }));
  const btn = $('#enableBoardsBtn');
  const state = $('#enableBoardsState');
  btn.disabled = true;
  state.className = 'scan-state';
  state.textContent = 'Сохранение и применение конфигурации…';
  try {
    const data = await api('/api/boards/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ devices: configs }),
    });
    const failed = data.results.filter((x) => !x.ok);
    state.textContent = `Save and Apply завершён: ${data.results.length - failed.length}/${data.results.length}${failed.length ? ` · ${failed.map((x) => `${x.ip}: ${x.error}`).join('; ')}` : ''}`;
    toast(failed.length ? 'Не все настройки применены' : 'Настройки сохранены и применены');
    startMonitoring(devices);
  } catch (e) {
    state.textContent = `Ошибка: ${e.message}`;
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
$('#selectAllRecipients').onchange = (event) => {
  const all = uniqueDevices(activeRecipients);
  if (event.target.checked) all.forEach((d) => selectedRecipientIps.add(d.ip));
  else selectedRecipientIps.clear();
  syncRecipientSelection();
};
$('#enableBoardsBtn').onclick = () =>
  performEnableBoards(
    uniqueDevices(activeRecipients).filter((d) => selectedRecipientIps.has(d.ip)),
    'выбранных ASIC',
  );
$('#stopMonitorBtn').onclick = () => stopMonitoring();

let mapData = null;
let fleetResults = [];
const ipNum = (ip) => {
  const p = String(ip || '')
    .split('.')
    .map(Number);
  // IPv4 состоит ровно из четырёх целых октетов 0–255. Проверяем это до вычисления числового адреса; при неверном вводе возвращаем null, а не ошибочное число.
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n < 256)
    ? ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]
    : null;
};
const numIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function syncMapCodSelect() {
  const select = $('#mapCodSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML =
    '<option value="">Выберите ЦОД</option>' +
    cods.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (cods.some((c) => c.id === current)) select.value = current;
  else if (selectedCod) select.value = selectedCod.id;
}
function mapCellsForGrid() {
  const cols = Number($('#mapColumns').value) || 11;
  const rows = Number($('#mapRows').value) || 4;
  const count = cols * rows;
  const existing = Array.isArray(mapData?.cells) ? mapData.cells : [];
  // Подгоняет массив ячеек под текущий размер сетки: уже заполненные позиции сохраняются, новые получают номер и пустой IP. Лишние позиции не попадают в результат.
  return Array.from({ length: count }, (_, i) => existing[i] || { slot: i + 1, ip: '' });
}
function mapDeviceStatus(ip) {
  return fleetResults.flatMap((x) => x.devices || []).find((d) => d.ip === ip);
}
// Отображает карту ячеек ЦОДа и связывает каждую ячейку с редактированием IP; статус берётся из последних результатов сканирования.
function renderMapGrid() {
  const grid = $('#mapGrid');
  if (!mapData) {
    grid.className = 'map-grid empty compact';
    grid.innerHTML =
      '<div class="empty-icon">▦</div><h3>Карта не выбрана</h3><p>Выберите ЦОД для редактирования его схемы.</p>';
    return;
  }
  const cols = Number(mapData.columns) || 11;
  const rows = Number(mapData.rows) || 4;
  $('#mapColumns').value = cols;
  $('#mapRows').value = rows;
  const cells = mapCellsForGrid();
  grid.className = 'map-grid';
  grid.style.setProperty('--map-cols', cols);
  grid.innerHTML = cells
    .map((cell, i) => {
      const d = mapDeviceStatus(cell.ip);
      const state = d
        ? d.status === 'offline'
          ? 'offline'
          : d.status === 'sleep'
            ? 'sleep'
            : d.firmwareFamily !== 'braiins'
              ? 'other-firmware'
              : d.status === 'healthy'
                ? 'healthy'
                : d.status === 'check'
                  ? 'check'
                  : 'degraded'
        : cell.ip
          ? 'unknown'
          : 'empty';
      return `<button type="button" class="map-cell ${state}" data-index="${i}"><span>${cell.ip ? escapeHtml(cell.ip.split('.').slice(-2).join('.')) : '—'}</span><small>${cell.ip ? (d ? `${d.ratio} · ${d.status === 'healthy' ? 'OK' : d.status === 'offline' ? 'OFFLINE' : 'ПРОВЕРИТЬ'}` : 'не сканирован') : `ячейка ${i + 1}`}</small></button>`;
    })
    .join('');
  grid.querySelectorAll('.map-cell').forEach(
    (button) =>
      (button.onclick = () => {
        const i = Number(button.dataset.index);
        const current = cells[i].ip || '';
        const ip = window.prompt(
          `IP для ячейки ${i + 1}. Оставьте пустым, чтобы очистить:`,
          current,
        );
        if (ip === null) return;
        cells[i].ip = ip.trim();
        mapData.cells = cells;
        renderMapGrid();
      }),
  );
  const cod = cods.find((c) => c.id === mapData.codId);
  $('#mapSummary').textContent =
    `${cod?.name || mapData.name} · ${cols} × ${rows} · заполнено ${cells.filter((x) => x.ip).length} из ${cells.length}`;
}
// Загружает карту указанного ЦОДа; пустой ID очищает текущую карту, а ошибка запроса выводится через уведомление.
async function loadMap(codId) {
  if (!codId) {
    mapData = null;
    renderMapGrid();
    return;
  }
  try {
    mapData = await api(`/api/maps/${encodeURIComponent(codId)}`);
    renderMapGrid();
  } catch (e) {
    toast(e.message);
  }
}
function generateMap() {
  if (!mapData) return toast('Выберите ЦОД');
  // Ограничиваем ввод допустимыми размерами и подставляем значения по умолчанию, если поле пустое или нечисловое; это предотвращает пустую или чрезмерно большую сетку.
  const cols = Math.max(1, Math.min(40, Number($('#mapColumns').value) || 11));
  const rows = Math.max(1, Math.min(20, Number($('#mapRows').value) || 4));
  mapData.columns = cols;
  mapData.rows = rows;
  mapData.cells = Array.from({ length: cols * rows }, (_, i) => ({ slot: i + 1, ip: '' }));
  renderMapGrid();
}
// Отправляет текущие размеры и ячейки карты серверу; после успешного сохранения использует возвращённую версию карты.
async function saveMap() {
  if (!mapData) return toast('Выберите ЦОД');
  try {
    mapData = await api(`/api/maps/${encodeURIComponent(mapData.codId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        columns: Number($('#mapColumns').value),
        rows: Number($('#mapRows').value),
        cells: mapCellsForGrid(),
      }),
    });
    renderMapGrid();
    toast('Карта ЦОДа сохранена');
  } catch (e) {
    toast(e.message);
  }
}
// Перерисовывает результаты общего сканирования по ЦОДам и обновляет статусы на карте.
function renderFleetResults() {
  const box = $('#fleetScanList');
  if (!box) return;
  if (!fleetResults.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = fleetResults
    .map(
      (r) =>
        `<details class="fleet-cod" open><summary><strong>${escapeHtml(r.codName)}</strong><span>${r.devices.filter((d) => d.online).length}/${r.devices.length} онлайн · ${r.devices.filter((d) => d.firmwareFamily === 'braiins' && d.status === 'healthy').length} Braiins OK · ${r.devices.filter((d) => d.firmwareFamily === 'braiins' && d.ratio === '0/3' && d.status !== 'sleep').length} Braiins 0/3</span></summary><div>${r.devices.map((d) => `<span class="fleet-chip ${d.status === 'offline' ? 'offline' : d.status === 'sleep' ? 'sleep' : d.firmwareFamily !== 'braiins' ? 'other-firmware' : d.status}" title="${escapeHtml(d.ip)}">${escapeHtml(d.ip.split('.').slice(-2).join('.'))} · ${escapeHtml(d.ratio || '—')}</span>`).join('')}</div></details>`,
    )
    .join('');
  renderMapGrid();
}
async function scanAllCods() {
  // Ждём завершения применения настроек, прежде чем запускать общий сетевой запрос для всех ЦОДов.
  await window.scannerSettingsReady;
  if (!cods.length) return toast('Нет ЦОДов для сканирования');
  const button = $('#scanAllBtn');
  button.disabled = true;
  $('#scanAllState').textContent = 'Сканируем все ЦОДы…';
  try {
    const data = await api('/api/scan-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: selectedProtocol() || window.appliedScanSettings?.protocol || 'rest',
      }),
    });
    fleetResults = data.results || [];
    renderFleetResults();
    $('#scanAllState').textContent =
      `Готово · ${fleetResults.length} ЦОД · ${fleetResults.reduce((n, r) => n + r.devices.length, 0)} IP`;
    toast('Общий скан ЦОДов завершён');
  } catch (e) {
    $('#scanAllState').textContent = `Ошибка: ${e.message}`;
    toast(e.message);
  } finally {
    button.disabled = false;
  }
}
if ($('#mapCodSelect'))
  $('#mapCodSelect').onchange = (e) => {
    if (e.target.value) selectCod(e.target.value);
    loadMap(e.target.value);
  };
if ($('#mapGenerateBtn')) $('#mapGenerateBtn').onclick = generateMap;
if ($('#mapSaveBtn')) $('#mapSaveBtn').onclick = saveMap;
if ($('#scanAllBtn')) $('#scanAllBtn').onclick = scanAllCods;
async function init() {
  // Загружает ЦОДы с сервера, затем обновляет зависящие от них элементы и сохранённые наборы. Ошибки загрузки показываются уведомлением, чтобы приложение не завершалось молча.
  try {
    cods = await api('/api/cods');
    renderCods();
    updateProtocolControls();
    await refreshSavedSets();
    renderRecipientControl();
    if (!cods.length) {
      try {
        const diag = await api('/api/state-diagnostics');
        const info = diag.stateJson;
        toast(info.error ? `ЦОДы не загружены: ${info.error}` : `ЦОДы не найдены в ${info.path}`);
      } catch {}
    }
  } catch (e) {
    toast(e.message);
  }
}
init();
