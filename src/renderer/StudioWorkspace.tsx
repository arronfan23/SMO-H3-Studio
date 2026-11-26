import type { ReactNode } from 'react';

export function StudioWorkspace({ editor, output }: { editor: ReactNode; output: ReactNode }) {
  return (
    <div className="studio-workspace-grid">
      <div className="studio-editor-pane">{editor}</div>
      <aside className="studio-output-pane" aria-label="任务与结果">
        <h2 className="studio-output-title">任务与结果</h2>
        {output}
      </aside>
    </div>
  );
}
