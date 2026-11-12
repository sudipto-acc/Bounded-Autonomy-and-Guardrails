import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CodeQualityResultJSONSchema,
  CodeQualityResultSchema,
  RefactoringSuggestionJSONSchema,
  RefactoringSuggestionSchema,
  ReviewReportJSONSchema,
  ReviewReportSchema,
  TestCoverageResultJSONSchema,
  TestCoverageResultSchema
} from '../src/types/index.js';
import {
  createCodeQualityResult,
  createRefactoringSuggestion,
  createReviewReport,
  createTestCoverageResult
} from './fixtures.js';

type JsonSchemaNode = {
  type?: string;
  required?: string[];
  enum?: string[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
};

describe('CodeQualityResultSchema', () => {
  const [baseIssue] = createCodeQualityResult().issues;

  it('accepts valid data', () => {
    expect(() => CodeQualityResultSchema.parse(createCodeQualityResult())).not.toThrow();
  });

  it('accepts every severity and category value', () => {
    for (const severity of ['critical', 'high', 'medium', 'low', 'info'] as const) {
      for (const category of ['security', 'performance', 'maintainability', 'style', 'bug-risk', 'best-practice'] as const) {
        const data = { ...createCodeQualityResult(), issues: [{ ...baseIssue, severity, category }] };
        expect(CodeQualityResultSchema.safeParse(data).success).toBe(true);
      }
    }
  });

  it('accepts an empty issues array (clean code)', () => {
    const data = { ...createCodeQualityResult(), issues: [], overallScore: 100 };
    expect(CodeQualityResultSchema.parse(data).issues).toEqual([]);
  });

  it('accepts the boundary scores 0 and 100', () => {
    expect(CodeQualityResultSchema.safeParse({ ...createCodeQualityResult(), overallScore: 0 }).success).toBe(true);
    expect(CodeQualityResultSchema.safeParse({ ...createCodeQualityResult(), overallScore: 100 }).success).toBe(true);
  });

  it('rejects scores outside 0-100', () => {
    expect(() => CodeQualityResultSchema.parse({ ...createCodeQualityResult(), overallScore: -1 })).toThrow(ZodError);
    expect(() => CodeQualityResultSchema.parse({ ...createCodeQualityResult(), overallScore: 101 })).toThrow(ZodError);
  });

  it('rejects invalid enum values', () => {
    expect(() => CodeQualityResultSchema.parse({
      ...createCodeQualityResult(),
      issues: [{ ...baseIssue, severity: 'blocker' }]
    })).toThrow(ZodError);
    expect(() => CodeQualityResultSchema.parse({
      ...createCodeQualityResult(),
      issues: [{ ...baseIssue, category: 'typo' }]
    })).toThrow(ZodError);
  });

  it('rejects wrong types', () => {
    expect(() => CodeQualityResultSchema.parse({
      ...createCodeQualityResult(),
      issues: [{ ...baseIssue, line: '121' }]
    })).toThrow(ZodError);
    expect(() => CodeQualityResultSchema.parse({ ...createCodeQualityResult(), issues: 'none' })).toThrow(ZodError);
  });

  it('rejects missing required fields', () => {
    const { summary: _summary, ...withoutSummary } = createCodeQualityResult();
    const result = CodeQualityResultSchema.safeParse(withoutSummary);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['summary']);
  });
});

describe('TestCoverageResultSchema', () => {
  const [basePath] = createTestCoverageResult().untestedPaths;

  it('accepts valid data', () => {
    expect(() => TestCoverageResultSchema.parse(createTestCoverageResult())).not.toThrow();
  });

  it('accepts a file without tests and empty arrays', () => {
    const data = { ...createTestCoverageResult(), hasTests: false, testFiles: [], untestedPaths: [], coverageEstimate: 0 };
    expect(TestCoverageResultSchema.safeParse(data).success).toBe(true);
  });

  it('accepts every untested path type and priority', () => {
    for (const type of ['function', 'class', 'branch', 'edge-case'] as const) {
      for (const priority of ['critical', 'high', 'medium', 'low'] as const) {
        const data = { ...createTestCoverageResult(), untestedPaths: [{ ...basePath, type, priority }] };
        expect(TestCoverageResultSchema.safeParse(data).success).toBe(true);
      }
    }
  });

  it('accepts the boundary coverage values 0 and 100', () => {
    expect(TestCoverageResultSchema.safeParse({ ...createTestCoverageResult(), coverageEstimate: 0 }).success).toBe(true);
    expect(TestCoverageResultSchema.safeParse({ ...createTestCoverageResult(), coverageEstimate: 100 }).success).toBe(true);
  });

  it('rejects invalid data', () => {
    expect(() => TestCoverageResultSchema.parse({ ...createTestCoverageResult(), coverageEstimate: 150 })).toThrow(ZodError);
    expect(() => TestCoverageResultSchema.parse({ ...createTestCoverageResult(), hasTests: 'yes' })).toThrow(ZodError);
    expect(() => TestCoverageResultSchema.parse({
      ...createTestCoverageResult(),
      untestedPaths: [{ ...basePath, type: 'module' }]
    })).toThrow(ZodError);
    expect(() => TestCoverageResultSchema.parse({
      ...createTestCoverageResult(),
      untestedPaths: [{ ...basePath, priority: 'urgent' }]
    })).toThrow(ZodError);
  });

  it('rejects an untested path without a suggested test', () => {
    const { suggestedTest: _suggestedTest, ...withoutTest } = basePath!;
    const data = { ...createTestCoverageResult(), untestedPaths: [withoutTest] };
    expect(TestCoverageResultSchema.safeParse(data).success).toBe(false);
  });
});

describe('RefactoringSuggestionSchema', () => {
  const [baseSuggestion] = createRefactoringSuggestion().suggestions;

  it('accepts valid data', () => {
    expect(() => RefactoringSuggestionSchema.parse(createRefactoringSuggestion())).not.toThrow();
  });

  it('accepts an empty suggestions array', () => {
    expect(RefactoringSuggestionSchema.safeParse({ ...createRefactoringSuggestion(), suggestions: [] }).success).toBe(true);
  });

  it('accepts every refactoring type and impact', () => {
    for (const type of ['extract-function', 'rename', 'modernize', 'simplify', 'pattern-improvement'] as const) {
      for (const impact of ['low', 'medium', 'high'] as const) {
        const data = { ...createRefactoringSuggestion(), suggestions: [{ ...baseSuggestion, type, impact }] };
        expect(RefactoringSuggestionSchema.safeParse(data).success).toBe(true);
      }
    }
  });

  it('rejects invalid enum values', () => {
    expect(() => RefactoringSuggestionSchema.parse({
      ...createRefactoringSuggestion(),
      suggestions: [{ ...baseSuggestion, type: 'extract-class' }]
    })).toThrow(ZodError);
    expect(() => RefactoringSuggestionSchema.parse({
      ...createRefactoringSuggestion(),
      suggestions: [{ ...baseSuggestion, impact: 'critical' }]
    })).toThrow(ZodError);
  });

  it('requires before/after code examples', () => {
    const { before: _before, after: _after, ...withoutCode } = baseSuggestion!;
    const data = { ...createRefactoringSuggestion(), suggestions: [withoutCode] };
    expect(RefactoringSuggestionSchema.safeParse(data).success).toBe(false);
  });
});

describe('ReviewReportSchema', () => {
  it('accepts a valid report', () => {
    expect(() => ReviewReportSchema.parse(createReviewReport())).not.toThrow();
  });

  it('accepts empty fileReviews, recommendations and agentVersions', () => {
    const report = {
      ...createReviewReport(),
      fileReviews: [],
      recommendations: [],
      metadata: { analyzedAt: '2026-01-01T00:00:00.000Z', duration: 0, agentVersions: {} }
    };
    expect(ReviewReportSchema.safeParse(report).success).toBe(true);
  });

  it('strips unknown properties', () => {
    const parsed = ReviewReportSchema.parse({ ...createReviewReport(), extra: 'ignored' });
    expect(parsed).not.toHaveProperty('extra');
  });

  it('rejects an invalid nested file review', () => {
    const report = createReviewReport();
    const [review] = report.fileReviews;
    const invalid = {
      ...report,
      fileReviews: [{ ...review, codeQuality: { ...review!.codeQuality, overallScore: 101 } }]
    };
    const result = ReviewReportSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['fileReviews', 0, 'codeQuality', 'overallScore']);
  });

  it('rejects invalid recommendation priorities', () => {
    const report = createReviewReport();
    const invalid = { ...report, recommendations: [{ ...report.recommendations[0], priority: 'info' }] };
    expect(() => ReviewReportSchema.parse(invalid)).toThrow(ZodError);
  });

  it('rejects wrong types and missing sections', () => {
    const report = createReviewReport();
    expect(() => ReviewReportSchema.parse({ ...report, pullRequest: { ...report.pullRequest, number: '2' } })).toThrow(ZodError);
    expect(() => ReviewReportSchema.parse({
      ...report,
      metadata: { ...report.metadata, agentVersions: { orchestrator: 1 } }
    })).toThrow(ZodError);
    const { metadata: _metadata, ...withoutMetadata } = report;
    expect(() => ReviewReportSchema.parse(withoutMetadata)).toThrow(ZodError);
  });
});

describe('JSON Schema export for SDK structured outputs', () => {
  const reportSchema = ReviewReportJSONSchema as JsonSchemaNode;

  it('exports the ReviewReport as an object schema with all top-level sections required', () => {
    expect(reportSchema.type).toBe('object');
    expect(reportSchema.required).toEqual(
      expect.arrayContaining(['pullRequest', 'fileReviews', 'summary', 'recommendations', 'metadata'])
    );
  });

  it('matches the output of zodToJsonSchema with the root $ref strategy', () => {
    expect(ReviewReportJSONSchema).toEqual(zodToJsonSchema(ReviewReportSchema, { $refStrategy: 'root' }));
  });

  it('inlines nested schemas without $ref pointers', () => {
    expect(JSON.stringify(ReviewReportJSONSchema)).not.toContain('$ref');
    const fileReview = reportSchema.properties?.fileReviews?.items;
    expect(fileReview?.required).toEqual(expect.arrayContaining(['file', 'codeQuality', 'testCoverage', 'refactorings']));
  });

  it('marks required properties and constraints of the subagent schemas', () => {
    const codeQuality = CodeQualityResultJSONSchema as JsonSchemaNode;
    expect(codeQuality.required).toEqual(expect.arrayContaining(['file', 'issues', 'overallScore', 'summary']));
    expect(codeQuality.properties?.overallScore).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
    expect(codeQuality.properties?.issues?.items?.properties?.severity?.enum)
      .toEqual(['critical', 'high', 'medium', 'low', 'info']);

    const testCoverage = TestCoverageResultJSONSchema as JsonSchemaNode;
    expect(testCoverage.required).toEqual(
      expect.arrayContaining(['file', 'hasTests', 'testFiles', 'untestedPaths', 'coverageEstimate', 'summary'])
    );

    const refactoring = RefactoringSuggestionJSONSchema as JsonSchemaNode;
    expect(refactoring.properties?.suggestions?.items?.required)
      .toEqual(expect.arrayContaining(['type', 'location', 'impact', 'description', 'before', 'after', 'benefits']));
  });

  it('is serializable for the SDK outputFormat option', () => {
    expect(JSON.parse(JSON.stringify(ReviewReportJSONSchema))).toEqual(ReviewReportJSONSchema);
  });
});
