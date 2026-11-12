import type {
  CodeQualityResult,
  RefactoringSuggestion,
  ReviewReport,
  TestCoverageResult
} from '../src/types/index.js';

/** Valid sample data shared by the test suites */

export function createCodeQualityResult(file = 'src/todo.ts'): CodeQualityResult {
  return {
    file,
    issues: [
      {
        line: 121,
        severity: 'critical',
        category: 'security',
        description: 'SQL injection (OWASP A03): keyword is interpolated into the LIKE clause of searchTodos()',
        suggestion: "db.query('SELECT * FROM todos WHERE title LIKE $1 OR description LIKE $1', [`%${keyword}%`])"
      }
    ],
    overallScore: 75,
    summary: 'One critical SQL injection in searchTodos().'
  };
}

export function createTestCoverageResult(file = 'src/todo.ts'): TestCoverageResult {
  return {
    file,
    hasTests: true,
    testFiles: ['src/todo.test.ts'],
    untestedPaths: [
      {
        type: 'function',
        location: 'searchTodos() lines 119-124',
        priority: 'critical',
        reasoning: 'Injection-prone query without any test',
        suggestedTest: "it('passes the keyword as a query parameter', async () => {\n  await searchTodos(\"' OR '1'='1\");\n  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('$1'), [\"%' OR '1'='1%\"]);\n});"
      }
    ],
    coverageEstimate: 60,
    summary: 'The new search functions are untested.'
  };
}

export function createRefactoringSuggestion(file = 'src/todo.ts'): RefactoringSuggestion {
  return {
    file,
    suggestions: [
      {
        type: 'extract-function',
        location: 'searchTodos() lines 119-124',
        impact: 'medium',
        description: 'Extract the repeated query-and-cast logic into a helper',
        before: 'const rows = await db.query(query);\nreturn rows as Todo[];',
        after: 'return queryTodos(sql, params);',
        benefits: 'Removes duplication and centralises row validation'
      }
    ],
    summary: 'Extract a shared query helper.'
  };
}

export function createReviewReport(): ReviewReport {
  const file = 'src/todo.ts';
  return {
    pullRequest: { owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 2 },
    fileReviews: [
      {
        file,
        codeQuality: createCodeQualityResult(file),
        testCoverage: createTestCoverageResult(file),
        refactorings: createRefactoringSuggestion(file)
      }
    ],
    summary: {
      totalFiles: 1,
      overallScore: 75,
      criticalIssues: 1,
      highPriorityTests: 1,
      refactoringOpportunities: 1
    },
    recommendations: [
      {
        priority: 'critical',
        category: 'Security',
        description: 'Use parameterized queries in searchTodos() (line 121)',
        files: [file]
      }
    ],
    metadata: {
      analyzedAt: '2026-01-01T00:00:00.000Z',
      duration: 1234,
      agentVersions: { 'code-quality-analyzer': '1.0.0' }
    }
  };
}
