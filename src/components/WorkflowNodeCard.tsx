import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  ExclamationCircleFilled,
  LoadingOutlined,
  MinusCircleFilled,
  WarningFilled,
} from '@ant-design/icons'
import type { RunStatus, WorkflowNode } from '../types/workflow'
import { definitionFor } from '../utils/workflow'

const statusIcon: Record<RunStatus, React.ReactNode> = {
  idle: <ClockCircleOutlined />,
  queued: <ClockCircleOutlined />,
  running: <LoadingOutlined spin />,
  success: <CheckCircleFilled />,
  error: <CloseCircleFilled />,
  skipped: <MinusCircleFilled />,
}

export default function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowNode>) {
  const definition = definitionFor(data.kind)
  const retrying = data.status === 'running' && (data.attempts ?? 1) > 1
  return (
    <div
      className={`workflow-node ${selected ? 'is-selected' : ''} status-${data.status} ${data.stale ? 'is-stale' : ''}`}
      style={{ '--node-color': definition.color } as React.CSSProperties}
    >
      {definition.inputs.map((type, index) => (
        <Handle
          key={`in-${index}`}
          id={`in-${index}`}
          type="target"
          position={Position.Left}
          className={`port port-${type}`}
          style={{ top: 46 + index * 34 }}
        />
      ))}
      <div className="workflow-node-head">
        <span className="node-kind">{data.kind}</span>
        <span className={`node-status status-${data.status}`}>
          {statusIcon[data.status]}
          {retrying ? `重试 ${data.attempts}` : data.status}
        </span>
      </div>
      <strong>{data.label}</strong>
      {data.stale && (
        <div className="stale-chip"><WarningFilled /> 结果已失效</div>
      )}
      <p>{data.description}</p>
      {data.status === 'error' && data.errorMessage && (
        <div className="node-error"><ExclamationCircleFilled /> {data.errorMessage}</div>
      )}
      {data.status === 'skipped' && data.errorMessage && (
        <div className="node-skip">{data.errorMessage}</div>
      )}
      <div className="node-metrics">
        {data.rows !== undefined && <span>{data.rows.toLocaleString('zh-CN')} 行</span>}
        {data.duration !== undefined && <span>{data.duration} ms</span>}
      </div>
      {definition.outputs.map((type, index) => (
        <Handle
          key={`out-${index}`}
          id={`out-${index}`}
          type="source"
          position={Position.Right}
          className={`port port-${type}`}
          style={{ top: 50 + index * 34 }}
        />
      ))}
    </div>
  )
}
