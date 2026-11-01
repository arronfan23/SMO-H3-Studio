import { z } from 'zod';
import type {
  EnvironmentStartInput,
  EnvironmentState,
} from './environment';
import { ASPECT_RATIO_OPTIONS, type AspectRatio } from './generation-options';
import { H3_MODES, type H3Mode } from './prompt-contract';
import { SKILL_NAMES, type SkillName } from './skills';
import type {
  Avatar,
  GenerationRequest,
  GenerationStartResult,
  HardwareInfo,
  HardwareProfile,
  HardwareRecommendationInput,
  VideoMode,
  LlmProfile,
  LlmProfileView,
  LlmDiscoveryInput,
  Work,
} from './types';

export { SKILL_NAMES } from './skills';

export const WINDOW_RESIZE_DIRECTIONS = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
] as const;
export type WindowResizeDirection = (typeof WINDOW_RESIZE_DIRECTIONS)[number];

// Pointer position in screen DIPs, reported by the renderer during a resize
// drag. Matches the coordinate space Electron uses for window bounds.
export interface WindowScreenPoint {
  x: number;
  y: number;
}

export const IPC_CHANNELS = [
  'jobs:start',
  'jobs:retry',
  'jobs:cancel',
  'files:selectImage',
  'files:selectAudio',
  'files:authorizeDroppedImage',
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
  'works:delete',
  'works:rename',
  'comfy:health',
  'comfy:start',
  'comfy:open',
  'environment:getState',
  'environment:detect',
  'environment:start',
  'environment:retry',
  'environment:cancel',
  'environment:validate',
  'hardware:detect',
  'hardware:recommend',
  'hardware:reset',
  'hardware:apply',
] as const;

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, 'Value must not be empty');
const ASPECT_RATIO_VALUES = ASPECT_RATIO_OPTIONS.map((option) => option.value) as [
  AspectRatio,
  ...AspectRatio[],
];
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

const llmDiscoveryInputSchema = z
  .object({
    baseUrl: httpUrlSchema,
    model: nonEmptyString.optional(),
    apiKey: z.string().optional(),
  })
  .strict() satisfies z.ZodType<LlmDiscoveryInput>;

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

const environmentProfileIdSchema = z.enum([
  'conservative',
  'balanced-16gb',
  'high-memory-candidate',
]);

const hardwareProfileSchema = z
  .object({
    preset: environmentProfileIdSchema,
    modelPolicy: z.enum(['int8', 'bf16-if-present']),
    megapixels: positiveFiniteNumber,
    aspectRatio: z.enum(ASPECT_RATIO_VALUES).optional(),
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
  mode: 'text' | 'audio';
  profile: HardwareProfile;
  confirmed: boolean;
  modelDirectory: string;
}

export interface HardwareWorkflowResult {
  path: string;
  profile: HardwareProfile;
}

const hardwareRecommendationSchema = z
  .object({
    gpu: nonEmptyString,
    vramGiB: positiveFiniteNumber,
    ramGiB: positiveFiniteNumber,
  })
  .strict() satisfies z.ZodType<HardwareRecommendationInput>;

const hardwareResetSchema = z
  .object({ mode: z.enum(["text", "audio"]) })
  .strict();

const hardwareApplySchema = z
  .object({
    mode: z.enum(['text', 'audio']),
    profile: hardwareProfileSchema,
    confirmed: z.boolean(),
    modelDirectory: nonEmptyString,
  })
  .strict() satisfies z.ZodType<HardwareApplyRequest>;

const environmentDetectSchema = z
  .object({ installRoot: nonEmptyString.optional() })
  .strict();

const environmentStartSchema = z
  .object({
    profileId: environmentProfileIdSchema,
    installRoot: nonEmptyString,
  })
  .strict() satisfies z.ZodType<EnvironmentStartInput>;

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
      'files:authorizeDroppedImage',
      z.object({ path: nonEmptyString }).strict(),
    ),
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
    requestSchema('llm:listModels', llmDiscoveryInputSchema),
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
    requestSchema(
      'works:delete',
      z.object({ id: nonEmptyString }).strict(),
    ),
    requestSchema(
      'works:rename',
      z.object({ id: nonEmptyString, title: nonEmptyString.max(120) }).strict(),
    ),
    requestSchema('comfy:health', emptyPayload),
    requestSchema('comfy:start', emptyPayload),
    requestSchema('comfy:open', emptyPayload),
    requestSchema('environment:getState', emptyPayload),
    requestSchema('environment:detect', environmentDetectSchema),
    requestSchema('environment:start', environmentStartSchema),
    requestSchema('environment:retry', environmentStartSchema),
    requestSchema('environment:cancel', emptyPayload),
    requestSchema('environment:validate', emptyPayload),
    requestSchema('hardware:detect', emptyPayload),
    requestSchema('hardware:recommend', hardwareRecommendationSchema),
    requestSchema('hardware:reset', hardwareResetSchema),
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
    // Accepts the dropped File itself; the preload resolves its absolute path
    // via Electron webUtils before invoking IPC, so the renderer can never
    // authorize an arbitrary string path. Typed structurally (unknown) so the
    // main-process tsconfig (no DOM lib) still compiles this API surface.
    authorizeDroppedImage(file: unknown): Promise<string>;
    mediaUrl(path: string): Promise<string>;
    openFolder(path: string): Promise<void>;
  };
  readonly llm: {
    saveProfile(input: LlmProfile & { apiKey?: string }): Promise<void>;
    getProfile(): Promise<LlmProfileView | null>;
    listModels(input: LlmDiscoveryInput): Promise<string[]>;
    testModel(input: LlmProfile & { apiKey?: string }): Promise<LlmTestResult>;
    polish(request: LlmPolishInput): Promise<PolishResult>;
  };
  readonly comfy: {
    health(): Promise<ComfyHealth>;
    start(): Promise<ComfyHealth>;
    open(): Promise<void>;
  };
  readonly environment: {
    getState(): Promise<EnvironmentState>;
    detect(installRoot?: string): Promise<EnvironmentState>;
    start(input: EnvironmentStartInput): Promise<EnvironmentState>;
    retry(input: EnvironmentStartInput): Promise<EnvironmentState>;
    cancel(): Promise<EnvironmentState>;
    validate(): Promise<EnvironmentState>;
  };
  readonly hardware: {
    detect(): Promise<HardwareInfo>;
    recommend(input: HardwareRecommendationInput): Promise<HardwareProfile>;
    reset(mode: VideoMode): Promise<string>;
    apply(request: HardwareApplyRequest): Promise<HardwareWorkflowResult>;
  };
  readonly works: {
    list(): Promise<Work[]>;
    delete(id: string): Promise<void>;
    rename(input: IpcPayload<'works:rename'>): Promise<Work>;
  };
  readonly window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    beginResize(
      direction: WindowResizeDirection,
      cursor?: WindowScreenPoint,
    ): Promise<boolean>;
    resize(
      direction: WindowResizeDirection,
      cursor?: WindowScreenPoint,
    ): Promise<void>;
    endResize(): Promise<void>;
  };
}
