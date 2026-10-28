import { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, FolderOpen, Settings, Users } from 'lucide-react';
import { DEFAULT_MODEL_DIRECTORY } from '../shared/generation-options';
import type { Avatar } from '../shared/types';
import { AvatarsPage } from './AvatarsPage';
import { SettingsPage } from './SettingsPage';
import { StudioPage } from './StudioPage';
import { WorksPage } from './WorksPage';
import { errorMessage } from './ui';

const NAVIGATION = [
  { id: 'studio', label: '制作台', icon: Clapperboard },
  { id: 'avatars', label: '数字模特', icon: Users },
  { id: 'works', label: '我的作品', icon: FolderOpen },
  { id: 'settings', label: '设置', icon: Settings },
] as const;

type PageId = (typeof NAVIGATION)[number]['id'];

export function App() {
  const [page, setPage] = useState<PageId>('studio');
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
  const [avatarsLoading, setAvatarsLoading] = useState(true);
  const [avatarsError, setAvatarsError] = useState<string | null>(null);
  const [modelDirectory, setModelDirectory] = useState(DEFAULT_MODEL_DIRECTORY);
  const mountedRef = useRef(true);

  const refreshAvatars = useCallback(async (preferredId?: string): Promise<void> => {
    try {
      const result = await window.smo.avatars.list();
      if (!mountedRef.current) {
        return;
      }
      setAvatars(result);
      setSelectedAvatarId((current) => {
        if (preferredId && result.some((avatar) => avatar.id === preferredId)) {
          return preferredId;
        }
        if (current && result.some((avatar) => avatar.id === current)) {
          return current;
        }
        return result[0]?.id ?? null;
      });
      setAvatarsError(null);
    } catch (error) {
      if (mountedRef.current) {
        setAvatarsError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current) {
        setAvatarsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshAvatars();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshAvatars]);

  const avatarCreated = async (avatar: Avatar): Promise<void> => {
    setAvatars((current) => [avatar, ...current.filter((item) => item.id !== avatar.id)]);
    setSelectedAvatarId(avatar.id);
    await refreshAvatars(avatar.id);
  };

  const selectedAvatar = avatars.find((avatar) => avatar.id === selectedAvatarId) ?? null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <img src="./brand/icon.png" alt="SMO.H3 Studio 标志" width="42" height="42" />
          <div>
            <h1>SMO.H3 Studio</h1>
            <span>数字人制作台</span>
          </div>
        </div>
        <nav className="main-nav" aria-label="主导航">
          {NAVIGATION.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={page === id ? 'nav-item nav-item-active' : 'nav-item'}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="main-content">
        <div hidden={page !== 'studio'}>
          <StudioPage
            avatar={selectedAvatar}
            loading={avatarsLoading}
            error={avatarsError}
            modelDirectory={modelDirectory}
            onCreateAvatar={() => setPage('avatars')}
          />
        </div>
        {page === 'avatars' && (
          <AvatarsPage
            avatars={avatars}
            selectedAvatarId={selectedAvatarId}
            error={avatarsError}
            onSelect={setSelectedAvatarId}
            onCreated={avatarCreated}
            onChanged={refreshAvatars}
          />
        )}
        {page === 'works' && <WorksPage avatars={avatars} />}
        {page === 'settings' && (
          <SettingsPage
            modelDirectory={modelDirectory}
            onModelDirectoryChange={setModelDirectory}
          />
        )}
      </main>
    </div>
  );
}
