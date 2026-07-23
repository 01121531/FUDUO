import { ExtensionWorkbench } from "@/components/extension-workbench";

export default function ExtensionsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">扩展工厂</h1>
          <p className="page-description">通过对话生成、校验并审批 OpenClaw Skills 与 MCP 扩展</p>
        </div>
      </div>
      <ExtensionWorkbench />
    </div>
  );
}
