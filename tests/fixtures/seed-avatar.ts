import { join } from 'node:path';
import { Store } from '../../src/main/store';
import { AvatarService } from '../../src/main/avatars';
import { MediaRegistry } from '../../src/main/media';
import type { Avatar } from '../../src/shared/types';

// Seeds a real avatar through the same Store/AvatarService/MediaRegistry the
// app uses, so packaged E2E runs can start with a persisted avatar without
// relying on SMO_TEST_FILE_DIALOG (which is disabled when app.isPackaged).
export async function seedAvatar(options: {
  dataDirectory: string;
  outputDirectory: string;
  name: string;
  photoPath: string;
}): Promise<Avatar> {
  const avatarsDirectory = join(options.dataDirectory, 'avatars');
  const mediaRegistry = new MediaRegistry({
    avatarsDirectory,
    outputDirectory: options.outputDirectory,
  });
  await mediaRegistry.authorizeSelectedImage(options.photoPath);

  const store = new Store(join(options.dataDirectory, 'studio.sqlite'));
  try {
    const avatars = new AvatarService({
      avatarsDirectory,
      store,
      mediaRegistry,
    });
    return await avatars.createAvatar({
      name: options.name,
      photoPath: options.photoPath,
    });
  } finally {
    store.close();
  }
}
