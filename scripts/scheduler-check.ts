import { runWorkflow } from '../src/utils/scheduler'
import type { WorkflowEdge, WorkflowNode } from '../src/types/workflow'
import { createWorkflowNode } from '../src/utils/workflow'

process.on('unhandledRejection', (error) => {
  console.error('UNHANDLED REJECTION:', error)
  process.exit(1)
})
console.log('scheduler check starting...')

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

function makeNode(id: string, kind: WorkflowNode['data']['kind'], maxRetries = 1): WorkflowNode {
  const node = createWorkflowNode(kind, { x: 0, y: 0 }, id)
  node.data.maxRetries = maxRetries
  return node
}

function edge(source: string, target: string, index = 0): WorkflowEdge {
  return {
    id: `${source}-${target}-${index}`,
    source,
    sourceHandle: 'out-0',
    target,
    targetHandle: `in-${index}`,
    type: 'smoothstep',
    data: { portType: 'dataset' },
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 图：
// source1 ─► transform1 ─► join ─► sink1
// source2 ─► filter1   ──┘
//           badNode(必失败, 0 重试) ─► sink2
const nodes = [
  makeNode('source1', 'source'),
  makeNode('source2', 'source'),
  makeNode('transform1', 'transform'),
  makeNode('filter1', 'filter'),
  makeNode('badNode', 'transform', 0),
  makeNode('join', 'join'),
  makeNode('sink1', 'sink'),
  makeNode('sink2', 'sink'),
]
const edges = [
  edge('source1', 'transform1'),
  edge('source2', 'filter1'),
  edge('transform1', 'join', 0),
  edge('filter1', 'join', 1),
  edge('join', 'sink1'),
  edge('badNode', 'sink2', 0),
]

async function main() {
  console.log('case 1...')
  // —— 用例 1：并发上限与排队 ——
  {
    const concurrent: string[] = []
    let maxObserved = 0
    let result: Awaited<ReturnType<typeof runWorkflow>>
    try {
      result = await runWorkflow({
        nodes,
        edges,
        maxConcurrency: 2,
        maxRetriesFor: () => 0,
        isFresh: () => false,
        runAttempt: async (id, _attempt, signal) => {
          concurrent.push(id)
          maxObserved = Math.max(maxObserved, concurrent.length)
          await sleep(20)
          concurrent.splice(concurrent.indexOf(id), 1)
          return { ok: true, duration: 20 }
        },
      })
    } catch (error) {
      console.error('case1 threw:', error)
      throw error
    }
    assert(maxObserved === 2, `并发数到顶后排队（观测峰值 ${maxObserved} === 2）`)
    assert(Object.values(result.status).every((s) => s === 'success'), '全部成功时没有跳过/失败')
  }

  // —— 用例 2：顺序模式（并发 1）——
  {
    const concurrent: string[] = []
    let maxObserved = 0
    await runWorkflow({
      nodes,
      edges,
      maxConcurrency: 1,
      maxRetriesFor: () => 0,
      isFresh: () => false,
      runAttempt: async (id) => {
        concurrent.push(id)
        maxObserved = Math.max(maxObserved, concurrent.length)
        await sleep(5)
        concurrent.splice(concurrent.indexOf(id), 1)
        return { ok: true, duration: 5 }
      },
    })
    assert(maxObserved === 1, '并发 1 时严格顺序执行')
  }

  // —— 用例 3：节点按自己的次数重试，最终失败只跳过自己的下游 ——
  {
    const attempts = new Map<string, number>()
    const skipped: string[] = []
    const result = await runWorkflow({
      nodes,
      edges,
      maxConcurrency: 4,
      maxRetriesFor: (id) => (id === 'badNode' ? 0 : 2),
      isFresh: () => false,
      listeners: { onSkip: (id) => skipped.push(id) },
      runAttempt: async (id, attempt) => {
        attempts.set(id, (attempts.get(id) ?? 0) + 1)
        // badNode 始终失败；其余节点首次失败、第二次成功
        if (id === 'badNode' || attempt === 1) {
          if (id !== 'badNode') await sleep(1)
          return { ok: false, duration: 1, errorMessage: '模拟故障' }
        }
        return { ok: true, duration: 1 }
      },
    })
    assert(result.failed === 1, `只有 badNode 最终失败（失败数 ${result.failed}）`)
    assert(result.status['badNode'] === 'error', 'badNode 状态为 error')
    assert(result.status['sink2'] === 'skipped', '失败节点下游 sink2 被跳过')
    assert(skipped.includes('sink2') && skipped.length === 1, '仅跳过 badNode 的下游，其他分支不受影响')
    assert(attempts.get('badNode') === 1, 'badNode 按自身配置重试 0 次（只执行 1 次）')
    assert((attempts.get('source1') ?? 0) === 2, '其他节点按自身配置重试（共尝试 2 次）后成功')
    assert(result.status['join'] === 'success' && result.status['sink1'] === 'success', '不相关分支照常跑完')
  }

  // —— 用例 4：中断后已完成结果保留，排队节点回到待执行 ——
  {
    const controller = new AbortController()
    const started = new Set<string>()
    const reset: string[] = []
    const run = runWorkflow({
      nodes,
      edges,
      maxConcurrency: 2,
      maxRetriesFor: () => 0,
      isFresh: () => false,
      signal: controller.signal,
      listeners: {
        onStart: (id) => started.add(id),
        onAbortIdle: (ids) => reset.push(...ids),
      },
      runAttempt: async (id, _attempt, signal) => {
        await sleep(30)
        return signal.aborted ? { ok: false, duration: 0 } : { ok: true, duration: 30 }
      },
    })
    await sleep(15)
    controller.abort()
    const result = await run
    assert(result.aborted, '中断结果被标记为 aborted')
    assert(started.size === 2, `中断时只有占槽的 2 个节点启动过（实际 ${started.size}）`)
    assert(reset.length === nodes.length - 2, `未启动节点回到待执行（${reset.length} 个）`)
  }

  // —— 用例 5：依据仍新鲜的节点沿用结果，只重算失效节点 ——
  {
    const executed: string[] = []
    const reused: string[] = []
    const result = await runWorkflow({
      nodes,
      edges,
      maxConcurrency: 8,
      maxRetriesFor: () => 0,
      isFresh: (id) => id === 'source1' || id === 'transform1' || id === 'join' || id === 'sink1',
      listeners: { onReuse: (id) => reused.push(id) },
      runAttempt: async (id) => {
        executed.push(id)
        return { ok: true, duration: 1 }
      },
    })
    assert(reused.length === 4, '4 个依据未变的节点直接沿用旧结果')
    assert(!executed.includes('source1') && executed.includes('badNode'), '失效节点按新依据重算，新鲜节点不重跑')
    assert(result.status['source1'] === 'success', '沿用结果的节点状态为 success')
  }

  // —— 用例 6：环检测 ——
  {
    const cyclicNodes = [makeNode('a', 'transform'), makeNode('b', 'transform')]
    const cyclicEdges = [edge('a', 'b'), edge('b', 'a')]
    let threw = false
    try {
      await runWorkflow({
        nodes: cyclicNodes,
        edges: cyclicEdges,
        maxConcurrency: 2,
        maxRetriesFor: () => 0,
        isFresh: () => false,
        runAttempt: async () => ({ ok: true, duration: 1 }),
      })
    } catch {
      threw = true
    }
    assert(threw, '检测到环形依赖时拒绝执行')
  }

  console.log(`\n${passed} 项断言通过`)
}

main()
