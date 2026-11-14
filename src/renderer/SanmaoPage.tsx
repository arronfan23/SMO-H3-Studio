import { useEffect, useRef, useState } from 'react';
import { Check, Plus, RefreshCw, Send, Square } from 'lucide-react';
import type {
  SanmaoMessage,
  SanmaoProfileView,
  SanmaoStreamEvent,
} from '../shared/sanmao';
import { errorMessage } from './ui';

export function SanmaoPage({
  active = true,
  onOpenSettings,
}: {
  active?: boolean;
  onOpenSettings?: () => void;
}) {
  const [profile, setProfile] = useState<SanmaoProfileView | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<SanmaoMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  const activeReplyRef = useRef(activeReplyId);
  const logRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    activeReplyRef.current = activeReplyId;
  }, [activeReplyId]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void window.smo.sanmao.getProfile().then((next) => {
      if (current) setProfile(next);
    }).catch((loadError) => {
      if (current) setError(errorMessage(loadError));
    });
    return () => {
      current = false;
    };
  }, [active]);

  useEffect(() => {
    const unsubscribe = window.smo.sanmao.subscribe((event: SanmaoStreamEvent) => {
      if (event.conversationId !== conversationIdRef.current) return;
      if (event.kind === 'error') {
        setError(event.text);
        setActiveReplyId(null);
        return;
      }
      setMessages((current) => {
        const existing = current.find((message) => message.id === event.replyId);
        const text = event.kind === 'delta' && existing
          ? existing.text + event.text
          : event.text;
        if (existing) {
          return current.map((message) =>
            message.id === event.replyId ? { ...message, text } : message,
          );
        }
        return [...current, { id: event.replyId, role: 'assistant', text }];
      });
      if (event.kind === 'done') setActiveReplyId(null);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = '0px';
    composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  }, [draft]);

  const canChat = profile !== null && profile.keyStatus === 'valid';
  const modelOptions = profile
    ? [profile.model, ...models.filter((model) => model !== profile.model)]
    : [];

  const changeModel = async (model: string): Promise<void> => {
    if (!profile || activeReplyId || savingModel || !model) return;
    setSavingModel(true);
    setError(null);
    setNotice(null);
    try {
      await window.smo.sanmao.saveProfile({
        baseUrl: profile.baseUrl,
        model,
        apiKey: '',
      });
      setProfile({ ...profile, model, keyStatus: 'valid' });
      setNotice('已保存');
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSavingModel(false);
    }
  };

  const refreshModels = async (): Promise<void> => {
    if (!profile || refreshing) return;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const next = await window.smo.sanmao.listModels({});
      setModels(next);
      setNotice(`已获取 ${next.length} 个模型`);
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      setRefreshing(false);
    }
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || activeReplyRef.current !== null || !canChat) return;
    const replyId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      { id: `${replyId}:user`, role: 'user', text },
    ]);
    setDraft('');
    setError(null);
    setActiveReplyId(replyId);
    try {
      await window.smo.sanmao.send({ conversationId, replyId, text });
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      if (activeReplyRef.current === replyId) setActiveReplyId(null);
    }
  };

  const newConversation = async (): Promise<void> => {
    const replyId = activeReplyRef.current;
    if (replyId) await window.smo.sanmao.cancel(replyId);
    const next = crypto.randomUUID();
    conversationIdRef.current = next;
    setConversationId(next);
    setMessages([]);
    setActiveReplyId(null);
    setError(null);
  };

  return (
    <section className="sanmao-page" aria-label="三脚猫">
      <header className="sanmao-header">
        <div className="sanmao-title-group">
          <h2>三脚猫</h2>
          <span className="sanmao-connection-state">
            {profile ? '已配置' : '未配置'}
          </span>
          {notice && <span className="sanmao-saved" role="status">{notice}</span>}
        </div>
        <div className="sanmao-header-actions">
          {profile ? (
            <>
              <label htmlFor="sanmao-current-model">当前模型</label>
              <select
                id="sanmao-current-model"
                value={profile.model}
                disabled={!canChat || savingModel || activeReplyId !== null}
                onChange={(event) => void changeModel(event.target.value)}
              >
                {modelOptions.map((model) => (
                  <option key={model} value={model} title={model}>{model}</option>
                ))}
              </select>
              <button
                className="button button-secondary sanmao-icon-button"
                type="button"
                aria-label="刷新模型"
                title="刷新模型"
                disabled={refreshing || savingModel}
                onClick={() => void refreshModels()}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
            </>
          ) : (
            <button
              className="button button-secondary"
              type="button"
              onClick={onOpenSettings}
            >
              前往设置
            </button>
          )}
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void newConversation()}
          >
            <Plus size={16} aria-hidden="true" />
            新建会话
          </button>
        </div>
      </header>

      {error && <p className="form-error sanmao-error" role="alert">{error}</p>}
      <div className="sanmao-log" ref={logRef} role="log" aria-live="polite">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`sanmao-message sanmao-message-${message.role}`}
          >
            <span className="sanmao-message-role">
              {message.role === 'user' ? '你' : '三脚猫'}
            </span>
            <p>{message.text}</p>
          </div>
        ))}
        {activeReplyId && !messages.some((message) => message.id === activeReplyId) && (
          <p className="sanmao-waiting" role="status">三脚猫正在回复…</p>
        )}
      </div>

      <form
        className="sanmao-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="sanmao-message">发送给三脚猫的消息</label>
        <div className="sanmao-composer-row">
          <textarea
            ref={composerRef}
            id="sanmao-message"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {activeReplyId ? (
            <button
              className="button button-secondary sanmao-send-button"
              type="button"
              aria-label="停止"
              title="停止"
              onClick={() => void window.smo.sanmao.cancel(activeReplyId)}
            >
              <Square size={17} aria-hidden="true" />
            </button>
          ) : (
            <button
              className="button button-primary sanmao-send-button"
              type="submit"
              aria-label="发送"
              title="发送"
              disabled={!draft.trim() || !canChat}
            >
              <Send size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
