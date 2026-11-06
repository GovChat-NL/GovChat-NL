"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAgentSequence = createAgentSequence;
const runnables_1 = require("@langchain/core/runnables");
const agents_1 = require("@langchain/classic/agents");
const common_1 = require("../../common");
const govchatPolicy = require("/opt/govchat/n8n-orchestrator-tool-policy.js");
function createAgentSequence(model, tools, prompt, _options, outputParser, memory, fallbackModel) {
    const agent = (0, agents_1.createToolCallingAgent)({
        llm: model,
        tools: getAllTools(model, tools),
        prompt,
        streamRunnable: true,
    });
    let fallbackAgent;
    if (fallbackModel) {
        fallbackAgent = (0, agents_1.createToolCallingAgent)({
            llm: fallbackModel,
            tools: getAllTools(fallbackModel, tools),
            prompt,
            streamRunnable: true,
        });
    }
    const runnableAgent = runnables_1.RunnableSequence.from([
        fallbackAgent ? agent.withFallbacks([fallbackAgent]) : agent,
        (0, common_1.getAgentStepsParser)(outputParser, memory),
        common_1.fixEmptyContentMessage,
    ]);
    runnableAgent.singleAction = true;
    runnableAgent.streamRunnable = true;
    return runnableAgent;
}
function getAllTools(model, tools) {
    const modelTools = model.metadata?.tools ?? [];
    const allTools = [...tools, ...modelTools];
    return govchatPolicy.selectTools(allTools);
}
//# sourceMappingURL=createAgentSequence.js.map
