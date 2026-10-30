const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[char],
  );
const api = async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Ошибка запроса');
  return data;
};
let active = false;

async function loadPageData() {
  try {
    const [cods, settings] = await Promise.all([api('/api/cods'), api('/api/scanner-settings')]);
    $('#codSelect').innerHTML =
      '<option value="">Выберите ЦОД</option>' +
      cods
        .map((cod) => `<option value="${escapeHtml(cod.id)}">${escapeHtml(cod.name)}</option>`)
        .join('');
    $('#runBtn').disabled = cods.length === 0;
    if (settings.protocol) $('#protocol').value = settings.protocol;
    $('#railCods').innerHTML = cods.length
      ? cods
          .map(
            (cod) =>
              `<a class="rail-cod" href="/#cods"><strong>${escapeHtml(cod.name)}</strong></a>`,
          )
          .join('')
      : '<div class="rail-empty">Нет ЦОДов</div>';
  } catch (error) {
    $('#codSelect').innerHTML = '<option value="">Ошибка загрузки ЦОДов</option>';
    $('#results').textContent = error.message;
  }
}

const formatSet = (values) =>
  values?.length ? values.map((value) => `<code>${escapeHtml(value)}</code>`).join('<br>') : '—';

function renderResults(data) {
  const summary = data.scanSummary;
  $('#summary').hidden = false;
  $('#summary').innerHTML =
    `<span>IP в проверке: ${summary.totalIps}</span>` +
    `<span>Опросов завершено: ${summary.completedObservations}</span>` +
    `<span>Подтверждено: ${summary.confirmed}</span>` +
    `<span>Требует проверки: ${summary.possible}</span>`;
  const findings = data.results.filter((item) => item.status !== 'clear');
  if (!findings.length) {
    $('#results').className = 'conflict-empty';
    $('#results').textContent = data.cancelled
      ? 'Проверка отменена. Завершённые IP обработаны; неполный набор раундов не подтверждает отсутствие конфликта.'
      : 'Подозрительных адресов не найдено. Результат относится только к завершённым раундам и не гарантирует отсутствия конфликта.';
    return;
  }
  $('#results').className = 'conflict-table-wrap';
  $('#results').innerHTML =
    `<table class="conflict-table"><thead><tr><th>IP</th><th>ОЦЕНКА</th><th>СЕРИЙНЫЕ НОМЕРА</th><th>MAC АДРЕСА</th><th>ОТПЕЧАТКИ</th><th>ОПРОСЫ</th></tr></thead><tbody>${findings
      .map(
        (item) =>
          `<tr><td><a class="ip-link" href="http://${encodeURIComponent(item.ip)}" target="_blank" rel="noopener">${escapeHtml(item.ip)}</a></td><td><span class="conflict-state ${escapeHtml(item.status)}">${item.status === 'confirmed' ? 'КОНФЛИКТ' : 'ПРОВЕРИТЬ'}</span><br>${escapeHtml(item.reason)}</td><td>${formatSet(item.serialNumbers)}</td><td>${formatSet(item.macAddresses)}</td><td>${formatSet(item.fingerprints)}</td><td>${item.onlineRounds}/${item.rounds} ответов</td></tr>`,
      )
      .join('')}</tbody></table>`;
}

async function updateProgress() {
  if (!active) return;
  try {
    const progress = await api('/api/scan-all/progress');
    $('#progress').hidden = false;
    $('#progress').textContent =
      `Проверено ${progress.completed} из ${progress.total} опросов · ${escapeHtml(progress.currentCod || '')}`;
  } catch {
    // Main request remains authoritative; progress endpoint is only a convenience.
  }
}

$('#runBtn').onclick = async () => {
  const codId = $('#codSelect').value;
  const rounds = Number($('#rounds').value);
  if (!codId) return;
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 6) {
    $('#rounds').focus();
    return;
  }
  active = true;
  $('#runBtn').disabled = true;
  $('#cancelBtn').hidden = false;
  $('#summary').hidden = true;
  $('#results').className = 'conflict-empty';
  $('#results').textContent = 'Проверка выполняется…';
  const timer = setInterval(updateProgress, 700);
  updateProgress();
  try {
    const data = await api('/api/ip-conflicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codId, rounds, protocol: $('#protocol').value }),
    });
    renderResults(data);
  } catch (error) {
    $('#results').className = 'conflict-empty';
    $('#results').textContent = error.message;
  } finally {
    active = false;
    clearInterval(timer);
    $('#runBtn').disabled = false;
    $('#cancelBtn').hidden = true;
    $('#progress').hidden = true;
  }
};

$('#cancelBtn').onclick = async () => {
  try {
    await api('/api/scan/cancel', { method: 'POST' });
    $('#cancelBtn').disabled = true;
    $('#cancelBtn').textContent = 'Отмена…';
  } catch (error) {
    $('#results').textContent = error.message;
  }
};

loadPageData();
