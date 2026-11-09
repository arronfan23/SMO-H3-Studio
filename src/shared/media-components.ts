export type MediaComponentId = 'speech' | 'image';

export interface MediaComponentState {
  id: MediaComponentId;
  status: 'missing' | 'installing' | 'ready' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  currentFile: string | null;
  error: string | null;
  active: boolean;
}

export interface MediaComponentFile {
  url: string;
  path: string;
  size: number;
  sha256: string;
  source: string;
}

export interface MediaComponentDefinition {
  id: MediaComponentId;
  revisions: Record<string, string>;
  files: MediaComponentFile[];
  totalBytes: number;
}

export interface MediaComponentManifest {
  version: 1;
  components: Partial<Record<MediaComponentId, MediaComponentDefinition>>;
}
