import { UpdatePanel } from "@/components/update-panel";

export default function UpdatePage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">在线更新</h1>
          <p className="page-description">检查 GitHub Release，并更新 Docker 或源码部署</p>
        </div>
      </div>
      <UpdatePanel />
    </div>
  );
}
