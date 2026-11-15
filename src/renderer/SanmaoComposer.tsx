import { useEffect, useRef } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, Plus, RefreshCw, Square, X } from 'lucide-react';
import type { SanmaoAttachmentMetadata, SanmaoEffort } from '../shared/sanmao';

export function SanmaoComposer({
  draft,
  canChat,
  activeReplyId,
  model,
  models,
  effort,
  attachments,
  selectingAttachments,
  savingModel,
  refreshing,
  onDraftChange,
  onEffortChange,
  onSelectAttachments,
  onDropAttachments,
  onRemoveAttachment,
  onModelChange,
  onRefreshModels,
  onSend,
  onStop,
}: {
  draft: string;
  canChat: boolean;
  activeReplyId: string | null;
  model: string;
  models: string[];
  effort: SanmaoEffort;
  attachments: SanmaoAttachmentMetadata[];
  selectingAttachments: boolean;
  savingModel: boolean;
  refreshing: boolean;
  onDraftChange: (draft: string) => void;
  onEffortChange: (effort: SanmaoEffort) => void;
  onSelectAttachments: () => void;
  onDropAttachments: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onModelChange: (model: string) => void;
  onRefreshModels: () => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = '0px';
    composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  }, [draft]);

  return (
    <form
      className="sanmao-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropAttachments(Array.from(event.dataTransfer.files));
      }}
    >
      <label className="sr-only" htmlFor="sanmao-message">发送给三脚猫的消息</label>
      <textarea
        ref={composerRef}
        id="sanmao-message"
        rows={1}
        value={draft}
        placeholder="给三脚猫发送消息"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      {attachments.length > 0 && (
        <ul className="sanmao-attachment-list" aria-label="已选附件">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              {attachment.kind === 'image'
                ? <ImageIcon size={14} aria-hidden="true" />
                : <FileText size={14} aria-hidden="true" />}
              <span>{attachment.name}</span>
              <button
                className="button button-icon"
                type="button"
                aria-label={`移除附件 ${attachment.name}`}
                title="移除附件"
                disabled={activeReplyId !== null}
                onClick={() => onRemoveAttachment(attachment.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sanmao-composer-toolbar">
        <div className="sanmao-composer-leading">
          <button
            className="button button-icon sanmao-attachment-button"
            type="button"
            aria-label="添加附件"
            title="添加附件"
            disabled={!canChat || activeReplyId !== null || selectingAttachments}
            onClick={onSelectAttachments}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="sanmao-composer-actions">
          <select
            aria-label="当前模型"
            value={model}
            disabled={!canChat || savingModel || activeReplyId !== null}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.map((option) => (
              <option key={option} value={option} title={option}>{option}</option>
            ))}
          </select>
          <button
            className="button button-icon"
            type="button"
            aria-label="刷新模型"
            title="刷新模型"
            disabled={refreshing || savingModel || activeReplyId !== null}
            onClick={onRefreshModels}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <select
            aria-label="思考深度"
            value={effort}
            disabled={!canChat || activeReplyId !== null}
            onChange={(event) => onEffortChange(event.target.value as SanmaoEffort)}
          >
            <option value="low">快速</option>
            <option value="medium">标准</option>
            <option value="high">深入</option>
          </select>
          {activeReplyId ? (
            <button
              className="button button-secondary sanmao-send-button"
              type="button"
              aria-label="停止"
              title="停止"
              onClick={onStop}
            >
              <Square size={16} aria-hidden="true" />
            </button>
          ) : (
            <button
              className="button button-primary sanmao-send-button"
              type="submit"
              aria-label="发送"
              title="发送"
              disabled={(!draft.trim() && attachments.length === 0) || !canChat}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
