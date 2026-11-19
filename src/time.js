/**
 * 时间解析与时钟偏移归一化。
 * 约定：occurredAt 是事件在来源系统中的发生时间，receivedAt 是本系统接收时间。
 * 只有发生时间缺失时才退而使用接收时间，并在 timeBasis 中显式标记。
 */

/**
 * @param {number|string|Date|null|undefined} value
 * @returns {number|null} epoch 毫秒
 */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // 10 位秒级时间戳自动转毫秒
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * 来源时钟偏移，单位毫秒。正值表示该来源时钟比统一时钟快。
 * @param {string} source
 * @param {{clockOffsetsMs?: Record<string, number>}} [config]
 * @returns {number}
 */
export function offsetFor(source, config = {}) {
  return config.clockOffsetsMs?.[source] ?? 0;
}

/**
 * 归一化单条原始事件。
 * @param {Record<string, unknown>} raw
 * @param {number} index
 * @param {Record<string, unknown>} [config]
 */
export function normalizeEvent(raw, index, config = {}) {
  const source = String(raw.source ?? 'unknown');
  const clockOffsetMs = offsetFor(source, config);
  const rawOccurred = parseTime(raw.occurredAt);
  const rawReceived = parseTime(raw.receivedAt);

  const occurredAt = rawOccurred === null ? null : rawOccurred - clockOffsetMs;
  const receivedAt = rawReceived;

  let effectiveAt;
  let timeBasis;
  if (occurredAt !== null) {
    effectiveAt = occurredAt;
    timeBasis = 'occurred';
  } else if (receivedAt !== null) {
    effectiveAt = receivedAt;
    timeBasis = 'received';
  } else {
    effectiveAt = null;
    timeBasis = 'unknown';
  }

  return {
    id: raw.id ?? `evt-${index + 1}`,
    source,
    type: String(raw.type ?? 'log'),
    status: raw.status === undefined ? null : String(raw.status),
    message: String(raw.message ?? ''),
    sender: raw.sender === undefined ? null : String(raw.sender),
    actionKey: raw.actionKey === undefined ? null : String(raw.actionKey),
    fingerprint: raw.fingerprint === undefined ? null : String(raw.fingerprint),
    incidentRefs: toStringList(raw.incidentRefs),
    deployRefs: toStringList(raw.deployRefs),
    refs: toStringList(raw.refs),
    causalRefs: toStringList(raw.causalRefs),
    duplicateKey: raw.duplicateKey === undefined ? null : String(raw.duplicateKey),
    occurredAtRaw: raw.occurredAt ?? null,
    receivedAtRaw: raw.receivedAt ?? null,
    occurredAt,
    receivedAt,
    clockOffsetMs,
    effectiveAt,
    timeBasis,
    raw,
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item));
}

/**
 * 稳定排序键：有效时间（未知排最后），再按 id。
 * @param {{effectiveAt: number|null, id: string}} a
 * @param {{effectiveAt: number|null, id: string}} b
 */
export function timeThenIdComparator(a, b) {
  const ta = a.effectiveAt === null ? Number.POSITIVE_INFINITY : a.effectiveAt;
  const tb = b.effectiveAt === null ? Number.POSITIVE_INFINITY : b.effectiveAt;
  if (ta !== tb) return ta - tb;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}
