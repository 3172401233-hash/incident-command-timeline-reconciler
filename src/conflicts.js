/**
 * 汇总时间冲突片段：因果/时间倒置、状态机冲突、重复组内部矛盾、未解析引用。
 */

/**
 * @param {object} params
 * @param {object[]} params.actions
 * @param {object[]} params.conflictedGroups
 * @param {object[]} params.duplicates
 * @param {object[]} params.timeCausalConflicts
 * @param {object[]} params.unresolvedRefs
 * @returns {object[]}
 */
export function collectConflicts({
  actions,
  conflictedGroups,
  duplicates,
  timeCausalConflicts,
  unresolvedRefs,
}) {
  const segments = [];
  const seen = new Set();
  const pushOnce = (key, segment) => {
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(segment);
  };

  for (const conflict of timeCausalConflicts) {
    if (conflict.type === 'causal_time_inversion') {
      pushOnce(`inversion:${conflict.edgeType}:${conflict.earlierByCausality.nodeId}->${conflict.laterByCausality.nodeId}`, {
        kind: 'causal_time_inversion',
        severity: 'high',
        edgeType: conflict.edgeType,
        nodes: [conflict.earlierByCausality.nodeId, conflict.laterByCausality.nodeId],
        detail: `因果要求 ${conflict.earlierByCausality.nodeId} 先于 ${conflict.laterByCausality.nodeId}，但发生时间反向，偏差 ${conflict.skewMs}ms`,
        sources: [...new Set([...conflict.earlierByCausality.sources, ...conflict.laterByCausality.sources])],
        resolution: conflict.resolution,
      });
    } else if (conflict.type === 'cycle_broken') {
      pushOnce(`cycle:${conflict.edge.from}->${conflict.edge.to}:${conflict.edge.type}`, {
        kind: 'causal_cycle',
        severity: 'high',
        nodes: [conflict.edge.from, conflict.edge.to],
        detail: `因果引用成环，已移除 ${conflict.edge.type} 边 ${conflict.edge.from} -> ${conflict.edge.to}`,
        resolution: 'lowest_weight_edge_removed',
      });
    }
  }

  for (const action of actions) {
    for (const conflict of action.stateConflicts) {
      segments.push({
        kind: 'state_machine_conflict',
        severity: 'medium',
        nodes: [`node:${conflict.episodeId}`],
        actionKey: conflict.actionKey,
        detail: `动作 ${conflict.actionKey} 在状态 ${conflict.currentState} 收到非法更新 ${conflict.attemptedState}（${conflict.reason}），事件 ${conflict.eventId} 已保留但不参与状态推进`,
      });
    }
  }

  const duplicateMap = new Map(duplicates.map((item) => [item.duplicateKey, item]));
  for (const key of conflictedGroups) {
    const report = duplicateMap.get(key);
    segments.push({
      kind: 'duplicate_group_conflict',
      severity: 'medium',
      duplicateKey: key,
      nodes: report ? [report.canonicalId, ...report.duplicateIds] : [],
      detail: `重复组 ${key} 内部时间或状态不一致，已按最早发生时间选取权威记录`,
      conflictingOccurredAt: report?.conflictingOccurredAt ?? [],
    });
  }

  for (const ref of unresolvedRefs) {
    segments.push({
      kind: 'unresolved_reference',
      severity: 'low',
      nodes: [ref.nodeId],
      detail: `节点 ${ref.nodeId} 引用了不存在的 ${ref.kind} 目标 ${ref.ref}`,
    });
  }

  return segments;
}
