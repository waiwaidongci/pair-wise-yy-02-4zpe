import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped'

export interface NodeConfig {
  [key: string]: string | number | boolean
}

/** 节点一次执行留下的记录，随流程一起导出 */
export interface NodeRunRecord {
  status: RunStatus
  basis: string
  startedAt?: string
  finishedAt?: string
  duration?: number
  rows?: number
  attempts?: number
  errorMessage?: string
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string
  kind: NodeKind
  description: string
  config: NodeConfig
  status: RunStatus
  /** 失败后允许的重试次数（不含首次） */
  maxRetries: number
  duration?: number
  rows?: number
  /** 最近一次执行的尝试次数 */
  attempts?: number
  /** 失败原因 */
  errorMessage?: string
  /** 当前配置/连线对应的结果依据哈希 */
  basis?: string
  /** 沿用的旧结果是否已失效，需要按新依据重算 */
  stale?: boolean
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

export interface WorkflowDocument {
  version: 2
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  /** 最大并发执行数 */
  maxConcurrency: number
  /** 旧版本文件没有运行记录，按顺序执行打开 */
  runRecords?: Record<string, NodeRunRecord>
  savedAt: string
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
