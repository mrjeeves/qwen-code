/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import OpenAI from 'openai';
/**
 * Reconfigure final messages for OpenAI API
 * This function takes the final messages array and applies any necessary transformations
 */
export declare function reconfigureFinalMessages(finalMessages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[];
