import { Trash2 } from 'lucide-react';
import type { SanmaoConversationSummary } from '../shared/sanmao';

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function SanmaoConversationList({
  conversations,
  currentId,
  disabled = false,
  onOpen,
  onDelete,
}: {
  conversations: SanmaoConversationSummary[];
  currentId: string;
  disabled?: boolean;
  onOpen: (conversationId: string) => void;
  onDelete: (conversation: SanmaoConversationSummary) => void;
}) {
  return (
    <aside className="sanmao-history" aria-label="旧会话">
      <div className="sanmao-history-heading">
        <h3>旧会话</h3>
        <span>{conversations.length}</span>
      </div>
      {conversations.length === 0 ? (
        <p className="sanmao-history-empty">还没有旧会话</p>
      ) : (
        <div className="sanmao-history-list" role="list">
          {conversations.map((conversation) => (
            <div
              className={`sanmao-history-item${currentId === conversation.id ? ' is-active' : ''}`}
              key={conversation.id}
              role="listitem"
            >
              <button
                className="sanmao-history-open"
                type="button"
                aria-current={currentId === conversation.id ? 'page' : undefined}
                disabled={disabled}
                onClick={() => onOpen(conversation.id)}
              >
                <strong>{conversation.title}</strong>
                <span>{conversation.model} · {formatUpdatedAt(conversation.updatedAt)}</span>
              </button>
              <button
                className="button button-icon sanmao-history-delete"
                type="button"
                aria-label={`删除会话 ${conversation.title}`}
                title="删除会话"
                disabled={disabled}
                onClick={() => onDelete(conversation)}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
