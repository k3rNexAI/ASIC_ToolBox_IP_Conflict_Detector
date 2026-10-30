const firstValue = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
};

export const normalizeMac = (value) => {
  const hex = String(value || '')
    .replace(/[^a-f\d]/gi, '')
    .toLowerCase();
  return hex.length === 12 ? hex.match(/.{2}/g).join(':') : '';
};

export const serialNumberOf = (device) =>
  firstValue(device, [
    'serialNumber',
    'serial_number',
    'serial',
    'sn',
    'minerSerial',
    'miner_serial',
  ]);

export const hardwareFingerprintOf = (device) =>
  [device?.model, device?.version, device?.boardModel]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase(),
    )
    .join('|');

/**
 * Aggregate repeated observations for each address. Distinct serial numbers are the strongest
 * evidence. MAC changes are considered strong only when no serial number was reported, because
 * routed scans can expose a gateway MAC instead of the ASIC's hardware address.
 */
export const analyzeIpObservations = (observations) => {
  const byIp = new Map();
  for (const observation of Array.isArray(observations) ? observations : []) {
    const ip = String(observation?.ip || '').trim();
    if (!ip) continue;
    if (!byIp.has(ip)) byIp.set(ip, []);
    byIp.get(ip).push(observation);
  }

  return [...byIp.entries()].map(([ip, samples]) => {
    const online = samples.filter((sample) => sample.online && sample.identity);
    const serials = [
      ...new Set(online.map((sample) => serialNumberOf(sample.identity)).filter(Boolean)),
    ];
    const macs = [...new Set(online.map((sample) => normalizeMac(sample.mac)).filter(Boolean))];
    const fingerprints = [
      ...new Set(
        online
          .map((sample) => hardwareFingerprintOf(sample.identity))
          .filter((value) => value !== '||'),
      ),
    ];

    let status = 'clear';
    let reason = 'За раунды не обнаружено нескольких идентификаторов';
    if (serials.length > 1) {
      status = 'confirmed';
      reason = 'Один IP ответил с разными серийными номерами ASIC';
    } else if (serials.length === 0 && macs.length > 1) {
      status = 'confirmed';
      reason = 'В локальной таблице соседей зафиксированы разные MAC-адреса';
    } else if (fingerprints.length > 1) {
      status = 'possible';
      reason = 'Ответы отличаются моделью, версией или моделью hashboard; проверьте вручную';
    }

    return {
      ip,
      status,
      reason,
      rounds: samples.length,
      onlineRounds: online.length,
      serialNumbers: serials,
      macAddresses: macs,
      fingerprints,
    };
  });
};
