import { useState } from 'react';
import { ImagePlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Avatar } from '../shared/types';
import { AvatarImage } from './AvatarImage';
import { errorMessage, fileName } from './ui';

type DialogState =
  | { kind: 'rename'; avatar: Avatar }
  | { kind: 'delete'; avatar: Avatar }
  | null;

export function AvatarsPage({
  avatars,
  selectedAvatarId,
  error: listError,
  onSelect,
  onCreated,
  onChanged,
}: {
  avatars: Avatar[];
  selectedAvatarId: string | null;
  error: string | null;
  onSelect: (id: string) => void;
  onCreated: (avatar: Avatar) => Promise<void>;
  onChanged: (preferredId?: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mutationLoading, setMutationLoading] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const selectPhoto = async (): Promise<void> => {
    setSelecting(true);
    setError(null);
    try {
      const selected = await window.smo.files.selectImage();
      if (selected !== null) {
        setPhotoPath(selected);
      }
    } catch (selectError) {
      setError(errorMessage(selectError));
    } finally {
      setSelecting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (name.trim().length === 0 || photoPath === null) {
      setError('请填写模特名称并选择照片。');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const avatar = await window.smo.avatars.create({ name: name.trim(), photoPath });
      await onCreated(avatar);
      setName('');
      setPhotoPath(null);
      setNotice(`已保存并选择 ${avatar.name}`);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const openRename = (avatar: Avatar): void => {
    setDialog({ kind: 'rename', avatar });
    setRenameValue(avatar.name);
    setMutationError(null);
  };

  const openDelete = (avatar: Avatar): void => {
    setDialog({ kind: 'delete', avatar });
    setMutationError(null);
  };

  const closeDialog = (): void => {
    setDialog(null);
    setRenameValue('');
    setMutationError(null);
  };

  const saveRename = async (): Promise<void> => {
    if (dialog?.kind !== 'rename') {
      return;
    }
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setMutationError('模特名称不能为空');
      return;
    }
    setMutationLoading(true);
    setMutationError(null);
    try {
      await window.smo.avatars.update({ id: dialog.avatar.id, name: trimmed });
      await onChanged(dialog.avatar.id);
      closeDialog();
    } catch (renameError) {
      setMutationError(errorMessage(renameError));
    } finally {
      setMutationLoading(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (dialog?.kind !== 'delete') {
      return;
    }
    setMutationLoading(true);
    setMutationError(null);
    try {
      await window.smo.avatars.delete(dialog.avatar.id);
      await onChanged();
      closeDialog();
    } catch (deleteError) {
      setMutationError(errorMessage(deleteError));
    } finally {
      setMutationLoading(false);
    }
  };

  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <span className="page-kicker">人物资产</span>
          <h2>数字模特</h2>
        </div>
        <span>{avatars.length} 位模特</span>
      </header>
      {listError && <p className="form-error" role="alert">模特列表加载失败：{listError}</p>}
      <div className="avatars-layout">
        <form
          className="avatar-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3>新建模特</h3>
          <div className="field">
            <label htmlFor="avatar-name">模特名称</label>
            <input
              id="avatar-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button className="button button-secondary" type="button" onClick={() => void selectPhoto()} disabled={selecting}>
            <ImagePlus size={16} aria-hidden="true" />
            {selecting ? '正在选择…' : '选择照片'}
          </button>
          <div className="selected-file">{photoPath ? fileName(photoPath) : '尚未选择照片'}</div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="form-notice" role="status">{notice}</p>}
          <button className="button button-primary" type="submit" disabled={saving}>
            <Plus size={16} aria-hidden="true" />
            {saving ? '正在保存…' : '保存模特'}
          </button>
        </form>
        <section className="avatar-list" aria-label="模特列表">
          {avatars.length === 0 ? (
            <div className="page-state">保存后，数字模特会显示在这里。</div>
          ) : (
            avatars.map((avatar) => (
              <article className="avatar-item" key={avatar.id}>
                <AvatarImage avatar={avatar} />
                <div className="avatar-item-copy">
                  <h3>{avatar.name}</h3>
                  <p>{new Date(avatar.createdAt).toLocaleDateString('zh-CN')}</p>
                </div>
                <div className="avatar-item-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={selectedAvatarId === avatar.id}
                    onClick={() => onSelect(avatar.id)}
                  >
                    {selectedAvatarId === avatar.id ? '当前模特' : '选择此模特'}
                  </button>
                  <button
                    className="button button-icon"
                    type="button"
                    aria-label={`重命名 ${avatar.name}`}
                    onClick={() => openRename(avatar)}
                  >
                    <Pencil size={16} aria-hidden="true" />
                  </button>
                  <button
                    className="button button-icon"
                    type="button"
                    aria-label={`删除 ${avatar.name}`}
                    onClick={() => openDelete(avatar)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
      {dialog?.kind === 'rename' && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="重命名模特">
          <div className="modal-card">
            <h3>重命名模特</h3>
            <div className="field">
              <label htmlFor="avatar-rename-name">模特新名称</label>
              <input
                id="avatar-rename-name"
                value={renameValue}
                maxLength={80}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </div>
            {mutationError && <p className="form-error" role="alert">{mutationError}</p>}
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={closeDialog}>
                <X size={16} aria-hidden="true" /> 取消
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={mutationLoading}
                onClick={() => void saveRename()}
              >
                {mutationLoading ? '正在保存…' : '保存名称'}
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog?.kind === 'delete' && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="删除模特">
          <div className="modal-card">
            <h3>删除模特</h3>
            <p>确定要删除模特“{dialog.avatar.name}”吗？此操作不可撤销。</p>
            {mutationError && <p className="form-error" role="alert">{mutationError}</p>}
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={closeDialog}>
                <X size={16} aria-hidden="true" /> 取消
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={mutationLoading}
                onClick={() => void confirmDelete()}
              >
                {mutationLoading ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
