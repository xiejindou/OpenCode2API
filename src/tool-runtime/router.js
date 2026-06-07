import { EXTERNAL_TOOL_PREFIX } from './contracts.js';
import { findExternalToolByName } from './registry.js';

export function normalizeExternalToolChoice(toolChoice, registry) {
  if (!toolChoice || !Array.isArray(registry) || registry.length === 0) {
    return { mode: 'auto', requiredTool: null };
  }
  if (toolChoice === 'auto' || toolChoice === 'none') {
    return { mode: toolChoice, requiredTool: null };
  }
  if (toolChoice === 'required') {
    return { mode: 'required', requiredTool: null };
  }
  const requestedName = toolChoice?.function?.name;
  if (toolChoice?.type === 'function' && requestedName) {
    const mappedTool = findExternalToolByName(registry, requestedName);
    return {
      mode: 'required',
      requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${requestedName}`
    };
  }
  return { mode: 'auto', requiredTool: null };
}

export function buildExternalToolsPrompt(registry, toolChoice = null) {
  if (!Array.isArray(registry) || registry.length === 0) return '';
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const choiceInstructions = [];
  if (normalizedChoice.mode === 'required') {
    if (normalizedChoice.requiredTool) {
      choiceInstructions.push(`Tool use is REQUIRED for this turn. You MUST call ${normalizedChoice.requiredTool} before giving any final answer.`);
    } else {
      choiceInstructions.push('Tool use is REQUIRED for this turn. You MUST call an external tool before giving any final answer.');
    }
  } else if (normalizedChoice.mode === 'none') {
    choiceInstructions.push('Tool use is disabled for this turn. Do not emit <function_calls>.');
  }

  return [
    'External tools are virtualized by this proxy. They are not OpenCode tools.',
    'When you need to call an external tool, your ENTIRE reply MUST be ONLY <function_calls>...</function_calls> blocks.',
    'Format: <function_calls>{"name":"external__tool_name","arguments":{}}</function_calls>',
    'Rules:',
    '- You MUST wrap every tool call inside <function_calls>...</function_calls> tags. Do NOT output bare JSON.',
    '- Do NOT output thinking, explanations, markdown, prose, or any text before or after <function_calls> blocks when making a tool call.',
    '- Arguments must be a valid JSON object matching the declared schema.',
    '- Use ONLY the namespaced names listed below (e.g. external__tool_name). Do NOT use original client tool names.',
    '- When a user request matches an available tool, prefer calling the tool over answering from general knowledge.',
    '- When a user request does NOT match any available tool, answer directly without calling tools.',
    '- If tool results are later provided as TOOL_RESULT messages, use those results to continue normally.',
    ...choiceInstructions,
    `Available external tools: ${JSON.stringify(registry.map((tool) => ({
      name: tool.namespacedName,
      client_name: tool.originalName,
      description: tool.description,
      parameters: tool.parameters,
      risk_level: tool.riskLevel,
      side_effect: tool.sideEffect,
      requires_confirmation: tool.requiresConfirmation
    })))}`,
  ].join('\n');
}

export function buildToolExposure(registry, toolChoice = null) {
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry);
  const exposedTools = Array.isArray(registry) ? registry.filter((tool) => tool.enabled !== false) : [];
  return {
    tools: exposedTools,
    toolChoice: normalizedChoice,
    prompt: buildExternalToolsPrompt(exposedTools, toolChoice)
  };
}
