import * as vscode from 'vscode';
import { AgentTask } from './AgentTaskQueue.js';
import { AgentMemory } from './AgentMemory.js';
import { errorMessage } from '../util/narrow.js';

export interface AgentRunOutcome {
  taskId: string;
  status: 'completed' | 'failed' | 'deferred' | 'no-model';
  iterations: number;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; error?: string }>;
  summary: string;
}

export interface AgentRunnerOptions {
  /** Hard ceiling on tool-call iterations to prevent runaway loops. */
  maxIterations?: number;
  /** Confidence threshold for autonomous merge vs. open-PR-for-review. */
  autonomyLevel?: 'observe' | 'draft-pr' | 'merge';
  /** Override the model selector (for tests / specific tasks). */
  modelSelector?: vscode.LanguageModelChatSelector;
}

const SYSTEM_PROMPT_BASE = `You are an autonomous engineering agent embedded in VS Code.
You can call Terraform-workspace tools to inspect, scaffold, and modify Terraform repositories.

Operating principles:
1. Read before you write. Use the discovery tools first.
2. Never destroy state. Refuse \`terraform destroy\` and any deletions you cannot undo.
3. When unsure, leave a note in memory and stop. A draft PR is always preferable to a merged mistake.
4. Cite the issue URL in any commit, PR, or comment you produce.
5. Keep going until the task is done OR you have left a clear note about why you stopped.`;

/**
 * Drives an LM tool-call loop to attempt one autonomous task. The runner
 * deliberately does NOT contain task-selection logic — it just executes one
 * task with whatever tools are registered.
 *
 * The loop:
 *   1. Build a chat with system prompt + memory digest + task context.
 *   2. Send to the language model with all registered tools available.
 *   3. For each tool call in the response, invoke it and append the result.
 *   4. Repeat until the model produces a final text response, errors out,
 *      or hits `maxIterations`.
 *   5. Record outcome in memory.
 */
export class AgentRunner {
  constructor(
    private readonly memory: AgentMemory,
    private readonly options: AgentRunnerOptions = {},
  ) {}

  async runTask(task: AgentTask, cancel: vscode.CancellationToken): Promise<AgentRunOutcome> {
    const maxIterations = this.options.maxIterations ?? 12;
    const toolCalls: AgentRunOutcome['toolCalls'] = [];

    // Discover the model.
    const selector = this.options.modelSelector ?? { vendor: 'copilot', family: 'gpt-4o' };
    const models = await vscode.lm.selectChatModels(selector);
    const model = models[0];
    if (!model) {
      const summary = `No language model matched selector ${JSON.stringify(selector)}.`;
      this.memory.record(task.id, 'failure', summary);
      return { taskId: task.id, status: 'no-model', iterations: 0, toolCalls, summary };
    }

    const tools = vscode.lm.tools.filter(t => t.name.startsWith('terraform_'));

    const memoryDigest = this.memory.buildContextDigest(task.id);
    const autonomy = this.options.autonomyLevel ?? 'draft-pr';
    const systemPrompt = `${SYSTEM_PROMPT_BASE}\n\nAutonomy level: ${autonomy}.`;

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(buildTaskPrompt(task, memoryDigest)),
    ];

    let iteration = 0;
    let finalText = '';

    try {
      while (iteration < maxIterations) {
        if (cancel.isCancellationRequested) {
          this.memory.record(task.id, 'failure', 'Cancelled by host before completion.');
          return { taskId: task.id, status: 'failed', iterations: iteration, toolCalls, summary: 'Cancelled.' };
        }
        iteration++;

        const response = await model.sendRequest(messages, { tools }, cancel);

        const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
        let textChunk = '';

        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            textChunk += part.value;
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCallParts.push(part);
          }
        }

        if (toolCallParts.length === 0) {
          // Model produced a final answer — we're done.
          finalText = textChunk.trim();
          break;
        }

        // Append assistant message containing the tool calls so the model
        // sees its own request when we send the next turn.
        messages.push(vscode.LanguageModelChatMessage.Assistant([
          ...(textChunk ? [new vscode.LanguageModelTextPart(textChunk)] : []),
          ...toolCallParts,
        ]));

        // Execute every tool call in this turn and feed results back.
        const resultParts: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCallParts) {
          try {
            const result = await vscode.lm.invokeTool(
              call.name,
              { input: call.input, toolInvocationToken: undefined },
              cancel,
            );
            toolCalls.push({ name: call.name, input: call.input, ok: true });
            resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
          } catch (err) {
            const msg = errorMessage(err);
            toolCalls.push({ name: call.name, input: call.input, ok: false, error: msg });
            this.memory.record(task.id, 'failure', `Tool ${call.name} failed: ${msg}`, { input: call.input });
            resultParts.push(new vscode.LanguageModelToolResultPart(
              call.callId,
              [new vscode.LanguageModelTextPart(`ERROR: ${msg}`)],
            ));
          }
        }

        messages.push(vscode.LanguageModelChatMessage.User(resultParts));
      }
    } catch (err) {
      const summary = `Run aborted: ${errorMessage(err)}`;
      this.memory.record(task.id, 'failure', summary);
      return { taskId: task.id, status: 'failed', iterations: iteration, toolCalls, summary };
    }

    if (!finalText) {
      const summary = `Hit max iterations (${maxIterations}) without conclusion.`;
      this.memory.record(task.id, 'failure', summary);
      return { taskId: task.id, status: 'deferred', iterations: iteration, toolCalls, summary };
    }

    this.memory.record(task.id, 'decision', finalText, {
      taskTitle: task.title,
      iterations: iteration,
      toolCallCount: toolCalls.length,
    });
    return { taskId: task.id, status: 'completed', iterations: iteration, toolCalls, summary: finalText };
  }
}

function buildTaskPrompt(task: AgentTask, memoryDigest: string): string {
  const lines = [
    `# Task: ${task.title}`,
    '',
    `Source: ${task.source}`,
    `URL: ${task.url}`,
    task.repo ? `Repo: ${task.repo}` : '',
    task.labels.length ? `Labels: ${task.labels.join(', ')}` : '',
    '',
    '## Description',
    task.body || '(no body provided)',
  ].filter(Boolean);

  if (memoryDigest) {
    lines.push('', '## Memory context', memoryDigest);
  }

  lines.push(
    '',
    '## Instructions',
    '1. Investigate using the read-only tools first.',
    '2. Plan your changes briefly before invoking write tools.',
    '3. If you cannot finish safely, record what you found and stop.',
    '4. End with a short summary of what was done (or why nothing was done).',
  );
  return lines.join('\n');
}
