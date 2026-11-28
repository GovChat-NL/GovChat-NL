'use strict';

// Deliberately source-level, not a bundle rewrite or a maintained LibreChat fork.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const helperPath = 'client/src/components/Chat/useManualEntrypoints.ts';
const helper = `import { useEffect, useState } from 'react';

// Only the authenticated overlay owner controls activation. Native text stays native.
export function useManualEntrypoints(): boolean {
  const read = () => typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-govchat-manual-enabled') === 'true';
  const [enabled, setEnabled] = useState(read);
  useEffect(() => {
    const sync = () => setEnabled(read());
    window.addEventListener('govchat:manual-state', sync);
    sync();
    return () => window.removeEventListener('govchat:manual-state', sync);
  }, []);
  return enabled;
}

export function openManualEntrypoint(): void {
  window.dispatchEvent(new CustomEvent('govchat:manual-open', { cancelable: true }));
}
`;
const patches = [
  {
    file: 'client/src/components/Chat/Footer.tsx',
    sha256: 'f3d797dff319ccc254258c98407a8367ef6415ddff1d3eeaf4e36c13d9ec0d4c',
    changes: [
      ["import { useLocalize } from '~/hooks';", "import { useLocalize } from '~/hooks';\nimport { useManualEntrypoints } from './useManualEntrypoints';"],
      ['export function useConfiguredFooter(): boolean {', 'export function useConfiguredFooter(): boolean {\n  const manualEnabled = useManualEntrypoints();'],
      ['return isSuccess ? hasConfiguredFooter(config) : shellHasConfiguredFooter;', 'return manualEnabled || (isSuccess ? hasConfiguredFooter(config) : shellHasConfiguredFooter);'],
      ['  const localize = useLocalize();', '  const localize = useLocalize();\n  const manualEnabled = useManualEntrypoints();'],
      ['if (footerElements.length === 0) {', 'if (footerElements.length === 0 && !manualEnabled) {'],
      ['<div className="relative w-full">', '<div className="relative w-full" data-govchat-manual-footer="native">'],
      ['        })}\n      </div>', '        })}\n        {manualEnabled && <span data-govchat-manual-slot="desktop" />}\n      </div>\n      {manualEnabled && (\n        <div className="absolute bottom-0 right-0 z-20 px-2 py-1 sm:hidden" data-govchat-manual-slot="mobile" />\n      )}'],
    ],
  },
  {
    file: 'client/src/components/Nav/AccountSettings.tsx',
    sha256: 'bd46d02f9d29a3b14cb71323f529862243d74e27322f094fedcb110e0e552157',
    changes: [
      ["import Settings from './Settings';", "import Settings from './Settings';\nimport { useManualEntrypoints, openManualEntrypoint } from '../Chat/useManualEntrypoints';"],
      ["  const hasHelpFaq = !!helpAndFaqURL && helpAndFaqURL !== '/';", "  const manualEnabled = useManualEntrypoints();\n  const hasHelpFaq = !!helpAndFaqURL && helpAndFaqURL !== '/';"],
      ['{hasHelpFaq && (', '{(manualEnabled || hasHelpFaq) && ('],
      ['onClick={() => openInNewTab(helpAndFaqURL)}', 'data-govchat-manual-menu="help-faq"\n            onClick={() => manualEnabled ? openManualEntrypoint() : openInNewTab(helpAndFaqURL)}'],
    ],
  },
  {
    file: 'client/src/components/Messages/Content/Error/index.tsx',
    sha256: '9183e3094f986d7fb34f725c0169fbbd935eca29db8c287115b4c2658d24e616',
    changes: [
      ['const Error = ({ text, message: rowMessage }:', 'const NativeError = ({ text, message: rowMessage }:'],
      ['export default Error;', `// Marker wraps only the pinned failed-turn renderer, never generated chat.
const Error = (props: { text: string; message?: ErrorSource }) => {
  let code: string | undefined = parseLangChainErrorCode(props.text) ?? undefined;
  let message: string | undefined;
  try {
    const jsonString = extractJson(props.text);
    if (isJson(jsonString)) {
      const json = JSON.parse(jsonString) as ErrorPayload;
      const envelope = readObject(json, 'error');
      code = readString(json, 'code') ?? readString(json, 'type') ??
        readString(envelope, 'code') ?? readString(envelope, 'type') ?? code;
      message = readString(envelope, 'message') ?? readString(json, 'message');
    } else {
      message = props.text;
    }
  } catch { /* Native renderer retains its own error behavior. */ }
  return (
    <div data-govchat-manual-error="message" data-govchat-error-code={code} data-govchat-error-message={message}>
      <NativeError {...props} />
      <span data-govchat-manual-error-actions="" />
    </div>
  );
};

export default Error;`],
    ],
  },
  {
    file: 'client/src/components/Auth/ErrorMessage.tsx',
    sha256: 'f8cfca9fa14ff9048b2979110eb8dee2b431989f96b1cb3c4cd911403f6748bf',
    changes: [
      ['  <Alert\n', '  <div data-govchat-manual-error="auth">\n  <Alert\n'],
      ['  </Alert>\n', '  </Alert>\n  <span data-govchat-manual-error-actions="" />\n  </div>\n'],
    ],
  },
  {
    file: 'client/src/components/Agents/ErrorDisplay.tsx',
    sha256: '6614adde4110f46af92b4fc39f29cb11737f817cfdb9fe5be7a8dca9337071bc',
    changes: [
      ['<div className="py-12 text-center" role="alert"', '<div data-govchat-manual-error="agent" data-govchat-error-code={isErrorObject(error) && typeof error.code === \'string\' ? error.code : undefined} className="py-12 text-center" role="alert"'],
      ['        {/* Retry button with enhanced accessibility */}', '        <span data-govchat-manual-error-actions="" />\n        {/* Retry button with enhanced accessibility */}'],
    ],
  },
  {
    file: 'client/src/components/Chat/Input/ChatForm.tsx',
    sha256: 'cb5cfccac60bf632d98d4adda9fd787d3b1a704682eaa5271c91dd6fceffed8a',
    changes: [
      ["import { useGetStartupConfig } from '~/data-provider';", "import { useGetStartupConfig } from '~/data-provider';\nimport { useManualEntrypoints } from '../useManualEntrypoints';"],
      ['  const localize = useLocalize();', '  const localize = useLocalize();\n  const manualEnabled = useManualEntrypoints();'],
      ['  /** Answer mode, then during-run steering', "  // Below sm the upstream composer otherwise covers the native help control.\n  // Reserve only the optional manual's 44px mobile target; desktop stays upstream.\n  if (manualEnabled) bottomClearance = `mb-14 ${bottomClearance}`;\n\n  /** Answer mode, then during-run steering"],
    ],
  },
];

function replaceOnce(text, from, to, filename) {
  if (text.split(from).length !== 2) throw new Error(`Native marker anchor changed: ${filename}`);
  return text.replace(from, to);
}

function patchManualNative(root) {
  const staged = patches.map(patch => {
    const filename = path.join(root, patch.file);
    const source = fs.readFileSync(filename, 'utf8');
    let original = source;
    if (hash(source) !== patch.sha256) {
      // Reverse exact additions, then require the exact pinned original fingerprint.
      for (const [from, to] of [...patch.changes].reverse()) original = replaceOnce(original, to, from, patch.file);
    }
    if (hash(original) !== patch.sha256) throw new Error(`Pinned v0.8.8 source changed: ${patch.file}`);
    let result = original;
    for (const [from, to] of patch.changes) result = replaceOnce(result, from, to, patch.file);
    if (source !== original && source !== result) throw new Error(`Partial native patch: ${patch.file}`);
    return { filename, source, result };
  });
  const helperFile = path.join(root, helperPath);
  if (fs.existsSync(helperFile) && fs.readFileSync(helperFile, 'utf8') !== helper) throw new Error('Native helper source changed');
  // All source assertions precede writes. Repeated runs leave every file byte-identical.
  for (const { filename, source, result } of staged) if (source !== result) fs.writeFileSync(filename, result);
  if (!fs.existsSync(helperFile)) fs.writeFileSync(helperFile, helper);
  return staged.map(entry => path.relative(root, entry.filename)).concat(helperPath);
}

module.exports = { patchManualNative, patches, helper, helperPath };
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node patch-manual-native.js LIBRECHAT_SOURCE_ROOT');
  patchManualNative(path.resolve(process.argv[2]));
}
