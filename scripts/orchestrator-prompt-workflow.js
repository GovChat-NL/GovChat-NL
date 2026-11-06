"use strict";

// Scoped migration: retain all deployed tools, connections, credentials and integrations.
const runtimeLoader = `
const promptToken = String($env.CRAWLER_INTERNAL_TOKEN || $env.N8N_WEBHOOK_TOKEN || '').trim();
if (!promptToken) throw new Error('Masterpromptconfiguratie: interne authenticatie ontbreekt');
let orchestratorPrompt;
try {
  const config = await requestJson(overlayBaseUrl + '/api/internal/orchestrator/prompt', {
    method: 'GET',
    timeoutMs: 10000,
    headers: { authorization: 'Bearer ' + promptToken, 'cache-control': 'no-store' },
  });
  if (!config || typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.length > 32000 ||
      !['admin', 'environment', 'default'].includes(config.source)) throw new Error();
  orchestratorPrompt = config.prompt;
} catch {
  throw new Error('Masterpromptconfiguratie is onbereikbaar of ongeldig; verzoek afgebroken zonder vervangende prompt');
}
`;

function configurePromptManagement(workflow) {
  if (workflow.id !== "govchat-orchestrator-litellm") throw new Error("Alleen de GovChat-orkestrator mag worden gemigreerd");
  const detector = workflow.nodes.find(node => node.id === "DetectImageMessages");
  const agent = workflow.nodes.find(node => node.id === "AIAgentOrchestrator");
  if (!detector || !agent) throw new Error("Orkestratortemplate mist vereiste nodes");
  let code = detector.parameters.jsCode;
  if (!code.includes("const promptToken =")) {
    if (!code.includes("let configuredMaxChars =")) throw new Error("Onbekende runtime-loaderstructuur");
    code = code.replace("let configuredMaxChars =", runtimeLoader + "\nlet configuredMaxChars =");
    code = code.replace("fetch(url, opts)", "fetch(url, { ...opts, ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}) })");
    code = code.replace("req.on('error', reject);", "if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('Request timeout')));\n      req.on('error', reject);");
    code = code.replace("    ...raw,", "    ...raw,\n    orchestratorPrompt,");
    code = code.replace("model, messages: normalizedMessages, temperature: 0.2", "model, messages: [{ role: 'system', content: orchestratorPrompt }, ...normalizedMessages], temperature: 0.2");
    detector.parameters.jsCode = code;
  }
  let expression = agent.parameters.options.systemMessage;
  if (!expression.includes("const organizationPrompt =")) {
    const match = expression.match(/const base = '([^']*)';/);
    if (!match) throw new Error("Onbekende masterpromptstructuur; geen wijzigingen uitgevoerd");
    const technical = "Als de input begint met [FINAL_ANSWER], geef exact alles na dit label terug als eindantwoord zonder extra tekst.";
    if (!match[1].endsWith(technical)) throw new Error("FINAL_ANSWER-regel ontbreekt");
    expression = expression.replace(match[0],
      `const organizationPrompt = $json.orchestratorPrompt;\n  if (typeof organizationPrompt !== 'string' || !organizationPrompt.trim() || organizationPrompt.length > 32000) throw new Error('Masterpromptconfiguratie ontbreekt of is ongeldig');\n  const base = organizationPrompt + '\\n\\n' + ${JSON.stringify(technical)};`);
    agent.parameters.options.systemMessage = expression;
  }
  // The per-request prompt must not be retained in n8n execution history/log data.
  workflow.settings = { ...workflow.settings, saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveManualExecutions: false, saveExecutionProgress: false };
  return workflow;
}

module.exports = { configurePromptManagement };
