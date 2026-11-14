import { FolderOpen, Library } from 'lucide-react';
import { parentPath } from './ui';
import { useMediaUrl } from './useMediaUrl';
import { useWorkResult } from './useWorkResult';

export function GenerationResultPreview({
  jobId,
  onOpenWorks,
}: {
  jobId: string | null;
  onOpenWorks: () => void;
}) {
  const work = useWorkResult(jobId);
  const outputPath = work?.status === 'done' ? work.outputPath : null;
  const { url, error } = useMediaUrl(outputPath);

  if (work === null || outputPath === null) return null;

  return (
    <section className="generation-result" aria-label="生成结果预览">
      <h3>生成结果</h3>
      {url ? (
        <>
          {work.mode === 'speech' && <audio aria-label="生成语音结果" controls src={url} />}
          {work.mode === 'image' && (
            <img aria-label="生成图像结果" src={url} style={{ objectFit: 'contain' }} />
          )}
          {(work.mode === 'text' || work.mode === 'audio') && (
            <video aria-label="生成视频结果" controls src={url} />
          )}
        </>
      ) : (
        <p role={error ? 'alert' : 'status'}>{error ?? '正在读取结果…'}</p>
      )}
      <div className="generation-result-actions">
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void window.smo.files.openFolder(parentPath(outputPath))}
        >
          <FolderOpen size={16} aria-hidden="true" />
          打开目录
        </button>
        <button className="button button-secondary" type="button" onClick={onOpenWorks}>
          <Library size={16} aria-hidden="true" />
          进入我的作品
        </button>
      </div>
    </section>
  );
}
