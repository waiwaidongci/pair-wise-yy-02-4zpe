import { useWorkflowStore } from '../src/stores/workflow'

// store 里用了 window.setTimeout，Node 环境补一下
;(globalThis as Record<string, unknown>).window = globalThis

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  // 1. 完整执行一遍示例流程（并发 3）
  useWorkflowStore.getState().setMaxConcurrency(3)
  await useWorkflowStore.getState().simulate()
  let s = useWorkflowStore.getState()
  assert(!s.running, '执行结束后 running 复位')
  const statuses = s.nodes.map((node) => node.data.status)
  assert(statuses.every((status) => status === 'success' || status === 'error' || status === 'skipped'),
    '执行后每个节点都有终态')
  const successCount = s.nodes.filter((node) => node.data.status === 'success').length
  assert(successCount === s.nodes.length || s.notice.includes('失败') || s.notice.includes('跳过'),
    '全成功或通知中说明失败/跳过')
  assert(Object.keys(s.runRecords).length === s.nodes.length, '每个节点都留下运行记录')

  // 2. 再次执行：依据未变，应直接沿用，瞬间结束
  const before = JSON.stringify(s.nodes.map((node) => [node.id, node.data.duration]))
  await useWorkflowStore.getState().simulate()
  s = useWorkflowStore.getState()
  const after = JSON.stringify(s.nodes.map((node) => [node.id, node.data.duration]))
  assert(before === after, '依据未变时结果沿用，未重算')

  // 3. 改一个节点参数 -> stale 级联 -> 再次执行只重算失效部分
  const source = s.nodes.find((node) => node.id === 'source-orders')!
  const sink = s.nodes.find((node) => node.id === 'sink-warehouse')!
  assert(source.data.stale !== true, '改动前 source 不失效')
  useWorkflowStore.getState().updateConfig('source-orders', 'source', '退款明细表')
  s = useWorkflowStore.getState()
  const staleIds = s.nodes.filter((node) => node.data.stale).map((node) => node.id)
  assert(staleIds.length === s.nodes.length, '源头参数变化，整链所有下游失效')
  assert(staleIds.includes('sink-warehouse'), '末端 sink 也失效')

  await useWorkflowStore.getState().simulate()
  s = useWorkflowStore.getState()
  assert(s.nodes.every((node) => !node.data.stale), '重算后失效标记清除')
  assert(s.nodes.find((node) => node.id === 'source-orders')?.data.status === 'success', '重算节点成功')

  // 4. 中断后再执行：第一次中断，第二次能跑完（幂等续跑）
  useWorkflowStore.getState().updateConfig('source-orders', 'source', '又换了一张表')
  const runPromise = useWorkflowStore.getState().simulate()
  await sleep(30)
  useWorkflowStore.getState().stopRun()
  await runPromise
  s = useWorkflowStore.getState()
  assert(!s.running, '中断后 running 复位')
  assert(s.notice.includes('中断'), '中断通知正确')
  // 续跑到结束
  await useWorkflowStore.getState().simulate()
  s = useWorkflowStore.getState()
  assert(!s.running, '中断后可以再次执行到结束')

  // 5. 导出 v2 文件 -> 重新导入：运行记录与终态恢复
  const doc = useWorkflowStore.getState().exportDocument()
  assert(doc.version === 2 && !!doc.runRecords, '导出文件带 version=2 与运行记录')
  const sinkStateBefore = doc.nodes.find((node) => node.id === 'sink-warehouse')?.data
  const { legacy } = useWorkflowStore.getState().loadDocument(JSON.parse(JSON.stringify(doc)))
  assert(!legacy, 'v2 文件不按 legacy 打开')
  s = useWorkflowStore.getState()
  const importedSink = s.nodes.find((node) => node.id === 'sink-warehouse')
  assert(importedSink?.data.status === sinkStateBefore?.status, '导入后恢复节点终态')
  assert(importedSink?.data.duration === sinkStateBefore?.duration, '导入后恢复耗时等运行数据')
  assert(s.maxConcurrency === doc.maxConcurrency, '导入后恢复并发设置')

  // 6. 旧文件（v1）导入：顺序模式
  const oldDoc = { version: 1, name: '老流程', nodes: JSON.parse(JSON.stringify(s.nodes)), edges: JSON.parse(JSON.stringify(s.edges)), savedAt: '' }
  const loaded = useWorkflowStore.getState().loadDocument(oldDoc)
  assert(loaded.legacy, 'v1 旧文件识别成功')
  s = useWorkflowStore.getState()
  assert(s.maxConcurrency === 1, '旧文件并发降为 1（顺序执行）')
  assert(s.nodes.every((node) => node.data.status === 'idle'), '旧文件节点待执行')
  assert(s.sequentialMode === true, '顺序模式标志置位')

  console.log(`\n${passed} 项断言通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
