import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/index.js';

/**
 * Code Quality Analyzer subagent
 * Reviews a single PR file for security, performance and best-practice issues.
 * Returns a CodeQualityResult JSON object.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Code quality and security reviewer. Use this agent to analyze ONE changed source file of a pull request for ' +
    'security vulnerabilities (OWASP Top 10, injection, sensitive data exposure), performance problems, bug risks and ' +
    'best-practice/maintainability issues. Returns a CodeQualityResult JSON object with line-level issues, ' +
    'severity levels and a 0-100 quality score.',
  // Read/Grep/Glob for local code, Skill for javascript-best-practices / typescript-patterns / security-analysis,
  // GitHub MCP to load the PR version of the file
  tools: ['Read', 'Grep', 'Glob', 'Skill', 'mcp__github__get_file_contents'],
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  model: 'inherit'
};
