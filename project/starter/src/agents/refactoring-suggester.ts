import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/index.js';

/**
 * Refactoring Suggester subagent
 * Proposes structural improvements (design patterns, modernization, extract method/class, dead code removal).
 * Returns a RefactoringSuggestion JSON object.
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Refactoring and architecture specialist. Use this agent to analyze ONE changed source file of a pull request for ' +
    'opportunities to apply design patterns, adopt modern language features, extract functions/classes, rename unclear ' +
    'identifiers and remove dead or redundant code. Returns a RefactoringSuggestion JSON object with actionable ' +
    'before/after code examples and impact ratings.',
  // Skill loads typescript-patterns / javascript-best-practices as the modernization catalogue
  tools: ['Read', 'Grep', 'Glob', 'Skill', 'mcp__github__get_file_contents'],
  prompt: REFACTORING_SUGGESTER_PROMPT,
  model: 'inherit'
};
