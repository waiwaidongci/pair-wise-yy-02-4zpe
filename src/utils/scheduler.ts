import type { WorkflowEdge, WorkflowNode } from '../types/workflow'

/** 单次尝试的结果 */
export interface AttemptOutcome {
  ok: boolean
  duration: number
  rows?: number
  errorMessage?: string
}

export type SchedulerTerminal = 'success' | 'error' | 'skipped'

export interface SchedulerListeners {
  /** 节点被纳入本轮执行范围（之前没有可沿用的结果） */
  onReset?: (id: string) => void
  /** 节点结果仍有效，本轮直接沿用 */
  onReuse?: (id: string) => void
  /** 排队等待调度槽位 */
  onQueue?: (id: string) => void
  /** 开始一次尝试（attempt 从 1 开始） */
  onStart?: (id: string, attempt: number, startedAt: string) => void
  /** 一次尝试失败，还会重试 */
  onRetry?: (id: string, attempt: number, errorMessage: string) => void
  onSuccess?: (id: string, outcome: AttemptOutcome, attempts: number, startedAt: string, finishedAt: string) => void
  onError?: (id: string, errorMessage: string, attempts: number, startedAt: string, finishedAt: string, durations: number[]) => void
  onSkip?: (id: string, reason: string) => void
  /** 中断后仍在排队/未开始或执行到一半的节点回到待执行 */
  onAbortIdle?: (ids: string[]) => void
}

export interface RunWorkflowOptions {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  maxConcurrency: number
  maxRetriesFor: (id: string) => number
  /** 执行一次尝试；收到中断信号时应尽快让 Promise 结束 */
  runAttempt: (id: string, attempt: number, signal: AbortSignal) => Promise<AttemptOutcome>
  /** 已有的成功结果是否仍与当前依据一致，可直接沿用 */
  isFresh: (id: string) => boolean
  listeners?: SchedulerListeners
  signal?: AbortSignal
}

export interface RunWorkflowResult {
  aborted: boolean
  status: Record<string, SchedulerTerminal>
  skipped: number
  failed: number
}

/**
 * 按依赖图执行工作流：
 * - 上游全部完成后节点才可开始，互不依赖的节点并发执行，超过 maxConcurrency 时排队；
 * - 每个节点按自己的 maxRetries 重试；
 * - 节点最终失败（或被上游牵连）后，其下游一律跳过，其他分支照常跑完；
 * - 触发 abort 后不再调度新节点，在跑的尝试结束后整体收尾。
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const { nodes, edges, maxConcurrency, maxRetriesFor, runAttempt, isFresh, listeners, signal } = options
  const ids = nodes.map((node) => node.id)
  const idSet = new Set(ids)
  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  ids.forEach((id) => { indegree.set(id, 0); outgoing.set(id, []) })
  edges.forEach((edge) => {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) return
    outgoing.get(edge.source)!.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  })

  // 用稳定的拓扑序决定就绪队列里的先后，避免同批次执行顺序随机
  const ordered: string[] = []
  const scratch = new Map(indegree)
  const available = ids.filter((id) => scratch.get(id) === 0)
  while (available.length) {
    const id = available.shift()!
    ordered.push(id)
    for (const next of outgoing.get(id) ?? []) {
      scratch.set(next, (scratch.get(next) ?? 1) - 1)
      if (scratch.get(next) === 0) available.push(next)
    }
  }
  if (ordered.length !== ids.length) {
    throw new Error('存在环形依赖或无效连线，无法执行')
  }

  type Phase = 'waiting' | 'queued' | 'running' | 'success' | 'error' | 'skipped'
  const phase = new Map<string, Phase>(ids.map((id) => [id, 'waiting']))
  const remaining = new Map(indegree)
  const ready: string[] = []
  const inFlight = new Set<string>()
  const status = {} as Record<string, SchedulerTerminal>
  let active = 0
  let pending = ids.length
  let failed = 0
  let skippedCount = 0
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  function finishNode(id: string, terminal: SchedulerTerminal) {
    phase.set(id, terminal)
    status[id] = terminal
    pending -= 1
    if (terminal === 'error') failed += 1
    if (terminal === 'skipped') skippedCount += 1
  }

  /** 失败/跳过后，把还没开始跑的下游全部标记为跳过，正在跑的节点不受影响 */
  function cascadeSkip(start: string, reason: string) {
    const queue = [start]
    const seen = new Set<string>([start])
    while (queue.length) {
      const id = queue.shift()!
      for (const next of outgoing.get(id) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        const nextPhase = phase.get(next)
        if (nextPhase === 'waiting' || nextPhase === 'queued') {
          phase.set(next, 'skipped')
          status[next] = 'skipped'
          pending -= 1
          skippedCount += 1
          listeners?.onSkip?.(next, reason)
          queue.push(next)
        }
        // success/error/skipped/running 的节点不再向下扩散
      }
    }
  }

  /** 成功节点释放下游入度；入度归零后进入就绪队列排队 */
  function release(id: string) {
    for (const next of outgoing.get(id) ?? []) {
      const left = (remaining.get(next) ?? 1) - 1
      remaining.set(next, left)
      if (left === 0 && phase.get(next) === 'waiting') ready.push(next)
    }
  }

  // 入队顺序按拓扑序排稳
  function refreshReady() {
    ready.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b))
  }

  // 先处理可沿用的旧结果：跳过执行，但其下游仍要释放
  for (const id of ordered) {
    if (isFresh(id)) {
      finishNode(id, 'success')
      listeners?.onReuse?.(id)
      release(id)
    } else {
      listeners?.onReset?.(id)
    }
  }
  // 没有上游依赖（或上游已全部沿用）的非新鲜节点，第一批入队
  for (const id of ordered) {
    if (phase.get(id) === 'waiting' && (remaining.get(id) ?? 0) === 0) ready.push(id)
  }
  refreshReady()

  async function executeNode(id: string, startedForRun: boolean) {
    const maxRetries = maxRetriesFor(id)
    const startedAt = new Date().toISOString()
    inFlight.add(id)
    listeners?.onStart?.(id, 1, startedAt)
    const durations: number[] = []
    let attempt = 0
    let lastError = '执行失败'
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1
      if (signal?.aborted) {
        inFlight.delete(id)
        if (startedForRun) active -= 1
        pump()
        return
      }
      let outcome: AttemptOutcome
      try {
        outcome = await runAttempt(id, attempt, signal ?? new AbortController().signal)
      } catch (error) {
        outcome = { ok: false, duration: 0, errorMessage: error instanceof Error ? error.message : '执行异常' }
      }
      durations.push(outcome.duration)
      if (outcome.ok && !signal?.aborted) {
        inFlight.delete(id)
        if (startedForRun) active -= 1
        finishNode(id, 'success')
        const finishedAt = new Date().toISOString()
        listeners?.onSuccess?.(id, outcome, attempt, startedAt, finishedAt)
        release(id)
        pump()
        return
      }
      lastError = outcome.errorMessage ?? '执行失败'
      if (attempt <= maxRetries && !signal?.aborted) {
        listeners?.onRetry?.(id, attempt, lastError)
        continue
      }
      break
    }
    if (signal?.aborted) {
      inFlight.delete(id)
      if (startedForRun) active -= 1
      pump()
      return
    }
    inFlight.delete(id)
    if (startedForRun) active -= 1
    finishNode(id, 'error')
    const finishedAt = new Date().toISOString()
    listeners?.onError?.(id, lastError, attempt, startedAt, finishedAt, durations)
    cascadeSkip(id, `上游节点 ${id} 执行失败`)
    pump()
  }

  function pump() {
    if (signal?.aborted) {
      // 中断后：在跑的尝试逐一结束，槽位全部释放即收尾，排队节点不再启动
      if (active === 0) resolveDone()
      return
    }
    if (pending === 0) {
      resolveDone()
      return
    }
    refreshReady()
    while (active < Math.max(1, maxConcurrency) && ready.length) {
      const id = ready.shift()!
      if (phase.get(id) !== 'waiting') continue
      phase.set(id, 'queued')
      listeners?.onQueue?.(id)
      // 排队结束、实际占槽
      phase.set(id, 'running')
      active += 1
      void executeNode(id, true)
    }
  }

  pump()
  await done

  const aborted = signal?.aborted ?? false
  if (aborted) {
    const abortedIds = ids.filter((id) => {
      const p = phase.get(id)
      return p === 'waiting' || p === 'queued' || inFlight.has(id)
    })
    if (abortedIds.length) listeners?.onAbortIdle?.(abortedIds)
  }
  return { aborted, status, skipped: skippedCount, failed }
}
