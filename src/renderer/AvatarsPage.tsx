import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Avatar } from '../shared/types';
import { AvatarImage } from './AvatarImage';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage, fileName } from './ui';

const DROPPED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

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
  const [authorizing, setAuthorizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mutationLoading, setMutationLoading] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const { url: photoUrl, error: photoUrlError } = useMediaUrl(photoPath);
  const mountedRef = useRef(true);
  // Monotonic id for photo-selection operations (dialog select, drag-drop,
  // remove); only the latest request may update photoPath or pending flags.
  const photoRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectPhoto = async (): Promise<void> => {
    if (saving) {
      return;
    }
    const requestId = ++photoRequestRef.current;
    setAuthorizing(false);
    setSelecting(true);
    setError(null);
    try {
      const selected = await window.smo.files.selectImage();
      if (
        mountedRef.current &&
        photoRequestRef.current === requestId &&
        selected !== null
      ) {
        setPhotoPath(selected);
      }
    } catch (selectError) {
      if (mountedRef.current && photoRequestRef.current === requestId) {
        setError(errorMessage(selectError));
      }
    } finally {
      if (mountedRef.current && photoRequestRef.current === requestId) {
        setSelecting(false);
      }
    }
  };

  const save = async (): Promise<void> => {
    if (selecting || authorizing || saving) {
      return;
    }
    if (name.trim().length === 0 || photoPath === null) {
      setError('请填写模特名称并选择照片。');
      return;
    }
    const requestId = photoRequestRef.current;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const avatar = await window.smo.avatars.create({ name: name.trim(), photoPath });
      await onCreated(avatar);
      // Only clear the form when no newer photo-selection request started
      // while the save was in flight; otherwise the cleanup would wipe a
      // fresh selection.
      if (mountedRef.current && photoRequestRef.current === requestId) {
        setName('');
        setPhotoPath(null);
        setNotice(`已保存并选择 ${avatar.name}`);
      }
    } catch (saveError) {
      if (mountedRef.current) {
        setError(errorMessage(saveError));
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  };

  const removePhoto = (): void => {
    photoRequestRef.current += 1;
    setSelecting(false);
    setAuthorizing(false);
    setPhotoPath(null);
    setError(null);
  };

  const handlePhotoDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDropActive(false);
    if (saving) {
      return;
    }
    const requestId = ++photoRequestRef.current;
    setSelecting(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setAuthorizing(false);
      setError('一次只能拖入一张照片。');
      return;
    }
    const file = files[0];
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!DROPPED_IMAGE_EXTENSIONS.has(extension)) {
      setAuthorizing(false);
      setError('仅支持 PNG、JPG、JPEG 或 WebP 图片。');
      return;
    }
    setError(null);
    setAuthorizing(true);
    void (async () => {
      try {
        // The renderer never trusts the dropped path directly: the main
        // process must authorize it before it becomes the photo path.
        const droppedPath = window.smo.files.getDroppedFilePath(file);
        const authorized = await window.smo.files.authorizeDroppedImage(droppedPath);
        if (mountedRef.current && photoRequestRef.current === requestId) {
          setPhotoPath(authorized);
          setNotice(null);
        }
      } catch (dropError) {
        if (mountedRef.current && photoRequestRef.current === requestId) {
          setError(errorMessage(dropError));
        }
      } finally {
        if (mountedRef.current && photoRequestRef.current === requestId) {
          setAuthorizing(false);
        }
      }
    })();
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
      if (mountedRef.current) {
        closeDialog();
      }
    } catch (renameError) {
      if (mountedRef.current) {
        setMutationError(errorMessage(renameError));
      }
    } finally {
      if (mountedRef.current) {
        setMutationLoading(false);
      }
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
      if (mountedRef.current) {
        closeDialog();
      }
    } catch (deleteError) {
      if (mountedRef.current) {
        setMutationError(errorMessage(deleteError));
      }
    } finally {
      if (mountedRef.current) {
        setMutationLoading(false);
      }
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
          <button className="button button-secondary" type="button" onClick={() => void selectPhoto()} disabled={selecting || saving}>
            <ImagePlus size={16} aria-hidden="true" />
            {selecting ? '正在选择…' : '选择照片'}
          </button>
          <div
            className="avatar-preview"
            role="group"
            aria-label="模特照片拖放区"
            data-drop-active={dropActive ? 'true' : undefined}
            style={
              dropActive
                ? { outline: '2px dashed #258665', outlineOffset: '4px' }
                : undefined
            }
            onDragOver={(event) => {
              event.preventDefault();
              if (!saving) {
                setDropActive(true);
              }
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={handlePhotoDrop}
          >
            {photoPath === null ? (
              <div className="avatar-preview-empty">尚未选择照片</div>
            ) : (
              <>
                {photoUrl ? (
                  <img
                    className="avatar-preview-image"
                    src={photoUrl}
                    alt="待保存模特照片预览"
                  />
                ) : (
                  <div
                    className="avatar-preview-empty"
                    role={photoUrlError ? 'alert' : 'status'}
                  >
                    {photoUrlError ?? '正在读取照片…'}
                  </div>
                )}
                <div className="avatar-preview-meta">
                  <span className="selected-file">{fileName(photoPath)}</span>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={removePhoto}
                    disabled={selecting || saving}
                  >
                    <X size={16} aria-hidden="true" />
                    移除照片
                  </button>
                </div>
              </>
            )}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {notice && <p className="form-notice" role="status">{notice}</p>}
          <button
            className="button button-primary"
            type="submit"
            disabled={saving || selecting || authorizing}
          >
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
