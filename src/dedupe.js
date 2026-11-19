/**
 * 重复事件合并。
 * 分组键优先级：显式 duplicateKey > fingerprint。
 * 同组保留一条权威记录（canonical），其余作为 duplicates，绝不重复计数。
 */

/**
 * @param {Array<Record<string, unknown>>} events 已归一化事件
 * @returns {{events: Array, duplicates: Array<object>, conflictedGroups: string[]}}
 */
export function dedupe(events) {
  const groups = new Map();

  for (const event of events) {
    const key = groupKey(event);
    if (key === null) {
      groups.set(`__singleton__:${event.id}`, [event]);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }

  const canonicalEvents = [];
  const duplicateReports = [];
  const conflictedGroups = [];

  for (const [key, members] of groups) {
    if (key.startsWith('__singleton__:')) {
      canonicalEvents.push({ ...members[0], canonical: true, duplicateOf: null });
      continue;
    }

    const ordered = [...members].sort(canonicalComparator);
    const canonical = ordered[0];
    const dropped = ordered.slice(1);

    const occurredValues = new Set(
      members.map((member) => member.occurredAt).filter((value) => value !== null),
    );
    const statusValues = new Set(members.map((member) => member.status).filter((value) => value !== null));
    const sources = [...new Set(members.map((member) => member.source))];
    const timeConflict = occurredValues.size > 1;
    const statusConflict = statusValues.size > 1;

    if (timeConflict || statusConflict) conflictedGroups.push(key);

    canonicalEvents.push({
      ...canonical,
      canonical: true,
      duplicateOf: null,
      duplicateCount: members.length,
      duplicateSources: sources,
    });

    duplicateReports.push({
      duplicateKey: key,
      canonicalId: canonical.id,
      duplicateIds: dropped.map((member) => member.id),
      mergedCount: members.length,
      sources,
      timeConflict,
      statusConflict,
      conflictingOccurredAt: timeConflict
        ? members
            .filter((member) => member.occurredAt !== null)
            .map((member) => ({ id: member.id, occurredAt: member.occurredAt, source: member.source }))
        : [],
    });
  }

  return {
    events: canonicalEvents,
    duplicates: duplicateReports,
    conflictedGroups,
  };
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string|null}
 */
function groupKey(event) {
  if (event.duplicateKey) return `dk:${event.duplicateKey}`;
  if (event.fingerprint) return `fp:${event.fingerprint}`;
  return null;
}

/**
 * 权威记录选择：有发生时间的事件优先于只有接收时间的事件；
 * 发生时间相同取先接收；再相同按 id 保证确定性。
 */
function canonicalComparator(a, b) {
  const aHasOccurred = a.occurredAt !== null;
  const bHasOccurred = b.occurredAt !== null;
  if (aHasOccurred !== bHasOccurred) return aHasOccurred ? -1 : 1;
  if (aHasOccurred && a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
  const ra = a.receivedAt === null ? Number.POSITIVE_INFINITY : a.receivedAt;
  const rb = b.receivedAt === null ? Number.POSITIVE_INFINITY : b.receivedAt;
  if (ra !== rb) return ra - rb;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}
