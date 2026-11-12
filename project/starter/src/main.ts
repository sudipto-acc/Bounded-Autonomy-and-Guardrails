// Must stay the first import: loads .env before other modules read process.env
import './config/env.js';

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodeReviewOrchestrator } from './orchestrator.js';
import type { ReviewReport } from './types/report-types.js';
import { ErrorCodes, formatError, isReviewError } from './utils/error-handler.js';
import { ReportGenerator } from './utils/report-generator.js';

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 *
 * Integration test (real public PR): npm run dev -- octocat Hello-World 1
 */

const USAGE = `Usage:   npm run dev -- <owner> <repo> <pr-number>
Example: npm run dev -- udacity cd14715-simple-todo-app 1`;

// GitHub naming rules; this also keeps the values safe to use in report file names
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

type AuthMethod = 'anthropic' | 'bedrock';

interface CliArguments {
  owner: string;
  repo: string;
  prNumber: number;
}

function exitWithError(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function parseArguments(args: string[]): CliArguments {
  const [owner, repo, prStr] = args;

  if (!owner || !repo || !prStr) {
    exitWithError(`Missing required arguments: owner, repo and PR number.\n\n${USAGE}`);
  }
  if (!OWNER_PATTERN.test(owner)) {
    exitWithError(`Invalid repository owner "${owner}": use letters, digits and hyphens only.\n\n${USAGE}`);
  }
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    exitWithError(`Invalid repository name "${repo}": use letters, digits, ".", "-" and "_" only.\n\n${USAGE}`);
  }

  const prNumber = Number(prStr);
  if (!/^\d+$/.test(prStr) || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    exitWithError(`Invalid PR number "${prStr}": it must be a positive integer.\n\n${USAGE}`);
  }

  return { owner, repo, prNumber };
}

function validateAuthentication(): AuthMethod {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (hasAwsCredentials && (!hasApiKey || process.env.CLAUDE_CODE_USE_BEDROCK === '1')) {
    if (!process.env.AWS_REGION) {
      exitWithError('AWS_REGION is required for AWS Bedrock authentication (for example AWS_REGION=us-east-1).');
    }
    // Makes the Claude Code runtime call Bedrock instead of the Anthropic API
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    console.log('🔐 Using AWS Bedrock authentication');
    return 'bedrock';
  }

  if (hasApiKey) {
    console.log('🔐 Using Anthropic API authentication');
    return 'anthropic';
  }

  exitWithError(`No authentication configured. Set ONE of the following in your environment or .env file:

  Option 1 - Anthropic API:
    ANTHROPIC_API_KEY=sk-ant-your-key-here

  Option 2 - AWS Bedrock:
    AWS_ACCESS_KEY_ID=your-access-key-id
    AWS_SECRET_ACCESS_KEY=your-secret-access-key
    AWS_REGION=us-east-1`);
}

function validateModel(authMethod: AuthMethod): string {
  const model = process.env.ANTHROPIC_MODEL?.trim();
  const formats = `  - Anthropic API: ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
  - AWS Bedrock:   ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0`;

  if (!model) {
    exitWithError(`ANTHROPIC_MODEL environment variable is required. Add it to your .env file:\n${formats}`);
  }

  const looksLikeBedrockId = model.includes('anthropic.');
  if ((authMethod === 'bedrock') !== looksLikeBedrockId) {
    console.warn(`⚠️  ANTHROPIC_MODEL "${model}" does not look like a ${authMethod === 'bedrock' ? 'Bedrock' : 'Anthropic API'} model ID. Expected format:\n${formats}`);
  }
  return model;
}

function validateProjectRoot(): string {
  const projectRoot = process.env.PROJECT_ROOT?.trim();

  if (!projectRoot) {
    exitWithError(`PROJECT_ROOT is required. Set it in .env to the absolute path of project/starter, e.g.\n  PROJECT_ROOT=${process.cwd()}`);
  }
  if (!existsSync(path.join(projectRoot, '.claude', 'skills'))) {
    exitWithError(`PROJECT_ROOT "${projectRoot}" does not contain a .claude/skills directory. Set it to the absolute path of project/starter, e.g.\n  PROJECT_ROOT=${process.cwd()}`);
  }
  return projectRoot;
}

async function saveReports(report: ReviewReport, baseName: string): Promise<string[]> {
  const generator = new ReportGenerator();
  const reportsDir = path.resolve('reports');
  await mkdir(reportsDir, { recursive: true });

  const outputs: Array<[fileName: string, content: string]> = [
    [`${baseName}.json`, generator.generateJSONReport(report)],
    [`${baseName}.md`, generator.generateMarkdownReport(report)],
    [`${baseName}.html`, generator.generateHTMLReport(report)]
  ];

  return Promise.all(
    outputs.map(async ([fileName, content]) => {
      const filePath = path.join(reportsDir, fileName);
      await writeFile(filePath, content, 'utf8');
      return filePath;
    })
  );
}

function troubleshootingHint(error: unknown): string {
  const message = formatError(error);
  if (/credit balance/i.test(message)) {
    return 'Your Anthropic account has insufficient credits: add credits in the Anthropic Console or use another API key.';
  }
  if (/authenticat|api key|401/i.test(message)) {
    return 'Check ANTHROPIC_API_KEY (or your AWS credentials) and ANTHROPIC_BASE_URL.';
  }
  if (/rate.?limit|429|403/i.test(message)) {
    return 'A rate limit was hit (Anthropic or GitHub API). Wait a minute and retry; setting GITHUB_TOKEN raises the GitHub limit.';
  }
  if (/not found|404/i.test(message)) {
    return 'Check that the repository and pull request exist and are accessible with your GITHUB_TOKEN.';
  }
  if (isReviewError(error) && error.metadata?.lastErrorCode === ErrorCodes.AGENT_TIMEOUT) {
    return 'The review timed out. Try again; large pull requests need more time.';
  }
  return 'Run again with LOG_LEVEL=debug for details (see logs/combined.log).';
}

async function main(): Promise<void> {
  const { owner, repo, prNumber } = parseArguments(process.argv.slice(2));
  const authMethod = validateAuthentication();
  const model = validateModel(authMethod);
  const projectRoot = validateProjectRoot();

  // An empty ANTHROPIC_BASE_URL in .env means "use the default Anthropic endpoint"
  if (process.env.ANTHROPIC_BASE_URL === '') delete process.env.ANTHROPIC_BASE_URL;

  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠️  GITHUB_TOKEN is not set: using unauthenticated GitHub access (public repos only, 60 requests/hour).');
  }

  console.log(`\n🔍 Reviewing ${owner}/${repo}#${prNumber} with ${model} (this can take several minutes)...\n`);

  try {
    const orchestrator = new CodeReviewOrchestrator({ model, projectRoot });
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);
    const savedFiles = await saveReports(report, `${owner}_${repo}_${prNumber}`);

    const { summary } = report;
    console.log(`\n✅ Review complete for ${owner}/${repo}#${prNumber}`);
    console.log(`   Overall score: ${summary.overallScore}/100 | Files: ${summary.totalFiles} | Critical issues: ${summary.criticalIssues} | High-priority tests: ${summary.highPriorityTests} | Refactorings: ${summary.refactoringOpportunities}`);
    console.log('\n📄 Reports saved:');
    for (const file of savedFiles) console.log(`   - ${path.relative(process.cwd(), file)}`);
  } catch (error) {
    console.error(`\n❌ Review failed: ${formatError(error)}`);
    console.error(`💡 ${troubleshootingHint(error)}\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n❌ Unexpected error: ${formatError(error)}\n`);
  process.exitCode = 1;
});
