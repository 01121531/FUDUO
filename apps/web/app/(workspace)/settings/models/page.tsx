import { ModelsPanel } from "@/components/models-panel";

export default function ModelsPage() {
  return <div className="page"><div className="page-header"><div><h1 className="page-title">模型管理</h1><p className="page-description">配置供应商，并为默认对话、复杂分析和故障降级选择模型</p></div></div><ModelsPanel /></div>;
}
