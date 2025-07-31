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
    const logEntry = `[${timestamp}] ${message}${data ? '\n' + JSON.stringify(data, null, 2) : ''}\n\n`;
    fs.appendFileSync(logPath, logEntry);
  } catch (error) {
    // Silent fail to avoid breaking the main functionality
    console.error('Failed to log prompt analysis:', error);
  }
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

  const lastMessage = realConversation[realConversation.length - 1];
  
  // Check if last message is a tool result
  if (lastMessage.role === 'tool') {
    // Keep the last tool call sequence in the conversation
    const lastToolCallId = 'tool_call_id' in lastMessage ? lastMessage.tool_call_id : '';
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
  logPromptAnalysis('Deconstructing messages', { messageCount: finalMessages.length });

  if (finalMessages.length < 3) {
    return {
      systemPrompt: '',
      cannedUserContext: '',
      cannedAssistantReply: '',
      realConversation: finalMessages,
      toolCallPairs: []
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
  
  logPromptAnalysis('Tool call strategy', {
    keepLastToolSequence: strategy.keepLastToolSequence,
    lastToolCallIds: Array.from(strategy.lastToolCallIds)
  });

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

  return {
    systemPrompt,
    cannedUserContext,
    cannedAssistantReply,
    realConversation,
    toolCallPairs
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
  return `You are an interactive CLI agent specializing in software engineering tasks. Your primary goal is to help users safely and efficiently, adhering strictly to the following instructions and utilizing your available tools.

# Core Mandates

- **Conventions:** Follow existing project conventions when reading or modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** Never assume a library/framework is available. Verify its usage within the project first.
- **Style & Structure:** Mimic the style, structure, framework choices, typing, and architectural patterns of existing code.
- **Idiomatic Changes:** When editing, understand the local context to ensure changes integrate naturally.
- **Comments:** Add code comments sparingly. Focus on *why* something is done, not *what* is done.
- **Proactiveness:** Fulfill requests thoroughly, including reasonable follow-up actions.
- **Path Construction:** Always use absolute paths for file system tools.

# Primary Workflows

## Software Engineering Tasks
1. **Understand:** Use search and read tools to understand file structures, patterns, and conventions.
2. **Plan:** Build a coherent plan based on your understanding.
3. **Implement:** Use available tools to act on the plan, adhering to project conventions.
4. **Verify:** Test changes using project-specific testing procedures and build/lint commands.

## New Applications
1. **Understand Requirements:** Analyze the request to identify core features and constraints.
2. **Propose Plan:** Present a clear, high-level summary to the user.
3. **User Approval:** Obtain user approval for the proposed plan.
4. **Implementation:** Implement each feature using available tools.
5. **Verify:** Review work against requirements and ensure it builds without errors.

# Operational Guidelines

## Tone and Style
- **Concise & Direct:** Adopt a professional, direct tone suitable for CLI environments.
- **Minimal Output:** Aim for fewer than 3 lines of text output per response when practical.
- **No Chitchat:** Avoid conversational filler or unnecessary explanations.
- **Tools vs. Text:** Use tools for actions, text only for communication.

## Security and Safety
- **Explain Critical Commands:** Before executing commands that modify the system, provide a brief explanation.
- **Security First:** Apply security best practices. Never expose secrets or sensitive information.

## Tool Usage
- **File Paths:** Always use absolute paths.
- **Parallelism:** Execute multiple independent tool calls in parallel when feasible.
- **Background Processes:** Use background processes for long-running commands.
- **Interactive Commands:** Avoid commands requiring user interaction.

# Git Repository
- The current working directory is managed by a git repository.
- When committing, gather information with shell commands first.
- Always propose draft commit messages.
- Never push to remote repositories without explicit user request.`;
}

/**
 * Build new system prompt with tool call context and environment info at the end
 */
function buildContextStuffedSystemPrompt(
  toolCallPairs: Array<{ toolCall: OpenAI.Chat.ChatCompletionMessageToolCall; result: string; }>,
  cannedUserContext: string
): string {
  // Start with cleaned system prompt
  let systemPrompt = createCleanedSystemPrompt();

  // Add environment context section
  const contextInfo = extractContextInfo(cannedUserContext);
  systemPrompt += '\n\n# Current Environment\n\n';
  systemPrompt += `- **Date:** ${contextInfo.date}\n`;
  systemPrompt += `- **Operating System:** ${contextInfo.os}\n`;
  systemPrompt += `- **Current Working Directory:** ${contextInfo.cwd}\n`;

  // Add tool context section at the END if there are tool calls
  if (toolCallPairs.length > 0) {
    systemPrompt += '\n\n# Previous Tool Calls and Results\n\n';
    
    for (const pair of toolCallPairs) {
      const functionName = pair.toolCall.function?.name || 'unknown';
      const functionArgs = pair.toolCall.function?.arguments || '{}';
      
      systemPrompt += `## ${functionName}\n`;
      systemPrompt += `**Arguments:**\n\`\`\`json\n${functionArgs}\n\`\`\`\n\n`;
      systemPrompt += `**Result:**\n\`\`\`\n${pair.result}\n\`\`\`\n\n`;
    }
  }

  return systemPrompt;
}

/**
 * Build new messages array with comprehensive cleaning and selective tool call filtering
 */
function buildNewMessagesArray(deconstructed: DeconstructedMessages, originalRealConversation: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const newMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  // 1. New system message with context stuffed in
  const contextStuffedSystemPrompt = buildContextStuffedSystemPrompt(
    deconstructed.toolCallPairs,
    deconstructed.cannedUserContext
  );
  
  newMessages.push({
    role: 'system',
    content: contextStuffedSystemPrompt
  });

  // 2. Skip canned directory listing and context setup - we want a clean conversation
  // 3. Skip canned assistant reply - we want a clean conversation

  // 4. Determine strategy for filtering
  const strategy = analyzeToolCallStrategy(originalRealConversation);
  
  // Get the tool call IDs that were moved to system prompt
  const movedToolCallIds = new Set(deconstructed.toolCallPairs.map(pair => 
    pair.toolCall.id || ''
  ).filter(id => id !== ''));

  // 5. Process real conversation with comprehensive cleaning
  for (let i = 0; i < deconstructed.realConversation.length; i++) {
    const message = deconstructed.realConversation[i];
    
    if (message.role === 'tool') {
      // Only keep tool messages that weren't moved to system prompt
      const toolCallId = 'tool_call_id' in message ? message.tool_call_id : '';
      if (toolCallId && !movedToolCallIds.has(toolCallId)) {
        newMessages.push(message);
      }
    } else if (message.role === 'assistant' && 'tool_calls' in message) {
      // For assistant messages with tool calls, selectively remove moved tool calls
      if (message.tool_calls) {
        const keptToolCalls = message.tool_calls.filter(toolCall => 
          toolCall.id && !movedToolCallIds.has(toolCall.id)
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
    } else {
      // Keep other message types as-is
      newMessages.push(message);
    }
  }

  return newMessages;
}

/**
 * Reconfigure final messages for OpenAI API
 * This function deconstructs the messages array and rebuilds it with tool context stuffed into system prompt
 */
export function reconfigureFinalMessages(
  finalMessages: OpenAI.Chat.ChatCompletionMessageParam[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  logPromptAnalysis('Starting refocus reconfiguration', { originalMessageCount: finalMessages.length });

  // Step 1: Deconstruct the finalMessages array
  const deconstructed = deconstructMessages(finalMessages);
  
  logPromptAnalysis('Deconstructed structure', {
    systemPromptLength: deconstructed.systemPrompt.length,
    toolCallPairs: deconstructed.toolCallPairs.length,
    realConversationMessages: deconstructed.realConversation.length
  });

  // Step 2: Build new messages array with selective context stuffing
  const newMessages = buildNewMessagesArray(deconstructed, deconstructed.realConversation);

  logPromptAnalysis('Final refocused messages array', newMessages);

  return newMessages;
}