import { findExternalToolByName } from './registry.js';

/**
 * 从文本中提取所有可能的 JSON 工具调用对象。
 * 支持嵌套 arguments、多行格式、markdown 代码块包裹。
 */
function extractJsonToolCalls(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];

  // 1. 先尝试从 markdown 代码块中提取
  const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  for (const match of text.matchAll(codeBlockPattern)) {
    const blockContent = match[1].trim();
    tryExtractJsonToolCall(blockContent, results);
  }

  // 2. 用括号平衡法提取顶层 JSON 对象（支持嵌套）
  const jsonObjects = extractTopLevelJsonObjects(text);
  for (const jsonStr of jsonObjects) {
    tryExtractJsonToolCall(jsonStr, results);
  }

  return results;
}

/**
 * 用括号平衡法从文本中提取所有顶层 JSON 对象字符串。
 * 支持嵌套对象和数组。
 */
function extractTopLevelJsonObjects(text) {
  const objects = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let j = start;
    while (j < text.length) {
      const ch = text[j];
      if (escape) {
        escape = false;
        j++;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        j++;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        j++;
        continue;
      }
      if (inString) {
        j++;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
      j++;
      if (depth === 0) {
        const candidate = text.slice(start, j);
        objects.push(candidate);
        break;
      }
    }
    i = j;
  }
  return objects;
}

/**
 * 尝试将字符串解析为工具调用 JSON，成功则加入 results。
 */
function tryExtractJsonToolCall(jsonStr, results) {
  try {
    const parsed = JSON.parse(jsonStr);
    const rawCalls = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tool_calls)
        ? parsed.tool_calls
        : [parsed];
    rawCalls.forEach((rawCall) => {
      const name = rawCall?.function?.name || rawCall?.name;
      const rawArgs = rawCall?.function?.arguments ?? rawCall?.arguments ?? {};
      if (!name || typeof name !== 'string') return;
      results.push({
        name,
        arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
      });
    });
  } catch {
    // not valid JSON, skip
  }
}

export function stripFunctionCallMarkup(text, trim = true) {
  if (!text) return text;
  const cleaned = text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .replace(/<\/?function_calls>/g, '')
    .replace(/```(?:json)?\s*\n?\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}\s*\n?```/g, '');
  return trim ? cleaned.trim() : cleaned;
}

export function parseToolCallsFromText(...chunks) {
  const matches = [];
  chunks.forEach((chunk) => {
    if (!chunk || typeof chunk !== 'string') return;

    // 1. 先尝试匹配 <function_calls> 标签格式
    const blocks = chunk.matchAll(/<function_calls>([\s\S]*?)<\/function_calls>/g);
    let foundTaggedCalls = false;
    for (const block of blocks) {
      const payload = block?.[1]?.trim();
      if (!payload) continue;
      foundTaggedCalls = true;
      try {
        const parsed = JSON.parse(payload);
        const rawCalls = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.tool_calls)
            ? parsed.tool_calls
            : [parsed];
        rawCalls.forEach((rawCall, index) => {
          const name = rawCall?.function?.name || rawCall?.name;
          const rawArgs = rawCall?.function?.arguments ?? rawCall?.arguments ?? {};
          if (!name) return;
          matches.push({
            id: rawCall?.id || `call_${Date.now()}_${matches.length + index + 1}`,
            type: 'function',
            function: {
              name,
              arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
            }
          });
        });
      } catch {
      }
    }

    // 2. Fallback: 如果标签匹配不到，用括号平衡法提取裸 JSON
    //    支持嵌套 arguments、多行格式、markdown 代码块包裹
    if (!foundTaggedCalls) {
      const extracted = extractJsonToolCalls(chunk);
      extracted.forEach((call, index) => {
        matches.push({
          id: `call_${Date.now()}_${matches.length + index + 1}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.arguments
          }
        });
      });
    }
  });
  return matches;
}

export function parseExternalToolCallsFromText(registry, ...chunks) {
  if (!Array.isArray(registry) || registry.length === 0) return [];
  const rawCalls = parseToolCallsFromText(...chunks);
  const counts = new Map();
  return rawCalls.flatMap((rawCall) => {
    const tool = findExternalToolByName(registry, rawCall?.function?.name);
    if (!tool) return [];
    const nextCount = (counts.get(tool.namespacedName) || 0) + 1;
    counts.set(tool.namespacedName, nextCount);
    return [{
      id: rawCall.id || `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, '_')}_${nextCount}`,
      type: 'function',
      function: {
        name: tool.originalName,
        arguments: rawCall.function.arguments
      }
    }];
  });
}

export function createToolCallFilter({ disableTools, forceStrip = false }) {
  if (!disableTools && !forceStrip) return (chunk) => chunk;
  let inBlock = false;
  return (chunk) => {
    if (!chunk) return chunk;
    let output = '';
    let remaining = chunk;
    while (remaining.length) {
      if (inBlock) {
        const endIdx = remaining.indexOf('</function_calls>');
        if (endIdx === -1) {
          return output;
        }
        remaining = remaining.slice(endIdx + '</function_calls>'.length);
        inBlock = false;
        continue;
      }
      const startIdx = remaining.indexOf('<function_calls>');
      if (startIdx === -1) {
        output += remaining;
        return output;
      }
      output += remaining.slice(0, startIdx);
      remaining = remaining.slice(startIdx + '<function_calls>'.length);
      inBlock = true;
    }
    return output;
  };
}

export function createExternalToolCallStreamParser(registry) {
  if (!Array.isArray(registry) || registry.length === 0) {
    return () => [];
  }
  const openTag = '<function_calls>';
  const closeTag = '</function_calls>';
  let buffer = '';
  return (chunk) => {
    if (!chunk) return [];
    buffer += chunk;
    const parsedCalls = [];

    // 1. 先尝试匹配 <function_calls> 标签
    while (buffer.length) {
      const startIdx = buffer.indexOf(openTag);
      if (startIdx === -1) break;
      const endIdx = buffer.indexOf(closeTag, startIdx + openTag.length);
      if (endIdx === -1) {
        buffer = buffer.slice(startIdx);
        break;
      }
      const block = buffer.slice(startIdx, endIdx + closeTag.length);
      parsedCalls.push(...parseExternalToolCallsFromText(registry, block));
      buffer = buffer.slice(endIdx + closeTag.length);
    }

    // 2. Fallback: 如果标签匹配不到，用括号平衡法提取裸 JSON
    if (parsedCalls.length === 0) {
      const extracted = extractJsonToolCalls(buffer);
      extracted.forEach((call) => {
        // 检查是否匹配 registry 中的工具
        const tool = findExternalToolByName(registry, call.name);
        if (tool) {
          parsedCalls.push({
            id: `call_${Date.now()}_${parsedCalls.length + 1}`,
            type: 'function',
            function: {
              name: tool.originalName,
              arguments: call.arguments
            }
          });
          // 从 buffer 中移除已匹配的 JSON
          const jsonStr = JSON.stringify(JSON.parse(call.arguments)); // normalize
          const idx = buffer.indexOf(call.name);
          if (idx > -1) {
            // 找到这个 JSON 对象的起止位置并移除
            let start = buffer.lastIndexOf('{', idx);
            if (start > -1) {
              let depth = 0;
              let inStr = false;
              let esc = false;
              for (let i = start; i < buffer.length; i++) {
                const ch = buffer[i];
                if (esc) { esc = false; continue; }
                if (ch === '\\' && inStr) { esc = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '{') depth++;
                if (ch === '}') depth--;
                if (depth === 0) {
                  buffer = buffer.slice(0, start) + buffer.slice(i + 1);
                  break;
                }
              }
            }
          }
        }
      });
    }

    // 防止 buffer 无限增长
    if (buffer.length > 10000) {
      buffer = buffer.slice(-500);
    }

    return parsedCalls;
  };
}
