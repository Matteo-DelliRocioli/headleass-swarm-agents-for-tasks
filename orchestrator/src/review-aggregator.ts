// ---------------------------------------------------------------------------
// Review aggregator — collects review scores and calculates confidence
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";

export interface ReviewIssue {
  severity: "critical" | "high" | "medium" | "low";
  file?: string;
  line?: number;
  description: string;
}

export interface ReviewResult {
  reviewerId: string;
  score: number;
  issues: ReviewIssue[];
}

export interface AggregatedReview {
  confidence: number;
  reviewCount: number;
  perReviewer: Array<{ id: string; score: number; issueCount: number }>;
  criticalIssues: ReviewIssue[];
  allIssues: ReviewIssue[];
  followUpTasks: Array<{ title: string; priority: number; description: string }>;
}

// Weights per reviewer type (security issues are more important than style)
const REVIEWER_WEIGHTS: Record<string, number> = {
  "security-reviewer": 1.5,
  "quality-reviewer": 1.0,
  "architecture-reviewer": 1.2,
  "master-reviewer": 1.0,
};

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Aggregate multiple review results into a single confidence score
 * and a list of follow-up tasks.
 */
export function aggregateReviews(reviews: ReviewResult[]): AggregatedReview {
  if (reviews.length === 0) {
    return {
      confidence: 0,
      reviewCount: 0,
      perReviewer: [],
      criticalIssues: [],
      allIssues: [],
      followUpTasks: [],
    };
  }

  // Calculate weighted confidence
  let weightedSum = 0;
  let totalWeight = 0;
  for (const review of reviews) {
    const weight = REVIEWER_WEIGHTS[review.reviewerId] ?? 1.0;
    weightedSum += review.score * weight;
    totalWeight += weight;
  }
  const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Collect all issues
  const allIssues = reviews.flatMap(r => r.issues);

  // Find critical issues (flagged by 2+ reviewers or severity=critical)
  const criticalIssues = allIssues.filter(issue => {
    if (issue.severity === "critical") return true;
    // Count how many reviewers flagged similar issues (same file + similar description)
    const similar = allIssues.filter(other =>
      other !== issue &&
      other.file === issue.file &&
      other.description.toLowerCase().includes(issue.description.toLowerCase().slice(0, 20)),
    );
    return similar.length >= 1; // 2+ reviewers flagged it
  });

  // Generate follow-up tasks from issues
  const followUpTasks = criticalIssues
    .filter((issue, idx, arr) =>
      // Deduplicate by file + first 30 chars of description
      arr.findIndex(i => i.file === issue.file && i.description.slice(0, 30) === issue.description.slice(0, 30)) === idx,
    )
    .map(issue => ({
      title: `Fix: ${issue.description.slice(0, 60)}`,
      priority: SEVERITY_PRIORITY[issue.severity] ?? 2,
      description: `${issue.severity.toUpperCase()}: ${issue.description}${issue.file ? ` in ${issue.file}` : ""}${issue.line ? `:${issue.line}` : ""}`,
    }));

  const result: AggregatedReview = {
    confidence: Math.round(confidence * 100) / 100, // 2 decimal places
    reviewCount: reviews.length,
    perReviewer: reviews.map(r => ({
      id: r.reviewerId,
      score: r.score,
      issueCount: r.issues.length,
    })),
    criticalIssues,
    allIssues,
    followUpTasks,
  };

  logger.info("Review aggregation complete", {
    confidence: result.confidence,
    reviewCount: result.reviewCount,
    criticalIssueCount: criticalIssues.length,
    followUpTaskCount: followUpTasks.length,
  });

  return result;
}
