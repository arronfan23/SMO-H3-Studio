// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ComfyClient } from '../../src/main/comfy';

describe('ComfyClient lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('close can be called multiple times without error', async () => {
    const client = new ComfyClient('http://127.0.0.1:8188');
    await client.close();
    await client.close();
  });

  test('close aborts in-flight REST requests', async () => {
    const client = new ComfyClient('http://127.0.0.1:8188', { requestTimeoutMs: 60_000 });

    let requestInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      async (_url: string | URL, init: RequestInit): Promise<Response> => {
        requestInit = init;
        return new Promise(() => undefined);
      },
    );

    const healthPromise = client.health();
    const closePromise = client.close();

    await expect(Promise.race([healthPromise, closePromise])).resolves.toBeUndefined();
    await expect(healthPromise).rejects.toThrow(/aborted|closed/i);
    expect(requestInit?.signal?.aborted).toBe(true);
  });

  test('close rejects waitForCompletion', async () => {
    const client = new ComfyClient('http://127.0.0.1:8188', { completionTimeoutMs: 60_000 });

    vi.stubGlobal(
      'fetch',
      async (_url: string | URL, _init: RequestInit): Promise<Response> => {
        return new Promise(() => undefined);
      },
    );

    const completionPromise = client.waitForCompletion('prompt-1');
    const closePromise = client.close();

    await expect(Promise.race([completionPromise, closePromise])).resolves.toBeUndefined();
    await expect(completionPromise).rejects.toThrow(/closed/i);
  });

  test('operations after close reject promptly', async () => {
    const client = new ComfyClient('http://127.0.0.1:8188');
    await client.close();

    await expect(client.health()).rejects.toThrow(/closed/i);
    await expect(client.waitForCompletion('prompt-1')).rejects.toThrow(/closed/i);
  });
});
