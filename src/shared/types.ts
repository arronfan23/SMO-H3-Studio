export type VideoMode = 'text' | 'audio';

export interface GenerationRequest {
  mode: VideoMode;
  avatarId: string;
  prompt: string;
  duration: number;
  seed: number;
  audioPath?: string;
  trimStart?: number;
}

export interface Avatar {
  id: string;
  name: string;
  photoPath: string;
  createdAt: string;
}

export type WorkStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Work {
  id: string;
  avatarId: string;
  mode: VideoMode;
  outputPath: string | null;
  status: WorkStatus;
  createdAt: string;
}

export type NewWork = Omit<Work, 'createdAt'>;

export interface LlmProfile {
  baseUrl: string;
  model: string;
}

export interface LlmCredentials extends LlmProfile {
  apiKey: string;
}
