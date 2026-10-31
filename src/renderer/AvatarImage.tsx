import type { Avatar } from '../shared/types';
import { useMediaUrl } from './useMediaUrl';

export function AvatarImage({ avatar }: { avatar: Avatar }) {
  const { url, error } = useMediaUrl(avatar.photoPath);

  return (
    <div className="avatar-image">
      {url ? (
        <img src={url} alt={`${avatar.name}的照片`} />
      ) : (
        <span role={error ? 'alert' : undefined}>{error ?? '正在读取照片…'}</span>
      )}
    </div>
  );
}
