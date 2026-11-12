import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  HookCallback,
  Options,
  SDKMessage,
  SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk';
import { codeQualityAnalyzer, refactoringSuggester, testCoverageAnalyzer } from './agents/index.js';
import { MCP_ALLOWED_TOOLS, mcpServersConfig } from './config/mcp.config.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import { ReviewReportJSONSchema, ReviewReportSchema, type ReviewReport } from './types/report-types.js';
import {
  ErrorCodes,
  ReviewError,
  formatError,
  isReviewError,
  withRetry,
  withTimeout
} from './utils/error-handler.js';
import { logReviewComplete, logReviewError, logReviewStart, logger } from './utils/logger.js';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimiterConfig } from './utils/rate-limiter.js';

const AGENT_VERSION = '1.0.0';

/** Rough token budget of one multi-agent review, reserved in the rate limiter before starting */
const ESTIMATED_TOKENS_PER_REVIEW = 50_000;

/** Subagents registered with the SDK; the keys are the agent names used in the orchestrator prompt */
export const SUBAGENTS: Record<string, AgentDefinition> = {
  'code-quality-analyzer': codeQualityAnalyzer,
  'test-coverage-analyzer': testCoverageAnalyzer,
  'refactoring-suggester': refactoringSuggester
};

/**
 * Tools that run without a permission prompt: Task spawns the subagents, Skill loads .claude/skills,
 * Read/Grep/Glob are used by the subagents, plus the read-only tools of the connected MCP servers.
 */
export const ALLOWED_TOOLS: string[] = [
  'Task',
  'Skill',
  'Read',
  'Grep',
  'Glob',
  ...MCP_ALLOWED_TOOLS.github,
  ...MCP_ALLOWED_TOOLS.eslint
];

/** PR content is untrusted input, so tools that execute commands or modify files/GitHub state are removed */
export const DISALLOWED_TOOLS: string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'mcp__github__create_or_update_file',
  'mcp__github__push_files',
  'mcp__github__create_repository',
  'mcp__github__fork_repository',
  'mcp__github__create_branch',
  'mcp__github__create_issue',
  'mcp__github__update_issue',
  'mcp__github__add_issue_comment',
  'mcp__github__create_pull_request',
  'mcp__github__create_pull_request_review',
  'mcp__github__merge_pull_request',
  'mcp__github__update_pull_request_branch'
];

const DEFAULT_OPTIONS = {
  maxTurns: 40,
  timeoutMs: 15 * 60 * 1000,
  maxRetries: 2,
  retryDelayMs: 5000
};

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /** Claude model for the orchestrator; subagents inherit it (default: ANTHROPIC_MODEL) */
  model?: string;
  /** Directory that contains .claude/skills, used as the agents' working directory (default: PROJECT_ROOT) */
  projectRoot?: string;
  /** Maximum agentic turns of the orchestrator */
  maxTurns?: number;
  /** Timeout of a single review attempt in milliseconds */
  timeoutMs?: number;
  /** Total number of attempts; failed attempts are retried with exponential backoff */
  maxRetries?: number;
  /** Base delay of the exponential backoff in milliseconds */
  retryDelayMs?: number;
  /** Rate limits applied to review requests */
  rateLimits?: Partial<RateLimiterConfig>;
}

export type ResolvedOrchestratorConfig = Required<Omit<OrchestratorOptions, 'rateLimits'>> & {
  rateLimits: RateLimiterConfig;
};

interface ReviewAttemptResult {
  report: ReviewReport;
  tokensUsed: number;
}

/**
 * Derive the summary metrics from the per-file results so they always match the findings.
 * overallScore is the mean code-quality score of the reviewed files.
 */
export function calculateSummary(fileReviews: ReviewReport['fileReviews']): ReviewReport['summary'] {
  const issues = fileReviews.flatMap((review) => review.codeQuality.issues);
  const untestedPaths = fileReviews.flatMap((review) => review.testCoverage.untestedPaths);
  const scores = fileReviews.map((review) => review.codeQuality.overallScore);

  return {
    totalFiles: fileReviews.length,
    overallScore: scores.length > 0
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : 100,
    criticalIssues: issues.filter((issue) => issue.severity === 'critical').length,
    highPriorityTests: untestedPaths.filter((p) => p.priority === 'critical' || p.priority === 'high').length,
    refactoringOpportunities: fileReviews.reduce((sum, review) => sum + review.refactorings.suggestions.length, 0)
  };
}

/**
 * PostToolUse hook for mcp__github__get_file_contents.
 * The GitHub MCP server returns file contents inside escaped JSON; re-render files as a line-numbered
 * listing so the agents can cite exact line numbers. Directory listings and errors pass through unchanged.
 */
export const addLineNumbersToFileContents: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PostToolUse') return {};

  const blocks = input.tool_response;
  if (!Array.isArray(blocks) || blocks.length !== 1) return {};
  const [block] = blocks as Array<{ type?: unknown; text?: unknown }>;
  if (block?.type !== 'text' || typeof block.text !== 'string') return {};

  let file: { type?: unknown; path?: unknown; content?: unknown };
  try {
    file = JSON.parse(block.text) as typeof file;
  } catch {
    return {};
  }
  if (file.type !== 'file' || typeof file.content !== 'string') return {};

  const lines = file.content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const listing = lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n');
  const ref = (input.tool_input as { branch?: unknown }).branch;
  const header =
    `File: ${String(file.path)}${typeof ref === 'string' ? ` @ ${ref}` : ''} ` +
    `(${lines.length} lines, 1-based line numbers)`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: [{ type: 'text', text: `${header}\n${listing}` }]
    }
  };
};

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  private readonly config: ResolvedOrchestratorConfig;
  private readonly rateLimiter: RateLimiter;

  constructor(options: OrchestratorOptions = {}) {
    const model = options.model ?? process.env.ANTHROPIC_MODEL;
    if (!model) {
      throw new ReviewError('ANTHROPIC_MODEL environment variable is required', ErrorCodes.INVALID_CONFIG);
    }

    const projectRoot = options.projectRoot ?? process.env.PROJECT_ROOT;
    if (!projectRoot) {
      throw new ReviewError(
        'PROJECT_ROOT is required (absolute path of the directory that contains .claude/skills)',
        ErrorCodes.INVALID_CONFIG
      );
    }

    this.config = {
      model,
      projectRoot,
      maxTurns: options.maxTurns ?? DEFAULT_OPTIONS.maxTurns,
      timeoutMs: options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_OPTIONS.retryDelayMs,
      rateLimits: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits }
    };
    this.rateLimiter = new RateLimiter(this.config.rateLimits);
  }

  getConfig(): Readonly<ResolvedOrchestratorConfig> {
    return this.config;
  }

  getRateLimitStatus(): ReturnType<RateLimiter['getStatus']> {
    return this.rateLimiter.getStatus();
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startedAt = Date.now();
    logReviewStart(owner, repo, prNumber);

    await this.rateLimiter.acquire(ESTIMATED_TOKENS_PER_REVIEW);
    let tokensUsed: number | undefined;
    let attempt = 0;

    try {
      const result = await withRetry(
        async () => {
          attempt++;
          try {
            return await this.runReviewAttempt(owner, repo, prNumber);
          } catch (error) {
            logger.warn(`Review attempt ${attempt}/${this.config.maxRetries} failed`, { error: formatError(error) });
            throw error;
          }
        },
        this.config.maxRetries,
        this.config.retryDelayMs
      );
      tokensUsed = result.tokensUsed;

      const report = this.finalizeReport(result.report, owner, repo, prNumber, startedAt);
      logReviewComplete(owner, repo, prNumber, report.summary.overallScore, report.metadata.duration);
      return report;
    } catch (error) {
      logReviewError(owner, repo, prNumber, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.rateLimiter.release(tokensUsed);
    }
  }

  /** One review attempt, bounded by the configured timeout */
  private async runReviewAttempt(owner: string, repo: string, prNumber: number): Promise<ReviewAttemptResult> {
    const abortController = new AbortController();
    try {
      return await withTimeout(
        () => this.runQuery(owner, repo, prNumber, abortController),
        this.config.timeoutMs,
        `Review of ${owner}/${repo}#${prNumber} timed out after ${Math.round(this.config.timeoutMs / 1000)}s`
      );
    } catch (error) {
      // Stop the Claude Code process of a failed or timed-out attempt
      abortController.abort();
      throw error;
    }
  }

  private async runQuery(
    owner: string,
    repo: string,
    prNumber: number,
    abortController: AbortController
  ): Promise<ReviewAttemptResult> {
    const stderrTail: string[] = [];
    const stream = query({
      prompt: buildOrchestratorPrompt(owner, repo, prNumber),
      options: this.buildQueryOptions(abortController, stderrTail)
    });

    let result: SDKResultMessage | undefined;
    try {
      for await (const message of stream) {
        this.handleMessage(message);
        if (message.type === 'result') result = message;
      }
    } catch (error) {
      if (isReviewError(error)) throw error;
      // The Claude Code process can exit non-zero right after reporting a failed result; prefer that result
      if (!result) {
        const details = stderrTail.length > 0 ? ` (${stderrTail.join(' | ')})` : '';
        throw new ReviewError(`Claude Code process failed: ${formatError(error)}${details}`, ErrorCodes.AGENT_FAILED);
      }
    }

    if (!result) {
      throw new ReviewError('Orchestrator finished without a result', ErrorCodes.AGENT_FAILED);
    }

    return {
      report: this.parseResult(result),
      tokensUsed: result.usage.input_tokens + result.usage.output_tokens
    };
  }

  private buildQueryOptions(abortController: AbortController, stderrTail: string[]): Options {
    return {
      abortController,
      cwd: this.config.projectRoot,
      model: this.config.model,
      // Loads the skills in PROJECT_ROOT/.claude/skills
      settingSources: ['project'],
      mcpServers: mcpServersConfig,
      agents: SUBAGENTS,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      // Non-interactive for CI/CD: pre-approved tools run, anything else is denied instead of prompting
      permissionMode: 'dontAsk',
      maxTurns: this.config.maxTurns,
      outputFormat: { type: 'json_schema', schema: ReviewReportJSONSchema },
      hooks: {
        PostToolUse: [{ matcher: 'mcp__github__get_file_contents', hooks: [addLineNumbersToFileContents] }]
      },
      stderr: (data: string) => {
        for (const line of data.split('\n').map((l) => l.trim()).filter(Boolean)) {
          // The spawn command line embeds the MCP config, including the GitHub token: never log it
          if (line.startsWith('Spawning Claude Code')) continue;
          logger.debug('Claude Code stderr', { line });
          stderrTail.push(line);
          if (stderrTail.length > 3) stderrTail.shift();
        }
      }
    };
  }

  /** Log progress and stop early when the GitHub MCP server is unavailable */
  private handleMessage(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      logger.info('Orchestrator session started', {
        model: message.model,
        mcpServers: message.mcp_servers.map((server) => `${server.name}:${server.status}`),
        skills: message.skills,
        agents: message.agents
      });
      for (const server of message.mcp_servers) {
        if (server.status !== 'connected') logger.warn(`MCP server "${server.name}" is ${server.status}`);
      }
      if (message.mcp_servers.find((server) => server.name === 'github')?.status === 'failed') {
        throw new ReviewError(
          'GitHub MCP server failed to start, so pull request data cannot be fetched. Check network access and GITHUB_TOKEN.',
          ErrorCodes.GITHUB_API_ERROR
        );
      }
      return;
    }

    if (message.type === 'assistant') {
      const actor = message.parent_tool_use_id ? 'Subagent' : 'Orchestrator';
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (block.name === 'Task') {
          logger.info(`Dispatching ${String(input.subagent_type)}: ${String(input.description ?? '')}`);
        } else if (block.name === 'Skill') {
          logger.info(`${actor} invoked skill "${String(input.skill)}"`);
        } else {
          logger.info(`${actor} called ${block.name}${typeof input.path === 'string' ? ` (${input.path})` : ''}`);
        }
      }
      return;
    }

    if (message.type === 'result') {
      logger.info('Orchestrator finished', {
        status: message.subtype,
        turns: message.num_turns,
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms
      });
    }
  }

  /** Validate the structured output against the ReviewReport Zod schema */
  private parseResult(result: SDKResultMessage): ReviewReport {
    if (result.subtype !== 'success') {
      const details = result.errors.length > 0 ? `: ${result.errors.join('; ')}` : '';
      throw new ReviewError(
        `Orchestrator stopped with "${result.subtype}"${details}`,
        result.subtype === 'error_max_structured_output_retries'
          ? ErrorCodes.STRUCTURED_OUTPUT_FAILED
          : ErrorCodes.AGENT_FAILED,
        { turns: result.num_turns }
      );
    }

    if (result.is_error) {
      throw new ReviewError(`Orchestrator reported an error: ${result.result}`, ErrorCodes.AGENT_FAILED);
    }

    if (result.structured_output === undefined) {
      throw new ReviewError(
        `Orchestrator returned no structured report: ${result.result.slice(0, 300)}`,
        ErrorCodes.STRUCTURED_OUTPUT_FAILED
      );
    }

    const parsed = ReviewReportSchema.safeParse(result.structured_output);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ReviewError(
        `Structured output does not match the ReviewReport schema: ${issues}`,
        ErrorCodes.STRUCTURED_OUTPUT_FAILED
      );
    }
    return parsed.data;
  }

  /** Fill in the values the application knows better than the model */
  private finalizeReport(
    report: ReviewReport,
    owner: string,
    repo: string,
    prNumber: number,
    startedAt: number
  ): ReviewReport {
    return {
      ...report,
      pullRequest: { owner, repo, number: prNumber },
      summary: calculateSummary(report.fileReviews),
      metadata: {
        analyzedAt: new Date(startedAt).toISOString(),
        duration: Date.now() - startedAt,
        agentVersions: {
          orchestrator: AGENT_VERSION,
          ...Object.fromEntries(Object.keys(SUBAGENTS).map((name) => [name, AGENT_VERSION])),
          model: this.config.model
        }
      }
    };
  }
}
