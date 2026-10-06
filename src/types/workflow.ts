import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped'
export type RunRecordStatus = 'success' | 'error' | 'skipped'

export interface NodeConfig {
  [key: string]: string | number | boolean
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string
  kind: NodeKind
  description: string
  config: NodeConfig
  status: RunStatus
  /** 失败后重试次数（不含首次执行） */
  retries?: number
  /** 最近一次运行实际尝试次数（含首次） */
  attempts?: number
  duration?: number
  rows?: number
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

export interface RunRecord {
  nodeId: string
  /** 结果依据：节点参数与上游依据的递归哈希，依据变化即失效 */
  basis: string
  status: RunRecordStatus
  attempts: number
  duration?: number
  rows?: number
  error?: string
  ranAt: string
}

export interface WorkflowDocument {
  version: 1 | 2
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  savedAt: string
  runRecords?: RunRecord[]
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
