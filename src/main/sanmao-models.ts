import type { SanmaoConnection } from '../shared/sanmao';

interface SanmaoModelOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function createModelsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('三脚猫请求地址无效');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1/messages') || path.endsWith('/v1/chat/completions')) {
    url.pathname = '/v1/models';
  } else {
    url.pathname = path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`;
  }
  return url;
}

function parseModels(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { data?: unknown }).data)) {
    throw new Error('模型服务返回了无效的模型列表');
  }
  const ids = new Set<string>();
  for (const item of (value as { data: unknown[] }).data) {
    if (typeof item !== 'object' || item === null || typeof (item as { id?: unknown }).id !== 'string') {
      throw new Error('模型服务返回了无效的模型列表');
    }
    const id = ((item as { id: string }).id).trim();
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export async function listSanmaoModels(
  connection: SanmaoConnection,
  options: SanmaoModelOptions = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let response: Response;
  try {
    response = await fetchImpl(createModelsUrl(connection.baseUrl), {
      headers: {
        Accept: 'application/json',
        'x-api-key': connection.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('获取模型超时或无法连接，请检查请求地址和网络');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(
      response.status === 401 || response.status === 403
        ? `模型服务认证失败（HTTP ${response.status}），请检查 API Key`
        : `获取模型失败（HTTP ${response.status}）`,
    );
  }
  try {
    return parseModels(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === '模型服务返回了无效的模型列表') {
      throw error;
    }
    throw new Error('模型服务返回了无效 JSON');
  }
}
