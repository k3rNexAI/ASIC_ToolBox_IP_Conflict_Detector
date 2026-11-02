(() => {
  const $ = (selector) => document.querySelector(selector);
  const mount = $('#scannerSettingsMount');
  if (!mount) return;

  mount.innerHTML = `
    <details class="scan-settings" id="scannerSettingsPanel">
      <summary><strong>⚙ Настройки сканирования</strong><span>Основные параметры · протоколы · авторизация</span></summary>
      <form id="scanSettingsForm">
        <div class="scan-settings-sections">
          <section class="scan-settings-section scan-settings-main">
            <header><strong>Основные настройки</strong><small>Общие параметры каждого запуска</small></header>
            <div class="scan-settings-main-fields">
              <label>Протокол по умолчанию
                <select id="mapProtocol"><option value="hybrid">CGMiner API (TCP 4028) + детали проблемных (БЫСТРЫЙ НО НЕ ТОЧНЫЙ)</option><option value="rest">REST API — только REST (БЫСТРЫЙ И ТОЧНЫЙ)</option><option value="auto">REST → gRPC → CGMiner (последовательно)</option><option value="grpc">gRPC</option><option value="legacy">CGMiner / стоковый TCP 4028(БЕЗ ДЕТАЛЕЙ ПРОБЛЕМНЫХ)</option></select>
              </label>
              <label>Размер пачки ASIC<input id="scanBatchSize" type="number" min="1" max="256" step="1" required></label>
              <label>Максимум IP за запуск<input id="scanMaxIps" type="number" min="1" max="65536" step="1" required></label>
            </div>
          </section>

          <section class="scan-settings-section scan-protocol-section">
            <header><strong>Настройки протоколов</strong><small>Порты, ожидание ответа и соединения</small></header>
            <div class="scan-protocol-cards">
              <fieldset class="scan-protocol-card">
                <legend>REST API</legend>
                <label>Порт<input id="scanRestPort" type="number" min="1" max="65535" step="1" required></label>
                <label>Таймаут, мс<input id="scanRestTimeout" type="number" min="500" max="30000" step="100" required></label>
                <label>Соединений на ASIC<input id="scanRestSockets" type="number" min="1" max="16" step="1" required></label>
                <label class="scan-setting-check"><input id="scanRestKeepAlive" type="checkbox"> Keep-Alive</label>
              </fieldset>
              <fieldset class="scan-protocol-card">
                <legend>gRPC</legend>
                <label>Порт<input id="scanGrpcPort" type="number" min="1" max="65535" step="1" required></label>
                <label>Таймаут, мс<input id="scanGrpcTimeout" type="number" min="3000" max="30000" step="500" required></label>
              </fieldset>
              <fieldset class="scan-protocol-card">
                <legend>TCP 4028 / CGMiner</legend>
                <label>Порт<input id="scanLegacyPort" type="number" min="1" max="65535" step="1" required></label>
                <label>Таймаут, мс<input id="scanLegacyTimeout" type="number" min="300" max="20000" step="100" required></label>
              </fieldset>
            </div>
          </section>

          <section class="scan-settings-section scan-auth-section">
            <header><strong>Данные для авторизации</strong><small>Используются для запросов к ASIC и SSH-доступа</small></header>
            <div class="scan-auth-fields">
              <label>Пользователь ASIC<input id="scanUsername" type="text" autocomplete="username" maxlength="128" required></label>
              <label class="scan-password-label">Пароль ASIC
                <span class="scan-password-control"><input id="scanPassword" type="password" autocomplete="current-password" maxlength="512"><button id="toggleScanPassword" type="button" class="button secondary small-button" aria-controls="scanPassword" aria-pressed="false">Показать</button></span>
              </label>
              <label class="scan-setting-check scan-clear-password"><input id="scanClearPassword" type="checkbox"> Очистить сохранённый пароль</label>
            </div>
          </section>
        </div>
        <!--<p class="scan-settings-note">Гибридный режим по умолчанию использует CGMiner/TCP 4028 для быстрого прохода всех ASIC. Подробный REST-опрос выполняется только для проблемных Braiins ASIC; SSH-проверка NoPIC не задерживает массовый скан. «Авто» проверяет REST → gRPC → CGMiner последовательно и может быть медленнее. Сканирование и мониторинг не запускаются одновременно. Пароль маскируется и хранится локально; настройки применяются сразу.</p>-->
        <div class="scan-settings-actions"><button id="applyScanSettings" class="button primary small-button" type="submit">Применить настройки</button><span id="scanSettingsStatus" role="status" aria-live="polite">Загрузка настроек…</span></div>
      </form>
    </details>`;

  /** Находит поле формы по его id и задаёт значение. Проверка нужна, чтобы не обращаться к отсутствующему элементу; функция используется ниже при заполнении формы. */
  const setValue = (id, value) => {
    const el = $(`#${id}`);
    if (el) el.value = value;
  };
  /** Отражает выбранный режим в связанных переключателях и подписях портов, затем рассылает событие странице. Настройки приходят из загрузки или ответа сервера после сохранения. */
  const syncProtocolControls = (settings) => {
    const selected = settings.protocol;
    // В режиме auto отмечаем все три протокола, поскольку сервер попробует их по очереди; в остальных режимах отмечаем только выбранный способ (для hybrid нужен legacy/TCP).
    const checked =
      selected === 'auto'
        ? { useRest: true, useGrpc: true, useLegacy: true }
        : {
            useRest: selected === 'rest',
            useGrpc: selected === 'grpc',
            useLegacy: selected === 'legacy' || selected === 'hybrid',
          };
    for (const [id, value] of Object.entries(checked)) {
      const input = $(`#${id}`);
      if (input) input.checked = value;
    }
    const portLabels = [
      ['useRest', `REST API ${settings.restPort}`],
      ['useGrpc', `gRPC ${settings.grpcPort}`],
      ['useLegacy', `TCP ${settings.legacyPort}`],
    ];
    for (const [id, text] of portLabels) {
      const strong = $(`#${id}`)?.parentElement?.querySelector('strong');
      if (strong) strong.textContent = text;
    }
    // Другие компоненты страницы могут слушать это событие и читать новый набор настроек из detail.
    window.dispatchEvent(new CustomEvent('scanner-settings-applied', { detail: settings }));
  };
  /** Копирует пришедшие от сервера настройки в форму и сохраняет их в window.appliedScanSettings для других частей страницы. Пароль снова скрывается; эту функцию вызывают при загрузке и после успешного сохранения. */
  const fill = (settings) => {
    window.appliedScanSettings = settings;
    setValue('mapProtocol', settings.protocol);
    setValue('scanBatchSize', settings.batchSize);
    setValue('scanMaxIps', settings.maxScanIps);
    setValue('scanRestTimeout', settings.restTimeoutMs);
    setValue('scanGrpcTimeout', settings.grpcTimeoutMs);
    setValue('scanLegacyTimeout', settings.legacyTimeoutMs);
    setValue('scanRestPort', settings.restPort);
    setValue('scanGrpcPort', settings.grpcPort);
    setValue('scanLegacyPort', settings.legacyPort);
    setValue('scanRestSockets', settings.restSocketsPerDevice);
    $('#scanRestKeepAlive').checked = Boolean(settings.restKeepAlive);
    $('#scanUsername').value = settings.username;
    $('#scanPassword').value = settings.password || '';
    $('#scanPassword').placeholder = settings.passwordConfigured
      ? 'Сохранённый пароль'
      : 'Пароль не задан';
    $('#scanClearPassword').checked = false;
    $('#scanPassword').disabled = false;
    const reveal = $('#toggleScanPassword');
    $('#scanPassword').type = 'password';
    reveal.textContent = 'Показать';
    reveal.setAttribute('aria-pressed', 'false');
    syncProtocolControls(settings);
  };
  // Если адрес страницы заканчивается якорем этой панели, раскрываем её; прокрутку откладываем до следующего кадра, чтобы браузер успел показать раскрытое содержимое.
  if (location.hash === '#scannerSettingsPanel') {
    const panel = $('#scannerSettingsPanel');
    panel.open = true;
    requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  const form = $('#scanSettingsForm');
  const status = $('#scanSettingsStatus');
  const password = $('#scanPassword');
  const reveal = $('#toggleScanPassword');
  form.addEventListener('input', () => {
    status.textContent = 'Есть изменения — нажмите «Применить настройки»';
  });
  reveal.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    reveal.textContent = visible ? 'Скрыть' : 'Показать';
    reveal.setAttribute('aria-pressed', String(visible));
    password.focus({ preventScroll: true });
  });
  $('#scanClearPassword').addEventListener('change', (event) => {
    password.disabled = event.target.checked;
    if (password.disabled) password.value = '';
  });
  password.addEventListener('input', () => {
    if ($('#scanClearPassword').checked) $('#scanClearPassword').checked = false;
    password.disabled = false;
  });

  // Обработчик отправки формы собирает её поля в JSON и отправляет одним POST-запросом. Кнопка блокируется на время запроса, чтобы избежать повторного сохранения до ответа.
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#applyScanSettings');
    button.disabled = true;
    status.textContent = 'Сохранение…';
    const payload = {
      protocol: $('#mapProtocol').value,
      batchSize: Number($('#scanBatchSize').value),
      maxScanIps: Number($('#scanMaxIps').value),
      restTimeoutMs: Number($('#scanRestTimeout').value),
      grpcTimeoutMs: Number($('#scanGrpcTimeout').value),
      legacyTimeoutMs: Number($('#scanLegacyTimeout').value),
      restPort: Number($('#scanRestPort').value),
      grpcPort: Number($('#scanGrpcPort').value),
      legacyPort: Number($('#scanLegacyPort').value),
      restSocketsPerDevice: Number($('#scanRestSockets').value),
      restKeepAlive: $('#scanRestKeepAlive').checked,
      username: $('#scanUsername').value,
      password: password.value,
      clearPassword: $('#scanClearPassword').checked,
    };
    try {
      const settings = await fetchJson('/api/scanner-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      fill(settings);
      status.textContent = 'Настройки применены · перезапуск не требуется';
    } catch (error) {
      // Показываем причину сбоя в статусе; блок finally выполняется и при успехе, и при ошибке, поэтому кнопка снова станет доступна.
      status.textContent = `Не удалось применить: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  // Сразу запускаем GET-запрос настроек и сохраняем Promise в window: другие части страницы могут дождаться результата. При успехе настройки попадут в форму, при сбое страница продолжит работать без них.
  window.scannerSettingsReady = (async () => {
    try {
      const settings = await fetchJson('/api/scanner-settings');
      fill(settings);
      status.textContent = 'Настройки загружены';
      return settings;
    } catch (error) {
      // Возвращаем null вместо отклонённого Promise: вызывающим частям не нужно отдельно ловить сбой загрузки, а пользователь видит сообщение в строке статуса.
      status.textContent = `Настройки не загружены: ${error.message}`;
      return null;
    }
  })();

  /** Отправляет запрос по указанному адресу с необязательными параметрами, разбирает JSON-ответ и возвращает его данные. При HTTP-ошибке выбрасывает Error, который ловит обработчик загрузки или сохранения. */
  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    // Успешным считаем только HTTP-ответ без ошибки; иначе передаём серверное пояснение вызывающему обработчику, а при его отсутствии — общее сообщение.
    if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }
})();
