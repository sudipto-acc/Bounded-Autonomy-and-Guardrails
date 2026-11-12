/**
 * Model Context Protocol (MCP) server configurations
 *
 * Required MCP Servers:
 * 1. GitHub - For PR/repo operations
 * 2. ESLint - For code linting and style analysis
 *
 * Documentation:
 * - MCP Protocol: https://modelcontextprotocol.io
 * - GitHub MCP: https://github.com/github/github-mcp-server
 * - ESLint MCP: https://eslint.org/docs/latest/use/mcp
 */

import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

export const mcpServersConfig = {
  /**
   * GitHub MCP Server
   * Provides tools for GitHub API operations (get_pull_request, get_pull_request_files,
   * get_file_contents, ...). Exposed to agents as `mcp__github__<tool>`.
   *
   * Note: GITHUB_TOKEN is optional (recommended for private repos and higher rate limits).
   * The GitHub MCP server expects GITHUB_PERSONAL_ACCESS_TOKEN as the env var name.
   * We map our GITHUB_TOKEN from .env to this expected name.
   */
  github: {
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' }
  },

  /**
   * ESLint MCP Server
   * Provides the `lint-files` tool (exposed as `mcp__eslint__lint-files`) that lints
   * local files by absolute path. No authentication required.
   */
  eslint: {
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@eslint/mcp@latest'],
    env: {} as Record<string, string>
  }
} satisfies Record<string, McpStdioServerConfig>;

/**
 * MCP tools the orchestrator is allowed to call (read-only operations only).
 * Tool names follow the SDK convention: mcp__<server>__<tool>
 */
export const MCP_ALLOWED_TOOLS = {
  github: [
    'mcp__github__get_pull_request',
    'mcp__github__get_pull_request_files',
    'mcp__github__get_file_contents'
  ],
  eslint: ['mcp__eslint__lint-files']
} as const;
