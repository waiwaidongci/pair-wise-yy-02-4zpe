import {
  computeBasisMap,
  normalizeDocument,
  reconcileRunState,
  sampleWorkflow,
} from '../src/utils/workflow'
import type { NodeRunRecord, WorkflowNode } from '../src/types/workflow'

let passed = 0
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ${message}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✅ ${message}`)
  }
}

const { nodes, edges } = sampleWorkflow()
const initialBasis = computeBasisMap(nodes, edges)
nodes.forEach((node) => { node.data.basis = initialBasis.get(node.id) })

// 全部节点都有「成功」记录
const records: Record<string, NodeRunRecord> = {}
nodes.forEach((node) => {
  records[node.id] = { status: 'success', basis: node.data.basis!, duration: 100, rows: 10, attempts: 1 }
})
reconcileRunState(nodes, edges, records)
assert(nodes.every((node) => !node.data.stale), '初始状态下所有节点结果均有效')

// 修改 filter-paid 的参数：自身 + 下游 join/aggregate/sink 失效，兄弟分支 transform 不受影响
const filter = nodes.find((node) => node.id === 'filter-paid')!
filter.data.config.expression = 'status == "待支付"'
reconcileRunState(nodes, edges, records)
const staleIds = nodes.filter((node) => node.data.stale).map((node) => node.id)
assert(staleIds.includes('filter-paid'), '改参数的节点自身失效')
assert(staleIds.includes('join-customer'), '下游 join 级联失效')
assert(staleIds.includes('aggregate-region') && staleIds.includes('sink-warehouse'), '下游的下游继续级联失效')
assert(!staleIds.includes('transform-clean'), '兄弟分支不受影响')
assert(!staleIds.includes('source-orders'), '上游不受影响')

// 改连线：删除 source -> filter 的入边，filter 链全部失效
const { nodes: n2, edges: e2 } = sampleWorkflow()
const b2 = computeBasisMap(n2, e2)
n2.forEach((node) => { node.data.basis = b2.get(node.id) })
const r2: Record<string, NodeRunRecord> = {}
n2.forEach((node) => { r2[node.id] = { status: 'success', basis: node.data.basis!, duration: 1 } })
const nextEdges = e2.filter((edge) => edge.id !== 'e1')
reconcileRunState(n2, nextEdges, r2)
const staleAfterEdgeChange = n2.filter((node) => node.data.stale).map((node) => node.id)
assert(staleAfterEdgeChange.includes('filter-paid') && staleAfterEdgeChange.includes('join-customer'),
  '删除连线后相关节点失效')
assert(!staleAfterEdgeChange.includes('transform-clean'), '与被删连线无关的分支结果保留')

// 旧版文件（没有 version=2 与 runRecords）：顺序模式打开，节点全待执行，无 stale
{
  const { nodes: oldNodes, edges: oldEdges } = sampleWorkflow()
  const doc = { version: 1, name: '旧流程', nodes: oldNodes, edges: oldEdges, savedAt: new Date().toISOString() }
  const normalized = normalizeDocument(doc)
  assert(normalized.legacy, '旧文件识别为 legacy')
  assert(normalized.maxConcurrency === 1, '旧文件按顺序执行（并发 1）打开')
  assert(normalized.nodes.every((node) => node.data.status === 'idle'), '旧文件节点全部待执行')
  assert(Object.keys(normalized.runRecords).length === 0, '旧文件不带入运行记录')
}

// v2 文件往返：导出的记录恢复状态，依据对得上则不标 stale
{
  const { nodes: v2Nodes, edges: v2Edges } = sampleWorkflow()
  v2Nodes.forEach((node) => {
    node.data.maxRetries = 2
    node.data.status = 'success'
    node.data.duration = 321
  })
  const basisMap = computeBasisMap(v2Nodes, v2Edges)
  const runRecords: Record<string, NodeRunRecord> = {}
  v2Nodes.forEach((node) => {
    runRecords[node.id] = { status: 'success', basis: basisMap.get(node.id)!, duration: 321, attempts: 1 }
  })
  const doc = {
    version: 2,
    name: '新流程',
    nodes: v2Nodes,
    edges: v2Edges,
    maxConcurrency: 3,
    runRecords,
    savedAt: new Date().toISOString(),
  }
  const normalized = normalizeDocument(JSON.parse(JSON.stringify(doc)))
  assert(!normalized.legacy, 'v2 文件不是 legacy')
  assert(normalized.maxConcurrency === 3, 'v2 文件恢复并发设置')
  assert(normalized.nodes.every((node) => node.data.status === 'success'), 'v2 文件恢复成功状态')
  assert(normalized.nodes.every((node) => !node.data.stale), '记录依据与当前一致，不标失效')
  assert(Object.keys(normalized.runRecords).length === v2Nodes.length, '全部运行记录被恢复')
  assert(normalized.nodes[0].data.maxRetries === 2, '节点重试次数被恢复')
}

// v2 文件但导入后参数被人改过：恢复记录同时标 stale
{
  const { nodes: v2Nodes, edges: v2Edges } = sampleWorkflow()
  const basisMap = computeBasisMap(v2Nodes, v2Edges)
  const runRecords: Record<string, NodeRunRecord> = {}
  v2Nodes.forEach((node) => {
    runRecords[node.id] = { status: 'success', basis: basisMap.get(node.id)!, duration: 100 }
  })
  v2Nodes.find((node: WorkflowNode) => node.id === 'source-orders')!.data.config.source = '别的表'
  const doc = { version: 2, name: '改过的流程', nodes: v2Nodes, edges: v2Edges, maxConcurrency: 2, runRecords, savedAt: '' }
  const normalized = normalizeDocument(doc)
  assert(normalized.nodes.find((node) => node.id === 'source-orders')?.data.stale === true,
    '导入时检测到参数变更，标记旧结果失效')

  // 非法 maxRetries 回落到默认值
  const broken = normalizeDocument({
    version: 2,
    name: 'x',
    nodes: [{ ...v2Nodes[0], data: { ...v2Nodes[0].data, maxRetries: 'abc' } }],
    edges: [],
    maxConcurrency: 2,
    runRecords: {},
    savedAt: '',
  })
  assert(broken.nodes[0].data.maxRetries === 1, '非法重试次数回落到 1')
}

console.log(`\n${passed} 项断言通过`)
