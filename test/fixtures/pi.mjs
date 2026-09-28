import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { createRelayExtension } from '../../dist/pi/index.js';
export async function piFixture({
  home,
  cwd,
  url,
  sessionFile,
  strict = false,
  fault,
  extraExtensions = [],
  noTools = 'all',
}) {
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const sessionsDir = join(cwd, 'sessions');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models-cache'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider('relay-fixture', {
    baseUrl: url,
    api: 'openai-completions',
    apiKey: 'synthetic-fixture-only',
    models: [
      {
        id: 'fixture',
        name: 'Fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 256,
      },
    ],
  });
  let host, port;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: 'You are a deterministic local test fixture.',
    extensionFactories: [
      createRelayExtension({
        home,
        realm: 'test',
        strictNoAutoResume: strict,
        fault,
        onAttached(h, p) {
          host = h;
          port = p;
        },
      }),
      ...extraExtensions,
    ],
  });
  await loader.reload();
  const manager = sessionFile
    ? SessionManager.open(sessionFile, sessionsDir)
    : SessionManager.create(cwd, sessionsDir);
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel('relay-fixture', 'fixture'),
    thinkingLevel: 'off',
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools,
  });
  const errors = [];
  await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error) });
  if (!host)
    throw new Error(
      'Relay extension did not attach: ' +
        JSON.stringify({ errors, extensionErrors: extensionsResult.errors }),
    );
  return {
    session,
    host,
    port,
    manager,
    errors,
    async close() {
      await session.abort();
      await session.extensionRunner.emit({ type: 'session_shutdown' });
      session.dispose();
    },
  };
}
