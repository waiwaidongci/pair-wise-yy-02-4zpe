import { App as AntApp, Button, Input, Select, Space, Tooltip, Upload } from 'antd'
import {
  ApartmentOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  SnippetsOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useRef } from 'react'
import type { UploadProps } from 'antd'
import NodePalette from '../components/NodePalette'
import Inspector from '../components/Inspector'
import WorkflowCanvas from '../components/WorkflowCanvas'
import { useWorkflowStore } from '../stores/workflow'

export default function EditorView() {
  const { message } = AntApp.useApp()
  const uploadRef = useRef<HTMLInputElement>(null)
  const store = useWorkflowStore()

  function exportJson() {
    const document = store.exportDocument()
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${store.name.replace(/\s+/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    message.success('流程与运行记录已导出')
  }

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: async (file) => {
      try {
        const raw = JSON.parse(await file.text())
        const { legacy } = store.loadDocument(raw)
        message.success(legacy ? '旧版流程已按顺序执行模式打开' : '流程与运行记录导入成功')
      } catch (error) {
        message.error(error instanceof Error ? error.message : '流程 JSON 无效')
      }
      return false
    },
  }

  async function run() {
    message.loading({ content: '正在排队执行…', key: 'run' })
    await store.simulate()
    const latest = useWorkflowStore.getState()
    if (latest.notice.includes('中断')) {
      message.warning({ content: latest.notice, key: 'run' })
    } else if (latest.notice.includes('失败') || latest.notice.includes('跳过')) {
      message.warning({ content: latest.notice, key: 'run' })
    } else {
      message.success({ content: latest.notice, key: 'run' })
    }
  }

  return (
    <div className="editor-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">FP</div>
          <div><strong>FlowPilot</strong><span>数据工作流编排平台</span></div>
        </div>
        <Input
          className="flow-name"
          value={store.name}
          onChange={(event) => store.setName(event.target.value)}
          prefix={<SnippetsOutlined />}
        />
        <Space wrap>
          <Tooltip title="撤销"><Button icon={<UndoOutlined />} disabled={!store.past.length} onClick={store.undo} /></Tooltip>
          <Tooltip title="重做"><Button icon={<RedoOutlined />} disabled={!store.future.length} onClick={store.redo} /></Tooltip>
          <Tooltip title="复制"><Button icon={<CopyOutlined />} onClick={store.copySelection} /></Tooltip>
          <Tooltip title="粘贴"><Button icon={<SnippetsOutlined />} onClick={store.pasteSelection} /></Tooltip>
          <Tooltip title="删除"><Button danger icon={<DeleteOutlined />} onClick={store.deleteSelection} /></Tooltip>
          <Button icon={<ApartmentOutlined />} onClick={store.layout}>自动布局</Button>
          <Upload {...uploadProps}><Button icon={<CloudUploadOutlined />}>导入</Button></Upload>
          <Button icon={<CloudDownloadOutlined />} onClick={exportJson}>导出</Button>
          <Button icon={<ReloadOutlined />} onClick={store.reset}>重置</Button>
          <Tooltip title={store.sequentialMode ? '旧版文件按顺序执行（并发 1）打开，可在此调整' : '同时运行的节点数量上限，到顶后其余节点排队'}>
            <span className="concurrency-picker">
              <span className="concurrency-label">并发</span>
              <Select
                size="middle"
                value={store.maxConcurrency}
                disabled={store.running}
                style={{ width: 74 }}
                onChange={(value) => store.setMaxConcurrency(value)}
                options={[1, 2, 3, 4, 6, 8].map((value) => ({ value, label: value === 1 ? '顺序' : value }))}
              />
            </span>
          </Tooltip>
          {store.running ? (
            <Button danger icon={<PauseCircleOutlined />} onClick={store.stopRun}>中断</Button>
          ) : (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={run}>执行</Button>
          )}
        </Space>
      </header>
      <main className="editor-grid">
        <NodePalette />
        <WorkflowCanvas />
        <Inspector />
      </main>
    </div>
  )
}
