import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedLlmRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

export interface LocalLlmMock {
  baseUrl: string;
  requests: RecordedLlmRequest[];
  close: () => Promise<void>;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function formatTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function createRef2VaPrompt(duration: number): string {
  const tailStart = Math.max(0, duration - 2);
  return [
    'subject_definitions: A young woman with shoulder-length black hair, wearing a simple white blouse, standing in a softly lit indoor space.',
    'summary: She smiles gently, raises her hand in a small wave, and then lowers it as the camera holds a medium close-up.',
    'retention_analysis: The motion is minimal and centered, keeping the viewer focused on the subject’s expression and gesture.',
    'detailed_description:',
    `[Shot 1] At 00:00.000, a medium close-up shows the young woman. She looks toward the camera and says <d>Hello, nice to meet you.</d> The lighting is warm and even, with a shallow depth of field that softens the background.`,
    `[Shot 2] At ${formatTimestamp(tailStart)} her hand lowers back to her side and her expression settles into a calm, friendly gaze. No further movement or speech occurs.`,
    'The final 2 seconds contain no narration, dialogue, speech, or vocals; only ambient room tone and gentle instrumental music continue.',
    'overall_soundscape: Soft room ambience, subtle fabric movement, and a quiet breath.',
    'non_diegetic_music: A short, warm piano phrase that begins at 00:01.000, stays understated, and fades out during the final 2 seconds.',
  ].join('\n\n');
}

export async function startLlmMock(): Promise<LocalLlmMock> {
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

      try {
        const url = request.url ?? '';
        if (request.method === 'GET' && url === '/v1/models') {
          sendJson(response, 200, {
            object: 'list',
            data: [
              { id: 'model-a', object: 'model' },
              { id: 'model-b', object: 'model' },
            ],
          });
          return;
        }

        if (request.method === 'POST' && url === '/v1/chat/completions') {
          const parsed = JSON.parse(body) as {
            messages?: Array<{ role: string; content: string }>;
            max_tokens?: number;
          };
          const userContent =
            parsed.messages?.find((message) => message.role === 'user')?.content ?? '';
          const durationMatch = /Target duration:\s*([0-9.]+)\s*seconds/i.exec(userContent);
          const duration = durationMatch ? Number(durationMatch[1]) : 8;

          sendJson(response, 200, {
            id: 'mock-chat-completion',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'model-a',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: createRef2VaPrompt(duration),
                },
                finish_reason: 'stop',
              },
            ],
          });
          return;
        }

        sendJson(response, 404, { error: 'Not found' });
      } catch {
        sendJson(response, 500, { error: 'Mock server error' });
      }
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
