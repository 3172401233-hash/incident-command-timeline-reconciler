/**
 * 按动作键把同一动作的多次状态更新归并为有限状态机。
 * 告警与部署各自有合法流转顺序；乱序到达时仍按发生时间重放，
 * 非法或重复跃迁记录到 ignoredTransitions 与状态冲突中，不破坏时间线。
 */

const ALERT_FLOW = ['firing', 'acknowledged', 'resolved'];
const DEPLOY_FLOW = ['started', 'succeeded', 'failed'];
const DEPLOY_RECOVERY_STATES = new Set(['rolled_back']);
const TASK_FLOW = ['started', 'in_progress', 'completed', 'failed', 'cancelled'];

const FLOW_BY_TYPE = {
  alert: ALERT_FLOW,
  deploy: DEPLOY_FLOW,
  task: TASK_FLOW,
};

const TERMINAL_STATES = new Set(['resolved', 'succeeded', 'failed', 'rolled_back', 'completed', 'cancelled']);

/**
 * @param {Array<Record<string, unknown>>} events 去重后的权威事件
 * @returns {{actions: object[], standaloneEvents: object[]}}
 */
export function buildStateMachines(events) {
  const actionEvents = [];
  const standaloneEvents = [];

  for (const event of events) {
    if (FLOW_BY_TYPE[event.type]) {
      actionEvents.push({ ...event, actionKey: resolveActionKey(event) });
    } else {
      standaloneEvents.push(event);
    }
  }

  const byAction = new Map();
  for (const event of actionEvents) {
    const bucket = byAction.get(event.actionKey);
    if (bucket) bucket.push(event);
    else byAction.set(event.actionKey, [event]);
  }

  const actions = [];
  for (const [actionKey, members] of byAction) {
    members.sort(compareForReplay);
    normalizeReplayStart(actionKey, members);
    actions.push(replay(actionKey, members));
  }

  actions.sort((a, b) => {
    const ta = a.startedAt ?? Number.POSITIVE_INFINITY;
    const tb = b.startedAt ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.actionKey < b.actionKey ? -1 : a.actionKey > b.actionKey ? 1 : 0;
  });

  return { actions, standaloneEvents };
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function resolveActionKey(event) {
  if (event.actionKey) return event.actionKey;
  if (event.type === 'deploy' && event.deployRefs.length) {
    return `deploy:${event.deployRefs[0]}`;
  }
  if (event.incidentRefs.length) return `${event.type}:incident:${event.incidentRefs[0]}`;
  if (event.deployRefs.length) return `${event.type}:deploy:${event.deployRefs[0]}`;
  if (event.fingerprint) return `${event.type}:${event.fingerprint}`;
  return `${event.type}:${event.id}`;
}

/**
 * 重放顺序：有发生时间的按发生时间，未知时间排最后；同刻按 id 稳定排序。
 */
function compareForReplay(a, b) {
  const ta = a.effectiveAt === null ? Number.POSITIVE_INFINITY : a.effectiveAt;
  const tb = b.effectiveAt === null ? Number.POSITIVE_INFINITY : b.effectiveAt;
  if (ta !== tb) return ta - tb;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/**
 * 若按时间排在最前的事件不是状态机起始态（典型时钟漂移，回滚时间戳早于开始），
 * 把最早的起始态事件提升为重放起点；被越过的事件保留原位，重放时按非法/恢复跃迁记录。
 * @param {string} actionKey
 * @param {Array<Record<string, unknown>>} members 已按时间排序，原地调整
 */
function normalizeReplayStart(actionKey, members) {
  const type = members[0].type;
  const flow = FLOW_BY_TYPE[type];
  const startStatus = flow[0];
  if ((members[0].status ?? startStatus) === startStatus) return;

  const startIndex = members.findIndex((member) => (member.status ?? startStatus) === startStatus);
  if (startIndex <= 0) return;

  const [startEvent] = members.splice(startIndex, 1);
  members.unshift({
    ...startEvent,
    promotedAsStart: true,
    displacedEvents: members.slice(0, startIndex).map((member) => member.id),
  });
}

/**
 * @param {string} actionKey
 * @param {Array<Record<string, unknown>>} members
 */
function replay(actionKey, members) {
  const type = members[0].type;
  const flow = FLOW_BY_TYPE[type];
  const episodes = [];
  const stateConflicts = [];
  let current = null;

  const openEpisode = (event) => {
    current = {
      episodeId: `${actionKey}#${episodes.length + 1}`,
      actionKey,
      type,
      currentState: flow[0],
      startEventId: event.id,
      endEventId: null,
      startedAt: event.effectiveAt,
      endedAt: null,
      startUnknown: event.timeBasis === 'unknown',
      endUnknown: false,
      transitions: [transitionRecord(event, 'enter')],
      sources: new Set([event.source]),
      incidentRefs: new Set(event.incidentRefs),
      deployRefs: new Set(event.deployRefs),
      ignoredTransitions: [],
    };
    episodes.push(current);
  };

  for (const event of members) {
    const status = event.status ?? flow[0];

    if (current === null) {
      openEpisode(event);
      continue;
    }

    // 告警 resolved 后再次 firing：新分段（恢复后再次告警）
    if (type === 'alert' && status === 'firing' && current.currentState === 'resolved') {
      current.endUnknown = current.endedAt === null;
      openEpisode(event);
      continue;
    }

    const fromIndex = flow.indexOf(current.currentState);
    const toIndex = flow.indexOf(status);

    if (toIndex === -1) {
      // 回滚属于恢复动作，可从部署任意状态进入
      if (type === 'deploy' && DEPLOY_RECOVERY_STATES.has(status)) {
        current.currentState = status;
        current.transitions.push(transitionRecord(event, 'transition'));
        current.sources.add(event.source);
        mergeRefs(current, event);
        current.endedAt = event.effectiveAt;
        current.endEventId = event.id;
        current.endUnknown = event.timeBasis === 'unknown';
        continue;
      }
      current.ignoredTransitions.push({
        eventId: event.id,
        status,
        reason: 'unknown_status',
      });
      stateConflicts.push(conflictRecord(current, event, 'unknown_status'));
      continue;
    }

    if (toIndex < fromIndex) {
      current.ignoredTransitions.push({
        eventId: event.id,
        status,
        reason: 'backward_transition',
        from: current.currentState,
      });
      stateConflicts.push(conflictRecord(current, event, 'backward_transition'));
      continue;
    }

    if (toIndex === fromIndex) {
      // 重复状态更新：归并而不是新建动作
      current.ignoredTransitions.push({
        eventId: event.id,
        status,
        reason: 'duplicate_state_update',
      });
      current.sources.add(event.source);
      mergeRefs(current, event);
      continue;
    }

    current.currentState = status;
    current.transitions.push(transitionRecord(event, 'transition'));
    current.sources.add(event.source);
    mergeRefs(current, event);

    if (TERMINAL_STATES.has(status)) {
      current.endedAt = event.effectiveAt;
      current.endEventId = event.id;
      current.endUnknown = event.timeBasis === 'unknown';
    }
  }

  if (current && current.endedAt === null) {
    current.endUnknown = true;
  }

  const plainEpisodes = episodes.map((episode) => ({
    ...episode,
    sources: [...episode.sources],
    incidentRefs: [...episode.incidentRefs],
    deployRefs: [...episode.deployRefs],
  }));

  return {
    actionKey,
    type,
    episodeCount: plainEpisodes.length,
    episodes: plainEpisodes,
    stateConflicts,
    open: plainEpisodes.some((episode) => episode.endedAt === null),
  };
}

/**
 * @param {Record<string, unknown>} event
 * @param {string} kind
 */
function transitionRecord(event, kind) {
  return {
    eventId: event.id,
    state: event.status,
    at: event.effectiveAt,
    timeBasis: event.timeBasis,
    source: event.source,
    refs: event.refs,
    causalRefs: event.causalRefs,
    deployRefs: event.deployRefs,
    incidentRefs: event.incidentRefs,
    kind,
  };
}

/**
 * @param {object} episode
 * @param {Record<string, unknown>} event
 * @param {string} reason
 */
function conflictRecord(episode, event, reason) {
  return {
    actionKey: episode.actionKey,
    episodeId: episode.episodeId,
    eventId: event.id,
    currentState: episode.currentState,
    attemptedState: event.status,
    reason,
    at: event.effectiveAt,
  };
}

/**
 * @param {object} episode
 * @param {Record<string, unknown>} event
 */
function mergeRefs(episode, event) {
  for (const ref of event.incidentRefs) episode.incidentRefs.add(ref);
  for (const ref of event.deployRefs) episode.deployRefs.add(ref);
}
