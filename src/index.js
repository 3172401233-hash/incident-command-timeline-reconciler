import { normalizeEvent } from './time.js';
import { dedupe } from './dedupe.js';
import { buildStateMachines } from './state-machine.js';
import { buildCausalTimeline } from './causal.js';
import { findRootCauseCandidates } from './root-cause.js';
import { collectConflicts } from './conflicts.js';

/**
 * 重建事故时间线。
 * @param {Array<Record<string, unknown>>} rawEvents
 * @param {Record<string, unknown>} [config] 支持 clockOffsetsMs: { source: 毫秒偏移 }
 * @returns {object}
 */
export function reconstructTimeline(rawEvents, config = {}) {
  const normalized = (Array.isArray(rawEvents) ? rawEvents : []).map((raw, index) =>
    normalizeEvent(raw, index, config),
  );

  const { events: canonicalEvents, duplicates, conflictedGroups } = dedupe(normalized);
  const { actions, standaloneEvents } = buildStateMachines(canonicalEvents);
  const graph = buildCausalTimeline(actions, standaloneEvents);
  const nodeMap = new Map(graph.nodes.map((node) => [node.nodeId, node]));

  const timeline = graph.ordering.map((nodeId, position) => {
    const node = nodeMap.get(nodeId);
    return {
      position: position + 1,
      nodeId,
      kind: node.kind,
      actionKey: node.actionKey ?? null,
      type: node.type,
      state: node.state ?? null,
      label: node.label,
      effectiveAt: node.effectiveAt,
      endedAt: node.endedAt,
      interval: {
        start: node.effectiveAt,
        end: node.endedAt,
        startUnknown: node.startUnknown,
        endUnknown: node.endUnknown,
        unknown: node.startUnknown || node.endUnknown,
      },
      timeBasis: node.timeBasis,
      sources: node.sources,
      incidentRefs: node.incidentRefs,
      deployRefs: node.deployRefs,
      transitions: node.transitions ?? null,
      message: node.message ?? null,
      sender: node.sender ?? null,
    };
  });

  const openActions = [];
  for (const action of actions) {
    for (const episode of action.episodes) {
      if (episode.endedAt !== null) continue;
      openActions.push({
        actionKey: action.actionKey,
        episodeId: episode.episodeId,
        type: action.type,
        currentState: episode.currentState,
        startedAt: episode.startedAt,
        startUnknown: episode.startUnknown,
        endUnknown: true,
        sources: episode.sources,
        incidentRefs: episode.incidentRefs,
        deployRefs: episode.deployRefs,
      });
    }
  }

  const rootCauseCandidates = findRootCauseCandidates(graph);

  const conflicts = collectConflicts({
    actions,
    conflictedGroups,
    duplicates,
    timeCausalConflicts: graph.timeCausalConflicts,
    unresolvedRefs: graph.unresolvedRefs,
  });

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      inputCount: normalized.length,
      canonicalCount: canonicalEvents.length,
      duplicateCount: normalized.length - canonicalEvents.length,
      actionCount: actions.length,
      episodeCount: actions.reduce((total, action) => total + action.episodeCount, 0),
      openActionCount: openActions.length,
      conflictCount: conflicts.length,
      rootCauseCandidateCount: rootCauseCandidates.length,
    },
    timeline,
    duplicateMerges: duplicates,
    actions: actions.map((action) => ({
      actionKey: action.actionKey,
      type: action.type,
      open: action.open,
      episodeCount: action.episodeCount,
      episodes: action.episodes,
      stateConflicts: action.stateConflicts,
    })),
    openActions,
    rootCauseCandidates,
    conflicts,
    unresolvedRefs: graph.unresolvedRefs,
  };
}

export { normalizeEvent, parseTime } from './time.js';
export { dedupe } from './dedupe.js';
export { buildStateMachines } from './state-machine.js';
export { buildCausalTimeline } from './causal.js';
export { findRootCauseCandidates } from './root-cause.js';

export const DISCLAIMER =
  '根因候选仅为多源证据的自动聚合与排序，不构成事故结论，必须由人工结合完整上下文复核。';
