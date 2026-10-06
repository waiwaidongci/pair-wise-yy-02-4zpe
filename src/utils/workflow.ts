import type { Connection } from '@xyflow/react'
import type { NodeDefinition, NodeRunRecord, PortType, WorkflowDocument, WorkflowEdge, WorkflowNode } from '../types/workflow'

export const NODE_DEFINITIONS: NodeDefinition[] = [
  {
    kind: 'source',
    label: '数据源',
    description: '读取订单、用户或日志数据集',
    color: '#2563eb',
    inputs: [],
    outputs: ['dataset'],
  },
  {
    kind: 'transform',
    label: '字段变换',
    description: '清洗、映射与派生字段',
    color: '#0891b2',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'filter',
    label: '条件过滤',
    description: '按表达式筛选数据行',
    color: '#7c3aed',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'aggregate',
    label: '聚合计算',
    description: '分组汇总并输出指标',
    color: '#ca8a04',
    inputs: ['dataset'],
    outputs: ['number'],
  },
  {
    kind: 'join',
    label: '双流关联',
    description: '按关联键合并两路数据',
    color: '#db2777',
    inputs: ['dataset', 'dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'sink',
    label: '结果输出',
    description: '写入数据仓库或消息队列',
    color: '#16a34a',
    inputs: ['dataset', 'number'],
    outputs: [],
  },
]

export function definitionFor(kind: WorkflowNode['data']['kind']) {
  return NODE_DEFINITIONS.find((item) => item.kind === kind) ?? NODE_DEFINITIONS[0]
}

export function defaultConfig(kind: WorkflowNode['data']['kind']) {
  const configs: Record<WorkflowNode['data']['kind'], Record<string, string | number | boolean>> = {
    source: { source: '订单主表', refresh: '实时', sampleRows: 125000 },
    transform: { expression: 'amount * 1.06', outputField: 'amount_with_tax', keepOriginal: true },
    filter: { expression: 'status == "已支付"', limit: 50000 },
    aggregate: { groupBy: 'region', metric: 'sum(amount)', outputField: 'region_total' },
    join: { joinType: 'left', leftKey: 'customer_id', rightKey: 'id' },
    sink: { target: '分析数据集市', mode: 'upsert', partition: 'dt' },
  }
  return configs[kind]
}

export function createWorkflowNode(
  kind: WorkflowNode['data']['kind'],
  position: { x: number; y: number },
  id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
): WorkflowNode {
  const definition = definitionFor(kind)
  return {
    id,
    type: 'workflow',
    position,
    data: {
      label: definition.label,
      kind,
      description: definition.description,
      config: defaultConfig(kind),
      status: 'idle',
      maxRetries: 1,
    },
  }
}

export function portAt(node: WorkflowNode, handle: string | null | undefined): { direction: 'input' | 'output'; type: PortType; index: number } | null {
  if (!handle) return null
  const match = /^(in|out)-(\d+)$/.exec(handle)
  if (!match) return null
  const definition = definitionFor(node.data.kind)
  const index = Number(match[2])
  const direction = match[1] === 'in' ? 'input' : 'output'
  const type = direction === 'input' ? definition.inputs[index] : definition.outputs[index]
  return type ? { direction, type, index } : null
}

export function connectionError(connection: Connection, nodes: WorkflowNode[]): string | null {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
    return '连接缺少有效的源端口或目标端口'
  }
  if (connection.source === connection.target) return '节点不能连接到自身'

  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return '连接节点不存在'

  const sourcePort = portAt(source, connection.sourceHandle)
  const targetPort = portAt(target, connection.targetHandle)
  if (!sourcePort || sourcePort.direction !== 'output') return '源端口类型无效'
  if (!targetPort || targetPort.direction !== 'input') return '目标端口类型无效'

  const compatible = sourcePort.type === 'any'
    || targetPort.type === 'any'
    || sourcePort.type === targetPort.type
  if (!compatible) return `端口类型不兼容：${sourcePort.type} → ${targetPort.type}`

  return null
}

export function createsCycle(connection: Connection, edges: WorkflowEdge[]): boolean {
  if (!connection.source || !connection.target) return false
  const adjacency = new Map<string, string[]>()
  edges.forEach((edge) => {
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  })
  const sourceList = adjacency.get(connection.source) ?? []
  sourceList.push(connection.target)
  adjacency.set(connection.source, sourceList)

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (hasCycle(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return [...adjacency.keys()].some(hasCycle)
}

export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  edges.forEach((edge) => {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const result: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return result
}

/** 稳定 JSON 序列化：对象键排序，键序不同不会产生不同依据 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** FNV-1a 32 位哈希，把节点结果依据压缩成短字符串 */
export function hashBasis(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

/**
 * 计算每个节点当前的结果依据：自身类型与业务参数 + 每条入边（来源、端口、上游依据）。
 * 入边或上游依据一变，依据随之改变，从而级联反映到所有下游。
 */
export function computeBasisMap(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, string> {
  const order = topologicalOrder(nodes, edges)
  const incoming = new Map<string, WorkflowEdge[]>()
  edges.forEach((edge) => {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  })
  const basisMap = new Map<string, string>()
  for (const id of order) {
    const node = nodes.find((item) => item.id === id)
    if (!node) continue
    const inputs = (incoming.get(id) ?? [])
      .slice()
      .sort((a, b) => (a.targetHandle ?? '').localeCompare(b.targetHandle ?? ''))
      .map((edge) => ({
        source: edge.source,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        portType: edge.data?.portType ?? 'dataset',
        upstream: basisMap.get(edge.source) ?? null,
      }))
    basisMap.set(id, hashBasis(stableStringify({ kind: node.data.kind, config: node.data.config, inputs })))
  }
  // 存在环时环内节点排不出拓扑序，退化为仅按自身配置计算依据
  for (const node of nodes) {
    if (!basisMap.has(node.id)) {
      basisMap.set(node.id, hashBasis(stableStringify({ kind: node.data.kind, config: node.data.config })))
    }
  }
  return basisMap
}

/**
 * 依据最新参数与连线重算各节点 basis，并标记沿用旧结果（成功记录的依据对不上）的节点为 stale。
 * 直接改写传入节点；返回剔除了游离记录后的运行记录表。
 */
export function reconcileRunState(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  records: Record<string, NodeRunRecord>,
): Record<string, NodeRunRecord> {
  const basisMap = computeBasisMap(nodes, edges)
  const next: Record<string, NodeRunRecord> = {}
  for (const node of nodes) {
    const basis = basisMap.get(node.id)
    if (basis) node.data.basis = basis
    const record = records[node.id]
    if (record) {
      next[node.id] = record
      // 沿用的旧结果（成功/失败/跳过）依据对不上即失效；执行时只有依据一致的成功结果才会被沿用
      node.data.stale = basis !== undefined && record.basis !== basis ? true : undefined
    } else {
      node.data.stale = undefined
    }
  }
  return next
}

export interface NormalizedDocument {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  maxConcurrency: number
  runRecords: Record<string, NodeRunRecord>
  /** 旧版本文件：没有运行记录，按顺序执行（并发 = 1）打开 */
  legacy: boolean
}

function clampRetry(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return 1
  return Math.min(5, Math.max(0, Math.round(num)))
}

/** 解析导入的流程文件，兼容没有运行记录的旧文件 */
export function normalizeDocument(raw: unknown): NormalizedDocument {
  if (!raw || typeof raw !== 'object') throw new Error('流程 JSON 无效')
  const doc = raw as Partial<WorkflowDocument>
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('JSON 缺少 nodes 或 edges')
  const legacy = doc.version !== 2 || !doc.runRecords
  const recordsInput = legacy ? {} : (doc.runRecords as Record<string, NodeRunRecord>)
  const validStatus: NodeRunRecord['status'][] = ['success', 'error', 'skipped']

  const nodes = doc.nodes.map((rawNode) => {
    const record = recordsInput[rawNode.id]
    const usableRecord = record && validStatus.includes(record.status) && typeof record.basis === 'string' ? record : undefined
    const node: WorkflowNode = {
      ...rawNode,
      data: {
        ...rawNode.data,
        config: rawNode.data?.config ?? {},
        maxRetries: clampRetry(rawNode.data?.maxRetries),
        status: usableRecord ? usableRecord.status : 'idle',
        duration: usableRecord?.duration,
        rows: usableRecord?.rows,
        attempts: usableRecord?.attempts,
        errorMessage: usableRecord?.errorMessage,
        basis: usableRecord?.basis,
      },
    }
    return node
  })

  const edges = doc.edges.map((edge) => ({
    ...edge,
    data: { portType: edge.data?.portType ?? 'dataset' },
  }))

  const runRecords: Record<string, NodeRunRecord> = {}
  nodes.forEach((node) => {
    const record = recordsInput[node.id]
    if (record && validStatus.includes(record.status) && typeof record.basis === 'string') {
      runRecords[node.id] = {
        status: record.status,
        basis: record.basis,
        ...(record.startedAt ? { startedAt: record.startedAt } : {}),
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        ...(record.duration !== undefined ? { duration: record.duration } : {}),
        ...(record.rows !== undefined ? { rows: record.rows } : {}),
        ...(record.attempts !== undefined ? { attempts: record.attempts } : {}),
        ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
      }
    }
  })

  const reconciled = reconcileRunState(nodes, edges, runRecords)
  const maxConcurrency = legacy ? 1 : Math.min(8, Math.max(1, Number(doc.maxConcurrency) || 2))
  return {
    name: typeof doc.name === 'string' ? doc.name : '未命名流程',
    nodes,
    edges,
    maxConcurrency,
    runRecords: reconciled,
    legacy,
  }
}

export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const order = topologicalOrder(nodes, edges)
  const depth = new Map<string, number>()
  order.forEach((id) => {
    const parents = edges.filter((edge) => edge.target === id)
    depth.set(id, parents.length ? Math.max(...parents.map((edge) => (depth.get(edge.source) ?? 0) + 1)) : 0)
  })
  const columns = new Map<number, WorkflowNode[]>()
  nodes.forEach((node) => {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  })
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 0
    const index = (columns.get(column) ?? []).findIndex((item) => item.id === node.id)
    return { ...node, position: { x: 90 + column * 260, y: 90 + index * 150 } }
  })
}

export function sampleWorkflow(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const source = createWorkflowNode('source', { x: 60, y: 150 }, 'source-orders')
  source.data.label = '订单实时流'
  const filter = createWorkflowNode('filter', { x: 330, y: 70 }, 'filter-paid')
  filter.data.label = '筛选已支付订单'
  const transform = createWorkflowNode('transform', { x: 330, y: 250 }, 'transform-clean')
  transform.data.label = '清洗收货信息'
  const join = createWorkflowNode('join', { x: 610, y: 160 }, 'join-customer')
  join.data.label = '关联客户画像'
  const aggregate = createWorkflowNode('aggregate', { x: 880, y: 160 }, 'aggregate-region')
  aggregate.data.label = '区域销售聚合'
  const sink = createWorkflowNode('sink', { x: 1150, y: 160 }, 'sink-warehouse')
  sink.data.label = '写入经营看板'
  return {
    nodes: [source, filter, transform, join, aggregate, sink],
    edges: [
      { id: 'e1', source: source.id, sourceHandle: 'out-0', target: filter.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' }, animated: true },
      { id: 'e2', source: source.id, sourceHandle: 'out-0', target: transform.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e3', source: filter.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e4', source: transform.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e5', source: join.id, sourceHandle: 'out-0', target: aggregate.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e6', source: aggregate.id, sourceHandle: 'out-0', target: sink.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'number' } },
    ],
  }
}
