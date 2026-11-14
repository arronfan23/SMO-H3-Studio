import type { LlmConnection, LlmCredentials, LlmProfile, LlmProfileView } from './types';

export type SanmaoProfile = LlmProfile;
export type SanmaoProfileView = LlmProfileView;
export type SanmaoCredentials = LlmCredentials;
export type SanmaoConnection = LlmConnection;

export interface SanmaoMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export type SanmaoStreamEvent = {
  conversationId: string;
  replyId: string;
} & (
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string }
);

export interface SanmaoTestResult {
  ok: true;
  latencyMs: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSanmaoStreamEvent(value: unknown): SanmaoStreamEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Sanmao stream event');
  }
  const event = value as Record<string, unknown>;
  if (
    typeof event.conversationId !== 'string' ||
    !UUID_PATTERN.test(event.conversationId) ||
    typeof event.replyId !== 'string' ||
    !UUID_PATTERN.test(event.replyId) ||
    !['delta', 'done', 'error'].includes(String(event.kind)) ||
    typeof event.text !== 'string' ||
    Object.keys(event).some((key) =>
      !['conversationId', 'replyId', 'kind', 'text'].includes(key),
    )
  ) {
    throw new Error('Invalid Sanmao stream event');
  }
  return value as SanmaoStreamEvent;
}
