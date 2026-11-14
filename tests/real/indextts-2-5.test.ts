import { expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createFfprobeDurationReader } from '../../src/main/audio-duration';
import { MediaComponentService } from '../../src/main/media-components';
import { SpeechProcessManager } from '../../src/main/speech-process';
import { SpeechRuntime } from '../../src/main/speech-runtime';

const enabled = process.env.SMO_REAL_INDEXTTS_25 === '1';
const referenceAudioPath = resolve(
  process.env.SMO_SPEECH_REFERENCE ??
    'G:\\SMO-H3-Data\\recordings\\b2feff54-16c5-4f37-8983-84d54fd5e5ff.wav',
);
const dataDirectory = resolve(
  process.env.SMO_SPEECH_DATA_DIRECTORY ?? 'G:\\SMO-H3-Data',
);
const componentDirectory = join(dataDirectory, 'components', 'speech');
const outputDirectory = resolve(
  process.env.SMO_INDEXTTS_25_OUTPUT ?? 'test-results/real-indextts-2-5',
);

test.skipIf(!enabled)(
  'real IndexTTS2.5 installs, loads and synthesizes Chinese, faster, emotional and English audio',
  { timeout: 7_200_000 },
  async () => {
    const components = new MediaComponentService({
      dataDirectory,
    });
    const progressTimer = setInterval(() => {
      const state = components.getState('speech');
      if (state.status === 'installing' && state.totalBytes > 0) {
        console.log(
          `IndexTTS2.5 download: ${(state.downloadedBytes / state.totalBytes * 100).toFixed(1)}%`,
        );
      }
    }, 10_000);

    let speech: SpeechProcessManager | undefined;
    let runtime: SpeechRuntime | undefined;
    try {
      console.log('Installing and verifying the IndexTTS2.5 component...');
      await expect(components.install('speech')).resolves.toMatchObject({
        status: 'ready',
        active: false,
      });
      clearInterval(progressTimer);

      const modelDirectory = join(componentDirectory, 'models');
      runtime = new SpeechRuntime({
        modelDirectory,
        runtimeDirectory: join(componentDirectory, 'runtime'),
        projectDirectory: resolve('resources/speech'),
      });
      console.log('Synchronizing the locked Python 3.11 environment...');
      const prepared = await runtime.prepare();

      speech = new SpeechProcessManager({
        pythonPath: prepared.pythonPath,
        serviceScript: resolve('resources/speech/index_tts_service.py'),
        modelDirectory,
        environment: prepared.environment,
        requestTimeoutMs: 600_000,
      });
      console.log('Loading the real IndexTTS2.5 model...');
      await expect(speech.capabilities('custom')).resolves.toMatchObject({
        languages: ['Chinese', 'English', 'Japanese', 'Spanish', 'Arabic'],
      });

      const readDuration = createFfprobeDurationReader();
      const generate = async (
        name: string,
        request: Parameters<SpeechProcessManager['generate']>[0],
      ): Promise<number> => {
        console.log(`Generating ${name}...`);
        const audio = await speech!.generate(request);
        expect(Buffer.from(audio).subarray(0, 4).toString('ascii')).toBe('RIFF');
        const outputPath = join(outputDirectory, `${name}.wav`);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, audio);
        const duration = await readDuration(outputPath);
        console.log(`${name}: ${duration.toFixed(2)} seconds (${outputPath})`);
        return duration;
      };

      const chinese = {
        voiceMode: 'clone' as const,
        text: '大家好，欢迎使用 SMO.H3 Studio 的本地语音合成功能。',
        language: 'Chinese',
        referenceAudioPath,
      };
      const normalDuration = await generate('chinese-normal', {
        ...chinese,
        speechRate: 1,
      });
      const fastDuration = await generate('chinese-fast', {
        ...chinese,
        speechRate: 1.5,
      });
      expect(fastDuration).toBeLessThan(normalDuration * 0.9);

      await generate('chinese-emotion', {
        voiceMode: 'custom',
        text: '今天真是一个值得庆祝的好日子。',
        language: 'Chinese',
        referenceAudioPath,
        instruct: '开心、明亮而富有感染力',
        speechRate: 1,
      });
      await generate('english', {
        voiceMode: 'clone',
        text: 'IndexTTS two point five is running locally in SMO H3 Studio.',
        language: 'English',
        referenceAudioPath,
        speechRate: 1,
      });
    } finally {
      clearInterval(progressTimer);
      await speech?.close();
      await runtime?.close();
    }
  },
);
