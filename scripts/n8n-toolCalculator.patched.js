"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolCalculator = void 0;
const calculator_1 = require("@langchain/community/tools/calculator");
const n8n_workflow_1 = require("n8n-workflow");
const ai_utilities_1 = require("@n8n/ai-utilities");
const govchatPolicy = require("/opt/govchat/n8n-orchestrator-tool-policy.js");
function getTool(ctx) {
    const calculator = new calculator_1.Calculator();
    calculator.name = (0, n8n_workflow_1.nodeNameToToolName)(ctx.getNode());
    return govchatPolicy.guardTool(calculator);
}
class ToolCalculator {
    constructor() {
        this.description = {
            displayName: 'Calculator',
            name: 'toolCalculator',
            icon: 'node:calculator',
            iconColor: 'black',
            group: ['transform'],
            version: 1,
            description: 'Make it easier for AI agents to perform arithmetic',
            defaults: {
                name: 'Calculator',
            },
            codex: {
                categories: ['AI'],
                subcategories: {
                    AI: ['Tools'],
                    Tools: ['Other Tools'],
                },
                resources: {
                    primaryDocumentation: [
                        {
                            url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolcalculator/',
                        },
                    ],
                },
            },
            inputs: [],
            outputs: [n8n_workflow_1.NodeConnectionTypes.AiTool],
            outputNames: ['Tool'],
            properties: [(0, ai_utilities_1.getConnectionHintNoticeField)([n8n_workflow_1.NodeConnectionTypes.AiAgent])],
        };
    }
    async supplyData() {
        return {
            response: (0, ai_utilities_1.logWrapper)(getTool(this), this),
        };
    }
    async execute() {
        const calculator = getTool(this);
        const input = this.getInputData();
        const response = [];
        for (let i = 0; i < input.length; i++) {
            const inputItem = input[i];
            const result = await calculator.invoke(inputItem.json);
            response.push({
                json: {
                    response: result,
                },
                pairedItem: {
                    item: i,
                },
            });
        }
        return [response];
    }
}
exports.ToolCalculator = ToolCalculator;
//# sourceMappingURL=ToolCalculator.node.js.map