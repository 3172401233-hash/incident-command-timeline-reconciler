import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructTimeline } from '../src/index.js';

const T = (value) => new Date(value).getTime();

test('时间戳乱序：恢复动作时间戳早于触发原因时，因果引用决定最终顺序', () => {
  const result = reconstructTimeline([
    {
      id: 'a1',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T02:00:00Z',
      receivedAt: '2026-11-19T02:00:05Z',
      incidentRefs: ['INC-1'],
      deployRefs: ['D-1'],
      message: '5xx 激增',
    },
    {
      id: 'd1',
      source: 'deploy',
      type: 'deploy',
      status: 'started',
      occurredAt: '2026-11-19T01:58:00Z',
      receivedAt: '2026-11-19T02:00:30Z',
      deployRefs: ['D-1'],
      incidentRefs: ['INC-1'],
      message: '发布 payment-service',
    },
    {
      id: 'd2',
      source: 'deploy',
      type: 'deploy',
      status: 'rolled_back',
      // 漂移时钟：发生时间戳反而早于发布开始
      occurredAt: '2026-11-19T01:57:00Z',
      receivedAt: '2026-11-19T02:05:00Z',
      deployRefs: ['D-1'],
      incidentRefs: ['INC-1'],
      causalRefs: ['a1'],
      message: '回滚 payment-service',
    },
    {
      id: 'a2',
      source: 'alerting',
      type: 'alert',
      status: 'resolved',
      occurredAt: '2026-11-19T02:06:00Z',
      receivedAt: '2026-11-19T02:06:10Z',
      incidentRefs: ['INC-1'],
      deployRefs: ['D-1'],
      causalRefs: ['d2'],
      message: '5xx 恢复',
    },
  ]);

  const ids = result.timeline.map((item) => item.nodeId);
  const deployNode = ids.find((id) => id.startsWith('node:deploy:D-1'));
  const alertNode = ids.find((id) => id.startsWith('node:alert:incident:INC-1'));
  assert.ok(ids.indexOf(deployNode) < ids.indexOf(alertNode), '部署先于告警');
  // 部署动作只有一个分段（started -> rolled_back 已归并），告警分段在其后
  assert.ok(ids.indexOf(alertNode) > ids.indexOf(deployNode), '告警在部署分段之后（因果覆盖漂移时间戳）');

  const inversion = result.conflicts.find((item) => item.kind === 'causal_time_inversion');
  assert.ok(inversion, '应登记因果/时间倒置冲突');
  assert.equal(inversion.resolution, 'causal_edge_wins');
});

test('时钟差异：clockOffsetsMs 校正来源时钟后顺序恢复正常', () => {
  const result = reconstructTimeline(
    [
      {
        id: 'x1',
        source: 'chat',
        type: 'chat',
        occurredAt: '2026-11-19T02:10:00Z',
        message: '团队开始排查',
      },
      {
        id: 'x2',
        source: 'lagging-log',
        type: 'log',
        // 该来源时钟慢了 5 分钟，实际发生在 02:08
        occurredAt: '2026-11-19T02:03:00Z',
        message: '错误日志首次出现',
      },
    ],
    {
      clockOffsetsMs: {
        'lagging-log': -5 * 60 * 1000,
      },
    },
  );

  const logNode = result.timeline.find((item) => item.nodeId === 'node:x2');
  assert.equal(logNode.effectiveAt, T('2026-11-19T02:08:00Z'));
  assert.equal(result.timeline[0].nodeId, 'node:x2', '校正后日志先于聊天');
});

test('重复消息：同 duplicateKey 只计数一次，权威记录选择可追溯', () => {
  const result = reconstructTimeline([
    {
      id: 'm1',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T03:00:00Z',
      receivedAt: '2026-11-19T03:00:01Z',
      duplicateKey: 'alert-42',
      incidentRefs: ['INC-2'],
      message: '数据库连接池耗尽',
    },
    {
      id: 'm2',
      source: 'chat-bridge',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T03:00:00Z',
      receivedAt: '2026-11-19T03:00:20Z',
      duplicateKey: 'alert-42',
      message: '数据库连接池耗尽（转发）',
    },
    {
      id: 'm3',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T03:00:05Z',
      receivedAt: '2026-11-19T03:00:30Z',
      duplicateKey: 'alert-42',
      message: '数据库连接池耗尽（重发）',
    },
  ]);

  assert.equal(result.summary.inputCount, 3);
  assert.equal(result.summary.canonicalCount, 1);
  assert.equal(result.summary.duplicateCount, 2);
  assert.equal(result.duplicateMerges[0].canonicalId, 'm1');
  assert.deepEqual(result.duplicateMerges[0].duplicateIds, ['m2', 'm3']);
  assert.equal(result.timeline.length, 1);
});

test('部署与故障关联：部署分段通过引用成为告警的上游证据并进入根因候选', () => {
  const result = reconstructTimeline([
    {
      id: 'dep1',
      source: 'deploy',
      type: 'deploy',
      status: 'started',
      occurredAt: '2026-11-19T04:00:00Z',
      deployRefs: ['D-9'],
      incidentRefs: ['INC-3'],
      message: '发布 order-service v2.3',
    },
    {
      id: 'dep2',
      source: 'deploy',
      type: 'deploy',
      status: 'failed',
      occurredAt: '2026-11-19T04:02:00Z',
      deployRefs: ['D-9'],
      incidentRefs: ['INC-3'],
      message: '健康检查失败',
    },
    {
      id: 'al1',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T04:03:00Z',
      deployRefs: ['D-9'],
      incidentRefs: ['INC-3'],
      message: '下单接口错误率升高',
    },
  ]);

  const deployAction = result.actions.find((action) => action.actionKey === 'deploy:D-9');
  assert.ok(deployAction, '部署事件按动作键归并为一个动作');
  assert.equal(deployAction.episodes[0].currentState, 'failed');

  const topCandidate = result.rootCauseCandidates[0];
  assert.ok(topCandidate);
  assert.equal(topCandidate.type, 'deploy');
  assert.ok(topCandidate.evidence.some((item) => item.kind === 'deploy_incident_correlation'));
  assert.equal(topCandidate.humanReviewRequired, true);
});

test('恢复后再次告警：同一动作产生两个分段，未结束分段保持打开', () => {
  const result = reconstructTimeline([
    {
      id: 'f1',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T05:00:00Z',
      actionKey: 'alert-cpu',
      message: 'CPU 使用率 > 95%',
    },
    {
      id: 'r1',
      source: 'alerting',
      type: 'alert',
      status: 'resolved',
      occurredAt: '2026-11-19T05:10:00Z',
      actionKey: 'alert-cpu',
      message: 'CPU 恢复',
    },
    {
      id: 'f2',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T05:30:00Z',
      actionKey: 'alert-cpu',
      message: 'CPU 使用率再次 > 95%',
    },
  ]);

  const action = result.actions.find((item) => item.actionKey === 'alert-cpu');
  assert.equal(action.episodeCount, 2);
  assert.equal(action.episodes[0].currentState, 'resolved');
  assert.equal(action.episodes[0].endedAt, T('2026-11-19T05:10:00Z'));
  assert.equal(action.episodes[1].currentState, 'firing');
  assert.equal(action.episodes[1].endedAt, null);

  assert.equal(result.openActions.length, 1);
  assert.equal(result.openActions[0].episodeId, 'alert-cpu#2');
  assert.equal(result.openActions[0].endUnknown, true);
});

test('多来源冲突：重复状态更新归并、非法跃迁登记、缺失时间标记未知区间', () => {
  const result = reconstructTimeline([
    {
      id: 't1',
      source: 'ci',
      type: 'task',
      status: 'started',
      occurredAt: '2026-11-19T06:00:00Z',
      actionKey: 'restart-db',
      message: '开始重启数据库',
    },
    {
      id: 't1-dup',
      source: 'chat',
      type: 'task',
      status: 'started',
      occurredAt: '2026-11-19T06:00:02Z',
      actionKey: 'restart-db',
      message: '开始重启数据库（人工确认）',
    },
    {
      id: 't2',
      source: 'ci',
      type: 'task',
      status: 'completed',
      occurredAt: '2026-11-19T06:05:00Z',
      actionKey: 'restart-db',
      message: '重启完成',
    },
    {
      id: 't3',
      source: 'ci',
      type: 'task',
      status: 'in_progress',
      occurredAt: '2026-11-19T06:06:00Z',
      actionKey: 'restart-db',
      message: '迟到的进度更新',
    },
    {
      id: 'z1',
      source: 'logs',
      type: 'alert',
      status: 'firing',
      // 没有 occurredAt 也没有 receivedAt
      actionKey: 'ghost-alert',
      message: '时间戳缺失的告警',
    },
  ]);

  const task = result.actions.find((item) => item.actionKey === 'restart-db');
  const episode = task.episodes[0];
  assert.equal(episode.currentState, 'completed');
  assert.ok(
    episode.ignoredTransitions.some((item) => item.eventId === 't1-dup' && item.reason === 'duplicate_state_update'),
  );
  assert.ok(
    episode.ignoredTransitions.some(
      (item) => item.eventId === 't3' && ['backward_transition', 'late_update_after_terminal'].includes(item.reason),
    ),
  );
  assert.ok(result.conflicts.some((item) => item.kind === 'state_machine_conflict'));

  const ghost = result.actions.find((item) => item.actionKey === 'ghost-alert');
  assert.equal(ghost.episodes[0].startedAt, null);
  assert.equal(ghost.episodes[0].startUnknown, true);
  assert.equal(ghost.episodes[0].endUnknown, true);

  const ghostTimeline = result.timeline.find((item) => item.actionKey === 'ghost-alert');
  assert.equal(ghostTimeline.interval.unknown, true);
  assert.equal(ghostTimeline.timeBasis, 'unknown');
});

test('接收时间只是辅助：发生时间缺失时才回退，且不覆盖因果引用', () => {
  const result = reconstructTimeline([
    {
      id: 'c1',
      source: 'chat',
      type: 'chat',
      // 只有接收时间
      receivedAt: '2026-11-19T07:02:00Z',
      message: '人工记录：先看到告警再回滚',
      causalRefs: ['g1'],
    },
    {
      id: 'g1',
      source: 'alerting',
      type: 'alert',
      status: 'firing',
      occurredAt: '2026-11-19T07:05:00Z',
      receivedAt: '2026-11-19T07:05:01Z',
      message: '网关超时',
    },
  ]);

  const chatNode = result.timeline.find((item) => item.nodeId === 'node:c1');
  assert.equal(chatNode.timeBasis, 'received');
  assert.equal(chatNode.effectiveAt, T('2026-11-19T07:02:00Z'));

  const ids = result.timeline.map((item) => item.nodeId);
  assert.ok(ids.indexOf('node:g1#1') < ids.indexOf('node:c1'), '因果引用让 g1 排在 c1 前面');
  assert.ok(result.conflicts.some((item) => item.kind === 'causal_time_inversion'));
});

test('缺失结束事件：分段保持打开并标记未知区间，摘要可统计未关闭动作', () => {
  const result = reconstructTimeline([
    {
      id: 'p1',
      source: 'ci',
      type: 'task',
      status: 'started',
      occurredAt: '2026-11-19T09:00:00Z',
      actionKey: 'migration',
      message: '开始数据迁移',
    },
    {
      id: 'p2',
      source: 'ci',
      type: 'task',
      status: 'in_progress',
      occurredAt: '2026-11-19T09:20:00Z',
      actionKey: 'migration',
      message: '迁移进行中，之后再无结束事件',
    },
  ]);

  const action = result.actions.find((item) => item.actionKey === 'migration');
  assert.equal(action.open, true);
  assert.equal(action.episodes[0].endedAt, null);
  assert.equal(action.episodes[0].endUnknown, true);
  assert.equal(result.summary.openActionCount, 1);

  const timelineNode = result.timeline.find((item) => item.actionKey === 'migration');
  assert.equal(timelineNode.interval.start, T('2026-11-19T09:00:00Z'));
  assert.equal(timelineNode.interval.end, null);
  assert.equal(timelineNode.interval.unknown, true);
});

test('漂移回滚时间戳早于开始：起始态提升后仍能正常走到 rolled_back 并关闭', () => {
  const result = reconstructTimeline([
    {
      id: 's1',
      source: 'deploy',
      type: 'deploy',
      status: 'started',
      occurredAt: '2026-11-19T10:00:00Z',
      deployRefs: ['D-55'],
      message: '发布开始',
    },
    {
      id: 'r1',
      source: 'deploy',
      type: 'deploy',
      status: 'rolled_back',
      occurredAt: '2026-11-19T09:55:00Z',
      receivedAt: '2026-11-19T10:08:00Z',
      deployRefs: ['D-55'],
      message: '时钟漂移的回滚记录',
    },
  ]);

  const action = result.actions.find((item) => item.actionKey === 'deploy:D-55');
  assert.equal(action.episodes[0].currentState, 'rolled_back');
  assert.equal(action.open, false);
  assert.deepEqual(
    action.episodes[0].transitions.map((transition) => transition.state),
    ['started', 'rolled_back'],
  );
  assert.equal(result.openActions.length, 0);
});
