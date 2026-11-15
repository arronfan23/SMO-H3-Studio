import { useEffect, useRef, useState } from 'react';
import { Plus, Settings2, X } from 'lucide-react';
import type {
  SanmaoAttachmentMetadata,
  SanmaoConversationSummary,
  SanmaoEffort,
  SanmaoMessage,
  SanmaoProfileView,
  SanmaoStreamEvent,
} from '../shared/sanmao';
import { SanmaoComposer } from './SanmaoComposer';
import { SanmaoConversationList } from './SanmaoConversationList';
import { SanmaoMessageLog } from './SanmaoMessageLog';
import { errorMessage } from './ui';

function summaryOf(conversation: SanmaoConversationSummary): SanmaoConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    effort: conversation.effort,
    draft: conversation.draft,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function SanmaoPage({
  active = true,
  onOpenSettings,
}: {
  active?: boolean;
  onOpenSettings?: () => void;
}) {
  const [profile, setProfile] = useState<SanmaoProfileView | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [conversations, setConversations] = useState<SanmaoConversationSummary[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<SanmaoMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [effort, setEffort] = useState<SanmaoEffort>('medium');
  const [attachments, setAttachments] = useState<SanmaoAttachmentMetadata[]>([]);
  const [selectingAttachments, setSelectingAttachments] = useState(false);
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [activeReplyId, setActiveReplyId] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SanmaoConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const conversationIdRef = useRef(conversationId);
  const activeReplyRef = useRef(activeReplyId);

  useEffect(() => {
    activeReplyRef.current = activeReplyId;
  }, [activeReplyId]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void Promise.all([
      window.smo.sanmao.getProfile(),
      window.smo.sanmao.listConversations(),
    ]).then(([nextProfile, nextConversations]) => {
      if (!current) return;
      setProfile(nextProfile);
      setConversations(nextConversations);
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
        setToolActivity(null);
        setActiveReplyId(null);
        return;
      }
      if (event.kind === 'tool') {
        setToolActivity(event.text);
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
      if (event.kind === 'done') {
        setToolActivity(null);
        setActiveReplyId(null);
      }
    });
    return unsubscribe;
  }, []);

  const canChat = profile !== null && profile.keyStatus === 'valid';
  const modelOptions = profile
    ? [profile.model, ...models.filter((model) => model !== profile.model)]
    : [];

  useEffect(() => {
    if (!draftDirty || profile === null || !canChat) return;
    const requestedConversationId = conversationId;
    const timer = window.setTimeout(() => {
      void window.smo.sanmao.saveDraft({
        conversationId: requestedConversationId,
        model: profile.model,
        effort,
        draft,
        attachments: attachments.map(({ id }) => ({ id })),
      }).then((saved) => {
        const summary = summaryOf(saved);
        setConversations((current) => [
          summary,
          ...current.filter((conversation) => conversation.id !== summary.id),
        ]);
      }).catch((saveError) => {
        if (conversationIdRef.current === requestedConversationId) {
          setError(errorMessage(saveError));
        }
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [attachments, canChat, conversationId, draft, draftDirty, effort, profile]);

  const refreshConversations = async (): Promise<void> => {
    try {
      setConversations(await window.smo.sanmao.listConversations());
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    }
  };

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
    const currentAttachments = [...attachments];
    const text = draft.trim() || (currentAttachments.length > 0 ? '请阅读并分析附件。' : '');
    if (!text || activeReplyRef.current !== null || !canChat) return;
    const replyId = crypto.randomUUID();
    const requestedConversationId = conversationIdRef.current;
    setMessages((current) => [
      ...current,
      {
        id: `${replyId}:user`,
        role: 'user',
        text,
        ...(currentAttachments.length === 0 ? {} : { attachments: currentAttachments }),
      },
    ]);
    setDraft('');
    setAttachments([]);
    setDraftDirty(false);
    setError(null);
    activeReplyRef.current = replyId;
    setActiveReplyId(replyId);
    setToolActivity(null);
    try {
      await window.smo.sanmao.send({
        conversationId: requestedConversationId,
        replyId,
        text,
        effort,
        attachments: currentAttachments,
      });
      await refreshConversations();
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      if (activeReplyRef.current === replyId) {
        activeReplyRef.current = null;
        setActiveReplyId(null);
      }
    }
  };

  const resetConversation = (): void => {
    const next = crypto.randomUUID();
    conversationIdRef.current = next;
    setConversationId(next);
    setMessages([]);
    setDraft('');
    setAttachments([]);
    setDraftDirty(false);
    setEffort('medium');
    setActiveReplyId(null);
    setToolActivity(null);
    activeReplyRef.current = null;
    setError(null);
  };

  const newConversation = async (): Promise<void> => {
    const replyId = activeReplyRef.current;
    if (replyId) await window.smo.sanmao.cancel(replyId);
    resetConversation();
  };

  const openConversation = async (nextConversationId: string): Promise<void> => {
    if (nextConversationId === conversationIdRef.current || activeReplyRef.current) return;
    try {
      const conversation = await window.smo.sanmao.getConversation(nextConversationId);
      if (conversation === null) throw new Error('会话不存在或已删除');
      conversationIdRef.current = nextConversationId;
      setConversationId(nextConversationId);
      setMessages(conversation.messages);
      setDraft(conversation.draft);
      setAttachments(conversation.draftAttachments);
      setEffort(conversation.effort);
      setDraftDirty(false);
      setError(null);
    } catch (openError) {
      setError(errorMessage(openError));
    }
  };

  const deleteConversation = async (): Promise<void> => {
    if (deleteTarget === null || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await window.smo.sanmao.deleteConversation(deleteTarget.id);
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      if (conversationIdRef.current === deleteTarget.id) resetConversation();
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setDeleting(false);
    }
  };

  const selectAttachments = async (): Promise<void> => {
    if (selectingAttachments || activeReplyRef.current) return;
    setSelectingAttachments(true);
    setError(null);
    try {
      const selected = await window.smo.sanmao.selectAttachments(
        conversationIdRef.current,
        attachments.map(({ id }) => id),
      );
      setAttachments((current) => [...current, ...selected]);
      if (selected.length > 0) setDraftDirty(true);
    } catch (selectError) {
      setError(errorMessage(selectError));
    } finally {
      setSelectingAttachments(false);
    }
  };

  const dropAttachments = async (files: File[]): Promise<void> => {
    if (files.length === 0 || activeReplyRef.current || !canChat) return;
    setSelectingAttachments(true);
    setError(null);
    try {
      const selected = await window.smo.sanmao.authorizeDroppedAttachments(
        files,
        conversationIdRef.current,
        attachments.map(({ id }) => id),
      );
      setAttachments((current) => [...current, ...selected]);
      setDraftDirty(true);
    } catch (dropError) {
      setError(errorMessage(dropError));
    } finally {
      setSelectingAttachments(false);
    }
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
          {!profile && (
            <button className="button button-secondary" type="button" onClick={onOpenSettings}>
              <Settings2 size={16} aria-hidden="true" />
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
      <div className="sanmao-workspace">
        <SanmaoConversationList
          conversations={conversations}
          currentId={conversationId}
          disabled={activeReplyId !== null}
          onOpen={(nextConversationId) => void openConversation(nextConversationId)}
          onDelete={setDeleteTarget}
        />
        <div className="sanmao-chat">
          <SanmaoMessageLog
            messages={messages}
            activeReplyId={activeReplyId}
            toolActivity={toolActivity}
          />
          <SanmaoComposer
            draft={draft}
            canChat={canChat}
            activeReplyId={activeReplyId}
            model={profile?.model ?? ''}
            models={modelOptions}
            effort={effort}
            attachments={attachments}
            selectingAttachments={selectingAttachments}
            savingModel={savingModel}
            refreshing={refreshing}
            onDraftChange={(next) => {
              setDraft(next);
              setDraftDirty(true);
            }}
            onEffortChange={(next) => {
              setEffort(next);
              setDraftDirty(true);
            }}
            onSelectAttachments={() => void selectAttachments()}
            onDropAttachments={(files) => void dropAttachments(files)}
            onRemoveAttachment={(attachmentId) => {
              setAttachments((current) => current.filter(({ id }) => id !== attachmentId));
              setDraftDirty(true);
            }}
            onModelChange={(next) => void changeModel(next)}
            onRefreshModels={() => void refreshModels()}
            onSend={() => void send()}
            onStop={() => {
              if (activeReplyId) void window.smo.sanmao.cancel(activeReplyId);
            }}
          />
        </div>
      </div>

      {deleteTarget !== null && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="删除旧会话">
          <div className="modal-card">
            <h3>删除旧会话</h3>
            <p>确定要删除“{deleteTarget.title}”吗？其中的消息和草稿也会删除。</p>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                <X size={16} aria-hidden="true" />
                取消
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={deleting}
                onClick={() => void deleteConversation()}
              >
                {deleting ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
