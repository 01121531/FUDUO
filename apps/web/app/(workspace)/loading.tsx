export default function WorkspaceLoading() {
  return (
    <div className="page" role="status" aria-label="正在加载页面">
      <div className="loading-header">
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-action" />
      </div>
      <div className="loading-kpis" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => <span className="skeleton skeleton-kpi" key={index} />)}
      </div>
      <span className="skeleton skeleton-panel" aria-hidden="true" />
      <span className="sr-only">正在加载页面内容</span>
    </div>
  );
}
