# incident-command-timeline-reconciler

合并多源事故事件并重建因果时间线与未决动作。

面向事故期间来自告警系统、聊天工具、部署记录和日志平台的混杂事件：时间戳会漂移、消息会重复、结束事件可能缺失，单纯按接收时间或发生时间排序经常把“恢复动作”排到触发原因之前。本工具按因果引用与证据关系合并事件，输出稳定、可追溯的时间线。

## 运行环境

- Node.js `24.16.0`（纯 ESM，无第三方依赖）
- 执行测试：`node --test`
- 运行示例：`node examples/basic.js`

## 快速开始

```js
import { reconstructTimeline } from './src/index.js';

const report = reconstructTimeline(rawEvents, {
  clockOffsetsMs: { 'lagging-log': -5 * 60 * 1000 },
});
```

## 输入事件字段

| 字段 | 说明 |
| --- | --- |
| `id` | 事件唯一标识，缺失时按输入顺序生成 |
| `source` | 来源系统，如 `alerting`、`chat`、`deploy-system` |
| `type` | `alert` / `deploy` / `task` 走状态机；`chat`、`log` 等作为独立证据事件 |
| `status` | 状态机状态，如告警 `firing`/`acknowledged`/`resolved`，部署 `started`/`succeeded`/`failed`/`rolled_back` |
| `occurredAt` | 来源系统记录的发生时间（ISO 字符串或毫秒/秒时间戳） |
| `receivedAt` | 本系统接收时间，仅在发生时间缺失时作为辅助回退，并通过 `timeBasis` 标记 |
| `sender` / `message` | 发送者与正文 |
| `actionKey` | 显式动作键；缺失时按 `incidentRefs`、`deployRefs`、`fingerprint` 回退推导 |
| `fingerprint` / `duplicateKey` | 重复判定键，`duplicateKey` 优先 |
| `incidentRefs` / `deployRefs` | 关联事故与部署引用 |
| `causalRefs` | 显式因果引用，目标事件 id；在排序中权重最高 |
| `refs` | 一般性证据引用 |

`config.clockOffsetsMs` 声明各来源时钟相对统一时钟的偏移毫秒数（来源时钟偏快为正值），归一化时从发生时间中扣除。

## 处理流程

1. **时间归一化**（`src/time.js`）：解析时间、应用来源时钟偏移；发生时间缺失才回退接收时间，两者都缺则标记 `timeBasis: 'unknown'`。
2. **重复合并**（`src/dedupe.js`）：按 `duplicateKey` / `fingerprint` 分组，每组保留一条权威记录（发生时间最早，其次接收最早，再按 id），重复事件不重复计数；组内时间或状态矛盾单独登记。
3. **状态机归并**（`src/state-machine.js`）：同一动作的多次状态更新按有限状态机重放；重复状态更新合并、非法跃迁记录但不丢弃；告警 `resolved` 后再次 `firing` 自动拆成新分段；漂移导致回滚时间戳早于开始时，起始态事件会被提升为重放起点。
4. **因果图与拓扑排序**（`src/causal.js`）：`causalRefs`、部署关联、同事故引用构成不同权重的有向边，Kahn 拓扑排序优先满足因果关系，同层再按时间与 id 稳定排序；成环时移除最低权重边并输出环路径。
5. **根因候选聚合**（`src/root-cause.js`）：按时间接近度、显式因果引用、部署-故障关联、回滚恢复信号和文本提示词打分并列出证据明细。
6. **冲突汇总**（`src/conflicts.js`）：输出因果/时间倒置、状态机冲突、重复组矛盾、未解析引用等片段。

## 输出结构

- `summary`：输入数、权威事件数、重复数、动作/分段数、未关闭动作数、冲突数。
- `timeline`：稳定排序后的节点序列，每个节点带 `interval`（含 `startUnknown`/`endUnknown` 标记未知区间）、来源、引用与状态跃迁明细。
- `duplicateMerges`：每个重复组的权威 id、被合并 id、来源与组内冲突情况。
- `actions`：动作及其分段（episode）、完整跃迁、被忽略的更新及原因。
- `openActions`：仍未进入终态的动作分段，缺少结束事件的分段统一标记 `endUnknown: true`。
- `rootCauseCandidates`：带分数、证据列表和 `humanReviewRequired` 的根因候选。
- `conflicts`：存在时间或证据冲突的片段，含冲突类型、涉及节点与解决方式（如 `causal_edge_wins`）。
- `unresolvedRefs`：指向不存在目标的引用。

## 关键设计约定

- **接收时间只能辅助**：它不会覆盖 `occurredAt`，更不会覆盖显式因果引用；当因果关系与时间戳矛盾时，输出顺序服从因果，矛盾登记在 `conflicts` 中。
- **重复不计数**：任何带相同 `duplicateKey`/`fingerprint` 的事件只保留一条权威记录。
- **未知区间显式化**：缺少开始或结束时间的分段不会被猜测填充，而是通过 `startUnknown`/`endUnknown` 暴露不确定性。
- **确定性输出**：所有平局都按 id 打破，相同输入始终产生相同顺序。

## 测试

`test/timeline.test.js` 使用 Node 内置 test runner，覆盖：

- 时间戳乱序与因果优先排序
- 来源时钟差异校正
- 重复消息合并与权威选择
- 部署与故障关联及根因证据
- 恢复后再次告警的分段与未关闭动作
- 多来源状态冲突、非法跃迁与未知区间
- 接收时间回退且不覆盖因果引用

## 免责声明

**根因候选只是多源证据的自动聚合与排序，不代替人工判断。** 分数反映的是证据强度（时间接近度、显式引用、部署关联、回滚信号等），不构成事故结论；`humanReviewRequired` 始终为 `true`，最终根因必须由值班人员结合完整上下文复核确认。
