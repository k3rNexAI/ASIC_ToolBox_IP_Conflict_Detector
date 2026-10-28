import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { getAsset, isSea } from 'node:sea';
import { Client as SshClient } from 'ssh2';
import {
  braiinsMinerState,
  needsRestBoardDetails,
  normalizeCgminerResult,
  scanProtocolOrder,
} from './miner-compat.js';
import { mixes } from './mix-algorithm.js';

const SEA = isSea();
const LEGACY_ROOT = path.dirname(path.resolve(process.argv[1] || process.execPath));
const ROOT = SEA
  ? process.env.ASIC_TOOLBOX_DATA_DIR ||
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'ASIC ToolBox',
    )
  : LEGACY_ROOT;
const STATE = path.join(ROOT, 'state.json');
const STATE_JS = path.join(ROOT, 'state.js');
const SAVES = path.join(ROOT, 'saves');
const MAPS = path.join(ROOT, 'maps.json');
const PORT = Number(process.env.PORT || 4180);
const HOST = process.env.HOST || '127.0.0.1';
const SCAN_SETTINGS_FILE = path.join(ROOT, 'scan-settings.json');
const execFileAsync = promisify(execFile);
const grpcurl = process.env.GRPCURL_PATH || path.join(LEGACY_ROOT, 'tools', 'grpcurl.exe');
const embeddedAsset = (name) => getAsset(name);
const resolveGrpcurl = async () => {
  if (!SEA) return grpcurl;
  const target = path.join(ROOT, 'runtime', 'grpcurl.exe');
  try {
    await fs.access(target);
    return target;
  } catch {}
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, embeddedAsset('tools/grpcurl.exe'));
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
  }
  return target;
};
const migratePortableData = async () => {
  if (!SEA) return;
  await fs.mkdir(ROOT, { recursive: true });
  for (const name of ['state.json', 'state.js', 'maps.json', 'scan-settings.json', 'saves']) {
    const source = path.join(path.dirname(process.execPath), name);
    const destination = path.join(ROOT, name);
    try {
      await fs.access(destination);
      continue;
    } catch {}
    try {
      await fs.cp(source, destination, { recursive: true, errorOnExist: false, force: false });
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Could not migrate ${name}: ${error.message}`);
    }
  }
};
const boundedInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const envInt = (name, fallback, min, max) => boundedInt(process.env[name], fallback, min, max);
const validScanProtocols = new Set(['rest', 'grpc', 'legacy', 'auto', 'hybrid']);
const defaultScannerSettings = {
  protocol: validScanProtocols.has(process.env.SCAN_PROTOCOL)
    ? process.env.SCAN_PROTOCOL
    : 'hybrid',
  batchSize: envInt('SCAN_CONCURRENCY', envInt('SCAN_BATCH_SIZE', 12, 1, 256), 1, 256),
  maxScanIps: envInt('SCAN_MAX_IPS', 4096, 1, 65536),
  restTimeoutMs: envInt('REST_TIMEOUT_MS', 4500, 500, 30000),
  grpcTimeoutMs: envInt('GRPC_TIMEOUT_MS', 6000, 3000, 30000),
  legacyTimeoutMs: envInt('LEGACY_TIMEOUT_MS', 1300, 300, 20000),
  restPort: envInt('REST_PORT', 80, 1, 65535),
  grpcPort: envInt('GRPC_PORT', 50051, 1, 65535),
  legacyPort: envInt('LEGACY_PORT', 4028, 1, 65535),
  restSocketsPerDevice: envInt('REST_SOCKETS_PER_DEVICE', 4, 1, 16),
  restKeepAlive: !['0', 'false', 'no'].includes(
    String(process.env.REST_KEEP_ALIVE || 'true').toLowerCase(),
  ),
  username: process.env.ASIC_USER || 'root',
  password: process.env.ASIC_PASSWORD || 'root',
};
/** Принимает объект настроек и возвращает новый объект с допустимыми значениями. Некорректные поля заменяются настройками по умолчанию, а границы чисел не дают запустить сканирование с опасными значениями. */
const normalizeScannerSettings = (raw = {}) => ({
  protocol: validScanProtocols.has(raw.protocol) ? raw.protocol : defaultScannerSettings.protocol,
  batchSize: boundedInt(raw.batchSize, defaultScannerSettings.batchSize, 1, 256),
  maxScanIps: boundedInt(raw.maxScanIps, defaultScannerSettings.maxScanIps, 1, 65536),
  restTimeoutMs: boundedInt(raw.restTimeoutMs, defaultScannerSettings.restTimeoutMs, 500, 30000),
  grpcTimeoutMs: boundedInt(raw.grpcTimeoutMs, defaultScannerSettings.grpcTimeoutMs, 3000, 30000),
  legacyTimeoutMs: boundedInt(
    raw.legacyTimeoutMs,
    defaultScannerSettings.legacyTimeoutMs,
    300,
    20000,
  ),
  restPort: boundedInt(raw.restPort, defaultScannerSettings.restPort, 1, 65535),
  grpcPort: boundedInt(raw.grpcPort, defaultScannerSettings.grpcPort, 1, 65535),
  legacyPort: boundedInt(raw.legacyPort, defaultScannerSettings.legacyPort, 1, 65535),
  restSocketsPerDevice: boundedInt(
    raw.restSocketsPerDevice,
    defaultScannerSettings.restSocketsPerDevice,
    1,
    16,
  ),
  restKeepAlive:
    typeof raw.restKeepAlive === 'boolean'
      ? raw.restKeepAlive
      : defaultScannerSettings.restKeepAlive,
  username:
    typeof raw.username === 'string' && raw.username.trim()
      ? raw.username.trim().slice(0, 128)
      : defaultScannerSettings.username,
  password:
    typeof raw.password === 'string' ? raw.password.slice(0, 512) : defaultScannerSettings.password,
});
let scannerSettings = { ...defaultScannerSettings };
const createRestAgent = () =>
  new http.Agent({
    keepAlive: scannerSettings.restKeepAlive,
    maxSockets: scannerSettings.restSocketsPerDevice,
    maxFreeSockets: Math.max(1, Math.floor(scannerSettings.restSocketsPerDevice / 2)),
    timeout: scannerSettings.restTimeoutMs,
  });
let restAgent = createRestAgent();
const restAgentUseCounts = new WeakMap();
const retiredRestAgents = new Set();
const retireRestAgent = (agent) => {
  retiredRestAgents.add(agent);
  if ((restAgentUseCounts.get(agent) || 0) === 0) {
    agent.destroy();
    retiredRestAgents.delete(agent);
  }
};
/** Читает файл при запуске; при его отсутствии или ошибке остаются значения по умолчанию. Переносит старый неявный выбор протокола, затем создаёт REST-пул соединений с загруженными параметрами. */
const loadScannerSettings = async () => {
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(SCAN_SETTINGS_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read scanner settings: ${error.message}`);
  }
  const migrateOldDefault =
    stored?.protocol === 'auto' && stored?.protocolSelectionExplicit !== true;
  if (migrateOldDefault) stored.protocol = 'hybrid';
  scannerSettings = normalizeScannerSettings({
    ...defaultScannerSettings,
    ...(stored && typeof stored === 'object' ? stored : {}),
  });
  if (migrateOldDefault) {
    await writeJsonAtomic(SCAN_SETTINGS_FILE, {
      ...scannerSettings,
      protocolSelectionExplicit: true,
    });
    try {
      await fs.chmod(SCAN_SETTINGS_FILE, 0o600);
    } catch {}
  }
  const old = restAgent;
  restAgent = createRestAgent();
  old.destroy();
};
const publicScannerSettings = () => ({
  ...scannerSettings,
  passwordConfigured: Boolean(scannerSettings.password),
});
let scanLock = false;
let monitorLock = false;
let activeScanController = null;
let scanProgress = {
  running: false,
  completed: 0,
  total: 0,
  codIndex: 0,
  codTotal: 0,
  currentCod: '',
  startedAt: null,
  cancelRequested: false,
  cancelled: false,
};
const scanAbortError = () =>
  Object.assign(new Error('Сканирование отменено'), { name: 'AbortError' });
const throwIfScanAborted = (signal) => {
  if (signal?.aborted) throw scanAbortError();
};

/** Принимает разобранный JSON и возвращает список ЦОДов из известных старых оболочек файла. Проверяет типы вложенных значений, а при отсутствии массива возвращает пустой список. */
const unwrapState = (parsed) => {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of ['cods', 'data', 'state', 'sites', 'locations', 'datacenters']) {
    const value = parsed[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = unwrapState(value);
      if (nested.length) return nested;
    }
  }
  if (parsed.codsById && typeof parsed.codsById === 'object') return Object.values(parsed.codsById);
  return [];
};
/** Принимает содержимое state.json или старого state.js и возвращает записи с пояснением ошибки. Сначала пробует JSON, затем поддерживаемую JS-обёртку с массивом, чтобы диагностика могла показать причину повреждённого файла. */
const parseStateText = (text) => {
  const source = String(text || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!source) return { items: [], error: 'Файл пустой' };
  try {
    const parsed = JSON.parse(source);
    const items = unwrapState(parsed);
    return { items, error: items.length ? null : 'JSON прочитан, но массив ЦОДов не найден' };
  } catch (jsonError) {
    const match = source.match(
      /(?:export\s+default|module\.exports|const\s+cods\s*=)?\s*(\[[\s\S]*\])/,
    );
    if (match) {
      try {
        const items = unwrapState(JSON.parse(match[1]));
        return { items, error: items.length ? null : 'Массив найден, но ЦОДы не распознаны' };
      } catch {}
    }
    return { items: [], error: `Некорректный JSON: ${jsonError.message}` };
  }
};
const readStateFile = async (file) => {
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = parseStateText(text);
    return { ...parsed, file, exists: true };
  } catch (error) {
    return {
      items: [],
      error: error.code === 'ENOENT' ? 'Файл отсутствует' : error.message,
      file,
      exists: false,
    };
  }
};
/** Выбирает основной файл состояния и использует legacy-файл при отсутствии распознанных записей. */
const codRecords = async () => {
  const primary = await readStateFile(STATE);
  if (primary.items.length) return { ...primary, source: 'state.json' };
  const legacy = await readStateFile(STATE_JS);
  if (legacy.items.length) return { ...legacy, source: 'state.js' };
  return { ...primary, source: 'state.json' };
};
const readCods = async () => {
  const result = await codRecords();
  return result.items
    .map((c, i) => ({
      ...c,
      ec: typeof c.ec === 'string' && c.ec.trim() ? c.ec.trim() : 'Без группы',
      order: Number.isInteger(c.order) ? c.order : i,
    }))
    .sort((a, b) => a.order - b.order);
};
const readMaps = async () => {
  try {
    const raw = await fs.readFile(MAPS, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};
/** Сохраняет значение JSON во временный файл и переименовывает его только после полной записи: при сбое основной файл не останется частичным. Параметр backup создаёт копию прежнего файла; эту функцию используют для записи состояния и карт. */
const writeJsonAtomic = async (file, value, { backup = false } = {}) => {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (backup) {
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    await fs.writeFile(temp, data, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    try {
      await fs.unlink(temp);
    } catch {}
    throw error;
  }
};
const writeMaps = async (maps) => writeJsonAtomic(MAPS, maps, { backup: true });
const defaultMap = (cod) => ({
  codId: cod.id,
  name: cod.name,
  racks: 11,
  shelves: 6,
  devicesPerShelf: 4,
  cells: [],
});
const writeCods = async (cods) => writeJsonAtomic(STATE, cods, { backup: true });
const safeSegment = (value, fallback = 'Без названия') =>
  String(value || fallback)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80) || fallback;
const localDate = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const saveRoot = () => path.resolve(SAVES);
const savePath = (relative) => {
  const root = saveRoot();
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    throw Error('Некорректный путь сохранения');
  return target;
};
/** Возвращает список сохранений, у которых удалось прочитать manifest.json. Незавершённые папки пропускаются, готовые сортируются от новых к старым; результат передаётся API списка сохранений. */
const readSavedList = async () => {
  await fs.mkdir(SAVES, { recursive: true });
  const dates = await fs.readdir(SAVES, { withFileTypes: true });
  const result = [];
  for (const date of dates.filter((x) => x.isDirectory())) {
    const dateDir = path.join(SAVES, date.name);
    const codFolders = await fs.readdir(dateDir, { withFileTypes: true });
    for (const codFolder of codFolders.filter((x) => x.isDirectory())) {
      const codDir = path.join(dateDir, codFolder.name);
      const saves = await fs.readdir(codDir, { withFileTypes: true });
      for (const save of saves.filter((x) => x.isDirectory())) {
        const folder = path.join(codDir, save.name);
        try {
          const manifest = JSON.parse(
            await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'),
          );
          result.push({ ...manifest, id: path.relative(SAVES, folder).replaceAll(path.sep, '/') });
        } catch {
          /* ignore incomplete save */
        }
      }
    }
  }
  return result.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
};
const enableAllBoards = async (recipients) =>
  Promise.all(
    (Array.isArray(recipients) ? recipients : []).map(async (recipient) => {
      const ip = recipient?.ip;
      if (!ip) return { ip: '—', ok: false, error: 'Не указан IP' };
      try {
        const login = await grpcCall(ip, 'braiins.bos.v1.AuthenticationService/Login', {
          username: scannerSettings.username,
          password: scannerSettings.password,
        });
        const token = login.token || login.sessionToken;
        if (!token) throw Error('Public API не вернул токен авторизации');
        let boards = Array.isArray(recipient.boards) ? recipient.boards : [];
        if (!boards.length) {
          const current = await grpcCall(
            ip,
            'braiins.bos.v1.MinerService/GetHashboards',
            undefined,
            token,
          );
          boards = firstArray(current, ['hashboards', 'hashBoards', 'boards']);
        }
        const ids = boards
          .map((b, i) => String(b.id ?? b.hashboardId ?? b.hashboard_id ?? i))
          .filter(Boolean);
        const response = await grpcCall(
          ip,
          'braiins.bos.v1.MinerService/EnableHashboards',
          { saveAction: 'SAVE_ACTION_SAVE_AND_APPLY', hashboardIds: ids },
          token,
        );
        return { ip, ok: true, ids, response };
      } catch (error) {
        return { ip, ok: false, error: error.message };
      }
    }),
  );
/** Подключается по SSH к майнеру с адресом ip и возвращает настройку NoPIC как enabled, disabled или unknown. Вызывается при уточнении проблемной платы; таймер и отмена завершают ожидание и закрывают соединение. */
const readNoPicExperimentalMode = (ip, signal) =>
  new Promise((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    let stdout = '';
    let stderr = '';
    const onAbort = () => finish(scanAbortError());
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      client.end();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error('SSH timeout while reading NoPIC setting')), 7000);
    timer.unref();
    const command = `p=/etc/bosminer-experimental.toml; if [ -r "$p" ]; then v=$(grep -E '^[[:space:]]*allow_disabling_hashboards_on_nopic_miners[[:space:]]*=' "$p" | tail -n 1 | cut -d '=' -f 2- | tr -d '[:space:]'); if [ "$v" = true ]; then echo enabled; elif [ "$v" = false ] || [ -z "$v" ]; then echo disabled; else echo unknown; fi; else echo disabled; fi`;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    client.on('ready', () =>
      client.exec(command, (err, stream) => {
        if (err) return finish(err);
        stream.on('data', (x) => (stdout += x.toString()));
        stream.stderr.on('data', (x) => (stderr += x.toString()));
        stream.on('close', (code) => {
          if (code !== 0) return finish(Error(stderr.trim() || `SSH command exited ${code}`));
          const value = stdout.trim().split(/\s+/).pop();
          finish(null, ['enabled', 'disabled'].includes(value) ? value : 'unknown');
        });
      }),
    );
    client.on('error', finish);
    client.connect({
      host: ip,
      port: 22,
      username: scannerSettings.username,
      password: scannerSettings.password,
      readyTimeout: 5000,
    });
  });
const attachNoPicMode = async (device, ip, signal) => {
  throwIfScanAborted(signal);
  if (
    device?.online &&
    device.firmwareFamily === 'braiins' &&
    device.status !== 'sleep' &&
    (device.status === 'check' || device.status === 'degraded' || device.ratio === '0/3')
  ) {
    try {
      device.nopicMode = await readNoPicExperimentalMode(ip, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      device.nopicMode = 'unknown';
    }
  }
  return device;
};
/** Обновляет экспериментальную настройку NoPIC на майнере через SSH. */
const setNoPicExperimental = (ip, enabled) =>
  new Promise((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      client.end();
      err ? reject(err) : resolve();
    };
    const value = enabled ? 'true' : 'false';
    const command = `set -eu; p=/etc/bosminer-experimental.toml; t=\"$p.asic-toolbox.$$\"; if [ -f \"$p\" ]; then grep -vE '^[[:space:]]*allow_disabling_hashboards_on_nopic_miners[[:space:]]*=' \"$p\" > \"$t\" || true; chmod --reference=\"$p\" \"$t\" || true; else : > \"$t\"; chmod 600 \"$t\"; fi; printf '\\nallow_disabling_hashboards_on_nopic_miners = ${value}\n' >> \"$t\"; mv \"$t\" \"$p\"`;
    client.on('ready', () =>
      client.exec(command, (err, stream) => {
        if (err) return finish(err);
        let stderr = '';
        stream.stderr.on('data', (x) => (stderr += x.toString()));
        stream.on('close', (code) =>
          finish(code === 0 ? null : Error(stderr.trim() || `SSH command exited ${code}`)),
        );
      }),
    );
    client.on('error', finish);
    client.connect({
      host: ip,
      port: 22,
      username: scannerSettings.username,
      password: scannerSettings.password,
      readyTimeout: 7000,
    });
    setTimeout(() => finish(Error('SSH timeout while applying NoPIC setting')), 12000).unref();
  });
const json = (res, code, data) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
const body = async (req) => {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
};
const validName = (v) => typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 80;
const ipToNum = (ip) => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]
    : null;
};
const numToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
/** Принимает CIDR или начальный и конечный IPv4 и возвращает массив адресов. Проверяет формат, границы и лимит адресов, чтобы не запустить ошибочное или чрезмерно большое сканирование; используется при проверке и запуске скана. */
const expandRange = (start, end, cidr) => {
  if (cidr) {
    const [ip, bitsText] = cidr.split('/');
    const n = ipToNum(ip);
    const bits = Number(bitsText);
    if (n === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
      throw Error('Некорректный CIDR');
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const first = (n & mask) >>> 0;
    const last = (first | (~mask >>> 0)) >>> 0;
    if (last - first + 1 > scannerSettings.maxScanIps)
      throw Error(`Диапазон слишком большой: максимум ${scannerSettings.maxScanIps} адресов`);
    return Array.from({ length: last - first + 1 }, (_, i) => numToIp(first + i));
  }
  const a = ipToNum(start);
  const b = ipToNum(end || start);
  if (a === null || b === null || b < a) throw Error('Некорректный диапазон IPv4');
  if (b - a + 1 > scannerSettings.maxScanIps)
    throw Error(`Диапазон слишком большой: максимум ${scannerSettings.maxScanIps} адресов`);
  return Array.from({ length: b - a + 1 }, (_, i) => numToIp(a + i));
};
const parseMinerApiJson = (text) => {
  const source = String(text || '')
    .replace(/\0/g, '')
    .trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw Error('invalid-response');
  return JSON.parse(source.slice(start, end + 1));
};
/** Отправляет одну команду на TCP-порт старого CGMiner API и возвращает разобранный JSON. Накопленные части ответа пробуются после каждого фрагмента; сокет закрывается при ответе, ошибке, тайм-ауте или отмене. */
const apiCall = (ip, command, timeoutMs = scannerSettings.legacyTimeoutMs, signal) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port: scannerSettings.legacyPort });
    let data = '';
    let settled = false;
    const onAbort = () => finish(scanAbortError());
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      try {
        finish(null, parseMinerApiJson(data));
      } catch {
        /* wait for the rest of the CGMiner API response */
      }
    });
    socket.once('timeout', () => finish(Error('timeout')));
    socket.once('error', (e) => finish(e));
    socket.once('end', () => {
      try {
        finish(null, parseMinerApiJson(data));
      } catch {
        finish(Error('invalid-response'));
      }
    });
  });
const asArray = (obj, key) => (Array.isArray(obj?.[key]) ? obj[key] : []);
const cleanModel = (value) =>
  String(value || '')
    .replace(/^Bitmain\s+/i, '')
    .trim() || 'Модель не определена';
/** Запускает grpcurl для одного вызова службы майнера и возвращает разобранный JSON-ответ. Переданные данные и токен добавляются в запрос; тайм-аут и сигнал отмены ограничивают время работы дочернего процесса. */
const grpcCall = async (ip, service, message, token = '', signal) => {
  throwIfScanAborted(signal);
  const grpcSeconds = Math.max(1, Math.floor((scannerSettings.grpcTimeoutMs - 2000) / 1000));
  const args = ['-plaintext', '-format', 'json', '-max-time', String(grpcSeconds)];
  if (token) args.push('-H', `authorization: ${token}`);
  if (message !== undefined) args.push('-d', JSON.stringify(message));
  args.push(`${ip}:${scannerSettings.grpcPort}`, service);
  const { stdout } = await execFileAsync(await resolveGrpcurl(), args, {
    timeout: scannerSettings.grpcTimeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    signal,
  });
  return JSON.parse(stdout || '{}');
};
// Native REST client: avoids spawning grpcurl for every RPC and reuses TCP sockets per ASIC.
/** Отправляет REST-запрос майнеру и возвращает разобранный JSON. Агент повторно использует TCP-соединения; счётчик запросов не даёт уничтожить старый агент, пока тот ещё используется. Проверяются HTTP-код, размер ответа и корректность JSON. */
const restCall = (
  ip,
  route,
  { method = 'GET', token = '', payload, timeoutMs = scannerSettings.restTimeoutMs, signal } = {},
) =>
  new Promise((resolve, reject) => {
    const requestAgent = restAgent;
    restAgentUseCounts.set(requestAgent, (restAgentUseCounts.get(requestAgent) || 0) + 1);
    let settled = false;
    let req;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      const remaining = Math.max(0, (restAgentUseCounts.get(requestAgent) || 1) - 1);
      restAgentUseCounts.set(requestAgent, remaining);
      if (retiredRestAgents.has(requestAgent) && remaining === 0) {
        requestAgent.destroy();
        retiredRestAgents.delete(requestAgent);
      }
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => {
      const error = scanAbortError();
      if (req) req.destroy(error);
      else finish(error);
    };
    if (signal?.aborted) return onAbort();
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const headers = {
      accept: 'application/json',
      connection: scannerSettings.restKeepAlive ? 'keep-alive' : 'close',
    };
    if (token) headers.authorization = token;
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = data.length;
    }
    req = http.request(
      {
        hostname: ip,
        port: scannerSettings.restPort,
        path: route,
        method,
        agent: requestAgent,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (text.length > 2 * 1024 * 1024) req.destroy(Error('REST response exceeds 2 MB'));
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return finish(Error(`HTTP ${res.statusCode}${text ? `: ${text.slice(0, 180)}` : ''}`));
          if (!text.trim()) return finish(null, {});
          try {
            finish(null, JSON.parse(text));
          } catch {
            finish(Error('REST returned invalid JSON'));
          }
        });
        res.once('error', finish);
      },
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('timeout', () => req.destroy(Error('REST timeout')));
    req.once('error', finish);
    if (data) req.write(data);
    req.end();
  });
/** Входит в REST API Braiins и возвращает общую запись состояния устройства, плат, ошибок и охлаждения для интерфейса. Необязательные запросы журнала и охлаждения выполняются параллельно; их сбой не отменяет основной опрос. */
const restScanOne = async (ip, signal) => {
  const login = await restCall(ip, '/api/v1/auth/login', {
    method: 'POST',
    payload: { username: scannerSettings.username, password: scannerSettings.password },
    signal,
  });
  const token = login.token || login.sessionToken || login.session_token;
  if (!token) throw Error('REST API не вернул токен авторизации');
  // Always collect diagnostic errors; they remain available even for degraded miners.
  const [details, hashboards, errorsResponse, coolingResponse] = await Promise.all([
    restCall(ip, '/api/v1/miner/details', { token, signal }),
    restCall(ip, '/api/v1/miner/hw/hashboards', { token, signal }),
    restCall(ip, '/api/v1/miner/errors', { token, signal }).catch((error) => ({
      errors: [],
      _diagnosticError: error.message,
    })),
    restCall(ip, '/api/v1/cooling/state', { token, signal }).catch(() => ({ fans: [] })),
  ]);
  const identity = details.miner_identity || details.minerIdentity || {};
  const boards = firstArray(hashboards, ['hashboards', 'hashBoards', 'boards']);
  const expected = 3;
  const boardDetails = boards.slice(0, expected).map((b, i) => ({
    number: i + 1,
    id: b.id ?? String(i),
    model: cleanModel(
      b.model ||
        b.boardModel ||
        b.board_name ||
        b.chip_type ||
        b.chipType ||
        identity.miner_model ||
        identity.minerModel ||
        identity.name,
    ),
    chips: chipCount(b),
    hashrateGh: boardHashrateGh(b),
    working: boardIsWorking(b),
    enabled: b.enabled !== false && b.disabled !== true,
    boardTemperature: b.board_temp ?? b.boardTemp ?? null,
    chipTemperature: b.highest_chip_temp ?? b.highestChipTemp ?? null,
    outletTemperature: b.highest_outlet_temp ?? b.highestOutletTemp ?? null,
    inletTemperature: b.lowest_inlet_temp ?? b.lowestInletTemp ?? null,
  }));
  const workingBoards = boardDetails.filter((b) => b.working).length;
  const boardModel =
    [...new Set(boardDetails.map((b) => b.model).filter(Boolean))].join(', ') ||
    cleanModel(identity.miner_model || identity.minerModel || identity.name);
  const model = cleanModel(
    identity.miner_model ||
      identity.minerModel ||
      identity.model ||
      identity.name ||
      details.miner_model,
  );
  const failedBoards = boardDetails.filter((b) => !b.working).map((b) => b.number);
  const errorLogs = firstArray(errorsResponse, ['errors'])
    .map((e) => {
      const message =
        e.message ||
        e.error ||
        e.reason ||
        (Array.isArray(e.error_codes)
          ? e.error_codes
              .map((x) => `${x.code || ''} ${x.reason || x.hint || ''}`.trim())
              .filter(Boolean)
              .join('; ')
          : '');
      const timestamp = e.timestamp ? `${e.timestamp} — ` : '';
      const components =
        Array.isArray(e.components) && e.components.length
          ? ` [${e.components.map((x) => x.name || x.index).join(', ')}]`
          : '';
      return `${timestamp}${message}${components}`.trim();
    })
    .filter(Boolean)
    .slice(-25);
  if (errorsResponse._diagnosticError)
    errorLogs.push(`Не удалось получить журнал ошибок: ${errorsResponse._diagnosticError}`);
  const noPic =
    errorLogs.some((l) => /nopic|no\s*pic/i.test(l)) || Boolean(identity.nopic || details.nopic);
  const version =
    details.bos_version?.current ||
    details.bosVersion?.current ||
    details.bos_version?.version ||
    details.bosVersion?.version ||
    'Braiins OS';
  const minerState = braiinsMinerState(details);
  return {
    ip,
    online: true,
    api: `REST ${scannerSettings.restPort}`,
    firmwareFamily: 'braiins',
    firmwareName: 'Braiins OS',
    minerState,
    model,
    boardModel,
    boards: boardDetails,
    fans: firstArray(coolingResponse, ['fans']),
    version,
    workingBoards: Math.min(expected, workingBoards),
    totalBoards: expected,
    failedBoards,
    errorLogs,
    noPic,
    ratio: `${Math.min(expected, workingBoards)}/${expected}`,
    status:
      minerState === 'sleep'
        ? 'sleep'
        : workingBoards === 0
          ? 'check'
          : workingBoards < expected
            ? 'degraded'
            : 'healthy',
  };
};
const firstArray = (obj, keys) => {
  for (const key of keys) if (Array.isArray(obj?.[key])) return obj[key];
  return [];
};
const chipCount = (board) =>
  Number(
    board.chipsCount?.value ??
      board.chips_count?.value ??
      board.chipsCount ??
      board.chips_count ??
      0,
  );
const boardHashrateGh = (board) =>
  Number(
    board.stats?.realHashrate?.last5s?.gigahashPerSecond ??
      board.stats?.real_hashrate?.last_5s?.gigahashPerSecond ??
      board.stats?.real_hashrate?.last_5s?.gigahash_per_second ??
      board.hashrateGh ??
      0,
  );
const boardIsWorking = (board) =>
  board.enabled !== false && chipCount(board) > 0 && boardHashrateGh(board) > 0;
/** Получает через gRPC состояние Braiins, платы и охлаждение и возвращает унифицированную запись устройства. Независимые запросы выполняются параллельно; недоступность журнала или охлаждения не мешает получить остальные сведения. */
const gRPCScanOne = async (ip, signal) => {
  const login = await grpcCall(
    ip,
    'braiins.bos.v1.AuthenticationService/Login',
    { username: scannerSettings.username, password: scannerSettings.password },
    '',
    signal,
  );
  const token = login.token || login.sessionToken;
  if (!token) throw Error('Public API не вернул токен авторизации');
  const [details, hashboards, errorsResponse, coolingResponse] = await Promise.all([
    grpcCall(ip, 'braiins.bos.v1.MinerService/GetMinerDetails', undefined, token, signal),
    grpcCall(ip, 'braiins.bos.v1.MinerService/GetHashboards', undefined, token, signal),
    grpcCall(ip, 'braiins.bos.v1.MinerService/GetErrors', undefined, token, signal).catch(() => ({
      errors: [],
    })),
    grpcCall(ip, 'braiins.bos.v1.CoolingService/GetCoolingState', undefined, token, signal).catch(
      () => ({ fans: [] }),
    ),
  ]);
  const identity = details.minerIdentity || details.miner_identity || {};
  const boards = firstArray(hashboards, ['hashboards', 'hashBoards', 'boards']);
  const expected = 3;
  const boardDetails = boards.slice(0, expected).map((b, i) => ({
    number: i + 1,
    id: b.id ?? String(i),
    model: cleanModel(
      b.model || b.boardModel || b.board_name || b.chipType || identity.minerModel || identity.name,
    ),
    chips: chipCount(b),
    hashrateGh: boardHashrateGh(b),
    working: boardIsWorking(b),
    enabled: b.enabled !== false && b.disabled !== true,
    boardTemperature: b.board_temp ?? b.boardTemp ?? null,
    chipTemperature: b.highest_chip_temp ?? b.highestChipTemp ?? null,
    outletTemperature: b.highest_outlet_temp ?? b.highestOutletTemp ?? null,
    inletTemperature: b.lowest_inlet_temp ?? b.lowestInletTemp ?? null,
  }));
  const workingBoards = boardDetails.filter((b) => b.working).length;
  const boardModel =
    [...new Set(boardDetails.map((b) => b.model).filter(Boolean))].join(', ') ||
    cleanModel(identity.minerModel || identity.name);
  const model = cleanModel(identity.minerModel || identity.model || identity.name);
  const failedBoards = boardDetails.filter((b) => !b.working).map((b) => b.number);
  const errorLogs = firstArray(errorsResponse, ['errors'])
    .map((e) => {
      const message = e.message || e.error || e.reason || '';
      const timestamp = e.timestamp ? `${e.timestamp} — ` : '';
      return `${timestamp}${message}`.trim();
    })
    .filter(Boolean)
    .slice(-15);
  const noPic =
    errorLogs.some((l) => /nopic|no\s*pic/i.test(l)) || Boolean(identity.nopic || details.nopic);
  const minerState = braiinsMinerState(details);
  return {
    ip,
    online: true,
    api: `gRPC ${scannerSettings.grpcPort}`,
    firmwareFamily: 'braiins',
    firmwareName: 'Braiins OS',
    minerState,
    model,
    boardModel,
    boards: boardDetails,
    fans: firstArray(coolingResponse, ['fans']),
    version: details.bosVersion?.current || details.bos_version?.current || 'Braiins OS',
    workingBoards: Math.min(expected, workingBoards),
    totalBoards: expected,
    failedBoards,
    errorLogs,
    noPic,
    ratio: `${Math.min(expected, workingBoards)}/${expected}`,
    status:
      minerState === 'sleep'
        ? 'sleep'
        : workingBoards === 0
          ? 'check'
          : workingBoards < expected
            ? 'degraded'
            : 'healthy',
  };
};
/** Запрашивает таблицы старого CGMiner API и приводит их к общей записи устройства. Ошибка отдельной команды не мешает остальным, но без единой таблицы с данными устройство считается не опрошенным. */
const scanOneLegacy = async (ip, signal, prefetchedVersion = null) => {
  const safeCall = (command) =>
    apiCall(ip, command, undefined, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return {};
    });
  const [versionResult, summary, devs, details, stats] = await Promise.all([
    prefetchedVersion ? Promise.resolve(prefetchedVersion) : safeCall('version'),
    safeCall('summary'),
    safeCall('devs'),
    safeCall('devdetails'),
    safeCall('stats'),
  ]);
  throwIfScanAborted(signal);
  const hasData =
    asArray(summary, 'SUMMARY').length ||
    asArray(summary, 'summary').length ||
    asArray(devs, 'DEVS').length ||
    asArray(devs, 'devs').length ||
    asArray(details, 'DEVDETAILS').length ||
    asArray(details, 'devdetails').length ||
    asArray(stats, 'STATS').length ||
    asArray(stats, 'stats').length;
  if (!hasData) throw Error('CGMiner API не вернул сводку или данные устройств');
  const device = normalizeCgminerResult({
    ip,
    port: scannerSettings.legacyPort,
    version: versionResult,
    summary,
    devs,
    details,
    stats,
  });
  const errorRows = [...asArray(stats, 'STATS'), ...asArray(devs, 'DEVS')].filter((row) =>
    /dead|sick|error|fail|offline/i.test(String(row.Status || row.STATUS || '')),
  );
  device.errorLogs = errorRows
    .slice(0, 15)
    .map(
      (row) =>
        `${row.Name || row.Model || `Устройство ${row.ID ?? ''}`}: ${row.Status || row.STATUS || 'Ошибка'}`,
    );
  return {
    ...device,
    ratio: device.totalBoards ? `${device.workingBoards}/${device.totalBoards}` : '—',
  };
};
const offlineDevice = (ip, errors) => ({
  ip,
  online: false,
  model: '—',
  boardModel: '—',
  version: '—',
  workingBoards: 0,
  totalBoards: 3,
  failedBoards: [1, 2, 3],
  ratio: '0/3',
  status: 'offline',
  error: errors.join('; '),
});
/** Принимает IP и порядок протоколов, пробует API по очереди и возвращает первый успешный результат. Ошибки попыток собираются для offline-диагностики; отмена передаётся вызывающему коду, а не считается отключением. */
const scanOne = async (ip, protocol = 'rest', signal) => {
  const errors = [];
  const modes = scanProtocolOrder(protocol);
  for (const mode of modes) {
    throwIfScanAborted(signal);
    try {
      let device =
        mode === 'rest'
          ? await restScanOne(ip, signal)
          : mode === 'grpc'
            ? await gRPCScanOne(ip, signal)
            : await scanOneLegacy(ip, signal);
      if (
        protocol === 'auto' &&
        mode !== 'legacy' &&
        device.firmwareFamily === 'braiins' &&
        device.status !== 'healthy' &&
        device.minerState === 'unknown'
      ) {
        try {
          const legacyState = await scanOneLegacy(ip, signal);
          if (legacyState.minerState === 'sleep' || legacyState.status === 'sleep')
            device = { ...device, minerState: 'sleep', status: 'sleep', sleepEvidence: 'CGMiner' };
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      return mode === 'legacy' ? device : await attachNoPicMode(device, ip, signal);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      errors.push(
        `${mode === 'rest' ? `REST ${scannerSettings.restPort}` : mode === 'grpc' ? `gRPC ${scannerSettings.grpcPort}` : `TCP ${scannerSettings.legacyPort}`}: ${error.message}`,
      );
    }
  }
  return offlineDevice(ip, errors);
};
/** Принимает результаты устройств и размер исходного списка IP, возвращает счётчики сводки. Отдельный totalIps позволяет учитывать адреса, по которым результат не появился. */
const scanSummary = (devices, totalIps = devices.length) => {
  const online = devices.filter((d) => d.online);
  const ratioCounts = Object.fromEntries(
    ['3/3', '2/3', '1/3', '0/3'].map((ratio) => [
      ratio,
      online.filter((d) => d.ratio === ratio).length,
    ]),
  );
  return {
    totalIps,
    scannedIps: online.length,
    offlineIps: devices.length - online.length,
    idleIps: online.filter((d) => d.status !== 'healthy' && d.status !== 'sleep').length,
    ratioCounts,
  };
};
/** Принимает ЦОД, IP и протокол, возвращает пакет результатов, сводку, время и признак отмены. Работники разбирают общую очередь адресов с ограниченной параллельностью, а callback сообщает вызывающему API о прогрессе. Второй проход уточняет подозрительные ответы; если REST не поддерживается, сохраняется результат первого опроса. */
const scanIps = async (cod, ips, protocol = 'rest', onProgress = null, signal) => {
  const scanStartedAt = Date.now();
  const unique = [
    ...new Set((Array.isArray(ips) ? ips : []).filter((ip) => ipToNum(String(ip)) !== null)),
  ];
  if (unique.length > scannerSettings.maxScanIps)
    throw Error(`Слишком много IP для сканирования: максимум ${scannerSettings.maxScanIps}`);
  const out = new Array(unique.length);
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (!signal?.aborted) {
      const index = nextIndex++;
      if (index >= unique.length) return;
      const deviceStartedAt = Date.now();
      try {
        const device = await scanOne(unique[index], protocol, signal);
        if (signal?.aborted) return;
        const responseTimeMs = Date.now() - deviceStartedAt;
        out[index] = { ...device, responseTimeMs, scanDurationMs: responseTimeMs };
        onProgress?.({ completed: ++completed, total: unique.length, ip: unique[index] });
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') return;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(scannerSettings.batchSize, unique.length) }, () => worker()),
  );
  // Быстрый проход остаётся только на CGMiner; REST-уточнение ограничено подозрительными нулевыми платами.
  // The broad pass remains CGMiner-only. For hybrid and explicit legacy scans, enrich only
  // devices that look like a real zero-board fault; REST can then identify Braiins SLEEP,
  // confirm the board ratio, and supply data needed by the existing board controls.
  if (!signal?.aborted && ['hybrid', 'legacy'].includes(protocol)) {
    const candidates = out
      .map((device, index) => ({ device, index }))
      .filter(({ device }) => needsRestBoardDetails(device));
    let detailIndex = 0;
    const detailWorker = async () => {
      while (!signal?.aborted) {
        const candidate = candidates[detailIndex++];
        if (!candidate) return;
        const started = Date.now();
        try {
          let detailed = await restScanOne(candidate.device.ip, signal);
          if (detailed?.online && detailed.firmwareFamily === 'braiins') {
            detailed = await attachNoPicMode(detailed, candidate.device.ip, signal);
            const elapsed = Date.now() - started;
            const total = Number(candidate.device.responseTimeMs) + elapsed;
            out[candidate.index] = {
              ...detailed,
              responseTimeMs: total,
              scanDurationMs: total,
              fastScanApi: candidate.device.api,
            };
          }
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') return;
          // REST may not be supported by third-party firmware; retain its CGMiner result.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => detailWorker()));
  }
  const devices = out.filter(Boolean);
  return {
    codId: cod.id,
    codName: cod.name,
    protocol,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - scanStartedAt,
    devices,
    scanSummary: scanSummary(devices, unique.length),
    mapIps: unique,
    cancelled: Boolean(signal?.aborted),
  };
};
const scanCod = async (cod, protocol = 'rest', signal) =>
  scanIps(cod, expandRange(cod.start, cod.end, cod.cidr), protocol, null, signal);
const demoResults = (cod) => ({
  codId: cod.id,
  codName: cod.name,
  scannedAt: new Date().toISOString(),
  demo: true,
  scanDurationMs: 1420,
  devices: [
    {
      ip: '10.0.12.41',
      online: true,
      model: 'Antminer S19j Pro',
      boardModel: 'BM1362',
      version: '26.08',
      workingBoards: 3,
      totalBoards: 3,
      failedBoards: [],
      ratio: '3/3',
      status: 'healthy',
      responseTimeMs: 38,
      scanDurationMs: 38,
      boards: [
        { number: 1, model: 'BM1362', chips: 76, hashrateGh: 40000, working: true, enabled: true },
        { number: 2, model: 'BM1362', chips: 76, hashrateGh: 40000, working: true, enabled: true },
        { number: 3, model: 'BM1362', chips: 76, hashrateGh: 40000, working: true, enabled: true },
      ],
    },
    {
      ip: '10.0.12.42',
      online: true,
      model: 'Antminer S19j Pro',
      boardModel: 'BM1362',
      version: '26.08',
      workingBoards: 2,
      totalBoards: 3,
      failedBoards: [3],
      ratio: '2/3',
      status: 'degraded',
      responseTimeMs: 44,
      scanDurationMs: 44,
      boards: [
        { number: 1, model: 'BM1362', chips: 76, hashrateGh: 40000, working: true, enabled: true },
        { number: 2, model: 'BM1362', chips: 76, hashrateGh: 40000, working: true, enabled: true },
        { number: 3, model: 'BM1362', chips: 76, hashrateGh: 0, working: false, enabled: true },
      ],
    },
    {
      ip: '10.0.12.43',
      online: true,
      model: 'Antminer S19j Pro',
      boardModel: 'BM1362',
      version: '26.08',
      workingBoards: 1,
      totalBoards: 3,
      failedBoards: [2, 3],
      ratio: '1/3',
      status: 'degraded',
      responseTimeMs: 47,
      scanDurationMs: 47,
      boards: [
        { number: 1, model: 'BM1362', chips: 76, hashrateGh: 40000, working: true, enabled: true },
        { number: 2, model: 'BM1362', chips: 76, hashrateGh: 0, working: false, enabled: true },
        { number: 3, model: 'BM1362', chips: 76, hashrateGh: 0, working: false, enabled: false },
      ],
    },
    {
      ip: '10.0.12.44',
      online: true,
      model: 'Antminer S19',
      boardModel: 'BM1397',
      version: '26.08',
      workingBoards: 0,
      totalBoards: 3,
      failedBoards: [1, 2, 3],
      ratio: '0/3',
      status: 'check',
      noPic: true,
      responseTimeMs: 62,
      scanDurationMs: 62,
      boards: [
        { number: 1, model: 'BM1397', chips: 0, hashrateGh: 0, working: false, enabled: true },
        { number: 2, model: 'BM1397', chips: 0, hashrateGh: 0, working: false, enabled: true },
        { number: 3, model: 'BM1397', chips: 0, hashrateGh: 0, working: false, enabled: false },
      ],
      errorLogs: [
        "2026-09-20T23:50:24.023200Z — {ERR:H1} Hashboard {HB:1} has a problem, but this is a NoPIC miner and bosminer can't disable it individually for safety reasons",
        "2026-09-20T23:50:24.036678Z — Tuner error: InitError on hashchain 1 {HB:1}: Hashchip: number of responses 0 of read_register(reg=0x0) doesn't match chip count 126: reply 0x0 missing",
        "2026-09-25T20:11:55.264207Z — Tuner error: Hashchip: number of responses 123 of read_register(reg=0x14) doesn't match chip count 126: reply 0x28 missing",
        '2026-10-14T08:14:12.118940Z — Tuner error: Stage 4: Zero MCR on hashboards [1, 2, 3]',
        '2026-10-18T14:22:05.419022Z — Power controller communication timeout on I2C bus 0',
      ],
    },
    {
      ip: '10.0.12.45',
      online: false,
      model: '—',
      boardModel: '—',
      version: '—',
      workingBoards: 0,
      totalBoards: 3,
      failedBoards: [1, 2, 3],
      ratio: '0/3',
      status: 'offline',
      responseTimeMs: null,
      scanDurationMs: 1300,
      error: 'REST 80: Connection timeout; gRPC 50051: connection refused',
    },
    {
      ip: '10.0.12.46',
      online: true,
      model: 'Antminer S19 XP',
      boardModel: 'BM1366',
      version: '26.08',
      workingBoards: 2,
      totalBoards: 3,
      failedBoards: [1],
      ratio: '2/3',
      status: 'degraded',
      responseTimeMs: 35,
      scanDurationMs: 35,
      boards: [
        { number: 1, model: 'BM1366', chips: 0, hashrateGh: 0, working: false, enabled: false },
        { number: 2, model: 'BM1366', chips: 110, hashrateGh: 70000, working: true, enabled: true },
        { number: 3, model: 'BM1366', chips: 110, hashrateGh: 70000, working: true, enabled: true },
      ],
    },
  ].map((device) => ({ ...device, firmwareFamily: 'braiins', firmwareName: 'Braiins OS' })),
});
/** Читает файл из public и отправляет его браузеру с типом содержимого; корневой URL означает index.html. Функция вызывается для запросов вне /api/, а отсутствующий или нечитаемый файл получает ответ 404. */
const serveFile = async (req, res) => {
  const requestPath = String(req.url || '/')
    .split('?')[0]
    .split('#')[0];
  const name = requestPath === '/' ? 'index.html' : requestPath.slice(1).replaceAll('..', '');
  try {
    const data = SEA
      ? embeddedAsset(`public/${name}`)
      : await fs.readFile(path.join(LEGACY_ROOT, 'public', name));
    const type = name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.js')
        ? 'text/javascript'
        : 'text/html';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
};
/** Принимает папку и возвращает вложенный объект из её JSON-файлов. Рекурсия сохраняет структуру каталогов; резервные и временные файлы исключены, а неразбираемый JSON помечается, чтобы экспорт продолжился. Используется при создании копии данных. */
const readBackupTree = async (dir, relative = '') => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const result = {};
  for (const entry of entries) {
    if (entry.name.endsWith('.bak') || entry.name.endsWith('.tmp')) continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result[entry.name] = await readBackupTree(full, childRelative);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        result[entry.name] = JSON.parse(await fs.readFile(full, 'utf8'));
      } catch {
        result[entry.name] = { _unreadable: true, note: 'Файл не удалось разобрать как JSON' };
      }
    }
  }
  return result;
};
/** Собирает данные приложения и сохранения в объект для API экспорта резервной копии. Каждый необязательный файл читается отдельно: отсутствие одного не отменяет экспорт остальных. */
const buildBackup = async () => {
  let packageInfo = { name: 'asic-mix-control', version: 'unknown' };
  try {
    packageInfo = JSON.parse(
      SEA
        ? embeddedAsset('package.json').toString('utf8')
        : await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'),
    );
  } catch {}
  let state = null;
  let maps = null;
  try {
    state = JSON.parse(await fs.readFile(STATE, 'utf8'));
  } catch {}
  try {
    maps = JSON.parse(await fs.readFile(MAPS, 'utf8'));
  } catch {}
  let legacyState = null;
  try {
    legacyState = await fs.readFile(STATE_JS, 'utf8');
  } catch {}
  return {
    format: 'asic-toolbox-backup',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: { name: packageInfo.name, version: packageInfo.version },
    data: { state, maps, legacyState, saves: await readBackupTree(SAVES) },
    restoreNote:
      'Экспорт предназначен для резервного хранения. Перед ручным восстановлением остановите приложение и сделайте копию текущего каталога.',
  };
};
// Здесь запросы направляются по методу и URL к API-обработчикам; обычные страницы передаются serveFile. Общий catch превращает необработанную ошибку любого обработчика в JSON-ответ 500.
const server = http.createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/api/')) return serveFile(req, res);
    if (req.method === 'GET' && req.url === '/api/scanner-settings')
      return json(res, 200, publicScannerSettings());
    if (req.method === 'POST' && req.url === '/api/scanner-settings') {
      const b = await body(req);
      if (!validScanProtocols.has(b.protocol))
        return json(res, 400, { error: 'Выберите допустимый протокол сканирования' });
      const integerRanges = {
        batchSize: [1, 256],
        maxScanIps: [1, 65536],
        restTimeoutMs: [500, 30000],
        grpcTimeoutMs: [3000, 30000],
        legacyTimeoutMs: [300, 20000],
        restPort: [1, 65535],
        grpcPort: [1, 65535],
        legacyPort: [1, 65535],
        restSocketsPerDevice: [1, 16],
      };
      for (const [key, [min, max]] of Object.entries(integerRanges))
        if (!Number.isInteger(Number(b[key])) || Number(b[key]) < min || Number(b[key]) > max)
          return json(res, 400, {
            error: `Параметр ${key} должен быть целым числом от ${min} до ${max}`,
          });
      if (typeof b.username !== 'string' || !b.username.trim() || b.username.trim().length > 128)
        return json(res, 400, { error: 'Имя пользователя должно содержать от 1 до 128 символов' });
      if (typeof b.password !== 'string' || b.password.length > 512)
        return json(res, 400, { error: 'Пароль должен содержать не более 512 символов' });
      if (typeof b.restKeepAlive !== 'boolean')
        return json(res, 400, { error: 'Параметр REST Keep-Alive должен быть true или false' });
      const nextSettings = normalizeScannerSettings({
        protocol: b.protocol,
        batchSize: Number(b.batchSize),
        maxScanIps: Number(b.maxScanIps),
        restTimeoutMs: Number(b.restTimeoutMs),
        grpcTimeoutMs: Number(b.grpcTimeoutMs),
        legacyTimeoutMs: Number(b.legacyTimeoutMs),
        restPort: Number(b.restPort),
        grpcPort: Number(b.grpcPort),
        legacyPort: Number(b.legacyPort),
        restSocketsPerDevice: Number(b.restSocketsPerDevice),
        restKeepAlive: b.restKeepAlive,
        username: b.username.trim(),
        password: b.clearPassword ? '' : b.password.length ? b.password : scannerSettings.password,
      });
      await writeJsonAtomic(SCAN_SETTINGS_FILE, {
        ...nextSettings,
        protocolSelectionExplicit: true,
      });
      try {
        await fs.chmod(SCAN_SETTINGS_FILE, 0o600);
      } catch {}
      const previousAgent = restAgent;
      scannerSettings = nextSettings;
      restAgent = createRestAgent();
      retireRestAgent(previousAgent);
      return json(res, 200, { ...publicScannerSettings(), applied: true });
    }
    if (req.method === 'GET' && req.url === '/api/scan-all/progress')
      return json(res, 200, { ...scanProgress });
    if (req.method === 'POST' && req.url === '/api/scan/cancel') {
      if (!scanLock || !activeScanController)
        return json(res, 409, { error: 'Сканирование не выполняется' });
      if (scanProgress.running) scanProgress.cancelRequested = true;
      activeScanController.abort();
      return json(res, 200, { ok: true, cancelRequested: true });
    }
    if (req.method === 'GET' && req.url === '/api/health')
      return json(res, 200, {
        ok: true,
        app: 'asic-toolbox',
        time: new Date().toISOString(),
        scanRunning: scanLock,
        monitorRunning: monitorLock,
      });
    if (req.method === 'GET' && req.url === '/api/backup/export') {
      const backup = await buildBackup();
      const filename = `asic-toolbox-backup-${localDate()}.json`;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename=\"${filename}\"`,
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify(backup, null, 2));
    }
    if (req.method === 'GET' && req.url === '/api/cods') {
      const result = await codRecords();
      const items = result.items
        .map((c, i) => ({
          ...c,
          ec: typeof c.ec === 'string' && c.ec.trim() ? c.ec.trim() : 'Без группы',
          order: Number.isInteger(c.order) ? c.order : i,
        }))
        .sort((a, b) => a.order - b.order);
      return json(res, 200, items);
    }
    if (req.method === 'GET' && req.url === '/api/state-diagnostics') {
      const primary = await readStateFile(STATE);
      const legacy = await readStateFile(STATE_JS);
      return json(res, 200, {
        root: ROOT,
        stateJson: {
          exists: primary.exists,
          path: primary.file,
          count: primary.items.length,
          error: primary.error,
        },
        stateJs: {
          exists: legacy.exists,
          path: legacy.file,
          count: legacy.items.length,
          error: legacy.error,
        },
        selected: primary.items.length ? 'state.json' : legacy.items.length ? 'state.js' : 'none',
      });
    }
    if (req.method === 'POST' && req.url === '/api/cods') {
      const b = await body(req);
      if (!validName(b.name)) return json(res, 400, { error: 'Укажите название ЦОДа' });
      try {
        expandRange(b.start, b.end, b.cidr);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      const cods = await readCods();
      const item = {
        id: crypto.randomUUID(),
        name: b.name.trim(),
        start: b.start || '',
        end: b.end || '',
        cidr: b.cidr || '',
        ec: typeof b.ec === 'string' && b.ec.trim() ? b.ec.trim() : 'Без группы',
        order: cods.length,
        createdAt: new Date().toISOString(),
      };
      cods.push(item);
      await writeCods(cods);
      return json(res, 201, item);
    }
    if (req.method === 'PATCH' && req.url.startsWith('/api/cods/')) {
      const id = req.url.split('/').pop();
      const b = await body(req);
      const cods = await readCods();
      const index = cods.findIndex((x) => x.id === id);
      if (index < 0) return json(res, 404, { error: 'ЦОД не найден' });
      const current = cods[index];
      const next = { ...current };
      if (b.name !== undefined) {
        if (!validName(b.name)) return json(res, 400, { error: 'Укажите название ЦОДа' });
        next.name = b.name.trim();
      }
      if (b.start !== undefined) next.start = b.start || '';
      if (b.end !== undefined) next.end = b.end || '';
      if (b.cidr !== undefined) next.cidr = b.cidr || '';
      if (b.ec !== undefined)
        next.ec = typeof b.ec === 'string' && b.ec.trim() ? b.ec.trim() : 'Без группы';
      if (b.start !== undefined || b.end !== undefined || b.cidr !== undefined) {
        try {
          expandRange(next.start, next.end, next.cidr);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (Number.isInteger(b.order)) next.order = b.order;
      cods[index] = next;
      await writeCods(cods);
      return json(res, 200, next);
    }
    if (req.method === 'POST' && req.url === '/api/cods/reorder') {
      const b = await body(req);
      if (!Array.isArray(b.ids)) return json(res, 400, { error: 'Нужен массив ids' });
      const cods = await readCods();
      const known = new Set(cods.map((x) => x.id));
      const ids = b.ids.filter((id, i, arr) => known.has(id) && arr.indexOf(id) === i);
      if (ids.length !== cods.length)
        return json(res, 400, { error: 'Список ЦОДов должен быть полным' });
      const byId = new Map(cods.map((x) => [x.id, x]));
      const reordered = ids.map((id, order) => ({ ...byId.get(id), order }));
      await writeCods(reordered);
      return json(res, 200, reordered);
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/cods/')) {
      const id = req.url.split('/').pop();
      await writeCods((await readCods()).filter((x) => x.id !== id));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/api/maps') {
      const maps = await readMaps();
      return json(res, 200, maps);
    }
    if (req.method === 'GET' && req.url.startsWith('/api/maps/')) {
      const id = decodeURIComponent(req.url.slice('/api/maps/'.length));
      const cod = (await readCods()).find((x) => x.id === id);
      if (!cod) return json(res, 404, { error: 'ЦОД не найден' });
      const maps = await readMaps();
      return json(res, 200, maps[id] || defaultMap(cod));
    }
    if (req.method === 'PUT' && req.url.startsWith('/api/maps/')) {
      const id = decodeURIComponent(req.url.slice('/api/maps/'.length));
      const cod = (await readCods()).find((x) => x.id === id);
      if (!cod) return json(res, 404, { error: 'ЦОД не найден' });
      const b = await body(req);
      const racks = Math.max(1, Math.floor(Number(b.racks) || 11));
      const shelves = Math.max(1, Math.floor(Number(b.shelves) || 6));
      const devicesPerShelf = Math.max(1, Math.floor(Number(b.devicesPerShelf) || 4));
      const capacity = racks * shelves * devicesPerShelf;
      const cells = Array.isArray(b.cells)
        ? b.cells.slice(0, capacity).map((cell, i) => ({
            slot: i + 1,
            rack: Math.floor(i / (shelves * devicesPerShelf)) + 1,
            shelf: (Math.floor(i / devicesPerShelf) % shelves) + 1,
            position: (i % devicesPerShelf) + 1,
            ip: typeof cell?.ip === 'string' ? cell.ip.trim() : '',
          }))
        : [];
      const maps = await readMaps();
      maps[id] = {
        codId: id,
        name: cod.name,
        racks,
        shelves,
        devicesPerShelf,
        cells,
        updatedAt: new Date().toISOString(),
      };
      await writeMaps(maps);
      return json(res, 200, maps[id]);
    }
    // Общий контроллер отмены охватывает пакет; finally сбрасывает прогресс и блокировку при любом выходе.
    if (req.method === 'POST' && req.url === '/api/scan-all') {
      if (scanLock || monitorLock)
        return json(res, 409, { error: 'Сканирование или мониторинг уже выполняется' });
      scanLock = true;
      const controller = new AbortController();
      const signal = controller.signal;
      activeScanController = controller;
      let progressStarted = false;
      try {
        const b = await body(req);
        const all = await readCods();
        const selected =
          Array.isArray(b.codIds) && b.codIds.length
            ? all.filter((c) => b.codIds.includes(c.id))
            : all;
        if (!selected.length) return json(res, 400, { error: 'Нет ЦОДов для сканирования' });
        const protocol = validScanProtocols.has(b.protocol) ? b.protocol : scannerSettings.protocol;
        const maps = await readMaps();
        const mappedIpsFor = (cod) =>
          Array.isArray(maps[cod.id]?.cells)
            ? maps[cod.id].cells
                .map((cell) => String(cell?.ip || '').trim())
                .filter((ip) => ipToNum(ip) !== null)
            : [];
        const scanTotal = selected.reduce((sum, cod) => {
          if (b.demo) {
            const mappedCount = Array.isArray(maps[cod.id]?.cells)
              ? maps[cod.id].cells.filter((cell) => cell?.ip).length
              : 0;
            return sum + (mappedCount || demoResults(cod).devices.length);
          }
          return sum + new Set(mappedIpsFor(cod)).size;
        }, 0);
        if (!b.demo && scanTotal > scannerSettings.maxScanIps)
          return json(res, 400, {
            error: `Слишком много IP для запуска: максимум ${scannerSettings.maxScanIps}`,
          });
        scanProgress = {
          running: true,
          completed: 0,
          total: scanTotal,
          codIndex: 0,
          codTotal: selected.length,
          currentCod: '',
          startedAt: new Date().toISOString(),
          cancelRequested: false,
          cancelled: false,
        };
        progressStarted = true;
        const results = [];
        let codIndex = 0;
        for (const cod of selected) {
          if (signal.aborted) break;
          scanProgress.codIndex = ++codIndex;
          scanProgress.currentCod = cod.name;
          if (b.demo) {
            const result = demoResults(cod);
            const map = maps[cod.id];
            const mapCellsList = Array.isArray(map?.cells) ? map.cells.filter((c) => c?.ip) : [];
            if (mapCellsList.length) {
              result.devices = mapCellsList.map((cell, idx) => {
                const base = result.devices[idx % result.devices.length];
                return { ...base, ip: cell.ip };
              });
            }
            result.mapConfigured = true;
            result.mapIps = result.devices.map((d) => d.ip);
            result.mixes = mixes(result.devices);
            scanProgress.completed = Math.min(
              scanProgress.total,
              scanProgress.completed + result.devices.length,
            );
            results.push(result);
            continue;
          }
          const map = maps[cod.id];
          const ips = Array.isArray(map?.cells)
            ? map.cells.map((cell) => cell?.ip).filter(Boolean)
            : [];
          const result = await scanIps(
            cod,
            ips,
            protocol,
            () => {
              scanProgress.completed = Math.min(scanProgress.total, scanProgress.completed + 1);
            },
            signal,
          );
          result.mapConfigured = ips.length > 0;
          result.mixes = mixes(result.devices);
          results.push(result);
          if (signal.aborted) break;
        }
        return json(res, 200, {
          scannedAt: new Date().toISOString(),
          protocol: validScanProtocols.has(b.protocol) ? b.protocol : scannerSettings.protocol,
          results,
          cancelled: signal.aborted,
        });
      } finally {
        if (progressStarted) {
          scanProgress.running = false;
          scanProgress.cancelled = signal.aborted;
          scanProgress.cancelRequested = false;
          scanProgress.finishedAt = new Date().toISOString();
        }
        if (activeScanController === controller) activeScanController = null;
        scanLock = false;
      }
    }
    if (req.method === 'GET' && req.url === '/api/saves')
      return json(res, 200, await readSavedList());
    if (req.method === 'POST' && req.url === '/api/saves') {
      const b = await body(req);
      if (!Array.isArray(b.recipients) || !Array.isArray(b.donors))
        return json(res, 400, { error: 'Нужны массивы recipients и donors' });
      const date = safeSegment(b.date || localDate(), localDate());
      const codName = safeSegment(b.codName || 'ЦОД');
      const base = path.join(date, codName);
      await fs.mkdir(savePath(base), { recursive: true });
      const existing = await fs.readdir(savePath(base), { withFileTypes: true });
      const numbers = existing
        .map((x) => Number((x.name.match(/^save-(\d+)$/) || [])[1]))
        .filter(Number.isInteger);
      const number = (numbers.length ? Math.max(...numbers) : 0) + 1;
      const folder = path.join(base, `save-${String(number).padStart(3, '0')}`);
      const relative = path.relative(SAVES, savePath(folder)).replaceAll(path.sep, '/');
      const manifest = {
        id: relative,
        date,
        codId: b.codId || '',
        codName: b.codName || 'ЦОД',
        ec: b.ec || '',
        saveNumber: number,
        savedAt: new Date().toISOString(),
        recipientsCount: b.recipients.length,
        donorsCount: b.donors.length,
        mixCount: Array.isArray(b.mixes) ? b.mixes.length : 0,
      };
      await fs.mkdir(savePath(folder), { recursive: true });
      await fs.writeFile(
        savePath(path.join(folder, 'manifest.json')),
        JSON.stringify(manifest, null, 2),
      );
      await fs.writeFile(
        savePath(path.join(folder, 'recipients.json')),
        JSON.stringify(b.recipients, null, 2),
      );
      await fs.writeFile(
        savePath(path.join(folder, 'donors.json')),
        JSON.stringify(b.donors, null, 2),
      );
      await fs.writeFile(
        savePath(path.join(folder, 'mixes.json')),
        JSON.stringify(Array.isArray(b.mixes) ? b.mixes : [], null, 2),
      );
      return json(res, 201, manifest);
    }
    if (req.method === 'GET' && req.url.startsWith('/api/saves/')) {
      try {
        const id = decodeURIComponent(req.url.slice('/api/saves/'.length));
        const folder = savePath(id);
        const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
        const recipients = JSON.parse(
          await fs.readFile(path.join(folder, 'recipients.json'), 'utf8'),
        );
        const donors = JSON.parse(await fs.readFile(path.join(folder, 'donors.json'), 'utf8'));
        const mixesData = JSON.parse(await fs.readFile(path.join(folder, 'mixes.json'), 'utf8'));
        return json(res, 200, { ...manifest, recipients, donors, mixes: mixesData });
      } catch (e) {
        return json(res, 404, { error: 'Сохранение не найдено' });
      }
    }
    if (req.method === 'POST' && req.url === '/api/boards/configure') {
      const b = await body(req);
      if (!Array.isArray(b.devices) || !b.devices.length)
        return json(res, 400, { error: 'Нет конфигураций устройств' });
      const results = await Promise.all(
        b.devices.map(async (device) => {
          const ip = device?.ip;
          try {
            if (!ip || !Array.isArray(device.boards)) throw Error('Некорректная конфигурация плат');
            const login = await grpcCall(ip, 'braiins.bos.v1.AuthenticationService/Login', {
              username: scannerSettings.username,
              password: scannerSettings.password,
            });
            const token = login.token || login.sessionToken;
            if (!token) throw Error('Braiins API не вернул токен авторизации');
            const enabledIds = device.boards.filter((x) => x.enabled).map((x) => String(x.id));
            const disabledIds = device.boards.filter((x) => !x.enabled).map((x) => String(x.id));
            const results = [];
            if (enabledIds.length)
              results.push(
                await grpcCall(
                  ip,
                  'braiins.bos.v1.MinerService/EnableHashboards',
                  { saveAction: 'SAVE_ACTION_SAVE_AND_APPLY', hashboardIds: enabledIds },
                  token,
                ),
              );
            if (disabledIds.length)
              results.push(
                await grpcCall(
                  ip,
                  'braiins.bos.v1.MinerService/DisableHashboards',
                  { saveAction: 'SAVE_ACTION_SAVE_AND_APPLY', hashboardIds: disabledIds },
                  token,
                ),
              );
            const nopicApplied = device.nopicMode === 'enabled' || device.nopicMode === 'disabled';
            if (nopicApplied) await setNoPicExperimental(ip, device.nopicMode === 'enabled');
            return {
              ip,
              ok: true,
              response: results,
              nopicApplied,
              nopicMode: nopicApplied ? device.nopicMode : 'unknown',
            };
          } catch (error) {
            return { ip: ip || '—', ok: false, error: error.message };
          }
        }),
      );
      return json(res, 200, { results });
    }
    if (req.method === 'POST' && req.url === '/api/boards/enable') {
      const b = await body(req);
      if (!Array.isArray(b.recipients) || !b.recipients.length)
        return json(res, 400, { error: 'Нет реципиентов для обработки' });
      return json(res, 200, { results: await enableAllBoards(b.recipients) });
    }
    if (req.method === 'POST' && req.url === '/api/miner/resume') {
      const b = await body(req);
      const ip = String(b.ip || '');
      if (ipToNum(ip) === null) return json(res, 400, { error: 'Некорректный IP устройства' });
      const login = await restCall(ip, '/api/v1/auth/login', {
        method: 'POST',
        payload: { username: scannerSettings.username, password: scannerSettings.password },
      });
      const token = login.token || login.sessionToken || login.session_token;
      if (!token) throw Error('REST API не вернул токен авторизации');
      const result = await restCall(ip, '/api/v1/actions/resume', { method: 'PUT', token });
      return json(res, 200, { ok: true, result });
    }
    if (req.method === 'POST' && req.url === '/api/monitor') {
      if (scanLock || monitorLock)
        return json(res, 409, { error: 'Сканирование или мониторинг уже выполняется' });
      monitorLock = true;
      try {
        const b = await body(req);
        const seenIps = new Set();
        const recipients = (Array.isArray(b.recipients) ? b.recipients : []).filter((x) => {
          const ip = String(x?.ip || '').trim();
          if (!ip || seenIps.has(ip)) return false;
          seenIps.add(ip);
          return true;
        });
        if (!recipients.length) return json(res, 400, { error: 'Нет устройств для мониторинга' });
        const protocol = ['rest', 'grpc', 'legacy', 'auto', 'hybrid'].includes(b.protocol)
          ? b.protocol
          : scannerSettings.protocol;
        const results = await Promise.all(
          recipients.map(async (x) => {
            const ip = String(x.ip).trim();
            const targetProtocol =
              protocol === 'hybrid'
                ? x.firmwareFamily === 'braiins' || x.firmwareFamily === 'unknown'
                  ? 'rest'
                  : 'legacy'
                : protocol;
            const result = await scanOne(ip, targetProtocol);
            if (
              protocol === 'hybrid' &&
              !result.online &&
              (x.firmwareFamily === 'unknown' || x.firmwareFamily === 'braiins')
            )
              return scanOne(ip, 'legacy');
            return result;
          }),
        );
        return json(res, 200, { checkedAt: new Date().toISOString(), protocol, devices: results });
      } finally {
        monitorLock = false;
      }
    }
    // Одиночный запуск предпочитает валидные IP карты; при пустой карте сканирует заданный диапазон.
    if (req.method === 'POST' && req.url === '/api/scan') {
      if (scanLock || monitorLock)
        return json(res, 409, { error: 'Сканирование или мониторинг уже выполняется' });
      scanLock = true;
      const controller = new AbortController();
      const signal = controller.signal;
      activeScanController = controller;
      try {
        const b = await body(req);
        const cod = (await readCods()).find((x) => x.id === b.codId);
        if (!cod) return json(res, 404, { error: 'ЦОД не найден' });
        const protocol = validScanProtocols.has(b.protocol) ? b.protocol : scannerSettings.protocol;
        let result;
        if (b.demo) result = demoResults(cod);
        else {
          const maps = await readMaps();
          const cells = maps[cod.id]?.cells;
          const mappedIps = Array.isArray(cells)
            ? [
                ...new Set(
                  cells
                    .map((cell) => String(cell?.ip || '').trim())
                    .filter((ip) => ipToNum(ip) !== null),
                ),
              ]
            : [];
          if (mappedIps.length > scannerSettings.maxScanIps)
            return json(res, 400, {
              error: `Слишком много IP для запуска: максимум ${scannerSettings.maxScanIps}`,
            });
          result = mappedIps.length
            ? await scanIps(cod, mappedIps, protocol, null, signal)
            : await scanCod(cod, protocol, signal);
          result.mapConfigured = mappedIps.length > 0;
          result.scanScope = mappedIps.length ? 'map' : 'range';
          result.mapIps = mappedIps.length ? mappedIps : result.mapIps;
        }
        result.protocol = protocol;
        result.scanSummary = scanSummary(
          result.devices,
          result.scanSummary?.totalIps ?? result.devices.length,
        );
        result.mixes = mixes(result.devices);
        return json(res, 200, {
          ...result,
          cancelled: Boolean(result.cancelled || signal.aborted),
        });
      } finally {
        if (activeScanController === controller) activeScanController = null;
        scanLock = false;
      }
    }
    json(res, 404, { error: 'API route not found' });
  } catch (e) {
    json(res, 500, { error: e.message || 'Server error' });
  }
});
const listenOnAvailablePort = async () => {
  const firstPort = PORT;
  let lastError;
  for (let port = firstPort; port < firstPort + 20; port++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
      });
      console.log(`ASIC ToolBox listening on http://${HOST}:${port}`);
      if (SEA && process.env.ASIC_TOOLBOX_NO_BROWSER !== '1') {
        const browser = spawn(
          'cmd.exe',
          ['/d', '/s', '/c', 'start', '""', `http://${HOST}:${port}`],
          {
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
          },
        );
        browser.unref();
      }
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  throw lastError || new Error('Не найден свободный локальный порт');
};
Promise.resolve()
  .then(migratePortableData)
  .then(loadScannerSettings)
  .then(listenOnAvailablePort)
  .catch((error) => {
    console.error(`Could not load scanner settings: ${error.message}`);
    process.exitCode = 1;
  });
process.on('exit', () => {
  restAgent.destroy();
  for (const agent of retiredRestAgents) agent.destroy();
});
