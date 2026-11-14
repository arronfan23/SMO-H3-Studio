import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FolderOpen,
  Image,
  Mic,
  MessageCircle,
  Settings,
  Users,
  Video,
} from 'lucide-react';
import type { Avatar, Work } from '../shared/types';
import { AvatarsPage } from './AvatarsPage';
import { EnvironmentWizard } from './EnvironmentWizard';
import { SettingsPage } from './SettingsPage';
import { StudioPage } from './StudioPage';
import { useEnvironment } from './useEnvironment';
import { WindowResizeHandles } from './WindowResizeHandles';
import { WindowTitlebar } from './WindowTitlebar';
import { WorksPage } from './WorksPage';
import { SanmaoPage } from './SanmaoPage';
import { errorMessage } from './ui';

const NAVIGATION = [
  { id: 'studio', label: '制作台', icon: Clapperboard },
  { id: 'sanmao', label: '三脚猫', icon: MessageCircle },
  { id: 'avatars', label: '数字模特', icon: Users },
  { id: 'works', label: '我的作品', icon: FolderOpen },
  { id: 'settings', label: '设置', icon: Settings },
] as const;

type PageId = (typeof NAVIGATION)[number]['id'];
export type StudioMode = 'speech' | 'image' | 'video';

const STUDIO_NAVIGATION = [
  { mode: 'speech', label: '语音', icon: Mic },
  { mode: 'image', label: '图像', icon: Image },
  { mode: 'video', label: '视频', icon: Video },
] as const;

export type StudioIntent = {
  token: number;
  mode: 'video';
  videoMode: 'audio';
  audioPath: string;
};

interface StudioApplicationProps {
  initialModelDirectory: string;
}

function StudioApplication({ initialModelDirectory }: StudioApplicationProps) {
  const [page, setPage] = useState<PageId>('studio');
  const [settingsService, setSettingsService] = useState<'polish' | 'sanmao'>('polish');
  const [studioMode, setStudioMode] = useState<StudioMode>('video');
  const [studioExpanded, setStudioExpanded] = useState(true);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
  const [avatarsLoading, setAvatarsLoading] = useState(true);
  const [avatarsError, setAvatarsError] = useState<string | null>(null);
  const [modelDirectory, setModelDirectory] = useState(initialModelDirectory);
  const [studioIntent, setStudioIntent] = useState<StudioIntent | null>(null);
  const studioIntentTokenRef = useRef(0);
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

  const importImageAsAvatar = async (work: Work): Promise<void> => {
    if (work.outputPath === null) {
      return;
    }
    const avatar = await window.smo.avatars.create({
      name: work.title?.trim() || work.id.slice(0, 8),
      photoPath: work.outputPath,
    });
    await avatarCreated(avatar);
    if (mountedRef.current) {
      setPage('avatars');
    }
  };

  const selectedAvatar = avatars.find((avatar) => avatar.id === selectedAvatarId) ?? null;

  const useSpeechInAudioDigitalHuman = (audioPath: string): void => {
    const token = ++studioIntentTokenRef.current;
    setStudioIntent({ token, mode: 'video', videoMode: 'audio', audioPath });
    setStudioMode('video');
    setPage('studio');
  };

  const selectStudioMode = (mode: StudioMode): void => {
    setPage('studio');
    setStudioMode(mode);
  };

  return (
    <div className="app-frame">
      <WindowTitlebar />
      <WindowResizeHandles />
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
            {NAVIGATION.map(({ id, label, icon: Icon }) =>
              id === 'studio' ? (
                <div key={id} className="nav-directory">
                  <button
                    id="studio-nav-button"
                    type="button"
                    className={page === id ? 'nav-item nav-item-active' : 'nav-item'}
                    aria-current={page === id ? 'page' : undefined}
                    aria-expanded={studioExpanded}
                    aria-controls="studio-mode-navigation"
                    onClick={() => setStudioExpanded((expanded) => !expanded)}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{label}</span>
                    {studioExpanded ? (
                      <ChevronDown className="nav-chevron" size={16} aria-hidden="true" />
                    ) : (
                      <ChevronRight className="nav-chevron" size={16} aria-hidden="true" />
                    )}
                  </button>
                  <div
                    id="studio-mode-navigation"
                    className="nav-submenu"
                    role="group"
                    aria-label="制作模式"
                    hidden={!studioExpanded}
                  >
                    {STUDIO_NAVIGATION.map(({ mode, label: modeLabel, icon: ModeIcon }) => {
                      const active = page === 'studio' && studioMode === mode;
                      return (
                        <button
                          key={mode}
                          id={`studio-${mode}-button`}
                          type="button"
                          className={active ? 'nav-item nav-item-active' : 'nav-item'}
                          aria-current={active ? 'page' : undefined}
                          aria-controls={`${mode}-main-panel`}
                          onClick={() => selectStudioMode(mode)}
                        >
                          <ModeIcon size={17} aria-hidden="true" />
                          <span>{modeLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
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
              ),
            )}
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
              pageActive={page === 'studio'}
              intent={studioIntent}
              mode={studioMode}
              onModeChange={setStudioMode}
            />
          </div>
          <div hidden={page !== 'sanmao'}>
            <SanmaoPage
              active={page === 'sanmao'}
              onOpenSettings={() => {
                setSettingsService('sanmao');
                setPage('settings');
              }}
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
          {page === 'works' && (
            <WorksPage
              avatars={avatars}
              onUseSpeech={useSpeechInAudioDigitalHuman}
              onImportImage={importImageAsAvatar}
            />
          )}
          {page === 'settings' && (
            <SettingsPage
              modelDirectory={modelDirectory}
              onModelDirectoryChange={setModelDirectory}
              service={settingsService}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const environment = useEnvironment();
  const config = environment.state?.config;

  if (config?.status === 'ready' && environment.state?.healthy) {
    return <StudioApplication initialModelDirectory={config.modelDirectory} />;
  }

  return <EnvironmentWizard environment={environment} />;
}
