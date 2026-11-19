/**
 * 根因候选只是证据聚合：根据时间接近度、显式引用、部署关联和回滚恢复信号
 * 计算候选分数并列出证据，绝不自动下结论。最终判定必须由人工复核。
 */

const ROOT_CAUSE_HINTS = ['root cause', '根因', '导致', 'caused by', '因为', 'rollback', '回滚'];

/**
 * @param {object} graph buildCausalTimeline 的返回值
 * @returns {object[]}
 */
export function findRootCauseCandidates(graph) {
  const { nodes, edges } = graph;
  const nodeMap = new Map(nodes.map((node) => [node.nodeId, node]));
  const alerts = nodes.filter((node) => node.type === 'alert');
  const firstAlertAt = alerts.length
    ? Math.min(...alerts.map((node) => node.effectiveAt).filter((value) => value !== null))
    : null;

  const candidates = [];

  for (const node of nodes) {
    if (node.type !== 'deploy' && node.kind !== 'event') continue;
    if (node.type === 'alert') continue;

    const evidence = [];
    let score = 0;

    // 1. 时间接近度：早于首个告警且越近分越高，窗口 30 分钟
    if (firstAlertAt !== null && node.effectiveAt !== null && node.effectiveAt <= firstAlertAt) {
      const gapMin = (firstAlertAt - node.effectiveAt) / 60000;
      if (gapMin <= 30) {
        const gained = Math.round((1 - gapMin / 30) * 30);
        score += gained;
        evidence.push({ kind: 'temporal_proximity', weight: gained, detail: `先于首个告警 ${gapMin.toFixed(1)} 分钟` });
      }
    }

    // 2. 显式因果引用（最高权重证据）
    const incomingCausal = edges.filter(
      (edge) => edge.to !== node.nodeId && edge.from === node.nodeId && edge.type === 'causal',
    );
    for (const edge of incomingCausal) {
      score += 35;
      evidence.push({ kind: 'explicit_causal_ref', weight: 35, detail: `${edge.from} -> ${edge.to}` });
    }

    // 3. 部署-故障关联
    const correlationEdges = edges.filter(
      (edge) => edge.from === node.nodeId && edge.type === 'deploy_correlation',
    );
    for (const edge of correlationEdges) {
      score += 20;
      evidence.push({ kind: 'deploy_incident_correlation', weight: 20, detail: edge.ref });
    }

    // 4. 回滚/恢复后告警消失
    if (node.state === 'rolled_back' || /rollback|回滚/i.test(node.label ?? '')) {
      score += 15;
      evidence.push({ kind: 'rollback_recovery_signal', weight: 15, detail: '存在回滚动作' });
    }

    // 5. 聊天/日志中的根因提示词
    const text = `${node.label ?? ''} ${node.message ?? ''}`;
    if (ROOT_CAUSE_HINTS.some((hint) => text.toLowerCase().includes(hint.toLowerCase()))) {
      score += 10;
      evidence.push({ kind: 'text_hint', weight: 10, detail: '消息包含根因/回滚提示词' });
    }

    // 6. 被其它节点引用为参考
    const referenceCount = edges.filter(
      (edge) => edge.from === node.nodeId && edge.type === 'reference',
    ).length;
    if (referenceCount > 0) {
      const gained = Math.min(referenceCount * 5, 10);
      score += gained;
      evidence.push({ kind: 'referenced', weight: gained, detail: `被 ${referenceCount} 个节点引用` });
    }

    if (evidence.length === 0) continue;

    candidates.push({
      nodeId: node.nodeId,
      kind: node.kind,
      type: node.type,
      label: node.label,
      effectiveAt: node.effectiveAt,
      sources: node.sources,
      score: Math.min(score, 100),
      evidence,
      humanReviewRequired: true,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });

  return candidates.map((candidate, index) => ({ rank: index + 1, ...candidate }));
}
