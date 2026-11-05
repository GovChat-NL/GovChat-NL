'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function minimalConfig(source) {
  const config = structuredClone(source);
  const endpoint = config.endpoints?.custom?.find(item => item.name === 'govchat-orchestrator');
  if (!endpoint) throw new Error('Minimal UI requires the govchat-orchestrator custom endpoint');
  config.interface = {
    ...config.interface,
    customWelcome: 'Waar kan ik je mee helpen?',
    modelSelect: false, parameters: false, presets: false, multiConvo: false,
    bookmarks: false, memories: false, prompts: true, agents: false,
    temporaryChat: false, autoSubmitFromUrl: false, runCode: false,
    webSearch: false, fileSearch: false, fileCitations: false, skills: false,
    sharedLinks: false, buildInfo: false, contextUsage: false, contextCost: false,
    marketplace: { ...config.interface?.marketplace, use: false },
    mcpServers: { use: false, create: false, share: false, public: false },
    remoteAgents: { use: false, create: false, share: false, public: false },
  };
  config.fileConfig = {
    ...config.fileConfig,
    endpoints: {
      ...config.fileConfig?.endpoints,
      default: { ...config.fileConfig?.endpoints?.default, disabled: false },
      'govchat-orchestrator': { ...config.fileConfig?.endpoints?.['govchat-orchestrator'], disabled: false },
    },
  };
  config.speech = {
    ...config.speech,
    speechTab: { conversationMode: false, advancedMode: false, speechToText: false, textToSpeech: false },
  };
  endpoint.models = { ...endpoint.models, default: ['govchat-orchestrator'], fetch: false };
  config.endpoints.custom = [endpoint];
  return config;
}

function render(env = process.env) {
  const enabled = env.GOVCHAT_MINIMAL_UI || 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('GOVCHAT_MINIMAL_UI must be true or false');
  const sourcePath = env.CONFIG_PATH || '/app/librechat.yaml';
  if (enabled === 'false') return sourcePath;
  const yaml = require('js-yaml'); // Included in the pinned LibreChat image.
  const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-minimal-'));
  const output = path.join(directory, 'librechat.yaml');
  // Preserve unresolved environment placeholders and never log config contents.
  fs.writeFileSync(output, yaml.dump(minimalConfig(source), { lineWidth: -1 }), { mode: 0o600 });
  return output;
}

module.exports = { minimalConfig, render };
if (require.main === module) {
  try {
    process.stdout.write(render() + '\n');
  } catch (error) {
    console.error('GovChat minimal UI: ' + error.message);
    process.exitCode = 1;
  }
}
