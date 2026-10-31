import type { MediaRegistryOptions } from '../../src/main/media';

export const options: MediaRegistryOptions = {
  avatarsDirectory: 'avatars',
  outputDirectory: 'output',
  // @ts-expect-error ComfyUI input is no longer a managed media root.
  inputDirectory: 'input',
};
