import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  CodeReviewOrchestrator,
  SUBAGENTS,
  addLineNumbersToFileContents,
  calculateSummary
} from '../src/orchestrator.js';
import { ReviewReportJSONSchema, ReviewReportSchema } from '../src/types/index.js';
import { ErrorCodes, ReviewError } from '../src/utils/error-handler.js';
import { DEFAULT_RATE_LIMITS } from '../src/utils/rate-limiter.js';
import { createCodeQualityResult, createReviewReport, createTestCoverageResult } from './fixtures.js';

/**
 * Tests for CodeReviewOrchestrator
 *
 * The Claude Agent SDK `query` function is mocked so the unit tests run without API keys,
 * MCP servers or network access. The integration test at the bottom uses the real SDK.
 */

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn()
}));

vi.mock('../src/utils/logger.js', () => {
  const noop = vi.fn();
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    logReviewStart: noop,
    logReviewComplete: noop,
    logReviewError: noop
  };
});

const mockedQuery = vi.mocked(query);
const AGENT_NAMES = ['code-quality-analyzer', 'test-coverage-analyzer', 'refactoring-suggester'];

function initMessage(githubStatus = 'connected'): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: 'test',
    cwd: '/tmp/project',
    tools: [],
    mcp_servers: [{ name: 'github', status: githubStatus }, { name: 'eslint', status: 'connected' }],
    model: 'claude-test-model',
    permissionMode: 'dontAsk',
    slash_commands: [],
    output_style: 'default',
    skills: ['javascript-best-practices', 'security-analysis'],
    plugins: [],
    agents: AGENT_NAMES,
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 'test-session'
  } as unknown as SDKMessage;
}

function toolUseMessage(name: string, input: Record<string, unknown>, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: 'tool_use', id: `tool-${name}`, name, input }] },
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'test-session'
  } as unknown as SDKMessage;
}

function resultMessage(overrides: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 6,
    result: 'Review complete',
    total_cost_usd: 0.42,
    usage: { input_tokens: 1200, output_tokens: 800 },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000003',
    session_id: 'test-session',
    ...overrides
  } as unknown as SDKMessage;
}

/** Make the next query() call stream the given messages */
function mockQueryMessages(...messages: SDKMessage[]): void {
  mockedQuery.mockImplementationOnce(() => (async function* () {
    yield* messages;
  })() as unknown as Query);
}

function lastQueryCall() {
  const call = mockedQuery.mock.calls.at(-1);
  if (!call) throw new Error('query() was not called');
  return call[0];
}

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-test-model');
    vi.stubEnv('PROJECT_ROOT', '/tmp/project');
    mockedQuery.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const config = new CodeReviewOrchestrator().getConfig();

      expect(config.model).toBe('claude-test-model');
      expect(config.projectRoot).toBe('/tmp/project');
      expect(config.maxTurns).toBeGreaterThan(0);
      expect(config.timeoutMs).toBeGreaterThan(0);
      expect(config.maxRetries).toBeGreaterThanOrEqual(1);
      expect(config.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
    });

    it('should accept custom rate limit configuration', () => {
      const rateLimits = { maxRequestsPerMinute: 10, maxTokensPerMinute: 20_000, maxConcurrent: 2 };
      const orchestrator = new CodeReviewOrchestrator({ rateLimits });

      expect(orchestrator.getConfig().rateLimits).toEqual(rateLimits);
      expect(orchestrator.getRateLimitStatus()).toMatchObject({ availableRequests: 10, availableTokens: 20_000 });
    });

    it('should require ANTHROPIC_MODEL and PROJECT_ROOT', () => {
      vi.stubEnv('ANTHROPIC_MODEL', '');
      expect(() => new CodeReviewOrchestrator()).toThrow(/ANTHROPIC_MODEL/);

      vi.stubEnv('ANTHROPIC_MODEL', 'claude-test-model');
      vi.stubEnv('PROJECT_ROOT', '');
      expect(() => new CodeReviewOrchestrator()).toThrow(/PROJECT_ROOT/);
    });
  });

  describe('reviewPullRequest', () => {
    it('should fetch PR files from GitHub MCP', async () => {
      mockQueryMessages(
        initMessage(),
        toolUseMessage('mcp__github__get_pull_request', { owner: 'udacity', repo: 'cd14715-simple-todo-app', pull_number: 2 }),
        toolUseMessage('mcp__github__get_pull_request_files', { owner: 'udacity', repo: 'cd14715-simple-todo-app', pull_number: 2 }),
        resultMessage({ structured_output: createReviewReport() })
      );

      await new CodeReviewOrchestrator().reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);

      const { prompt, options } = lastQueryCall();
      expect(prompt).toContain('udacity/cd14715-simple-todo-app#2');
      expect(prompt).toContain('mcp__github__get_pull_request');
      expect(prompt).toContain('mcp__github__get_pull_request_files');
      expect(options?.mcpServers?.github).toMatchObject({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github']
      });
      expect(options?.mcpServers?.eslint).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', '@eslint/mcp@latest'] });
      expect(options?.allowedTools).toEqual(expect.arrayContaining([
        'mcp__github__get_pull_request',
        'mcp__github__get_pull_request_files',
        'mcp__github__get_file_contents',
        'mcp__eslint__lint-files'
      ]));
      expect(options?.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'mcp__github__merge_pull_request']));
      expect(options?.cwd).toBe('/tmp/project');
      expect(options?.settingSources).toEqual(['project']);
      expect(options?.model).toBe('claude-test-model');
    });

    it('should spawn all 3 subagents in parallel', async () => {
      mockQueryMessages(
        initMessage(),
        toolUseMessage('Task', { subagent_type: 'code-quality-analyzer', description: 'Analyze src/todo.ts', prompt: '...' }),
        resultMessage({ structured_output: createReviewReport() })
      );

      await new CodeReviewOrchestrator().reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);

      const { prompt, options } = lastQueryCall();
      expect(Object.keys(options?.agents ?? {})).toEqual(AGENT_NAMES);
      for (const agent of Object.values(options?.agents ?? {})) {
        expect(agent.model).toBe('inherit');
        expect(agent.tools).toContain('Skill');
        expect(agent.description.length).toBeGreaterThan(50);
        expect(agent.prompt).toMatch(/Skill/);
      }
      expect(options?.allowedTools).toEqual(expect.arrayContaining(['Task', 'Skill']));
      for (const name of AGENT_NAMES) {
        expect(prompt).toContain(`Use the ${name} agent`);
      }
      expect(prompt).toContain('SINGLE message so they run in parallel');
    });

    it('should aggregate results into ReviewReport', async () => {
      const cleanFile = 'src/clean.ts';
      const raw = createReviewReport();
      raw.fileReviews.push({
        file: cleanFile,
        codeQuality: { ...createCodeQualityResult(cleanFile), issues: [], overallScore: 96 },
        testCoverage: { ...createTestCoverageResult(cleanFile), untestedPaths: [] },
        refactorings: { file: cleanFile, suggestions: [], summary: 'Already well structured.' }
      });
      // Values the model may get wrong; the orchestrator recomputes them
      raw.pullRequest = { owner: 'someone', repo: 'else', number: 0 };
      raw.summary = { totalFiles: 9, overallScore: 1, criticalIssues: 0, highPriorityTests: 0, refactoringOpportunities: 0 };
      mockQueryMessages(initMessage(), resultMessage({ structured_output: raw }));

      const report = await new CodeReviewOrchestrator().reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);

      expect(report.pullRequest).toEqual({ owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 2 });
      expect(report.fileReviews.map((review) => review.file)).toEqual(['src/todo.ts', cleanFile]);
      expect(report.summary).toEqual({
        totalFiles: 2,
        overallScore: 86, // mean of 75 and 96, rounded
        criticalIssues: 1,
        highPriorityTests: 1,
        refactoringOpportunities: 1
      });
      expect(report.recommendations).toEqual(raw.recommendations);
      expect(report.metadata.duration).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(report.metadata.analyzedAt))).toBe(false);
      expect(report.metadata.agentVersions).toMatchObject({
        orchestrator: '1.0.0',
        'code-quality-analyzer': '1.0.0',
        'test-coverage-analyzer': '1.0.0',
        'refactoring-suggester': '1.0.0',
        model: 'claude-test-model'
      });
      expect(() => ReviewReportSchema.parse(report)).not.toThrow();
    });

    it('should validate output with Zod schema', async () => {
      mockQueryMessages(initMessage(), resultMessage({ structured_output: { pullRequest: { owner: 'udacity' } } }));

      const orchestrator = new CodeReviewOrchestrator({ maxRetries: 1, retryDelayMs: 1 });
      const error = await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReviewError);
      expect(error).toMatchObject({
        code: ErrorCodes.RETRY_EXHAUSTED,
        metadata: { lastErrorCode: ErrorCodes.STRUCTURED_OUTPUT_FAILED }
      });
      expect((error as ReviewError).message).toContain('ReviewReport schema');
    });

    it('should request structured output with the ReviewReport JSON schema', async () => {
      mockQueryMessages(initMessage(), resultMessage({ structured_output: createReviewReport() }));

      await new CodeReviewOrchestrator().reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);

      expect(lastQueryCall().options?.outputFormat).toEqual({ type: 'json_schema', schema: ReviewReportJSONSchema });
    });

    it('should retry a failed attempt and then succeed', async () => {
      mockedQuery.mockImplementationOnce(() => {
        throw new Error('Claude Code process exited with code 1');
      });
      mockQueryMessages(initMessage(), resultMessage({ structured_output: createReviewReport() }));

      const report = await new CodeReviewOrchestrator({ maxRetries: 2, retryDelayMs: 1 })
        .reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);

      expect(mockedQuery).toHaveBeenCalledTimes(2);
      expect(report.fileReviews).toHaveLength(1);
    });

    it('should fail with a clear error when the orchestrator agent fails', async () => {
      mockQueryMessages(initMessage(), resultMessage({ subtype: 'error_max_turns', errors: ['Reached maximum number of turns'] }));

      const error = await new CodeReviewOrchestrator({ maxRetries: 1, retryDelayMs: 1 })
        .reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2)
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ code: ErrorCodes.RETRY_EXHAUSTED, metadata: { lastErrorCode: ErrorCodes.AGENT_FAILED } });
      expect((error as ReviewError).message).toContain('error_max_turns');
    });

    it('should stop early when the GitHub MCP server fails to start', async () => {
      mockQueryMessages(initMessage('failed'), resultMessage({ structured_output: createReviewReport() }));

      const error = await new CodeReviewOrchestrator({ maxRetries: 1, retryDelayMs: 1 })
        .reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2)
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ metadata: { lastErrorCode: ErrorCodes.GITHUB_API_ERROR } });
    });

    it('should release the rate limiter slot with the actual token usage', async () => {
      mockQueryMessages(initMessage(), resultMessage({ structured_output: createReviewReport() }));
      const orchestrator = new CodeReviewOrchestrator();

      await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);

      expect(orchestrator.getRateLimitStatus()).toMatchObject({
        activeRequests: 0,
        requestsInWindow: 1,
        tokensInWindow: 2000
      });
    });
  });

  describe('Helpers', () => {
    it('calculateSummary handles a review without files', () => {
      expect(calculateSummary([])).toEqual({
        totalFiles: 0,
        overallScore: 100,
        criticalIssues: 0,
        highPriorityTests: 0,
        refactoringOpportunities: 0
      });
    });

    it('registers every subagent under the name used in the orchestrator prompt', () => {
      expect(Object.keys(SUBAGENTS)).toEqual(AGENT_NAMES);
    });

    it('renders GitHub file contents with line numbers', async () => {
      const content = 'export const a = 1;\nexport const b = 2;\n';
      const output = await addLineNumbersToFileContents(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__github__get_file_contents',
          tool_input: { owner: 'udacity', repo: 'todo', path: 'src/a.ts', branch: 'abc123' },
          tool_response: [{ type: 'text', text: JSON.stringify({ type: 'file', path: 'src/a.ts', content }) }],
          tool_use_id: 'tool-1',
          session_id: 'test-session',
          transcript_path: '',
          cwd: '/tmp/project'
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedMCPToolOutput: [{
            type: 'text',
            text: 'File: src/a.ts @ abc123 (2 lines, 1-based line numbers)\n     1\texport const a = 1;\n     2\texport const b = 2;'
          }]
        }
      });
    });

    it('leaves directory listings unchanged', async () => {
      const output = await addLineNumbersToFileContents(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__github__get_file_contents',
          tool_input: { owner: 'udacity', repo: 'todo', path: 'src' },
          tool_response: [{ type: 'text', text: JSON.stringify([{ type: 'file', path: 'src/a.ts' }]) }],
          tool_use_id: 'tool-2',
          session_id: 'test-session',
          transcript_path: '',
          cwd: '/tmp/project'
        },
        'tool-2',
        { signal: new AbortController().signal }
      );

      expect(output).toEqual({});
    });
  });

  describe('Integration', () => {
    // Uses the real SDK, GitHub and Anthropic APIs. Run manually with valid credentials in .env:
    //   RUN_INTEGRATION_TESTS=true npm test -- orchestrator.test.ts
    // Equivalent CLI check: npm run dev -- octocat Hello-World 1
    it.runIf(process.env.RUN_INTEGRATION_TESTS === 'true')('should review a real small PR', async () => {
      const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
      mockedQuery.mockImplementation(actual.query);
      vi.unstubAllEnvs();
      await import('../src/config/env.js');

      const report = await new CodeReviewOrchestrator().reviewPullRequest('octocat', 'Hello-World', 1);

      expect(ReviewReportSchema.safeParse(report).success).toBe(true);
      expect(report.pullRequest).toEqual({ owner: 'octocat', repo: 'Hello-World', number: 1 });
      expect(report.fileReviews.length).toBeGreaterThan(0);
    }, 20 * 60 * 1000);
  });
});
