/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';

function logPromptAnalysis(message: string, data?: any) {
  // console.log('logPromptAnalysis', message, data);
  try {
    const timestamp = new Date().toISOString();
    const logPath = path.join(process.cwd(), '.doh', 'logs', 'qwen.log');
    
    let dataString = '';
    if (data) {
      // Handle the case where data might contain already-stringified JSON
      dataString = '\n' + JSON.stringify(data, (key, value) => {
        // If we encounter a string that looks like JSON, try to parse it for better formatting
        if (typeof value === 'string' && (key === 'arguments' || key === 'content')) {
          try {
            const parsed = JSON.parse(value);
            // If it parses successfully, return the parsed object for proper formatting
            return parsed;
          } catch {
            // If it fails to parse, return the original string
            return value;
          }
        }
        return value;
      }, 2);
    }
    
    const logEntry = `[${timestamp}] ${message}${dataString}\n\n`;
    fs.appendFileSync(logPath, logEntry);
  } catch (error) {
    // Silent fail to avoid breaking the main functionality
    console.error('Failed to log prompt analysis:', error);
  }
}

/**
 * Virtual filesystem representation for tracking file states
 */
interface VirtualFileSystem {
  [filepath: string]: {
    [lineNumber: number]: string;
  };
}

/**
 * File operation extracted from tool calls
 */
interface FileOperation {
  type: 'read' | 'write' | 'edit';
  filepath: string;
  content?: string;
  lineChanges?: { [lineNumber: number]: string };
  toolCallId: string;
}

/**
 * Deconstructed message structure
 */
interface DeconstructedMessages {
  systemPrompt: string;
  cannedUserContext: string;
  cannedAssistantReply: string;
  realConversation: OpenAI.Chat.ChatCompletionMessageParam[];
  toolCallPairs: Array<{
    toolCall: OpenAI.Chat.ChatCompletionMessageToolCall;
    result: string;
  }>;
  virtualFileSystem: VirtualFileSystem;
  fileOperationToolCallIds: Set<string>;
}

/**
 * Extract file operations from tool calls
 */
function extractFileOperationFromToolCall(toolCall: OpenAI.Chat.ChatCompletionMessageToolCall, result: string): FileOperation | null {
  const functionName = toolCall.function?.name;
  if (!functionName || !toolCall.id) return null;

  // logPromptAnalysis('Extracting file operation from tool call', {
  //   functionName,
  //   toolCallId: toolCall.id,
  //   toolCall: toolCall,
  //   result
  // });

  let args: any = {};
  try {
    args = JSON.parse(toolCall.function?.arguments || '{}');
  } catch {
    return null;
  }
        // logPromptAnalysis('Extracting file operation from tool call: args', {
        //   args
        // });

  switch (functionName) {
    case 'read_file':
    case 'read_many_files':
      if (args.absolute_path && typeof args.absolute_path === 'string') {
        return {
          type: 'read',
          filepath: args.absolute_path,
          content: result,
          toolCallId: toolCall.id
        };
      }
      // Handle read_many_files with multiple file paths
      if (args.absolute_paths && Array.isArray(args.absolute_paths) && args.absolute_paths.length > 0) {
        // For multiple files, we'll process the first one (could be enhanced to handle all)
        return {
          type: 'read',
          filepath: args.absolute_paths[0],
          content: result,
          toolCallId: toolCall.id
        };
      }
      break;

    case 'write_file':
      if (args.file_path && args.content && typeof args.file_path === 'string') {
        return {
          type: 'write',
          filepath: args.file_path,
          content: args.content,
          toolCallId: toolCall.id
        };
      }
      break;

    case 'replace':
      if (args.file_path && typeof args.file_path === 'string') {
        return {
          type: 'edit',
          filepath: args.file_path,
          toolCallId: toolCall.id
        };
      }
      break;
  }

  return null;
}


/**
 * Read actual file content from disk for a specific range
 */
function readFileRange(filepath: string, offset?: number, limit?: number): { [lineNumber: number]: string } {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.split('\n');
    const lineMap: { [lineNumber: number]: string } = {};
    
    const startLine = Math.max(0, offset || 0);
    const endLine = limit ? Math.min(lines.length, startLine + limit) : lines.length;
    
    for (let i = startLine; i < endLine; i++) {
      lineMap[i + 1] = lines[i]; // 1-indexed line numbers
    }
    
    return lineMap;
  } catch (error) {
    // If file can't be read, return empty map
    return {};
  }
}

/**
 * Build virtual filesystem from file operations by reading actual current file contents
 */
function buildVirtualFileSystem(toolCallPairs: Array<{ toolCall: OpenAI.Chat.ChatCompletionMessageToolCall; result: string }>): VirtualFileSystem {
  const vfs: VirtualFileSystem = {};
  const trackedFiles = new Set<string>();

  // Extract file paths and read current content from disk
  for (const pair of toolCallPairs) {
    const operation = extractFileOperationFromToolCall(pair.toolCall, pair.result);
    if (operation && operation.filepath) {
      trackedFiles.add(operation.filepath);
      
      if (operation.type === 'read') {
        // For read operations, get the exact range that was read
        const args = JSON.parse(pair.toolCall.function?.arguments || '{}');
        const offset = args.offset || 0;
        const limit = args.limit;
        
        // Read the current state of the file for this range
        const fileLines = readFileRange(operation.filepath, offset, limit);
        
        // Merge with existing tracked content
        if (!vfs[operation.filepath]) {
          vfs[operation.filepath] = {};
        }
        Object.assign(vfs[operation.filepath], fileLines);
      } else {
        // For write/edit operations, read the entire current file
        const fileLines = readFileRange(operation.filepath);
        vfs[operation.filepath] = fileLines;
      }
    }
  }

  return vfs;
}

/**
 * Convert line map to consecutive ranges
 */
function groupLinesIntoRanges(lines: { [lineNumber: number]: string }): Array<{ start: number; end: number; content: string[] }> {
  const sortedLineNumbers = Object.keys(lines).map(n => parseInt(n)).sort((a, b) => a - b);
  if (sortedLineNumbers.length === 0) return [];

  const ranges: Array<{ start: number; end: number; content: string[] }> = [];
  let currentRange = {
    start: sortedLineNumbers[0],
    end: sortedLineNumbers[0],
    content: [lines[sortedLineNumbers[0]]]
  };

  for (let i = 1; i < sortedLineNumbers.length; i++) {
    const lineNum = sortedLineNumbers[i];
    const prevLineNum = sortedLineNumbers[i - 1];

    if (lineNum === prevLineNum + 1) {
      // Consecutive line, extend current range
      currentRange.end = lineNum;
      currentRange.content.push(lines[lineNum]);
    } else {
      // Gap found, start new range
      ranges.push(currentRange);
      currentRange = {
        start: lineNum,
        end: lineNum,
        content: [lines[lineNum]]
      };
    }
  }

  ranges.push(currentRange);
  return ranges;
}

/**
 * Generate virtual filesystem context for system prompt
 */
function generateVirtualFileSystemContext(vfs: VirtualFileSystem): string {
  if (Object.keys(vfs).length === 0) {
    return '';
  }

  let context = '\n\n═══ 📁 CURRENT FILE STATES ═══\n\n';
  context += 'The following files have been read or modified during this conversation:\n\n';

  const fileEntries = Object.entries(vfs);
  for (let i = 0; i < fileEntries.length; i++) {
    const [filepath, lines] = fileEntries[i];
    context += `## ${filepath}\n`;
    
    const lineCount = Object.keys(lines).length;
    if (lineCount === 0) {
      context += '*File was modified but content not tracked*\n\n';
      continue;
    }

    const ranges = groupLinesIntoRanges(lines);
    
    for (const range of ranges) {
      if (range.start === range.end) {
        context += `**Line ${range.start}:**\n`;
      } else {
        context += `**Lines ${range.start}-${range.end}:**\n`;
      }
      
      context += '```\n';
      context += range.content.join('\n');
      context += '\n```\n\n';
    }
    
    // Add separator between files (but not after the last one)
    if (i < fileEntries.length - 1) {
      context += '--- END OF FILE ---\n\n';
    }
  }

  return context;
}

/**
 * Filter out tool calls that are replaced by virtual filesystem
 */
function filterToolCallsForVirtualFileSystem(
  toolCallPairs: Array<{ toolCall: OpenAI.Chat.ChatCompletionMessageToolCall; result: string }>
): Array<{ toolCall: OpenAI.Chat.ChatCompletionMessageToolCall; result: string }> {
  const fileOperationToolCallIds = new Set<string>();

  // Identify tool calls that are file operations
  for (const pair of toolCallPairs) {
    const operation = extractFileOperationFromToolCall(pair.toolCall, pair.result);
    if (operation) {
      fileOperationToolCallIds.add(pair.toolCall.id || '');
    }
  }

  // Return only non-file-operation tool calls
  return toolCallPairs.filter(pair => !fileOperationToolCallIds.has(pair.toolCall.id || ''));
}

/**
 * Analyze the conversation to determine which tool calls to keep vs move to system prompt
 */
function analyzeToolCallStrategy(realConversation: OpenAI.Chat.ChatCompletionMessageParam[]): {
  keepLastToolSequence: boolean;
  lastToolCallIds: Set<string>;
} {
  if (realConversation.length === 0) {
    return { keepLastToolSequence: false, lastToolCallIds: new Set() };
  }

  // Helper function to find the assistant message that contains the tool calls for a given tool result
  const findAssistantMessageWithToolCalls = (toolCallId: string): OpenAI.Chat.ChatCompletionMessageToolCall[] | null => {
    for (const message of realConversation) {
      if (message.role === 'assistant' && 'tool_calls' in message && message.tool_calls) {
        const hasToolCall = message.tool_calls.some(tc => tc.id === toolCallId);
        if (hasToolCall) {
          return message.tool_calls;
        }
      }
    }
    return null;
  };

  const lastMessage = realConversation[realConversation.length - 1];
  
  // Check if last message is a tool result
  if (lastMessage.role === 'tool') {
    const lastToolCallId = 'tool_call_id' in lastMessage ? lastMessage.tool_call_id : '';
    if (lastToolCallId) {
      // Find the assistant message that contains this tool call and get ALL tool calls from it
      const allToolCallsFromLastSequence = findAssistantMessageWithToolCalls(lastToolCallId);
      if (allToolCallsFromLastSequence) {
        const allToolCallIds = allToolCallsFromLastSequence
          .map(tc => tc.id)
          .filter((id): id is string => !!id);
        return { 
          keepLastToolSequence: true, 
          lastToolCallIds: new Set(allToolCallIds) 
        };
      }
    }
    return { 
      keepLastToolSequence: true, 
      lastToolCallIds: new Set(lastToolCallId ? [lastToolCallId] : []) 
    };
  }

  // Check if last message is "Please continue." after a tool result
  if (lastMessage.role === 'user' && 
      typeof lastMessage.content === 'string' && 
      lastMessage.content.trim() === 'Please continue.' &&
      realConversation.length >= 2) {
    
    const secondToLastMessage = realConversation[realConversation.length - 2];
    if (secondToLastMessage.role === 'tool') {
      const lastToolCallId = 'tool_call_id' in secondToLastMessage ? secondToLastMessage.tool_call_id : '';
      if (lastToolCallId) {
        // Find the assistant message that contains this tool call and get ALL tool calls from it
        const allToolCallsFromLastSequence = findAssistantMessageWithToolCalls(lastToolCallId);
        if (allToolCallsFromLastSequence) {
          const allToolCallIds = allToolCallsFromLastSequence
            .map(tc => tc.id)
            .filter((id): id is string => !!id);
          return { 
            keepLastToolSequence: true, 
            lastToolCallIds: new Set(allToolCallIds) 
          };
        }
      }
      return { 
        keepLastToolSequence: true, 
        lastToolCallIds: new Set(lastToolCallId ? [lastToolCallId] : []) 
      };
    }
  }

  // Final message is not a tool result, move all tool calls to system prompt
  return { keepLastToolSequence: false, lastToolCallIds: new Set() };
}

/**
 * Deconstruct the finalMessages array into its component parts
 */
function deconstructMessages(finalMessages: OpenAI.Chat.ChatCompletionMessageParam[]): DeconstructedMessages {
  // logPromptAnalysis('Deconstructing messages', { messageCount: finalMessages.length });

  if (finalMessages.length < 3) {
    return {
      systemPrompt: '',
      cannedUserContext: '',
      cannedAssistantReply: '',
      realConversation: finalMessages,
      toolCallPairs: [],
      virtualFileSystem: {},
      fileOperationToolCallIds: new Set()
    };
  }

  // Expected pattern: [system, user context, assistant reply, ...real conversation]
  const systemMessage = finalMessages[0];
  const userContextMessage = finalMessages[1];
  const assistantReplyMessage = finalMessages[2];
  const realConversation = finalMessages.slice(3);

  // Extract system prompt
  const systemPrompt = systemMessage.role === 'system' && typeof systemMessage.content === 'string' 
    ? systemMessage.content 
    : '';

  // Extract canned context
  const cannedUserContext = userContextMessage.role === 'user' && typeof userContextMessage.content === 'string'
    ? userContextMessage.content
    : '';

  // Extract canned reply
  const cannedAssistantReply = assistantReplyMessage.role === 'assistant' && typeof assistantReplyMessage.content === 'string'
    ? assistantReplyMessage.content
    : '';

  // Analyze which tool calls to keep vs move
  const strategy = analyzeToolCallStrategy(realConversation);
  
  // logPromptAnalysis('Tool call strategy', {
  //   keepLastToolSequence: strategy.keepLastToolSequence,
  //   lastToolCallIds: Array.from(strategy.lastToolCallIds)
  // });

  // Extract and pair tool calls with results
  const toolCallPairs: Array<{ toolCall: OpenAI.Chat.ChatCompletionMessageToolCall; result: string; }> = [];
  const toolCallMap = new Map<string, OpenAI.Chat.ChatCompletionMessageToolCall>();

  // First pass: collect all tool calls from assistant messages
  for (const message of finalMessages) {
    if (message.role === 'assistant' && 'tool_calls' in message && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id) {
          toolCallMap.set(toolCall.id, toolCall);
        }
      }
    }
  }

  // Second pass: match tool results with their calls, but only include ones we want to move to system prompt
  for (const message of finalMessages) {
    if (message.role === 'tool' && 'tool_call_id' in message && message.tool_call_id) {
      const toolCall = toolCallMap.get(message.tool_call_id);
      if (toolCall && typeof message.content === 'string') {
        // Only add to toolCallPairs if we should move it to system prompt
        const shouldMoveToSystemPrompt = !strategy.keepLastToolSequence || 
                                       !strategy.lastToolCallIds.has(message.tool_call_id);
        
        if (shouldMoveToSystemPrompt) {
          toolCallPairs.push({
            toolCall,
            result: message.content
          });
        }
      }
    }
  }

  // Build virtual filesystem from file operations
  const virtualFileSystem = buildVirtualFileSystem(toolCallPairs);
  
  // Get IDs of file operation tool calls that will be moved to VFS
  const fileOperationToolCallIds = new Set<string>();
  for (const pair of toolCallPairs) {
    const operation = extractFileOperationFromToolCall(pair.toolCall, pair.result);
    // logPromptAnalysis('Processing tool call pair for VFS', {
    //   toolCallId: pair.toolCall.id,
    //   functionName: pair.toolCall.function?.name,
    //   hasOperation: !!operation
    // });
    if (operation) {
      fileOperationToolCallIds.add(pair.toolCall.id || '');
      // logPromptAnalysis('Added to fileOperationToolCallIds', {
      //   toolCallId: pair.toolCall.id,
      //   currentSize: fileOperationToolCallIds.size
      // });
    }
  }
  
  // Filter out file operation tool calls since they're now represented in the VFS
  const filteredToolCallPairs = filterToolCallsForVirtualFileSystem(toolCallPairs);
  
  // Log the complete VFS contents
  // logPromptAnalysis('Virtual filesystem contents', {
  //   virtualFileSystem: virtualFileSystem,
  //   fileOperationToolCallIds: Array.from(fileOperationToolCallIds)
  // });

  return {
    systemPrompt,
    cannedUserContext,
    cannedAssistantReply,
    realConversation,
    toolCallPairs: filteredToolCallPairs,
    virtualFileSystem,
    fileOperationToolCallIds: fileOperationToolCallIds
  };
}

/**
 * Extract context information from canned user message
 */
function extractContextInfo(cannedUserContext: string): {
  date: string;
  os: string;
  cwd: string;
} {
  const defaultContext = {
    date: new Date().toDateString(),
    os: 'unknown',
    cwd: process.cwd()
  };

  if (!cannedUserContext) return defaultContext;

  // Extract date
  const dateMatch = cannedUserContext.match(/Today's date is ([^.\n]+)/);
  const date = dateMatch ? dateMatch[1].trim() : defaultContext.date;

  // Extract OS
  const osMatch = cannedUserContext.match(/My operating system is: ([^\n]+)/);
  const os = osMatch ? osMatch[1].trim() : defaultContext.os;

  // Extract CWD
  const cwdMatch = cannedUserContext.match(/I'm currently working in the directory: ([^\n]+)/);
  const cwd = cwdMatch ? cwdMatch[1].trim() : defaultContext.cwd;

  return { date, os, cwd };
}

/**
 * Create a cleaned, generic system prompt
 */
function createCleanedSystemPrompt(): string {
  return `You are an interactive CLI agent specializing in software engineering tasks. Your primary approach is to systematically discover and understand file content to build complete knowledge before taking action.

# Core Philosophy: File Content Discovery

Programming tasks require understanding existing code, patterns, and structures. Your workflow centers on:

1. **Search First:** Use search tools to locate relevant files, functions, and patterns
2. **Read Systematically:** Read discovered files to understand implementation details
3. **Build Context:** Continue searching and reading until you have complete understanding
4. **Act Informed:** Only implement changes after thorough file content analysis

# Primary Workflow: Discovery → Understanding → Action

## Phase 1: Discovery
- **Search for Patterns:** Use search tools to find relevant code patterns, function names, imports
- **Identify Key Files:** Locate configuration files, main implementation files, test files
- **Map Dependencies:** Find how components connect by searching for imports and references

## Phase 2: Understanding  
- **Read Core Files:** Read the main files identified during discovery
- **Understand Conventions:** Analyze code style, architectural patterns, naming conventions
- **Study Context:** Read surrounding code to understand how pieces fit together
- **Verify Assumptions:** Search for additional examples to confirm understanding

## Phase 3: Informed Action
- **Plan with Knowledge:** Create implementation plans based on discovered patterns
- **Follow Conventions:** Implement using the exact styles and patterns found in existing code
- **Maintain Consistency:** Ensure changes integrate seamlessly with existing codebase

# Tool Usage Strategy

## Search Tools (Primary Discovery Method)
- Use search extensively to find relevant code before reading files
- Search for function names, class names, import patterns, and usage examples
- Search for similar implementations to understand existing patterns

## Read Tools (Deep Understanding)
- Read files systematically after identifying them through search
- Focus on understanding implementation details, not just skimming
- Read related files to understand full context

## Parallel Operations
- Execute multiple search operations in parallel to build comprehensive understanding quickly
- Read multiple related files in parallel once identified

# Core Principles

- **Never Assume:** Always search and read to verify what exists in the codebase
- **Understand Before Acting:** Build complete understanding through file content analysis
- **Follow Discovered Patterns:** Mimic exactly what you find in existing code
- **Context is King:** Read surrounding code to understand how changes should integrate
- **Search → Read → Understand → Act:** This is your fundamental workflow

# Operational Guidelines

- **Concise Communication:** Use minimal text output, let tools do the work
- **Tool-Centric Approach:** Prefer using tools over making assumptions
- **Absolute Paths:** Always use absolute paths for file operations
- **Security First:** Never expose secrets or sensitive information`;
}

/**
 * Find a tool call by ID in the conversation messages
 */
function findToolCallById(messages: OpenAI.Chat.ChatCompletionMessageParam[], toolCallId: string): OpenAI.Chat.ChatCompletionMessageToolCall | undefined {
  for (const message of messages) {
    if (message.role === 'assistant' && 'tool_calls' in message && message.tool_calls) {
      const toolCall = message.tool_calls.find(tc => tc.id === toolCallId);
      if (toolCall) {
        return toolCall;
      }
    }
  }
  return undefined;
}

/**
 * Truncate search file contents results - limit to 20 results and 1000 chars per line
 */
function truncateSearchResult(functionName: string, result: string): string {
  if (functionName !== 'search_file_content') {
    return result;
  }

  try {
    // Parse the JSON result to get the output
    const parsed = JSON.parse(result);
    if (parsed.output && typeof parsed.output === 'string') {
      const lines = parsed.output.split('\n');
      let resultCount = 0;
      let truncatedLines: string[] = [];
      let totalResults = 0;
      
      // Count total results first
      for (const line of lines) {
        if (/^L\d+:/.test(line)) {
          totalResults++;
        }
      }
      
      // Process lines, limiting to 20 results
      for (const line of lines) {
        if (/^L\d+:/.test(line)) {
          resultCount++;
          if (resultCount > 20) {
            truncatedLines.push(`[... truncated ${totalResults - 20} more results]`);
            break;
          }
          
          // Truncate long line content
          const truncatedLine = line.replace(/^(L\d+: )(.+)$/, (match: string, linePrefix: string, lineContent: string) => {
            if (lineContent.length <= 1000) {
              return match;
            }
            return linePrefix + lineContent.slice(0, 1000) + '...';
          });
          truncatedLines.push(truncatedLine);
        } else {
          // Keep non-result lines (headers, separators, etc.)
          if (resultCount <= 20) {
            truncatedLines.push(line);
          }
        }
      }
      
      // Pack it back into JSON
      return JSON.stringify({
        ...parsed,
        output: truncatedLines.join('\n')
      });
    }
  } catch {
    // If JSON parsing fails, return original
  }
  
  return result;
}

/**
 * Build new system prompt with virtual filesystem and environment info at the end
 */
function buildContextStuffedSystemPrompt(
  toolCallPairs: Array<{ toolCall: OpenAI.Chat.ChatCompletionMessageToolCall; result: string; }>,
  cannedUserContext: string,
  virtualFileSystem: VirtualFileSystem
): string {
  // Start with cleaned system prompt
  let systemPrompt = createCleanedSystemPrompt();

  // Add environment context section
  const contextInfo = extractContextInfo(cannedUserContext);
  systemPrompt += '\n\n═══ 🌍 CURRENT ENVIRONMENT ═══\n\n';
  systemPrompt += `- **Date:** ${contextInfo.date}\n`;
  systemPrompt += `- **Operating System:** ${contextInfo.os}\n`;
  systemPrompt += `- **Current Working Directory:** ${contextInfo.cwd}\n`;

  // Add virtual filesystem context - this replaces verbose file operation tool calls
  const vfsContext = generateVirtualFileSystemContext(virtualFileSystem);
  if (vfsContext) {
    systemPrompt += vfsContext;
  }

  // Add remaining non-file-operation tool calls if any
  if (toolCallPairs.length > 0) {
    systemPrompt += '\n\n═══ 🔧 PREVIOUS TOOL CALLS AND RESULTS ═══\n\n';
    
    for (let i = 0; i < toolCallPairs.length; i++) {
      const pair = toolCallPairs[i];
      const functionName = pair.toolCall.function?.name || 'unknown';
      const functionArgs = pair.toolCall.function?.arguments || '{}';
      
      // Parse and re-stringify to ensure proper formatting and prevent nested escaping
      let formattedArgs: string;
      try {
        const parsedArgs = JSON.parse(functionArgs);
        formattedArgs = JSON.stringify(parsedArgs, null, 2);
      } catch {
        // If parsing fails, use the original string but avoid double-escaping
        formattedArgs = functionArgs;
      }
      
      systemPrompt += `## ${functionName}\n`;
      systemPrompt += `**Arguments:**\n\`\`\`json\n${formattedArgs}\n\`\`\`\n\n`;
      systemPrompt += `**Result:**\n\`\`\`\n${truncateSearchResult(functionName, pair.result)}\n\`\`\`\n\n`;
      
      // Add separator between tool calls (but not after the last one)
      if (i < toolCallPairs.length - 1) {
        systemPrompt += '--- END OF TOOL CALL ---\n\n';
      }
    }
  }

  return systemPrompt;
}

/**
 * Collapse consecutive assistant messages into single messages
 */
function collapseConsecutiveAssistantMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const collapsedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  
  for (let i = 0; i < messages.length; i++) {
    const currentMessage = messages[i];
    
    if (currentMessage.role === 'assistant') {
      // Start collecting consecutive assistant messages
      const consecutiveAssistantContents: string[] = [];
      const allToolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
      let j = i;
      
      // Collect all consecutive assistant messages
      while (j < messages.length && messages[j].role === 'assistant') {
        const assistantMessage = messages[j];
        
        // Collect content if it exists and is meaningful, and not already included
        if (assistantMessage.content && 
            typeof assistantMessage.content === 'string' && 
            assistantMessage.content.trim() !== '') {
          const trimmedContent = assistantMessage.content.trim();
          if (!consecutiveAssistantContents.includes(trimmedContent)) {
            consecutiveAssistantContents.push(trimmedContent);
          }
        }
        
        // Collect tool calls if they exist
        if ('tool_calls' in assistantMessage && assistantMessage.tool_calls) {
          allToolCalls.push(...assistantMessage.tool_calls);
        }
        
        j++;
      }
      
      // Create a single consolidated assistant message
      if (consecutiveAssistantContents.length > 0 || allToolCalls.length > 0) {
        const consolidatedMessage: OpenAI.Chat.ChatCompletionMessageParam = {
          role: 'assistant',
          content: consecutiveAssistantContents.join('\n')
        };
        
        if (allToolCalls.length > 0) {
          (consolidatedMessage as any).tool_calls = allToolCalls;
        }
        
        collapsedMessages.push(consolidatedMessage);
      }
      
      // Skip ahead past all the consecutive assistant messages we just processed
      i = j - 1;
    } else {
      // Non-assistant message, keep as-is
      collapsedMessages.push(currentMessage);
    }
  }
  
  return collapsedMessages;
}

/**
 * Build new messages array with comprehensive cleaning and selective tool call filtering
 */
function buildNewMessagesArray(deconstructed: DeconstructedMessages, originalRealConversation: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const newMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  // 1. New system message with context stuffed in
  const contextStuffedSystemPrompt = buildContextStuffedSystemPrompt(
    deconstructed.toolCallPairs,
    deconstructed.cannedUserContext,
    deconstructed.virtualFileSystem
  );
  
  newMessages.push({
    role: 'system',
    content: contextStuffedSystemPrompt
  });

  // 2. Skip canned directory listing and context setup - we want a clean conversation
  // 3. Skip canned assistant reply - we want a clean conversation

  // 4. Determine strategy for filtering
  const strategy = analyzeToolCallStrategy(originalRealConversation);
  
  // Get ALL tool call IDs that were moved to system prompt (not just file operations)
  const movedToSystemPromptToolCallIds = new Set<string>();
  for (const pair of deconstructed.toolCallPairs) {
    if (pair.toolCall.id) {
      movedToSystemPromptToolCallIds.add(pair.toolCall.id);
    }
  }
  
  // Also include file operations that were moved to VFS
  for (const fileOpId of deconstructed.fileOperationToolCallIds) {
    movedToSystemPromptToolCallIds.add(fileOpId);
  }

  // 5. Process real conversation with comprehensive cleaning
  for (let i = 0; i < deconstructed.realConversation.length; i++) {
    const message = deconstructed.realConversation[i];
    
    if (message.role === 'tool') {
      // Only keep tool messages that weren't moved to system prompt
      const toolCallId = 'tool_call_id' in message ? message.tool_call_id : '';
      if (toolCallId && !movedToSystemPromptToolCallIds.has(toolCallId)) {
        // Find the corresponding tool call to get the function name for truncation
        const toolCall = findToolCallById(deconstructed.realConversation, toolCallId);
        const functionName = toolCall?.function?.name || '';
        
        // Apply truncation to search_file_content results
        const truncatedContent = typeof message.content === 'string' 
          ? truncateSearchResult(functionName, message.content)
          : message.content;
        
        newMessages.push({
          ...message,
          content: truncatedContent
        });
      }
    } else if (message.role === 'assistant' && 'tool_calls' in message) {
      // For assistant messages with tool calls, selectively remove moved tool calls
      if (message.tool_calls) {
        const keptToolCalls = message.tool_calls.filter(toolCall => 
          toolCall.id && !movedToSystemPromptToolCallIds.has(toolCall.id)
        );
        
        if (keptToolCalls.length > 0) {
          // Keep assistant message with remaining tool calls
          newMessages.push({
            role: 'assistant',
            content: message.content,
            tool_calls: keptToolCalls
          });
        } else {
          // All tool calls were moved - check if there's meaningful content
          const hasContent = message.content && 
                            typeof message.content === 'string' && 
                            message.content.trim() !== '' &&
                            message.content.trim() !== null;
          
          if (hasContent) {
            newMessages.push({
              role: 'assistant',
              content: message.content
            });
          }
          // If no content, skip the empty assistant message container
        }
      } else {
        // No tool calls, keep as-is if it has content
        const hasContent = message.content && 
                          typeof message.content === 'string' && 
                          message.content.trim() !== '';
        if (hasContent) {
          newMessages.push(message);
        }
      }
    } else if (message.role === 'user') {
      // Handle user messages with special cleaning for "Please continue."
      const isPleaseContinue = typeof message.content === 'string' && 
                              message.content.trim() === 'Please continue.';
      
      if (isPleaseContinue) {
        // Only keep "Please continue." if it's the last message AND follows a kept tool call
        const isLastMessage = i === deconstructed.realConversation.length - 1;
        
        if (isLastMessage && strategy.keepLastToolSequence) {
          // This is the final "Please continue." after a kept tool call - keep it
          newMessages.push(message);
        }
        // Otherwise, skip "Please continue." messages
      } else {
        // Keep all other user messages
        newMessages.push(message);
      }
    } else if (message.role !== 'system') {
      // Keep other message types as-is, but skip system messages to avoid duplicates
      newMessages.push(message);
    }
    // Skip system messages since we already have our system message at the beginning
  }

  // 6. Collapse consecutive assistant messages before returning
  return collapseConsecutiveAssistantMessages(newMessages);
}

/**
 * Reconfigure final messages for OpenAI API
 * This function deconstructs the messages array and rebuilds it with tool context stuffed into system prompt
 */
export function reconfigureFinalMessages(
  finalMessages: OpenAI.Chat.ChatCompletionMessageParam[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  // logPromptAnalysis('Starting refocus reconfiguration', { originalMessageCount: finalMessages.length });

  // Step 1: Deconstruct the finalMessages array
  const deconstructed = deconstructMessages(finalMessages);
  
  // logPromptAnalysis('Deconstructed structure', {
  //   systemPromptLength: deconstructed.systemPrompt.length,
  //   toolCallPairs: deconstructed.toolCallPairs.length,
  //   realConversationMessages: deconstructed.realConversation.length
  // });

  // Step 2: Build new messages array with selective context stuffing
  const newMessages = buildNewMessagesArray(deconstructed, deconstructed.realConversation);

  logPromptAnalysis('Final refocused messages array', newMessages);

  return newMessages;
}