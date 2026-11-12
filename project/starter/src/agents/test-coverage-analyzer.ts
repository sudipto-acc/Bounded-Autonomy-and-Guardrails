import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/index.js';

/**
 * Test Coverage Analyzer subagent
 * Compares a PR source file with the repository's existing tests to find untested paths.
 * Returns a TestCoverageResult JSON object.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Test coverage specialist. Use this agent to analyze ONE changed source file of a pull request: it locates the ' +
    'existing test files, identifies functions/methods/branches/edge cases without test coverage, prioritizes critical ' +
    'untested paths, suggests specific test cases with meaningful assertions and estimates the coverage percentage. ' +
    'Returns a TestCoverageResult JSON object.',
  // GitHub MCP lists directories and loads source + test files; Skill loads testing-best-practices
  tools: ['Read', 'Grep', 'Glob', 'Skill', 'mcp__github__get_file_contents'],
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  model: 'inherit'
};
