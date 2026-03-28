#!/usr/bin/env npx tsx
/**
 * formulate.ts — Core algorithm: git diff → eval task JSON.
 *
 * This is the most critical piece of the curation pipeline. Given a git diff
 * (from a known bug fix), it reverse-engineers the task definition by:
 *
 *   1. Parsing the diff to extract files_modified
 *   2. Building a cross-reference graph via static import analysis
 *   3. Expanding files_must_read from the import graph (transitive closure)
 *   4. Computing the Reasoning Forcing Score (RFS)
 *   5. Generating a symptom-based prompt template (human review required)
 *   6. Scaffolding hint_levels from the diff metadata
 *   7. Computing difficulty metrics
 *   8. Outputting a draft task JSON for human validation
 *
 * Usage:
 *   npx tsx scripts/formulate.ts --repo <path> --diff <file.patch>
 *   npx tsx scripts/formulate.ts --repo <path> --commit <sha>
 *   npx tsx scripts/formulate.ts --repo <path> --commit <sha> --category bug_fix
 *
 * The output is a DRAFT — human review is required before inclusion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ── Types ──────────────────────────────────────────────────────────────────

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: string[];
}

interface ImportEdge {
  from: string;  // importer
  to: string;    // imported
}

interface CrossRefGraph {
  edges: ImportEdge[];
  adjacency: Map<string, Set<string>>;
  reverseAdjacency: Map<string, Set<string>>;
}

interface RFSComponents {
  filesMustRead: number;
  filesInDiff: number;
  crossReferences: number;
  backtracking: number;
  score: number;
}

interface DraftTask {
  schema_version: string;
  task_id: string;
  repository: {
    url: string;
    commit: string;
    languages: string[];
    size_files: number;
    size_lines: number;
    license: string;
  };
  task: {
    type: string;
    category: string;
    prompt: string;
    hint_levels: {
      symptom_only: string;
      file_hint: string;
      function_hint: string;
    };
    reasoning_forcing_score: number;
    context_pressure: string;
    difficulty: {
      files_involved: number;
      languages_required: number;
      reasoning_steps: number;
      context_depth: string;
      domain_knowledge: string;
      overall: number;
    };
    expected_changes: {
      files_modified: string[];
      files_must_read: string[];
      key_assertions: string[];
    };
    reasoning_chain: string[];
    contamination_info: {
      issue_created: string;
      fix_merged: string | null;
      training_cutoff_risk: string;
    };
  };
  eval_config: {
    timeout_ms: number;
    policy: string;
    setup: string;
    test_oracle: string | null;
  };
  _meta: {
    generated_by: string;
    requires_human_review: boolean;
    auto_confidence: number;
  };
}

// ── Diff Parsing ───────────────────────────────────────────────────────────

function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const block of fileBlocks) {
    const pathMatch = block.match(/^a\/(.+?) b\/(.+)/m);
    if (!pathMatch) continue;

    const filePath = pathMatch[2];
    const hunks = block.split(/^@@/m).slice(1);
    let additions = 0;
    let deletions = 0;

    for (const hunk of hunks) {
      const lines = hunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
    }

    files.push({
      path: filePath,
      additions,
      deletions,
      hunks: hunks.map((h) => h.split('\n').slice(0, 20).join('\n')), // truncate for analysis
    });
  }

  return files;
}

function getDiff(repoPath: string, commitOrPatch: string): string {
  if (fs.existsSync(commitOrPatch)) {
    return fs.readFileSync(commitOrPatch, 'utf-8');
  }
  // Treat as commit SHA
  return execSync(`git -C "${repoPath}" diff ${commitOrPatch}~1..${commitOrPatch}`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

// ── Import Graph Analysis ──────────────────────────────────────────────────

function buildImportGraph(repoPath: string, seedFiles: string[]): CrossRefGraph {
  const edges: ImportEdge[] = [];
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const queue = [...seedFiles];

  // TypeScript/JavaScript import patterns
  const importPatterns = [
    /import\s+.*?\s+from\s+['"](.+?)['"]/g,          // import X from 'Y'
    /import\s*\(\s*['"](.+?)['"]\s*\)/g,               // import('Y')
    /require\s*\(\s*['"](.+?)['"]\s*\)/g,              // require('Y')
    /import\s+['"](.+?)['"]/g,                          // import 'Y' (side-effect)
  ];

  const resolveImport = (fromFile: string, importPath: string): string | null => {
    if (importPath.startsWith('.')) {
      const dir = path.dirname(fromFile);
      const resolved = path.resolve(repoPath, dir, importPath);

      // Try common extensions
      const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        const candidate = resolved + ext;
        if (fs.existsSync(path.resolve(repoPath, candidate))) {
          return path.relative(repoPath, candidate);
        }
      }
    }
    return null; // external dependency or unresolvable
  };

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const absPath = path.resolve(repoPath, file);
    if (!fs.existsSync(absPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    for (const pattern of importPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const imported = resolveImport(file, match[1]);
        if (imported && imported !== file) {
          edges.push({ from: file, to: imported });

          if (!adjacency.has(file)) adjacency.set(file, new Set());
          adjacency.get(file)!.add(imported);

          if (!reverseAdjacency.has(imported)) reverseAdjacency.set(imported, new Set());
          reverseAdjacency.get(imported)!.add(file);

          // Expand to 1-hop neighbors only (2-hop would explode)
          if (!visited.has(imported) && queue.length < 50) {
            queue.push(imported);
          }
        }
      }
    }
  }

  return { edges, adjacency, reverseAdjacency };
}

// ── RFS Computation ────────────────────────────────────────────────────────

/**
 * Reasoning Forcing Score (RFS):
 *   RFS = (files_must_read - files_in_diff) × cross_references + backtracking
 *
 * - files_must_read: files the agent must read to understand the bug
 * - files_in_diff: files actually modified in the fix
 * - cross_references: import edges between files_must_read
 * - backtracking: estimated re-reads (files referenced from multiple contexts)
 */
function computeRFS(
  diffFiles: DiffFile[],
  graph: CrossRefGraph,
  filesMustRead: string[],
): RFSComponents {
  const filesInDiff = diffFiles.length;
  const mustReadCount = filesMustRead.length;
  const mustReadSet = new Set(filesMustRead);

  // Count cross-references within must-read set
  let crossRefs = 0;
  for (const file of filesMustRead) {
    const imports = graph.adjacency.get(file);
    if (imports) {
      for (const imp of imports) {
        if (mustReadSet.has(imp)) crossRefs++;
      }
    }
  }

  // Estimate backtracking: files that are imported by ≥2 other must-read files
  let backtracking = 0;
  for (const file of filesMustRead) {
    const importers = graph.reverseAdjacency.get(file);
    if (importers) {
      const relevantImporters = [...importers].filter((i) => mustReadSet.has(i));
      if (relevantImporters.length >= 2) backtracking++;
    }
  }

  const score = (mustReadCount - filesInDiff) * Math.max(1, crossRefs) + backtracking;

  return {
    filesMustRead: mustReadCount,
    filesInDiff,
    crossReferences: crossRefs,
    backtracking,
    score: Math.max(0, score),
  };
}

// ── Expand files_must_read ─────────────────────────────────────────────────

function expandFilesMustRead(
  diffFiles: DiffFile[],
  graph: CrossRefGraph,
): string[] {
  const mustRead = new Set(diffFiles.map((f) => f.path));

  // Add direct importers (who calls the modified files?)
  for (const file of diffFiles) {
    const importers = graph.reverseAdjacency.get(file.path);
    if (importers) {
      for (const importer of importers) {
        mustRead.add(importer);
      }
    }
  }

  // Add direct imports of modified files (what do they depend on?)
  for (const file of diffFiles) {
    const imports = graph.adjacency.get(file.path);
    if (imports) {
      for (const imp of imports) {
        mustRead.add(imp);
      }
    }
  }

  return [...mustRead].sort();
}

// ── Difficulty Computation ─────────────────────────────────────────────────

function computeDifficulty(
  diffFiles: DiffFile[],
  filesMustRead: string[],
  rfs: RFSComponents,
): DraftTask['task']['difficulty'] {
  const filesInvolved = filesMustRead.length;

  // Detect languages
  const extensions = new Set(filesMustRead.map((f) => path.extname(f).toLowerCase()));
  const langMap: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
    '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
  };
  const languages = new Set([...extensions].map((e) => langMap[e]).filter(Boolean));
  const languagesRequired = Math.max(1, languages.size);

  // Reasoning steps ≈ files_must_read + cross_references
  const reasoningSteps = Math.min(25, Math.max(2, filesInvolved + rfs.crossReferences));

  // Context depth based on file distribution
  let contextDepth: string;
  const packages = new Set(filesMustRead.map((f) => f.split('/').slice(0, 2).join('/')));
  if (packages.size > 1) contextDepth = 'cross_package';
  else if (filesMustRead.length > 1) contextDepth = 'cross_file';
  else if (rfs.crossReferences > 0) contextDepth = 'cross_function';
  else contextDepth = 'single_function';

  // Domain knowledge
  let domainKnowledge: string;
  if (packages.size > 2) domainKnowledge = 'architecture_level';
  else if (filesMustRead.some((f) => f.includes('config') || f.includes('plugin') || f.includes('extension')))
    domainKnowledge = 'framework_specific';
  else domainKnowledge = 'generic_coding';

  // Overall: weighted average (files_involved and reasoning_steps at 2x)
  const contextMap: Record<string, number> = {
    single_function: 1, cross_function: 2, cross_file: 3, cross_package: 4,
  };
  const domainMap: Record<string, number> = {
    generic_coding: 1, framework_specific: 2, architecture_level: 3,
  };
  const raw =
    (Math.min(filesInvolved, 50) / 10 * 2) +
    (languagesRequired) +
    (reasoningSteps / 5 * 2) +
    (contextMap[contextDepth] ?? 2) +
    (domainMap[domainKnowledge] ?? 2);
  const overall = Math.min(5, Math.max(1, Math.round(raw / 3)));

  return {
    files_involved: Math.min(50, filesInvolved),
    languages_required: languagesRequired,
    reasoning_steps: reasoningSteps,
    context_depth: contextDepth as any,
    domain_knowledge: domainKnowledge as any,
    overall,
  };
}

// ── Prompt Generation ──────────────────────────────────────────────────────

function generatePromptTemplate(
  diffFiles: DiffFile[],
  category: string,
): { prompt: string; hintLevels: DraftTask['task']['hint_levels'] } {
  const fileNames = diffFiles.map((f) => path.basename(f.path)).join(', ');
  const dirNames = [...new Set(diffFiles.map((f) => path.dirname(f.path)))].join(', ');

  // Category-specific symptom templates
  const symptomTemplates: Record<string, string> = {
    unbounded_growth: `The application's memory usage grows without bound during [DESCRIBE SCENARIO]. After running for [DURATION], the process crashes with an out-of-memory error. Investigate the memory growth pattern and identify the data structure that lacks proper size limits.`,
    race_condition: `Under concurrent load, [DESCRIBE INTERMITTENT BEHAVIOR]. The issue is non-deterministic and harder to reproduce with single-threaded execution. Investigate the shared state and identify the unsynchronized access pattern.`,
    silent_failure: `[DESCRIBE EXPECTED BEHAVIOR] but instead [DESCRIBE ACTUAL BEHAVIOR] with no error messages or warnings in the output. The operation appears to succeed but the expected side effects don't occur. Investigate the error handling and identify where errors are being swallowed.`,
    error_recovery: `When [DESCRIBE ERROR CONDITION] occurs, the system does not recover gracefully. Instead of [EXPECTED RECOVERY], it [ACTUAL BEHAVIOR]. Investigate the error recovery path and fix the incomplete cleanup.`,
    cross_component_bug: `[DESCRIBE SYMPTOM VISIBLE IN COMPONENT A] but the root cause is in [GENERAL AREA B]. The bug manifests when [TRIGGER CONDITION]. Trace the data flow across components to find and fix the root cause.`,
    resource_leak: `After repeated [OPERATIONS], system resources (file handles / connections / memory) are not properly released. The leak accumulates over time and eventually causes [FAILURE MODE]. Investigate the resource lifecycle and ensure proper cleanup.`,
    refactoring: `The current implementation of [FEATURE] has [QUALITY ISSUE]. Refactor the code to [GOAL] while maintaining backward compatibility and ensuring all existing tests continue to pass.`,
    feature_addition: `Add support for [FEATURE] that integrates with the existing [SYSTEM]. The implementation should [REQUIREMENTS]. Ensure the new feature follows existing patterns and is properly tested.`,
    cross_component_feature_integration: `Integrate [FEATURE] across [COMPONENTS]. The feature requires coordinated changes in [AREAS] to [ACHIEVE GOAL]. Ensure consistency across all integration points.`,
  };

  const prompt = symptomTemplates[category] ??
    `[DESCRIBE OBSERVABLE SYMPTOM WITHOUT REVEALING ROOT CAUSE]. Investigate and fix the issue.`;

  return {
    prompt,
    hintLevels: {
      symptom_only: `[DESCRIBE SYMPTOM ONLY — NO FILE NAMES OR FUNCTION NAMES]`,
      file_hint: `The issue is in ${dirNames}. Look at how ${fileNames} handles [SPECIFIC OPERATION].`,
      function_hint: `[NAME SPECIFIC FUNCTION AND LINE NUMBER WHERE THE BUG IS]`,
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf('--repo');
  const diffIdx = args.indexOf('--diff');
  const commitIdx = args.indexOf('--commit');
  const categoryIdx = args.indexOf('--category');

  if (repoIdx === -1 || (diffIdx === -1 && commitIdx === -1)) {
    console.error('Usage: npx tsx scripts/formulate.ts --repo <path> --commit <sha> [--category <type>]');
    console.error('       npx tsx scripts/formulate.ts --repo <path> --diff <file.patch> [--category <type>]');
    process.exit(1);
  }

  const repoPath = path.resolve(args[repoIdx + 1]);
  const commitOrPatch = args[diffIdx !== -1 ? diffIdx + 1 : commitIdx + 1];
  const category = categoryIdx !== -1 ? args[categoryIdx + 1] : 'bug_fix';

  console.log(`\n📝 Formulating task from ${commitOrPatch}...\n`);

  // Step 1: Parse diff
  const diffText = getDiff(repoPath, commitOrPatch);
  const diffFiles = parseDiff(diffText);
  console.log(`  Files in diff: ${diffFiles.length}`);
  for (const f of diffFiles) {
    console.log(`    ${f.path} (+${f.additions} -${f.deletions})`);
  }

  // Step 2: Build import graph
  console.log(`\n  Building import graph...`);
  const graph = buildImportGraph(repoPath, diffFiles.map((f) => f.path));
  console.log(`    Edges: ${graph.edges.length}`);

  // Step 3: Expand files_must_read
  const filesMustRead = expandFilesMustRead(diffFiles, graph);
  console.log(`    files_must_read: ${filesMustRead.length}`);

  // Step 4: Compute RFS
  const rfs = computeRFS(diffFiles, graph, filesMustRead);
  console.log(`\n  RFS Components:`);
  console.log(`    files_must_read: ${rfs.filesMustRead}`);
  console.log(`    files_in_diff: ${rfs.filesInDiff}`);
  console.log(`    cross_references: ${rfs.crossReferences}`);
  console.log(`    backtracking: ${rfs.backtracking}`);
  console.log(`    SCORE: ${rfs.score}`);

  if (rfs.score < 3) {
    console.warn(`\n  ⚠️  RFS ${rfs.score} < 3 — this task may not require long-context reasoning.`);
    console.warn(`     Consider including more context files or choosing a more complex bug.\n`);
  }

  // Step 5: Compute difficulty
  const difficulty = computeDifficulty(diffFiles, filesMustRead, rfs);

  // Step 6: Generate prompt template
  const { prompt, hintLevels } = generatePromptTemplate(diffFiles, category);

  // Step 7: Get repo metadata
  let repoUrl = '';
  let commitSha = '';
  try {
    repoUrl = execSync(`git -C "${repoPath}" remote get-url origin`, { encoding: 'utf-8' }).trim();
    commitSha = commitOrPatch.length === 40
      ? commitOrPatch
      : execSync(`git -C "${repoPath}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
  } catch {
    repoUrl = 'https://github.com/OWNER/REPO';
    commitSha = '0'.repeat(40);
  }

  // Step 8: Assemble draft task
  const repoSlug = repoUrl.split('/').slice(-1)[0].replace('.git', '');
  const taskId = `${repoSlug}-SLUG-000`;

  const draft: DraftTask = {
    schema_version: '1.0.0',
    task_id: taskId,
    repository: {
      url: repoUrl.replace(/\.git$/, ''),
      commit: commitSha,
      languages: [...new Set(filesMustRead.map((f) => {
        const ext = path.extname(f);
        const map: Record<string, string> = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript' };
        return map[ext] ?? ext;
      }))].filter(Boolean),
      size_files: 0,  // Fill in manually
      size_lines: 0,  // Fill in manually
      license: 'Apache-2.0',
    },
    task: {
      type: category.includes('fix') ? 'bug_fix' : category as any,
      category: category as any,
      prompt,
      hint_levels: hintLevels,
      reasoning_forcing_score: rfs.score,
      context_pressure: rfs.score >= 8 ? 'high' : rfs.score >= 5 ? 'medium' : 'low',
      difficulty,
      expected_changes: {
        files_modified: diffFiles.map((f) => f.path),
        files_must_read: filesMustRead,
        key_assertions: [], // Fill in manually
      },
      reasoning_chain: [
        `Read the symptom and identify the affected subsystem`,
        ...filesMustRead.map((f) => `Read ${f} to understand its role`),
        `Identify the root cause by tracing cross-references`,
        `Apply the fix to ${diffFiles.map((f) => f.path).join(', ')}`,
      ],
      contamination_info: {
        issue_created: new Date().toISOString().split('T')[0],
        fix_merged: null,
        training_cutoff_risk: 'low',
      },
    },
    eval_config: {
      timeout_ms: 300000,
      policy: 'USUALLY_PASSES',
      setup: 'sparse_clone',
      test_oracle: null,
    },
    _meta: {
      generated_by: 'formulate.ts v1.0.0',
      requires_human_review: true,
      auto_confidence: Math.min(1, rfs.score / 10),
    },
  };

  // Output
  const outputPath = path.join(
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))),
    '..',
    'dataset',
    'tasks',
    `${taskId}.draft.json`,
  );

  const json = JSON.stringify(draft, null, 2);
  fs.writeFileSync(outputPath, json, 'utf-8');

  console.log(`\n  ✅ Draft written to: ${outputPath}`);
  console.log(`\n  ⚠️  HUMAN REVIEW REQUIRED:`);
  console.log(`     1. Replace template placeholders in prompt and hint_levels`);
  console.log(`     2. Fill in key_assertions with expected diff patterns`);
  console.log(`     3. Set repository.size_files and repository.size_lines`);
  console.log(`     4. Update task_id slug and number`);
  console.log(`     5. Verify reasoning_chain covers actual reasoning path`);
  console.log(`     6. Run: npx tsx scripts/validate.ts --task ${taskId}.draft`);
  console.log();
}

main();
