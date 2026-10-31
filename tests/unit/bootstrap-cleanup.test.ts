// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createAppServices,
  type AppServices,
} from '../../src/main/app-services';
import { bootstrapApplication } from '../../src/main/bootstrap';
import { registerIpc } from '../../src/main/ipc';

vi.mock('../../src/main/app-services', () => ({ createAppServices: vi.fn() }));
vi.mock('../../src/main/ipc', () => ({ registerIpc: vi.fn() }));

function useServices() {
  const close = vi.fn().mockResolvedValue(undefined);
  const services = { close } as unknown as AppServices;
  vi.mocked(createAppServices).mockResolvedValue(services);
  return { close, services };
}

describe('bootstrap cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test.each(['registration', 'window creation'] as const)(
    'closes services once and rethrows when %s fails',
    async (failure) => {
      const { close } = useServices();
      const error = new Error(`${failure} failed`);
      vi.mocked(registerIpc).mockImplementation(() => {
        if (failure === 'registration') {
          throw error;
        }
      });
      const createMainWindow = vi.fn(async () => {
        if (failure === 'window creation') {
          throw error;
        }
      });

      await expect(bootstrapApplication({ createMainWindow })).rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  test('does not close services after a successful bootstrap', async () => {
    const { close, services } = useServices();
    const createMainWindow = vi.fn(async () => undefined);

    await expect(bootstrapApplication({ createMainWindow })).resolves.toBe(services);
    expect(close).not.toHaveBeenCalled();
  });
});
