import { useEffect, useRef } from 'react';
import type { SanmaoMessage } from '../shared/sanmao';

export function SanmaoMessageLog({
  messages,
  activeReplyId,
}: {
  messages: SanmaoMessage[];
  activeReplyId: string | null;
}) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const streaming = activeReplyId !== null &&
    messages.some((message) => message.id === activeReplyId);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, activeReplyId]);

  return (
    <div className="sanmao-message-log" ref={logRef} role="log" aria-live="polite">
      {messages.length === 0 && activeReplyId === null && (
        <div className="sanmao-empty">
          <span>三脚猫</span>
          <p>有什么可以帮你？</p>
        </div>
      )}
      {messages.map((message) => (
        <article
          key={message.id}
          className={`sanmao-message sanmao-message-${message.role}`}
        >
          <span className="sanmao-message-role">
            {message.role === 'user' ? '你' : '三脚猫'}
          </span>
          <p>{message.text}</p>
          {message.attachments && message.attachments.length > 0 && (
            <ul className="sanmao-message-attachments" aria-label="消息附件">
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>{attachment.name}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {activeReplyId !== null && !streaming && (
        <div className="sanmao-thinking" role="status" aria-label="正在思考">
          <span className="sanmao-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>三脚猫正在思考…</span>
        </div>
      )}
      {streaming && (
        <div className="sanmao-generating" role="status" aria-label="正在生成回复">
          <span className="sanmao-generating-mark" aria-hidden="true" />
          <span>正在生成回复…</span>
        </div>
      )}
    </div>
  );
}
