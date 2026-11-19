/**
 * 构建证据关系图并做稳定拓扑排序。
 * 因果边（causalRefs / deploy 关联 / 同事故引用）优先于发生时间：
 * 即使恢复动作的时间戳早于触发原因，拓扑顺序仍以因果引用为准，
 * 同时把被覆盖的时间顺序登记为冲突片段。
 */

/**
 * @typedef {object} GraphNode
 * @property {string} nodeId
 * @property {'episode'|'event'} kind
 * @property {number|null} effectiveAt
 * @property {string} timeBasis
 * @property {string[]} sources
 * @property {string[]} incidentRefs
 * @property {string[]} deployRefs
 * @property {string[]} refs
 * @property {string[]} causalRefs
 */

/**
 * @param {object[]} actions
 * @param {object[]} standaloneEvents
 * @returns {{nodes: GraphNode[], edges: object[], ordering: string[], cycles: string[][], unresolvedRefs: object[], timeCausalConflicts: object[]}}
 */
export function buildCausalTimeline(actions, standaloneEvents) {
  const nodes = [];
  const addNode = (node) => {
    nodes.push(node);
    return node.nodeId;
  };

  for (const action of actions) {
    for (const episode of action.episodes) {
      const memberRefs = unique(episode.transitions.flatMap((transition) => transition.refs ?? []));
      const memberCausalRefs = unique(
        episode.transitions.flatMap((transition) => transition.causalRefs ?? []),
      );
      addNode({
        nodeId: `node:${episode.episodeId}`,
        episodeId: episode.episodeId,
        actionKey: action.actionKey,
        kind: 'episode',
        type: action.type,
        state: episode.currentState,
        label: `${action.type}:${action.actionKey}:${episode.currentState}`,
        effectiveAt: episode.startedAt,
        endedAt: episode.endedAt,
        startUnknown: episode.startUnknown,
        endUnknown: episode.endUnknown,
        timeBasis: episode.transitions[0]?.timeBasis ?? 'unknown',
        sources: episode.sources,
        incidentRefs: episode.incidentRefs,
        deployRefs: episode.deployRefs,
        refs: memberRefs,
        causalRefs: memberCausalRefs,
        memberEventIds: episode.transitions.map((transition) => transition.eventId),
        transitions: episode.transitions,
      });
    }
  }

  for (const event of standaloneEvents) {
    addNode({
      nodeId: `node:${event.id}`,
      eventId: event.id,
      kind: 'event',
      type: event.type,
      state: event.status,
      label: event.message || event.id,
      effectiveAt: event.effectiveAt,
      endedAt: null,
      startUnknown: event.timeBasis === 'unknown',
      endUnknown: false,
      timeBasis: event.timeBasis,
      sources: [event.source],
      incidentRefs: event.incidentRefs,
      deployRefs: event.deployRefs,
      refs: event.refs,
      causalRefs: event.causalRefs,
      message: event.message,
      sender: event.sender,
    });
  }

  const index = buildIndex(nodes);
  const edges = [];
  const unresolvedRefs = [];
  const addEdge = (fromId, toId, type, weight, detail = {}) => {
    if (fromId === toId) return;
    if (edges.some((edge) => edge.from === fromId && edge.to === toId && edge.type === type)) return;
    edges.push({ from: fromId, to: toId, type, weight, ...detail });
  };

  for (const node of nodes) {
    for (const refId of node.causalRefs) {
      const target = index.event.get(refId) ?? index.episode.get(refId);
      if (!target) {
        unresolvedRefs.push({ nodeId: node.nodeId, ref: refId, kind: 'causal' });
        continue;
      }
      addEdge(target, node.nodeId, 'causal', 100, { ref: refId });
    }

    for (const refId of node.refs) {
      const target = index.event.get(refId) ?? index.episode.get(refId);
      if (!target) {
        unresolvedRefs.push({ nodeId: node.nodeId, ref: refId, kind: 'ref' });
        continue;
      }
      addEdge(target, node.nodeId, 'reference', 60, { ref: refId });
    }

    // 部署关联：节点引用了某 deploy，而存在对应的部署分段
    for (const deployRef of node.deployRefs) {
      const target = index.deploy.get(deployRef);
      if (target) addEdge(target, node.nodeId, 'deploy_correlation', 80, { ref: deployRef });
    }

    // 告警分段反向指向它所关联的部署（故障由部署引发的证据链）
    if (node.type === 'alert' && node.deployRefs.length) {
      for (const deployRef of node.deployRefs) {
        const target = index.deploy.get(deployRef);
        if (target) addEdge(target, node.nodeId, 'deploy_correlation', 80, { ref: deployRef });
      }
    }
  }

  // 同一 incident 下：部署/日志证据先于告警，告警先于恢复动作
  for (const incidentId of index.incident.keys()) {
    const members = index.incident.get(incidentId);
    const byType = new Map();
    for (const nodeId of members) {
      const node = nodes.find((candidate) => candidate.nodeId === nodeId);
      if (!byType.has(node.type)) byType.set(node.type, []);
      byType.get(node.type).push(nodeId);
    }
    const deploys = byType.get('deploy') ?? [];
    const alerts = byType.get('alert') ?? [];
    for (const deployId of deploys) {
      for (const alertId of alerts) addEdge(deployId, alertId, 'incident_group', 30, { ref: incidentId });
    }
  }

  const { ordering, cycles, removedEdges } = topoSort(nodes, edges);

  const timeCausalConflicts = [];
  const conflictKeys = new Set();
  const recordConflict = (conflict) => {
    const key = `${conflict.type}:${conflict.edgeType ?? ''}:${conflict.earlierByCausality?.nodeId ?? conflict.edge?.from}->${
      conflict.laterByCausality?.nodeId ?? conflict.edge?.to
    }`;
    if (conflictKeys.has(key)) return;
    conflictKeys.add(key);
    timeCausalConflicts.push(conflict);
  };

  for (const conflict of detectTimeCausalConflicts(nodes, edges)) recordConflict(conflict);
  for (const edge of removedEdges) {
    if (isTimeInversion(nodes, edge)) {
      recordConflict({
        type: 'causal_time_inversion',
        edgeType: edge.type,
        earlierByCausality: {
          nodeId: edge.from,
          effectiveAt: nodeTime(nodes, edge.from),
          timeBasis: nodeBasis(nodes, edge.from),
          sources: nodeSources(nodes, edge.from),
        },
        laterByCausality: {
          nodeId: edge.to,
          effectiveAt: nodeTime(nodes, edge.to),
          timeBasis: nodeBasis(nodes, edge.to),
          sources: nodeSources(nodes, edge.to),
        },
        skewMs: nodeTime(nodes, edge.from) - nodeTime(nodes, edge.to),
        resolution: 'causal_edge_wins',
      });
    } else {
      recordConflict({
        type: 'cycle_broken',
        edge,
        reason: 'causal_edge_cycle',
      });
    }
  }
  for (const edge of removedEdges) {
    timeCausalConflicts.push({
      type: 'cycle_broken',
      edge,
      reason: 'causal_edge_cycle',
    });
  }

  return { nodes, edges, ordering, cycles, unresolvedRefs, timeCausalConflicts };
}

/**
 * @param {GraphNode[]} nodes
 */
function buildIndex(nodes) {
  const event = new Map();
  const episode = new Map();
  const deploy = new Map();
  const incident = new Map();

  for (const node of nodes) {
    if (node.kind === 'event') event.set(node.eventId, node.nodeId);
    if (node.kind === 'episode') {
      episode.set(node.episodeId, node.nodeId);
      for (const eventId of node.memberEventIds ?? []) event.set(eventId, node.nodeId);
      if (node.type === 'deploy') {
        for (const deployRef of node.deployRefs) deploy.set(deployRef, node.nodeId);
      }
    }
    for (const incidentRef of node.incidentRefs) {
      if (!incident.has(incidentRef)) incident.set(incidentRef, []);
      incident.get(incidentRef).push(node.nodeId);
    }
  }
  return { event, episode, deploy, incident };
}

/**
 * Kahn 拓扑排序；同层用“时间 + nodeId”稳定打破平局。
 * 环上的低权重边被移除并记录，每次破环后完整重跑，保证产出完整顺序。
 * @param {GraphNode[]} nodes
 * @param {object[]} edges
 */
function topoSort(nodes, edges) {
  const activeEdges = edges.map((edge) => ({ ...edge, active: true }));
  const cycles = [];
  const removedEdges = [];

  const runOnce = () => {
    const adjacency = new Map(nodes.map((node) => [node.nodeId, []]));
    const indegree = new Map(nodes.map((node) => [node.nodeId, 0]));
    for (const edge of activeEdges) {
      if (!edge.active) continue;
      adjacency.get(edge.from)?.push(edge);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }

    const result = [];
    const ready = [];
    for (const [nodeId, degree] of indegree) {
      if (degree === 0) ready.push(nodeId);
    }

    while (ready.length) {
      ready.sort(readyComparator(nodes));
      const nodeId = ready.shift();
      result.push(nodeId);
      for (const edge of adjacency.get(nodeId) ?? []) {
        const next = indegree.get(edge.to) - 1;
        indegree.set(edge.to, next);
        if (next === 0) ready.push(edge.to);
      }
    }
    return result;
  };

  let ordering = runOnce();
  while (ordering.length < nodes.length) {
    const placed = new Set(ordering);
    const cycleEdges = activeEdges.filter(
      (edge) => edge.active && !placed.has(edge.from) && !placed.has(edge.to),
    );
    if (cycleEdges.length === 0) break;
    cycleEdges.sort((a, b) => a.weight - b.weight || edgeIdComparator(a, b));
    const victim = cycleEdges[0];
    victim.active = false;
    removedEdges.push({ from: victim.from, to: victim.to, type: victim.type, weight: victim.weight });
    cycles.push(traceCycle(nodes, activeEdges, victim));
    ordering = runOnce();
  }

  return { ordering, cycles, removedEdges };
}

/**
 * 从被移除边的起点沿活跃边回溯，输出环上的节点序列，便于人工核对。
 * @param {GraphNode[]} nodes
 * @param {object[]} activeEdges
 * @param {object} victim
 * @returns {string[]}
 */
function traceCycle(nodes, activeEdges, victim) {
  const adjacency = new Map(nodes.map((node) => [node.nodeId, []]));
  for (const edge of activeEdges) {
    if (edge.active) adjacency.get(edge.from)?.push(edge.to);
  }
  const path = [victim.from];
  const visited = new Set([victim.from]);
  let current = victim.to;
  while (current !== victim.from && !visited.has(current)) {
    visited.add(current);
    path.push(current);
    current = adjacency.get(current)?.[0];
    if (current === undefined) break;
  }
  path.push(victim.from);
  return path;
}

/**
 * 同层节点排序：有效时间未知排最后，再按 nodeId。
 */
function readyComparator(nodes) {
  const lookup = new Map(nodes.map((node) => [node.nodeId, node]));
  return (a, b) => {
    const na = lookup.get(a);
    const nb = lookup.get(b);
    const ta = na.effectiveAt === null ? Number.POSITIVE_INFINITY : na.effectiveAt;
    const tb = nb.effectiveAt === null ? Number.POSITIVE_INFINITY : nb.effectiveAt;
    if (ta !== tb) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/**
 * @param {object} a
 * @param {object} b
 */
function edgeIdComparator(a, b) {
  const keyA = `${a.from}->${a.to}`;
  const keyB = `${b.from}->${b.to}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * 因果边要求 from 先于 to；若发生时间相反，说明时间戳漂移，登记冲突。
 * @param {GraphNode[]} nodes
 * @param {object[]} edges
 */
function detectTimeCausalConflicts(nodes, edges) {
  const lookup = new Map(nodes.map((node) => [node.nodeId, node]));
  const conflicts = [];
  for (const edge of edges) {
    if (!['causal', 'deploy_correlation', 'incident_group', 'reference'].includes(edge.type)) continue;
    if (!isTimeInversion(nodes, edge)) continue;
    const from = lookup.get(edge.from);
    const to = lookup.get(edge.to);
    conflicts.push({
      type: 'causal_time_inversion',
      edgeType: edge.type,
      earlierByCausality: {
        nodeId: from.nodeId,
        effectiveAt: from.effectiveAt,
        timeBasis: from.timeBasis,
        sources: from.sources,
      },
      laterByCausality: {
        nodeId: to.nodeId,
        effectiveAt: to.effectiveAt,
        timeBasis: to.timeBasis,
        sources: to.sources,
      },
      skewMs: from.effectiveAt - to.effectiveAt,
      resolution: 'causal_edge_wins',
    });
  }
  return conflicts;
}

/**
 * @param {GraphNode[]} nodes
 * @param {object} edge
 * @returns {boolean}
 */
function isTimeInversion(nodes, edge) {
  const lookup = new Map(nodes.map((node) => [node.nodeId, node]));
  const from = lookup.get(edge.from);
  const to = lookup.get(edge.to);
  if (!from || !to) return false;
  if (from.effectiveAt === null || to.effectiveAt === null) return false;
  return to.effectiveAt < from.effectiveAt;
}

/**
 * @param {GraphNode[]} nodes
 * @param {string} nodeId
 * @returns {number|null}
 */
function nodeTime(nodes, nodeId) {
  return nodes.find((node) => node.nodeId === nodeId)?.effectiveAt ?? null;
}

/**
 * @param {GraphNode[]} nodes
 * @param {string} nodeId
 * @returns {string}
 */
function nodeBasis(nodes, nodeId) {
  return nodes.find((node) => node.nodeId === nodeId)?.timeBasis ?? 'unknown';
}

/**
 * @param {GraphNode[]} nodes
 * @param {string} nodeId
 * @returns {string[]}
 */
function nodeSources(nodes, nodeId) {
  return nodes.find((node) => node.nodeId === nodeId)?.sources ?? [];
}
