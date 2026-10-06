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
  NodeRunRecord,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import {
  autoLayout,
  computeBasisMap,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  normalizeDocument,
  NODE_DEFINITIONS,
  reconcileRunState,
  sampleWorkflow,
} from '../utils/workflow'
import { runWorkflow, type AttemptOutcome } from '../utils/scheduler'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  runRecords: Record<string, NodeRunRecord>
}

interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  runRecords: Record<string, NodeRunRecord>
  maxConcurrency: number
  selectedNodeId: string | null
  selectedEdgeId: string | null
  past: Snapshot[]
  future: Snapshot[]
  clipboard: WorkflowNode[]
  notice: string
  running: boolean
  /** 是否处于「旧文件无运行记录，按顺序执行打开」模式 */
  sequentialMode: boolean
  abortController: AbortController | null
  setName: (name: string) => void
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void
  connect: (connection: Connection) => boolean
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateNode: (id: string, patch: Partial<WorkflowNode['data']>) => void
  updateConfig: (id: string, key: string, value: string | number | boolean) => void
  setMaxRetries: (id: string, value: number) => void
  setMaxConcurrency: (value: number) => void
  deleteSelection: () => void
  copySelection: () => void
  pasteSelection: () => void
  layout: () => void
  undo: () => void
  redo: () => void
  clearNotice: () => void
  simulate: () => Promise<void>
  stopRun: () => void
  exportDocument: () => WorkflowDocument
  loadDocument: (document: WorkflowDocument | unknown) => { legacy: boolean }
  reset: () => void
}

const initial = sampleWorkflow()
const initialBasis = computeBasisMap(initial.nodes, initial.edges)
initial.nodes.forEach((node) => { node.data.basis = initialBasis.get(node.id) })

function snapshot(state: Pick<WorkflowState, 'nodes' | 'edges' | 'runRecords'>): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
    runRecords: JSON.parse(JSON.stringify(state.runRecords)) as Record<string, NodeRunRecord>,
  }
}

function pushHistory(state: WorkflowState) {
  state.past.push(snapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

/** 按当前参数/连线重算依据并级联标记失效（不在执行期间调用） */
function reconcile(state: WorkflowState) {
  state.runRecords = reconcileRunState(state.nodes, state.edges, state.runRecords)
}

const ERROR_MESSAGES = [
  '读取数据源超时，连接池耗尽',
  '表达式引用了不存在的字段',
  '关联键存在空值，违反非空约束',
  '分组字段类型不兼容',
  '写入目标存储失败，节点重试后仍不可用',
]

function seededRandom(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0xffffffff
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const useWorkflowStore = create<WorkflowState>()(immer((set, get) => ({
  name: '订单经营分析流程',
  nodes: initial.nodes,
  edges: initial.edges,
  runRecords: {},
  maxConcurrency: 2,
  selectedNodeId: null,
  selectedEdgeId: null,
  past: [],
  future: [],
  clipboard: [],
  notice: '端口与类型校验已开启',
  running: false,
  sequentialMode: false,
  abortController: null,

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    const removed = changes.some((change) => change.type === 'remove')
    state.nodes = applyNodeChanges(changes, state.nodes)
    if (removed) {
      state.edges = state.edges.filter((edge) => state.nodes.some((node) => node.id === edge.source)
        && state.nodes.some((node) => node.id === edge.target))
      if (!state.running) reconcile(state)
    }
  }),

  onEdgesChange: (changes) => set((state) => {
    const removed = changes.some((change) => change.type === 'remove')
    state.edges = applyEdgeChanges(changes, state.edges)
    if (removed && !state.running) reconcile(state)
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
      reconcile(draft)
      draft.notice = '连接成功，受影响节点的旧结果已标记失效'
    })
    return true
  },

  addNode: (kind, position) => set((draft) => {
    pushHistory(draft)
    const node = createWorkflowNode(kind, position ?? { x: 120 + draft.nodes.length * 28, y: 120 + draft.nodes.length * 22 })
    draft.nodes.push(node)
    draft.selectedNodeId = node.id
    draft.selectedEdgeId = null
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
    if (node) node.data = { ...node.data, ...patch }
  }),

  updateConfig: (id, key, value) => set((draft) => {
    pushHistory(draft)
    const node = draft.nodes.find((item) => item.id === id)
    if (node) node.data.config[key] = value
    if (!draft.running) {
      reconcile(draft)
      draft.notice = '参数已更新，该节点及其下游旧结果失效，将按新依据重算'
    }
  }),

  setMaxRetries: (id, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (node) node.data.maxRetries = Math.min(5, Math.max(0, value))
  }),

  setMaxConcurrency: (value) => set((draft) => {
    draft.maxConcurrency = Math.min(8, Math.max(1, value))
  }),

  deleteSelection: () => set((draft) => {
    if (!draft.selectedNodeId && !draft.selectedEdgeId) return
    pushHistory(draft)
    if (draft.selectedNodeId) {
      const id = draft.selectedNodeId
      draft.nodes = draft.nodes.filter((node) => node.id !== id)
      draft.edges = draft.edges.filter((edge) => edge.source !== id && edge.target !== id)
      delete draft.runRecords[id]
      draft.selectedNodeId = null
    }
    if (draft.selectedEdgeId) {
      draft.edges = draft.edges.filter((edge) => edge.id !== draft.selectedEdgeId)
      draft.selectedEdgeId = null
    }
    if (!draft.running) reconcile(draft)
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
      copy.data.status = 'idle'
      copy.data.stale = undefined
      draft.nodes.push(copy)
      return copy
    })
    draft.selectedNodeId = copies[0]?.id ?? null
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
    draft.runRecords = previous.runRecords
    draft.notice = '已撤销上一步操作'
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    draft.runRecords = next.runRecords
    draft.notice = '已恢复操作'
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  simulate: async () => {
    const state = get()
    if (state.running) return

    // 执行前按当前参数/连线刷新一次依据，确保编辑期间没有覆盖到的状态被补齐
    const basisMap = computeBasisMap(state.nodes, state.edges)
    const basisById = new Map(state.nodes.map((node) => [node.id, basisMap.get(node.id)]))
    const isFresh = (id: string) => {
      const record = get().runRecords[id]
      const basis = basisById.get(id)
      return record?.status === 'success' && basis !== undefined && record.basis === basis
    }

    const abortController = new AbortController()
    const startedAt = Date.now()

    set((draft) => {
      draft.running = true
      draft.abortController = abortController
      draft.nodes.forEach((node) => {
        node.data.basis = basisById.get(node.id)
        node.data.stale = undefined
        if (!isFresh(node.id)) {
          node.data.status = 'queued'
          node.data.duration = undefined
          node.data.rows = undefined
          node.data.attempts = undefined
          node.data.errorMessage = undefined
        }
      })
    })

    const patchNode = (id: string, apply: (data: WorkflowNode['data']) => void) => {
      set((draft) => {
        const node = draft.nodes.find((item) => item.id === id)
        if (node) apply(node.data)
      })
    }

    const persistRecord = (id: string, record: NodeRunRecord) => {
      set((draft) => { draft.runRecords[id] = record })
    }

    let result
    try {
      result = await runWorkflow({
        nodes: get().nodes,
        edges: get().edges,
        maxConcurrency: get().maxConcurrency,
        maxRetriesFor: (id) => get().nodes.find((node) => node.id === id)?.data.maxRetries ?? 1,
        signal: abortController.signal,
        isFresh,
        listeners: {
          onReuse: (id) => patchNode(id, (data) => { data.status = 'success' }),
          onReset: (id) => patchNode(id, (data) => { data.status = 'queued' }),
          onQueue: (id) => patchNode(id, (data) => { data.status = 'queued' }),
          onStart: (id, attempt) => patchNode(id, (data) => {
            data.status = 'running'
            data.attempts = attempt
            data.errorMessage = undefined
          }),
          onRetry: (id, attempt, errorMessage) => patchNode(id, (data) => {
            data.status = 'running'
            data.attempts = attempt + 1
            data.errorMessage = `第 ${attempt} 次尝试失败：${errorMessage}`
          }),
          onSuccess: (id, outcome, attempts, runStartedAt, finishedAt) => {
            patchNode(id, (data) => {
              data.status = 'success'
              data.duration = outcome.duration
              data.rows = outcome.rows
              data.attempts = attempts
              data.errorMessage = undefined
            })
            persistRecord(id, {
              status: 'success',
              basis: basisById.get(id) ?? '',
              startedAt: runStartedAt,
              finishedAt,
              duration: outcome.duration,
              ...(outcome.rows !== undefined ? { rows: outcome.rows } : {}),
              attempts,
            })
          },
          onError: (id, errorMessage, attempts, runStartedAt, finishedAt, durations) => {
            const duration = durations.reduce((sum, item) => sum + item, 0)
            patchNode(id, (data) => {
              data.status = 'error'
              data.duration = duration
              data.attempts = attempts
              data.errorMessage = errorMessage
            })
            persistRecord(id, {
              status: 'error',
              basis: basisById.get(id) ?? '',
              startedAt: runStartedAt,
              finishedAt,
              duration,
              attempts,
              errorMessage,
            })
          },
          onSkip: (id, reason) => {
            patchNode(id, (data) => {
              data.status = 'skipped'
              data.duration = undefined
              data.rows = undefined
              data.attempts = undefined
              data.errorMessage = reason
            })
            persistRecord(id, {
              status: 'skipped',
              basis: basisById.get(id) ?? '',
              finishedAt: new Date().toISOString(),
              errorMessage: reason,
            })
          },
          onAbortIdle: (ids) => {
            set((draft) => {
              ids.forEach((id) => {
                const node = draft.nodes.find((item) => item.id === id)
                if (node) {
                  node.data.status = 'idle'
                  node.data.errorMessage = undefined
                }
              })
            })
          },
        },
        runAttempt: async (id, attempt, signal): Promise<AttemptOutcome> => {
          const basis = basisById.get(id) ?? id
          // 同样的依据与尝试序号给出确定结果，重试才有可能转成功
          const roll = seededRandom(`${basis}:${attempt}`)
          const failChance = attempt === 1 ? 0.24 : 0.16
          const duration = attempt === 1
            ? 240 + Math.round(seededRandom(`${basis}:dur1`) * 620)
            : 160 + Math.round(seededRandom(`${basis}:dur${attempt}`) * 300)
          await delay(duration, signal)
          if (signal.aborted) return { ok: false, duration: 0 }
          if (roll < failChance) {
            return {
              ok: false,
              duration,
              errorMessage: ERROR_MESSAGES[Math.floor(seededRandom(`${basis}:err${attempt}`) * ERROR_MESSAGES.length)] ?? '执行失败',
            }
          }
          return {
            ok: true,
            duration,
            rows: 1200 + Math.round(seededRandom(`${basis}:rows${attempt}`) * 88000),
          }
        },
      })
    } catch (error) {
      set((draft) => {
        draft.running = false
        draft.abortController = null
        draft.notice = error instanceof Error ? error.message : '执行失败'
      })
      return
    }

    set((draft) => {
      draft.running = false
      draft.abortController = null
      // 执行期间若参数/连线被改过，按最新依据重新对账失效标记
      reconcile(draft)
      const elapsed = Date.now() - startedAt
      if (result.aborted) {
        draft.notice = '执行已中断，已完成节点的结果保留，可再次执行继续'
      } else if (result.failed > 0) {
        draft.notice = `执行结束：失败 ${result.failed} 个、跳过下游 ${result.skipped} 个，其余分支已跑完（耗时 ${elapsed} ms）`
      } else if (result.skipped > 0) {
        draft.notice = `执行结束：跳过 ${result.skipped} 个节点（耗时 ${elapsed} ms）`
      } else {
        draft.notice = `执行完成：并发 ${draft.maxConcurrency}，总耗时 ${elapsed} ms`
      }
    })
  },

  stopRun: () => set((draft) => {
    if (!draft.running || !draft.abortController) return
    draft.abortController.abort()
    draft.notice = '正在中断，等待运行中的节点结束…'
  }),

  exportDocument: () => {
    const state = get()
    return {
      version: 2 as const,
      name: state.name,
      nodes: state.nodes,
      edges: state.edges,
      maxConcurrency: state.maxConcurrency,
      runRecords: state.runRecords,
      savedAt: new Date().toISOString(),
    }
  },

  loadDocument: (document) => {
    const normalized = normalizeDocument(document)
    set((draft) => {
      draft.name = normalized.name
      draft.nodes = normalized.nodes
      draft.edges = normalized.edges
      draft.runRecords = normalized.runRecords
      draft.maxConcurrency = normalized.maxConcurrency
      draft.sequentialMode = normalized.legacy
      draft.past = []
      draft.future = []
      draft.selectedNodeId = null
      draft.selectedEdgeId = null
      draft.running = false
      draft.abortController = null
      draft.notice = normalized.legacy
        ? '旧版文件无运行记录，已按顺序执行（并发 1）打开'
        : '流程 JSON 与运行记录已导入'
    })
    return { legacy: normalized.legacy }
  },

  reset: () => set((draft) => {
    pushHistory(draft)
    const fresh = sampleWorkflow()
    const basisMap = computeBasisMap(fresh.nodes, fresh.edges)
    fresh.nodes.forEach((node) => { node.data.basis = basisMap.get(node.id) })
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.runRecords = {}
    draft.sequentialMode = false
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
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
