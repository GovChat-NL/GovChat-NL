"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processEventStream = processEventStream;
async function processEventStream(ctx, eventStream, itemIndex) {
    const agentResult = {
        output: '',
    };
    const toolCalls = [];
    const emittedToolCallIds = new Set();
    const activeToolCalls = new Map();
    ctx.sendChunk('begin', itemIndex);
    try {
        for await (const event of eventStream) {
            switch (event.event) {
            case 'on_chat_model_stream':
                const chunk = event.data?.chunk;
                if (chunk?.content) {
                    const chunkContent = chunk.content;
                    let chunkText = '';
                    if (Array.isArray(chunkContent)) {
                        for (const message of chunkContent) {
                            if (message?.type === 'text') {
                                chunkText += message?.text;
                            }
                        }
                    }
                    else if (typeof chunkContent === 'string') {
                        chunkText = chunkContent;
                    }
                    ctx.sendChunk('item', itemIndex, chunkText);
                    agentResult.output += chunkText;
                }
                break;
            case 'on_chat_model_end':
                if (event.data) {
                    const chatModelData = event.data;
                    const output = chatModelData.output;
                    if (output?.tool_calls && output.tool_calls.length > 0) {
                        for (const toolCall of output.tool_calls) {
                            const normalizedToolCall = {
                                tool: toolCall.name,
                                toolInput: toolCall.args,
                                toolCallId: toolCall.id || 'unknown',
                                type: toolCall.type || 'tool_call',
                                log: output.content ||
                                    `Calling ${toolCall.name} with input: ${JSON.stringify(toolCall.args)}`,
                                messageLog: [output],
                                additionalKwargs: output.additional_kwargs,
                            };
                            if (!emittedToolCallIds.has(normalizedToolCall.toolCallId)) {
                                toolCalls.push(normalizedToolCall);
                                activeToolCalls.set(normalizedToolCall.toolCallId, normalizedToolCall);
                                emittedToolCallIds.add(normalizedToolCall.toolCallId);
                                ctx.sendChunk('tool_call', itemIndex, JSON.stringify({
                                    type: 'tool_call',
                                    id: normalizedToolCall.toolCallId,
                                    name: normalizedToolCall.tool,
                                    arguments: normalizedToolCall.toolInput,
                                }));
                            }
                        }
                    }
                }
                break;
            case 'on_tool_end':
            case 'on_tool_error': {
                const toolName = event.name || event.data?.name || '';
                const toolInput = event.data?.input;
                const activeCalls = [...activeToolCalls.values()];
                const nameMatches = activeCalls.filter((call) => !toolName || call.tool === toolName);
                const candidates = nameMatches.length > 0 ? nameMatches : activeCalls;
                const matchedByInput = candidates.find((call) => toolInput !== undefined &&
                    JSON.stringify(call.toolInput) === JSON.stringify(toolInput));
                const matched = matchedByInput || (candidates.length === 1 ? candidates[0] : null);
                if (matched) {
                    activeToolCalls.delete(matched.toolCallId);
                    const isError = event.event === 'on_tool_error';
                    const result = isError
                        ? { type: 'tool_error', id: matched.toolCallId, name: matched.tool, error: String(event.data?.error?.message || event.data?.error || 'Tool execution failed') }
                        : { type: 'tool_result', id: matched.toolCallId, name: matched.tool, output: typeof event.data?.output === 'string' ? event.data.output : JSON.stringify(event.data?.output ?? '') };
                    ctx.sendChunk(result.type, itemIndex, JSON.stringify(result));
                }
                break;
            }
                default:
                    break;
            }
        }
    } catch (streamError) {
        for (const activeToolCall of activeToolCalls.values()) {
            ctx.sendChunk('tool_error', itemIndex, JSON.stringify({
                type: 'tool_error',
                id: activeToolCall.toolCallId,
                name: activeToolCall.tool,
                error: `Tool stream failed: ${streamError?.message || String(streamError)}`,
            }));
        }
        activeToolCalls.clear();
        throw streamError;
    }
    ctx.sendChunk('end', itemIndex);
    if (toolCalls.length > 0) {
        agentResult.toolCalls = toolCalls;
    }
    return agentResult;
}
//# sourceMappingURL=processEventStream.js.map
