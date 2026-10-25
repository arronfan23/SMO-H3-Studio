import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedLlmRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

type UpstreamHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void | Promise<void>;

export interface LocalLlmUpstream {
  baseUrl: string;
  requests: RecordedLlmRequest[];
  close: () => Promise<void>;
}

export async function startLlmUpstream(
  handler: UpstreamHandler,
): Promise<LocalLlmUpstream> {
  const requests: RecordedLlmRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });

      Promise.resolve(handler(request, response, body)).catch(() => {
        if (!response.destroyed) {
          response.destroy();
        }
      });
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
