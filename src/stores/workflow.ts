import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  NodeKind,
  RunRecord,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
} from '../types/workflow'
import {
  autoLayout,
  computeBases,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  NODE_DEFINITIONS,
  sampleWorkflow,
  topologicalOrder,
  upstreamMap,
} from '../utils/workflow'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

interface SimulateOptions {
  /** 顺序执行（并发上限降为 1），用于打开缺少运行记录的旧文件 */
  sequential?: boolean
}

interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  past: Snapshot[]
  future: Snapshot[]
  clipboard: WorkflowNode[]
  notice: string
  running: boolean
  cancelRequested: boolean
  runRecords: RunRecord[]
  setName: (name: string) => void
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void
  connect: (connection: Connection) => boolean
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateNode: (id: string, patch: Partial<WorkflowNode['data']>) => void
  updateConfig: (id: string, key: string, value: string | number | boolean) => void
  deleteSelection: () => void
  copySelection: () => void
  pasteSelection: () => void
  layout: () => void
  undo: () => void
  redo: () => void
  clearNotice: () => void
  simulate: (options?: SimulateOptions) => Promise<void>
  cancelRun: () => void
  loadDocument: (document: WorkflowDocument) => void
  reset: () => void
}

const initial = sampleWorkflow()

/** 并发执行上限：同时跑到顶后，其余节点在队列中等待 */
const MAX_CONCURRENCY = 3
/** 单次执行失败概率（模拟数据节点的偶发故障） */
const FAILURE_RATE = 0.18

function snapshot(state: Pick<WorkflowState, 'nodes' | 'edges'>): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  }
}

function pushHistory(state: WorkflowState) {
  state.past.push(snapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 参数或连线改动后，把依据失效的节点旧结果作废：
 * 状态重置为待执行并清空耗时/行数，运行记录同步剔除。
 * 依据未变的节点（含其下游也未受影响的分支）保留结果。
 */
function invalidateStale(state: WorkflowState) {
  const order = topologicalOrder(state.nodes, state.edges)
  if (order.length !== state.nodes.length) return
  const bases = computeBases(state.nodes, state.edges)
  const recordByNode = new Map(state.runRecords.map((record) => [record.nodeId, record]))
  for (const node of state.nodes) {
    const basis = bases.get(node.id)
    const record = recordByNode.get(node.id)
    if (!record || record.basis !== basis) {
      node.data.status = 'idle'
      node.data.duration = undefined
      node.data.rows = undefined
      node.data.attempts = undefined
    }
  }
  state.runRecords = state.runRecords.filter((record) => {
    const node = state.nodes.find((item) => item.id === record.nodeId)
    return Boolean(node) && record.basis === bases.get(record.nodeId)
  })
}

export const useWorkflowStore = create<WorkflowState>()(immer((set, get) => ({
  name: '订单经营分析流程',
  nodes: initial.nodes,
  edges: initial.edges,
  selectedNodeId: null,
  selectedEdgeId: null,
  past: [],
  future: [],
  clipboard: [],
  notice: '端口与类型校验已开启',
  running: false,
  cancelRequested: false,
  runRecords: [],

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
    invalidateStale(state)
  }),

  connect: (connection) => {
    const state = get()
    const error = connectionError(connection, state.nodes)
    if (error) {
      set((draft) => { draft.notice = error })
      return false
    }
    if (createsCycle(connection, state.edges)) {
      set((draft) => { draft.notice = '连接被拒绝：检测到环形依赖' })
      return false
    }
    set((draft) => {
      pushHistory(draft)
      const source = draft.nodes.find((node) => node.id === connection.source)
      const sourceHandle = connection.sourceHandle ?? ''
      const type = sourceHandle.startsWith('out-1') ? 'number' : 'dataset'
      draft.edges = addEdge({
        ...connection,
        id: `edge-${Date.now().toString(36)}`,
        type: 'smoothstep',
        animated: true,
        data: { portType: type },
      }, draft.edges) as WorkflowEdge[]
      invalidateStale(draft)
      draft.notice = '连接成功，端口类型兼容'
    })
    return true
  },

  addNode: (kind, position) => set((draft) => {
    pushHistory(draft)
    const node = createWorkflowNode(kind, position ?? { x: 120 + draft.nodes.length * 28, y: 120 + draft.nodes.length * 22 })
    draft.nodes.push(node)
    draft.selectedNodeId = node.id
    draft.selectedEdgeId = null
    invalidateStale(draft)
    draft.notice = `已添加${definitionFor(kind).label}`
  }),

  selectNode: (id) => set((state) => {
    state.selectedNodeId = id
    state.selectedEdgeId = null
  }),

  selectEdge: (id) => set((state) => {
    state.selectedEdgeId = id
    state.selectedNodeId = null
  }),

  updateNode: (id, patch) => set((draft) => {
    pushHistory(draft)
    const node = draft.nodes.find((item) => item.id === id)
    if (node) {
      node.data = { ...node.data, ...patch }
      invalidateStale(draft)
    }
  }),

  updateConfig: (id, key, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (node) {
      node.data.config[key] = value
      draft.past.push(snapshot(draft))
      draft.future = []
      invalidateStale(draft)
    }
  }),

  deleteSelection: () => set((draft) => {
    if (!draft.selectedNodeId && !draft.selectedEdgeId) return
    pushHistory(draft)
    if (draft.selectedNodeId) {
      const id = draft.selectedNodeId
      draft.nodes = draft.nodes.filter((node) => node.id !== id)
      draft.edges = draft.edges.filter((edge) => edge.source !== id && edge.target !== id)
      draft.selectedNodeId = null
    }
    if (draft.selectedEdgeId) {
      draft.edges = draft.edges.filter((edge) => edge.id !== draft.selectedEdgeId)
      draft.selectedEdgeId = null
    }
    invalidateStale(draft)
  }),

  copySelection: () => set((draft) => {
    const selected = draft.nodes.filter((node) => node.id === draft.selectedNodeId)
    draft.clipboard = JSON.parse(JSON.stringify(selected)) as WorkflowNode[]
    if (selected.length) draft.notice = `已复制 ${selected.length} 个节点`
  }),

  pasteSelection: () => set((draft) => {
    if (!draft.clipboard.length) return
    pushHistory(draft)
    const copies = draft.clipboard.map((source) => {
      const copy = JSON.parse(JSON.stringify(source)) as WorkflowNode
      copy.id = `${source.data.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      copy.position = { x: source.position.x + 36, y: source.position.y + 36 }
      copy.selected = false
      draft.nodes.push(copy)
      return copy
    })
    draft.selectedNodeId = copies[0]?.id ?? null
    invalidateStale(draft)
    draft.notice = `已粘贴 ${copies.length} 个节点`
  }),

  layout: () => set((draft) => {
    pushHistory(draft)
    draft.nodes = autoLayout(draft.nodes, draft.edges)
    draft.notice = '已按依赖层级自动布局'
  }),

  undo: () => set((draft) => {
    const previous = draft.past.pop()
    if (!previous) return
    draft.future.push(snapshot(draft))
    draft.nodes = previous.nodes
    draft.edges = previous.edges
    invalidateStale(draft)
    draft.notice = '已撤销上一步操作'
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    invalidateStale(draft)
    draft.notice = '已恢复操作'
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  simulate: async (options) => {
    const state = get()
    if (state.running) return
    const sequential = options?.sequential ?? false
    const concurrency = sequential ? 1 : MAX_CONCURRENCY
    const order = topologicalOrder(state.nodes, state.edges)
    if (order.length !== state.nodes.length) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法执行' })
      return
    }
    if (!order.length) {
      set((draft) => { draft.notice = '没有可执行的节点' })
      return
    }

    const bases = computeBases(state.nodes, state.edges)
    const upstream = upstreamMap(state.edges)
    const downstream = new Map<string, string[]>()
    state.edges.forEach((edge) => {
      const list = downstream.get(edge.source) ?? []
      list.push(edge.target)
      downstream.set(edge.source, list)
    })

    // 依据未变且上次成功的节点直接沿用结果，不重复执行
    const recordMap = new Map<string, RunRecord>()
    state.runRecords.forEach((record) => {
      if (record.basis === bases.get(record.nodeId) && record.status === 'success') {
        recordMap.set(record.nodeId, record)
      }
    })

    type NodeRunState = 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
    const nodeStates = new Map<string, NodeRunState>()
    const remaining = new Map<string, number>()
    order.forEach((id) => {
      nodeStates.set(id, recordMap.has(id) ? 'done' : 'pending')
      const ups = upstream.get(id) ?? []
      remaining.set(id, ups.filter((upId) => nodeStates.get(upId) !== 'done').length)
    })

    set((draft) => {
      draft.running = true
      draft.cancelRequested = false
      draft.nodes.forEach((node) => {
        const record = recordMap.get(node.id)
        if (record) {
          node.data.status = 'success'
          node.data.duration = record.duration
          node.data.rows = record.rows
          node.data.attempts = record.attempts > 1 ? record.attempts : undefined
        } else {
          node.data.status = 'idle'
          node.data.duration = undefined
          node.data.rows = undefined
          node.data.attempts = undefined
        }
      })
    })

    const queue: string[] = []
    order.forEach((id) => {
      if (nodeStates.get(id) === 'pending' && (remaining.get(id) ?? 0) === 0) queue.push(id)
    })

    let runningCount = 0
    let failedCount = 0
    let skippedCount = 0
    let retriedNodes = 0
    const startedAt = Date.now()
    const isCancelled = () => get().cancelRequested

    function markStatus(id: string, status: RunStatus, patch?: Partial<WorkflowNodeData>) {
      set((draft) => {
        const node = draft.nodes.find((item) => item.id === id)
        if (node) {
          node.data.status = status
          if (patch) Object.assign(node.data, patch)
        }
      })
    }

    function skipNode(id: string) {
      const current = nodeStates.get(id)
      if (current !== 'pending' && current !== 'queued') return
      nodeStates.set(id, 'skipped')
      skippedCount += 1
      recordMap.set(id, {
        nodeId: id,
        basis: bases.get(id) ?? '',
        status: 'skipped',
        attempts: 0,
        ranAt: new Date().toISOString(),
      })
      markStatus(id, 'skipped', { duration: undefined, rows: undefined, attempts: undefined })
      ;(downstream.get(id) ?? []).forEach(skipNode)
    }

    async function executeNode(id: string): Promise<{ ok: boolean; attempts: number; duration: number; rows: number }> {
      const node = get().nodes.find((item) => item.id === id)
      const maxAttempts = 1 + Math.max(0, Number(node?.data.retries) || 0)
      const duration = 240 + Math.round(Math.random() * 620)
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        markStatus(id, 'running', { attempts: attempt > 1 ? attempt : undefined })
        await delay(duration)
        if (isCancelled()) return { ok: false, attempts: attempt, duration, rows: 0 }
        if (Math.random() > FAILURE_RATE) {
          return { ok: true, attempts: attempt, duration, rows: 1200 + Math.round(Math.random() * 88000) }
        }
        if (attempt < maxAttempts) {
          retriedNodes += 1
          markStatus(id, 'queued')
          await delay(320)
          if (isCancelled()) return { ok: false, attempts: attempt, duration, rows: 0 }
        }
      }
      return { ok: false, attempts: maxAttempts, duration, rows: 0 }
    }

    function pump() {
      while (!isCancelled() && runningCount < concurrency && queue.length) {
        const id = queue.shift()!
        nodeStates.set(id, 'running')
        runningCount += 1
        void executeNode(id).then((result) => {
          runningCount -= 1
          if (isCancelled()) {
            nodeStates.set(id, 'pending')
            return
          }
          if (result.ok) {
            nodeStates.set(id, 'done')
            recordMap.set(id, {
              nodeId: id,
              basis: bases.get(id) ?? '',
              status: 'success',
              attempts: result.attempts,
              duration: result.duration,
              rows: result.rows,
              ranAt: new Date().toISOString(),
            })
            markStatus(id, 'success', {
              duration: result.duration,
              rows: result.rows,
              attempts: result.attempts > 1 ? result.attempts : undefined,
            })
          } else {
            nodeStates.set(id, 'failed')
            failedCount += 1
            recordMap.set(id, {
              nodeId: id,
              basis: bases.get(id) ?? '',
              status: 'error',
              attempts: result.attempts,
              duration: result.duration,
              error: `节点执行失败，已重试 ${result.attempts - 1} 次`,
              ranAt: new Date().toISOString(),
            })
            markStatus(id, 'error', { duration: result.duration, rows: undefined, attempts: result.attempts })
            ;(downstream.get(id) ?? []).forEach(skipNode)
          }
          ;(downstream.get(id) ?? []).forEach((downId) => {
            if (nodeStates.get(downId) === 'pending') {
              const left = (remaining.get(downId) ?? 1) - 1
              remaining.set(downId, left)
              if (left === 0) {
                nodeStates.set(downId, 'queued')
                queue.push(downId)
              }
            }
          })
          pump()
          checkDone()
        })
      }
    }

    function checkDone() {
      if (isCancelled()) return
      if (runningCount !== 0 || queue.length !== 0) return
      const unsettled = [...nodeStates.values()].some((s) => s === 'pending' || s === 'queued' || s === 'running')
      if (unsettled) return
      finishRun()
    }

    function finishRun() {
      if (isCancelled()) return
      const elapsed = Date.now() - startedAt
      const reusedCount = order.filter((id) =>
        state.runRecords.some((record) => record.nodeId === id && record.basis === bases.get(id) && record.status === 'success'),
      ).length
      set((draft) => {
        draft.running = false
        draft.cancelRequested = false
        draft.runRecords = order
          .map((id) => recordMap.get(id))
          .filter((record): record is RunRecord => Boolean(record))
        if (reusedCount === order.length) {
          draft.notice = '所有节点结果均为最新，本次无需重算'
        } else if (!failedCount && !skippedCount) {
          draft.notice = `执行完成：成功 ${order.length} 个${reusedCount ? `（沿用 ${reusedCount} 个旧结果）` : ''}${retriedNodes ? `，重试 ${retriedNodes} 个节点` : ''}，并发上限 ${concurrency}，总耗时 ${elapsed} ms`
        } else {
          draft.notice = `执行完成：失败 ${failedCount} 个，跳过下游 ${skippedCount} 个，其余分支照常跑完${retriedNodes ? `，重试 ${retriedNodes} 个节点` : ''}，总耗时 ${elapsed} ms`
        }
      })
    }

    pump()

    // 等待整次运行结束（正常完成或被中断）后再返回，便于调用方收起 loading
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        if (!get().running) {
          window.clearInterval(timer)
          resolve()
        }
      }, 120)
    })
  },

  cancelRun: () => set((draft) => {
    if (!draft.running) return
    draft.cancelRequested = true
    draft.running = false
    draft.nodes.forEach((node) => {
      if (node.data.status === 'queued' || node.data.status === 'running') {
        node.data.status = 'idle'
        node.data.duration = undefined
        node.data.rows = undefined
        node.data.attempts = undefined
      }
    })
    draft.notice = '已中断当前执行，排队中的节点已重置为待执行'
  }),

  loadDocument: (document) => {
    set((draft) => {
      draft.name = document.name
      draft.nodes = document.nodes
      draft.edges = document.edges
      draft.past = []
      draft.future = []
      draft.selectedNodeId = null
      draft.selectedEdgeId = null
      draft.cancelRequested = false
      draft.runRecords = document.runRecords ?? []
      draft.nodes.forEach((node) => {
        const record = draft.runRecords.find((item) => item.nodeId === node.id)
        if (record) {
          node.data.status = record.status === 'success'
            ? 'success'
            : record.status === 'skipped'
              ? 'skipped'
              : 'error'
          node.data.duration = record.duration
          node.data.rows = record.rows
          node.data.attempts = record.attempts > 1 ? record.attempts : undefined
        } else {
          node.data.status = 'idle'
          node.data.duration = undefined
          node.data.rows = undefined
          node.data.attempts = undefined
        }
      })
      invalidateStale(draft)
      draft.notice = draft.runRecords.length
        ? '流程 JSON 已导入，运行记录已恢复'
        : '流程 JSON 已导入'
    })
    // 旧文件缺少运行记录：打开后按顺序执行一遍以补齐结果
    if (!document.runRecords?.length) {
      get().simulate({ sequential: true })
    }
  },

  reset: () => set((draft) => {
    pushHistory(draft)
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.runRecords = []
    draft.cancelRequested = false
    draft.notice = '已恢复示例流程'
  }),
})))

export const nodeDefinitions = NODE_DEFINITIONS

export function statusLabel(status: RunStatus) {
  return {
    idle: '待执行',
    queued: '已排队',
    running: '运行中',
    success: '执行成功',
    error: '执行失败',
    skipped: '已跳过',
  }[status]
}
