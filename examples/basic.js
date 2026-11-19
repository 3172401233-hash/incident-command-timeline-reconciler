import { reconstructTimeline, DISCLAIMER } from '../src/index.js';

const events = [
  {
    id: 'deploy-1',
    source: 'deploy-system',
    type: 'deploy',
    status: 'started',
    occurredAt: '2026-11-19T08:00:00Z',
    receivedAt: '2026-11-19T08:00:02Z',
    deployRefs: ['D-100'],
    incidentRefs: ['INC-77'],
    message: '发布 checkout-service v4.2',
  },
  {
    id: 'alert-1',
    source: 'alerting',
    type: 'alert',
    status: 'firing',
    occurredAt: '2026-11-19T08:03:00Z',
    receivedAt: '2026-11-19T08:03:01Z',
    duplicateKey: 'checkout-5xx',
    deployRefs: ['D-100'],
    incidentRefs: ['INC-77'],
    message: 'checkout 5xx 错误率 > 20%',
  },
  {
    id: 'alert-1-copy',
    source: 'chat-bridge',
    type: 'alert',
    status: 'firing',
    occurredAt: '2026-11-19T08:03:00Z',
    receivedAt: '2026-11-19T08:03:30Z',
    duplicateKey: 'checkout-5xx',
    message: 'checkout 5xx（聊天转发）',
  },
  {
    id: 'chat-1',
    source: 'chat',
    type: 'chat',
    occurredAt: '2026-11-19T08:05:00Z',
    incidentRefs: ['INC-77'],
    deployRefs: ['D-100'],
    message: '怀疑本次发布导致，准备回滚',
  },
  {
    id: 'rollback-1',
    source: 'deploy-system',
    type: 'deploy',
    status: 'rolled_back',
    // 漂移时钟：时间戳早于发布开始
    occurredAt: '2026-11-19T07:59:00Z',
    receivedAt: '2026-11-19T08:08:00Z',
    deployRefs: ['D-100'],
    incidentRefs: ['INC-77'],
    causalRefs: ['alert-1'],
    message: '回滚 checkout-service',
  },
  {
    id: 'alert-2',
    source: 'alerting',
    type: 'alert',
    status: 'resolved',
    occurredAt: '2026-11-19T08:10:00Z',
    receivedAt: '2026-11-19T08:10:05Z',
    incidentRefs: ['INC-77'],
    causalRefs: ['rollback-1'],
    message: 'checkout 5xx 恢复',
  },
];

const report = reconstructTimeline(events, {
  clockOffsetsMs: {
    'deploy-system': 0,
  },
});

console.log('== 摘要 ==');
console.log(report.summary);
console.log('\n== 稳定时间线 ==');
for (const item of report.timeline) {
  console.log(`${item.position}. [${item.kind}] ${item.nodeId} @ ${item.effectiveAt ?? '未知时间'}`);
}
console.log('\n== 重复合并 ==');
console.log(report.duplicateMerges);
console.log('\n== 未关闭动作 ==');
console.log(report.openActions);
console.log('\n== 根因候选（证据聚合） ==');
console.log(report.rootCauseCandidates);
console.log('\n== 冲突片段 ==');
console.log(report.conflicts);
console.log(`\n${DISCLAIMER}`);
