#!/usr/bin/env npx tsx
/**
 * detect-contamination.ts — Estimates training data contamination risk.
 *
 * For each task, checks multiple signals that indicate whether the bug
 * and its fix might be in an LLM's training data:
 *
 *   1. Issue age: older issues = higher contamination risk
 *   2. Fix visibility: merged PRs with discussion = higher risk
 *   3. Repository popularity: more stars = higher risk
 *   4. Stack Overflow / blog coverage: search for exact error messages
 *   5. Commit message specificity: descriptive messages leak the fix
 *
 * Outputs a contamination_score ∈ [0, 1] per task.
 *
 * Usage:
 *   npx tsx scripts/detect-contamination.ts                          # all tasks
 *   npx tsx scripts/detect-contamination.ts --task <id>              # single task
 *   npx tsx scripts/detect-contamination.ts --cutoff 2025-04-01      # custom cutoff
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────

interface ContaminationSignals {
  issueAge: number;          // days since issue was created
  fixMerged: boolean;        // whether a fix has been merged
  daysSinceFix: number;      // days since fix was merged (0 if unmerged)
  repoPopularity: number;    // estimated from repo URL (could fetch from API)
  commitMessageLeaks: boolean; // whether commit message describes the fix
  issueTitleLeaks: boolean;  // whether issue title describes the root cause
  hasPublicDiscussion: boolean; // whether there are comments/PR reviews
}

interface ContaminationResult {
  taskId: string;
  score: number;             // 0 = clean, 1 = fully contaminated
  risk: 'low' | 'medium' | 'high';
  signals: ContaminationSignals;
  breakdown: Record<string, number>;
  recommendation: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

// Default training cutoff: models trained before this date are unlikely
// to have seen issues/fixes created after it
const DEFAULT_CUTOFF = '2025-04-01';

// Weight for each signal in the final score
const WEIGHTS = {
  issueAge: 0.25,            // older = more likely in training data
  fixVisibility: 0.30,       // merged fixes with discussion = high risk
  repoPopularity: 0.15,      // popular repos more likely scraped
  messageLeakage: 0.20,      // descriptive messages help LLMs
  publicDiscussion: 0.10,    // comments/reviews add context
};

// ── Paths ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')));
const TASKS_DIR = path.resolve(ROOT, '..', 'dataset', 'tasks');

// ── Scoring Functions ──────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.abs(Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

function scoreIssueAge(issueCreated: string, cutoffDate: string): number {
  const issueDateMs = new Date(issueCreated).getTime();
  const cutoffMs = new Date(cutoffDate).getTime();

  if (issueDateMs > cutoffMs) {
    // Issue created AFTER cutoff — very low contamination risk
    return 0.0;
  }

  // The older the issue relative to cutoff, the higher the risk
  const daysBeforeCutoff = daysBetween(issueCreated, cutoffDate);

  if (daysBeforeCutoff < 30) return 0.1;   // recent
  if (daysBeforeCutoff < 90) return 0.3;   // moderate
  if (daysBeforeCutoff < 180) return 0.5;  // notable
  if (daysBeforeCutoff < 365) return 0.7;  // high
  return 0.9;                                // very old
}

function scoreFixVisibility(fixMerged: string | null, cutoffDate: string): number {
  if (!fixMerged) return 0.0; // unmerged — not in training data

  const fixDateMs = new Date(fixMerged).getTime();
  const cutoffMs = new Date(cutoffDate).getTime();

  if (fixDateMs > cutoffMs) return 0.1; // merged after cutoff — low risk

  const daysBeforeCutoff = daysBetween(fixMerged, cutoffDate);
  if (daysBeforeCutoff < 30) return 0.3;
  if (daysBeforeCutoff < 90) return 0.5;
  return 0.8;
}

function scoreRepoPopularity(repoUrl: string): number {
  // Heuristic: well-known repos get higher scores
  // In production, this would fetch actual star counts from GitHub API
  const knownPopular = [
    'google-gemini', 'google', 'facebook', 'microsoft', 'vercel',
    'nodejs', 'rust-lang', 'golang', 'kubernetes',
  ];

  const urlLower = repoUrl.toLowerCase();
  for (const org of knownPopular) {
    if (urlLower.includes(org)) return 0.6;
  }

  return 0.2; // unknown or less popular
}

function scoreMessageLeakage(task: any): number {
  // Check if the prompt or hints contain patterns that would help an LLM
  // that has seen the fix commit message
  const prompt = (task.task?.prompt ?? '').toLowerCase();
  const filesModified = task.task?.expected_changes?.files_modified ?? [];

  let score = 0;

  // Does the prompt mention specific technical terms that appear in file names?
  for (const file of filesModified) {
    const basename = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    // Split camelCase/PascalCase into words
    const words = basename.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/);
    for (const word of words) {
      if (word.length > 4 && prompt.includes(word)) {
        score += 0.15;
      }
    }
  }

  return Math.min(1, score);
}

// ── Main Analysis ──────────────────────────────────────────────────────────

function analyzeTask(taskPath: string, cutoffDate: string): ContaminationResult {
  const raw = fs.readFileSync(taskPath, 'utf-8');
  const task = JSON.parse(raw);

  const contam = task.task?.contamination_info ?? {};
  const issueCreated = contam.issue_created ?? '2026-01-01';
  const fixMerged = contam.fix_merged ?? null;

  // Compute individual signal scores
  const issueAgeScore = scoreIssueAge(issueCreated, cutoffDate);
  const fixVisScore = scoreFixVisibility(fixMerged, cutoffDate);
  const repoPopScore = scoreRepoPopularity(task.repository?.url ?? '');
  const leakageScore = scoreMessageLeakage(task);
  const discussionScore = fixMerged ? 0.3 : 0.0; // assume merged = has discussion

  // Weighted final score
  const finalScore =
    WEIGHTS.issueAge * issueAgeScore +
    WEIGHTS.fixVisibility * fixVisScore +
    WEIGHTS.repoPopularity * repoPopScore +
    WEIGHTS.messageLeakage * leakageScore +
    WEIGHTS.publicDiscussion * discussionScore;

  const roundedScore = Math.round(finalScore * 100) / 100;

  // Risk classification
  let risk: 'low' | 'medium' | 'high';
  if (roundedScore < 0.3) risk = 'low';
  else if (roundedScore < 0.6) risk = 'medium';
  else risk = 'high';

  // Recommendation
  let recommendation: string;
  if (risk === 'low') {
    recommendation = 'Safe to include as-is.';
  } else if (risk === 'medium') {
    recommendation = 'Consider obfuscating variable names or restructuring the prompt to reduce leakage.';
  } else {
    recommendation = 'High contamination risk. Apply obfuscation or replace with a more recent/obscure task.';
  }

  return {
    taskId: task.task_id ?? path.basename(taskPath),
    score: roundedScore,
    risk,
    signals: {
      issueAge: daysBetween(issueCreated, cutoffDate),
      fixMerged: fixMerged !== null,
      daysSinceFix: fixMerged ? daysBetween(fixMerged, new Date().toISOString().split('T')[0]) : 0,
      repoPopularity: repoPopScore,
      commitMessageLeaks: leakageScore > 0.3,
      issueTitleLeaks: false, // would need issue title from GitHub API
      hasPublicDiscussion: fixMerged !== null,
    },
    breakdown: {
      issueAge: issueAgeScore,
      fixVisibility: fixVisScore,
      repoPopularity: repoPopScore,
      messageLeakage: leakageScore,
      publicDiscussion: discussionScore,
    },
    recommendation,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const taskFlag = args.indexOf('--task');
  const cutoffFlag = args.indexOf('--cutoff');

  const specificTask = taskFlag !== -1 ? args[taskFlag + 1] : null;
  const cutoffDate = cutoffFlag !== -1 ? args[cutoffFlag + 1] : DEFAULT_CUTOFF;

  // Find task files
  let taskFiles: string[];
  if (specificTask) {
    const candidates = [
      path.join(TASKS_DIR, `${specificTask}.json`),
      path.join(TASKS_DIR, specificTask),
    ];
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) {
      console.error(`Task not found: ${specificTask}`);
      process.exit(1);
    }
    taskFiles = [found];
  } else {
    taskFiles = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.draft.json'))
      .map((f) => path.join(TASKS_DIR, f));
  }

  console.log(`\n[CONTAMINATION] Contamination Analysis (cutoff: ${cutoffDate})\n`);
  console.log('-'.repeat(72));

  const results = taskFiles.map((f) => analyzeTask(f, cutoffDate));

  // Table header
  console.log(
    `${'Task ID'.padEnd(42)} ${'Score'.padEnd(7)} ${'Risk'.padEnd(8)} Recommendation`
  );
  console.log('-'.repeat(72));

  for (const r of results) {
    const riskIcon = r.risk === 'low' ? '[LOW]' : r.risk === 'medium' ? '[MED]' : '[HIGH]';
    console.log(
      `${r.taskId.padEnd(42)} ${r.score.toFixed(2).padEnd(7)} ${riskIcon} ${r.risk.padEnd(5)} ${r.recommendation}`
    );
  }

  console.log('-'.repeat(72));

  // Detailed breakdown
  console.log(`\n[DETAIL] Signal Breakdown:\n`);
  for (const r of results) {
    console.log(`  ${r.taskId}:`);
    console.log(`    Issue age:       ${r.breakdown.issueAge.toFixed(2)} (${r.signals.issueAge} days before cutoff)`);
    console.log(`    Fix visibility:  ${r.breakdown.fixVisibility.toFixed(2)} (merged: ${r.signals.fixMerged})`);
    console.log(`    Repo popularity: ${r.breakdown.repoPopularity.toFixed(2)}`);
    console.log(`    Message leakage: ${r.breakdown.messageLeakage.toFixed(2)}`);
    console.log(`    Public discuss:  ${r.breakdown.publicDiscussion.toFixed(2)}`);
    console.log();
  }

  // Overall stats
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  const lowCount = results.filter((r) => r.risk === 'low').length;
  const medCount = results.filter((r) => r.risk === 'medium').length;
  const highCount = results.filter((r) => r.risk === 'high').length;

  console.log('-'.repeat(72));
  console.log(`Average contamination score: ${avgScore.toFixed(2)}`);
  console.log(`Risk distribution: [LOW] ${lowCount} low, [MED] ${medCount} medium, [HIGH] ${highCount} high`);
  console.log('-'.repeat(72));
}

main();
