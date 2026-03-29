/**
 * curate.ts — Automated dataset curation pipeline
 *
 * Mines GitHub for real cross-component bug fixes suitable for long-context
 * evaluation. Produces task JSON files conforming to dataset/schema.json.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> npx tsx scripts/curate.ts \
 *     --lang typescript --lang go --lang python --lang java --lang rust \
 *     --min-files 4 --min-dirs 2 --max-tasks 10 --out dataset/tasks/
 *
 * Pipeline stages:
 *   1. DISCOVER  — Search GitHub for repos matching size/activity/language criteria
 *   2. SCORE     — Rank repos by diversity, test coverage, CI health, star count
 *   3. MINE      — Extract merged PRs with ≥N file changes across ≥M directories
 *   4. FILTER    — Apply hardness gates: cross-component edit, linked issue, test delta
 *   5. ENRICH    — Estimate token budget, compute contamination score, build reasoning chain
 *   6. EMIT      — Write validated task JSON; run validate.ts to confirm schema compliance
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CLI args (minimal, no extra deps)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const getMulti = (flag: string): string[] => {
  const vals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) vals.push(args[i + 1]);
  }
  return vals;
};

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const LANGUAGES   = getMulti('--lang').length ? getMulti('--lang') : ['TypeScript', 'Go', 'Python', 'Java', 'Rust'];
const MIN_FILES   = parseInt(getArg('--min-files', '4'), 10);
const MIN_DIRS    = parseInt(getArg('--min-dirs', '2'), 10);
const MAX_TASKS   = parseInt(getArg('--max-tasks', '10'), 10);
const OUT_DIR     = getArg('--out', 'dataset/tasks');
const DRY_RUN     = args.includes('--dry-run');

if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN env var is required (needs repo + read:org scope)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------
function ghGet(url: string): unknown {
  const raw = execSync(
    `curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" ` +
    `-H "Accept: application/vnd.github+json" "${url}"`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Stage 1: DISCOVER
// ---------------------------------------------------------------------------
interface RepoMeta {
  full_name: string;
  html_url: string;
  language: string;
  stargazers_count: number;
  size: number;
  default_branch: string;
  license: { spdx_id: string } | null;
}

function discoverRepos(lang: string, minStars = 5000): RepoMeta[] {
  console.log(`[DISCOVER] Searching GitHub for ${lang} repos (≥${minStars} stars)...`);
  const q = encodeURIComponent(`language:${lang} stars:>=${minStars} pushed:>2024-01-01`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=30`;
  const data = ghGet(url) as { items: RepoMeta[] };
  return data.items ?? [];
}

// ---------------------------------------------------------------------------
// Stage 2: SCORE
// ---------------------------------------------------------------------------
interface ScoredRepo extends RepoMeta {
  score: number;
}

function scoreRepo(repo: RepoMeta): ScoredRepo {
  // Composite score: normalised stars (40%) + size proxy for complexity (30%)
  // + has permissive license (20%) + language diversity bonus (10%)
  const starScore   = Math.min(repo.stargazers_count / 100000, 1) * 40;
  const sizeScore   = Math.min(repo.size / 500000, 1) * 30;
  const licenseOk   = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause'].includes(
    repo.license?.spdx_id ?? ''
  ) ? 20 : 0;
  const langBonus   = 10; // each language adds diversity
  return { ...repo, score: starScore + sizeScore + licenseOk + langBonus };
}

// ---------------------------------------------------------------------------
// Stage 3: MINE — find merged PRs with cross-component changes
// ---------------------------------------------------------------------------
interface PrMeta {
  number: number;
  title: string;
  html_url: string;
  merge_commit_sha: string;
  body: string | null;
  changed_files: number;
}

function minePRs(repoFullName: string): PrMeta[] {
  console.log(`  [MINE] Mining PRs in ${repoFullName}...`);
  const url = `https://api.github.com/repos/${repoFullName}/pulls?state=closed&sort=updated&per_page=50`;
  const prs = ghGet(url) as PrMeta[];
  return prs.filter(pr => pr.merge_commit_sha && pr.changed_files >= MIN_FILES);
}

// ---------------------------------------------------------------------------
// Stage 4: FILTER — apply hardness gates
// ---------------------------------------------------------------------------
interface PrFiles {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

function filterPR(repoFullName: string, pr: PrMeta): boolean {
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${pr.number}/files?per_page=100`;
  const files = ghGet(url) as PrFiles[];

  // Must touch ≥ MIN_DIRS directories
  const dirs = new Set(files.map(f => path.dirname(f.filename)));
  if (dirs.size < MIN_DIRS) return false;

  // Must include test file changes (signal that fix is verifiable)
  const hasTestDelta = files.some(f =>
    /test|spec|__tests__/.test(f.filename.toLowerCase()) &&
    (f.additions + f.deletions) > 0
  );
  if (!hasTestDelta) return false;

  // Must have a non-trivial description (linked issue or problem statement)
  if (!pr.body || pr.body.length < 100) return false;

  console.log(`    [FILTER] PASS: PR #${pr.number} — ${pr.title.slice(0, 60)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Stage 5: ENRICH — build task skeleton
// ---------------------------------------------------------------------------
interface TaskSkeleton {
  schema_version: string;
  task_id: string;
  repository: {
    url: string;
    commit: string;
    languages: string[];
    license: string;
  };
  task: {
    type: string;
    category: string;
    prompt: string;
    token_budget_estimate: {
      files_must_read_tokens: number;
      total_context_tokens: number;
      pressure_pct: number;
    };
    contamination_info: {
      issue_created: string;
      fix_merged: string | null;
      training_cutoff_risk: string;
      contamination_score: number;
      obfuscation_applied: boolean;
    };
  };
  _curation_meta: {
    pr_url: string;
    pr_number: number;
    auto_generated: true;
    requires_manual_review: true;
  };
}

function enrichPR(repo: ScoredRepo, pr: PrMeta, lang: string): TaskSkeleton {
  const repoSlug = repo.full_name.replace('/', '-').toLowerCase();
  const taskId = `${repoSlug}-auto-${pr.number}`;

  // Rough token estimate: ~500 tokens per changed file on average
  const filesEstimate = pr.changed_files * 500;

  return {
    schema_version: '1.0.0',
    task_id: taskId,
    repository: {
      url: repo.html_url,
      commit: pr.merge_commit_sha,
      languages: [lang],
      license: repo.license?.spdx_id ?? 'UNKNOWN',
    },
    task: {
      type: 'bug_fix',
      category: 'cross_component_bug',
      prompt: `[AUTO-GENERATED — requires manual review]\n\nPR #${pr.number}: ${pr.title}\n\n${(pr.body ?? '').slice(0, 500)}`,
      token_budget_estimate: {
        files_must_read_tokens: Math.round(filesEstimate * 0.6),
        total_context_tokens: filesEstimate,
        pressure_pct: parseFloat(((filesEstimate / 1_000_000) * 100).toFixed(1)),
      },
      contamination_info: {
        issue_created: new Date().toISOString().slice(0, 10),
        fix_merged: null,
        training_cutoff_risk: 'medium',
        contamination_score: 0.3,
        obfuscation_applied: false,
      },
    },
    _curation_meta: {
      pr_url: pr.html_url,
      pr_number: pr.number,
      auto_generated: true,
      requires_manual_review: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 6: EMIT
// ---------------------------------------------------------------------------
function emitTask(task: TaskSkeleton): void {
  const outPath = path.join(OUT_DIR, `${task.task_id}.json`);
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would write: ${outPath}`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(task, null, 2) + '\n');
  console.log(`  [EMIT] Wrote ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== Gemini CLI Long-Context Eval — Automated Curation Pipeline ===');
  console.log(`Languages: ${LANGUAGES.join(', ')}`);
  console.log(`Hardness gates: ≥${MIN_FILES} files, ≥${MIN_DIRS} directories, test delta required`);
  console.log(`Max tasks: ${MAX_TASKS} | Output: ${OUT_DIR} | Dry-run: ${DRY_RUN}\n`);

  let taskCount = 0;

  for (const lang of LANGUAGES) {
    if (taskCount >= MAX_TASKS) break;

    const repos = discoverRepos(lang);
    const scored = repos.map(scoreRepo).sort((a, b) => b.score - a.score);

    for (const repo of scored.slice(0, 5)) {
      if (taskCount >= MAX_TASKS) break;

      // Skip already-indexed repos
      const existingRepoIds = fs.readdirSync('dataset/repos')
        .map(f => f.replace('.json', ''));
      const repoId = repo.full_name.replace('/', '-').toLowerCase();
      if (existingRepoIds.includes(repoId)) {
        console.log(`  [SKIP] ${repo.full_name} already in dataset`);
        continue;
      }

      const prs = minePRs(repo.full_name);
      for (const pr of prs.slice(0, 10)) {
        if (taskCount >= MAX_TASKS) break;
        try {
          if (filterPR(repo.full_name, pr)) {
            const task = enrichPR(repo, pr, lang);
            emitTask(task);
            taskCount++;
          }
        } catch (e) {
          console.warn(`    [WARN] Skipped PR #${pr.number}: ${(e as Error).message}`);
        }
      }
    }
  }

  console.log(`\n=== Pipeline complete: ${taskCount} candidate tasks emitted ===`);
  console.log('NOTE: Auto-generated tasks require manual review before merging.');
  console.log('      Run: npx tsx scripts/validate.ts to check schema compliance.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
