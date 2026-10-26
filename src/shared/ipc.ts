import { z } from 'zod';
import { H3_MODES, type H3Mode } from './prompt-contract';
import { SKILL_NAMES, type SkillName } from './skills';
import type {
  Avatar,
  GenerationRequest,
  GenerationStartResult,
  HardwareInfo,
  HardwareProfile,
  LlmProfile,
  Work,
} from './types';

export { SKILL_NAMES } from './skills';

export const IPC_CHANNELS = [
  'jobs:start',
  'jobs:retry',
  'jobs:cancel',
  'files:selectImage',
  'files:selectAudio',
  'files:mediaUrl',
  'files:openFolder',
  'llm:saveProfile',
  'llm:getProfile',
  'llm:listModels',
  'llm:testModel',
  'llm:polish',
  'avatars:list',
  'avatars:create',
  'avatars:update',
  'avatars:delete',
  'works:list',
  'comfy:health',
  'comfy:open',
  'hardware:detect',
  'hardware:apply',
] as const;

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, 'Value must not be empty');
const positiveFiniteNumber = z.number().finite().positive();
const nonNegativeFiniteNumber = z.number().finite().nonnegative();
const emptyPayload = z.object({}).strict();

const httpUrlSchema = z.string().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid LLM base URL' });
    return;
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'LLM base URL must use HTTP or HTTPS without credentials, query, or fragment',
    });
  }
});

const generationRequestSchema = z
  .object({
    mode: z.enum(['text', 'audio']),
    avatarId: nonEmptyString,
    prompt: nonEmptyString,
    duration: positiveFiniteNumber,
    seed: z.number().int().nonnegative(),
    audioPath: nonEmptyString.optional(),
    trimStart: nonNegativeFiniteNumber.optional(),
    retryOf: z.string().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.mode === 'audio' && request.audioPath === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['audioPath'],
        message: 'audioPath is required for audio generation',
      });
    }
  }) satisfies z.ZodType<GenerationRequest>;

const llmProfileInputSchema = z
  .object({
    baseUrl: httpUrlSchema,
    model: nonEmptyString,
    apiKey: z.string().optional(),
  })
  .strict();

const polishRequestSchema = z
  .object({
    text: nonEmptyString,
    duration: positiveFiniteNumber,
    imageCount: z.number().int().min(0).max(9).optional(),
    videoCount: z.number().int().min(0).max(3).optional(),
    referenceLabels: z
      .array(z.string().regex(/^<(?:Picture|Video|Audio|Subject) [1-9]\d*>$/))
      .optional(),
    skill: z.enum([...SKILL_NAMES, 'auto']).optional(),
    mode: z.enum([...H3_MODES, 'auto']).optional(),
  })
  .strict();

const hardwareProfileSchema = z
  .object({
    preset: z.enum(['conservative', 'balanced-16gb', 'high-memory-candidate']),
    modelPolicy: z.enum(['int8', 'bf16-if-present']),
    megapixels: positiveFiniteNumber,
    lowvram: z.boolean(),
    tiling: z.union([z.literal('auto'), z.number().int().positive()]),
    requiresConfirmation: z.boolean(),
  })
  .strict() satisfies z.ZodType<HardwareProfile>;

const comfyNodeSchema = z
  .object({
    class_type: nonEmptyString,
    inputs: z.record(z.string(), z.unknown()),
    _meta: z.object({ title: z.string() }).strict().optional(),
  })
  .strict();

export type IpcSkillName = SkillName;
export type ComfyGraph = Record<string, z.infer<typeof comfyNodeSchema>>;
type PolishSchemaOutput = z.infer<typeof polishRequestSchema>;
export type LlmPolishInput = Omit<PolishSchemaOutput, 'referenceLabels'> & {
  referenceLabels?: readonly string[];
};

export interface HardwareApplyRequest {
  graph: ComfyGraph;
  profile: HardwareProfile;
  confirmed: boolean;
  modelDirectory: string;
}

const hardwareApplySchema = z
  .object({
    graph: z.record(z.string(), comfyNodeSchema),
    profile: hardwareProfileSchema,
    confirmed: z.boolean(),
    modelDirectory: nonEmptyString,
  })
  .strict() satisfies z.ZodType<HardwareApplyRequest>;

function requestSchema<T extends (typeof IPC_CHANNELS)[number], P extends z.ZodType>(
  channel: T,
  payload: P,
) {
  return z.object({ channel: z.literal(channel), payload }).strict();
}

export function createIpcSchema() {
  return z.discriminatedUnion('channel', [
    requestSchema('jobs:start', generationRequestSchema),
    requestSchema(
      'jobs:retry',
      z.object({ id: nonEmptyString }).strict(),
    ),
    requestSchema(
      'jobs:cancel',
      z.object({ id: nonEmptyString.optional() }).strict(),
    ),
    requestSchema('files:selectImage', emptyPayload),
    requestSchema('files:selectAudio', emptyPayload),
    requestSchema(
      'files:mediaUrl',
      z.object({ path: nonEmptyString }).strict(),
    ),
    requestSchema(
      'files:openFolder',
      z.object({ path: nonEmptyString }).strict(),
    ),
    requestSchema('llm:saveProfile', llmProfileInputSchema),
    requestSchema('llm:getProfile', emptyPayload),
    requestSchema('llm:listModels', llmProfileInputSchema),
    requestSchema('llm:testModel', llmProfileInputSchema),
    requestSchema('llm:polish', polishRequestSchema),
    requestSchema('avatars:list', emptyPayload),
    requestSchema(
      'avatars:create',
      z.object({ name: nonEmptyString, photoPath: nonEmptyString }).strict(),
    ),
    requestSchema(
      'avatars:update',
      z.object({ id: nonEmptyString, name: nonEmptyString }).strict(),
    ),
    requestSchema(
      'avatars:delete',
      z.object({ id: nonEmptyString }).strict(),
    ),
    requestSchema('works:list', emptyPayload),
    requestSchema('comfy:health', emptyPayload),
    requestSchema('comfy:open', emptyPayload),
    requestSchema('hardware:detect', emptyPayload),
    requestSchema('hardware:apply', hardwareApplySchema),
  ]);
}

export type IpcRequest = z.infer<ReturnType<typeof createIpcSchema>>;
export type IpcChannel = IpcRequest['channel'];
export type IpcPayload<C extends IpcChannel> = Extract<
  IpcRequest,
  { channel: C }
>['payload'];

export interface LlmTestResult {
  ok: true;
  latencyMs: number;
  summary: string;
}

export interface PolishResult {
  text: string;
  skill: IpcSkillName;
  mode: H3Mode;
  attempts: number;
}

export interface ComfyHealth {
  system: Record<string, unknown>;
  devices: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface SmoApi {
  readonly avatars: {
    list(): Promise<Avatar[]>;
    create(input: IpcPayload<'avatars:create'>): Promise<Avatar>;
    update(input: IpcPayload<'avatars:update'>): Promise<Avatar>;
    delete(id: string): Promise<void>;
  };
  readonly jobs: {
    start(request: GenerationRequest): Promise<GenerationStartResult>;
    retry(id: string): Promise<GenerationStartResult>;
    cancel(id?: string): Promise<void>;
  };

  readonly files: {
    selectImage(): Promise<string | null>;
    selectAudio(): Promise<string | null>;
    mediaUrl(path: string): Promise<string>;
    openFolder(path: string): Promise<void>;
  };
  readonly llm: {
    saveProfile(input: LlmProfile & { apiKey?: string }): Promise<void>;
    getProfile(): Promise<LlmProfile | null>;
    listModels(input: LlmProfile & { apiKey?: string }): Promise<string[]>;
    testModel(input: LlmProfile & { apiKey?: string }): Promise<LlmTestResult>;
    polish(request: LlmPolishInput): Promise<PolishResult>;
  };
  readonly comfy: {
    health(): Promise<ComfyHealth>;
    open(): Promise<void>;
  };
  readonly hardware: {
    detect(): Promise<HardwareInfo>;
    apply(request: HardwareApplyRequest): Promise<ComfyGraph>;
  };
  readonly works: {
    list(): Promise<Work[]>;
  };
}
