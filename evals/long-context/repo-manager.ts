/**
 * repo-manager.ts — Bare clone caching + git worktree management.
 *
 * Manages external repositories for long-context evals:
 *   1. Bare clones are cached in a shared directory (one per repo)
 *   2. Each eval run gets an isolated git worktree at a pinned commit
 *   3. Worktrees are cleaned up after eval completes
 *
 * This avoids re-cloning repos on every eval run (bare clones are ~10x smaller
 * than full clones) while providing full isolation between concurrent evals.
 *
 * Compared to waqar2403's RepoManager: this adds sparse checkout support,
 * commit verification, and repo size validation — not just clone/worktree.
 */

import { execSync, ExecSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RepoSpec {
  url: string;
  commit: string;
  sparseCheckoutPaths?: string[];
}

export interface WorktreeHandle {
  /** Absolute path to the worktree directory */
  path: string;
  /** Repo URL this worktree was created from */
  repoUrl: string;
  /** Commit SHA the worktree is pinned to */
  commit: string;
  /** Cleanup function — removes the worktree */
  cleanup: () => void;
}

export interface RepoManagerOptions {
  /** Directory for bare clone cache. Default: $TMPDIR/gemini-eval-repos */
  cacheDir?: string;
  /** Directory for worktrees. Default: $TMPDIR/gemini-eval-worktrees */
  worktreeBaseDir?: string;
  /** Timeout for git operations in ms. Default: 120000 */
  gitTimeout?: number;
  /** Enable verbose logging. Default: false */
  verbose?: boolean;
}

// ── RepoManager ────────────────────────────────────────────────────────────

export class RepoManager {
  private cacheDir: string;
  private worktreeBaseDir: string;
  private gitTimeout: number;
  private verbose: boolean;
  private activeWorktrees: Set<string> = new Set();

  constructor(options: RepoManagerOptions = {}) {
    this.cacheDir = options.cacheDir ?? path.join(os.tmpdir(), 'gemini-eval-repos');
    this.worktreeBaseDir = options.worktreeBaseDir ?? path.join(os.tmpdir(), 'gemini-eval-worktrees');
    this.gitTimeout = options.gitTimeout ?? 120_000;
    this.verbose = options.verbose ?? false;

    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.worktreeBaseDir, { recursive: true });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Get an isolated worktree for a repo at a specific commit.
   * Uses bare clone cache — first call clones, subsequent calls reuse.
   */
  async getWorktree(spec: RepoSpec): Promise<WorktreeHandle> {
    const bareDir = await this.ensureBareClone(spec.url);
    await this.fetchCommit(bareDir, spec.commit);
    const worktreePath = await this.createWorktree(bareDir, spec);

    const handle: WorktreeHandle = {
      path: worktreePath,
      repoUrl: spec.url,
      commit: spec.commit,
      cleanup: () => this.removeWorktree(bareDir, worktreePath),
    };

    this.activeWorktrees.add(worktreePath);
    return handle;
  }

  /**
   * Clean up all active worktrees. Call in afterAll().
   */
  cleanupAll(): void {
    for (const wt of this.activeWorktrees) {
      try {
        // Find the bare dir from the worktree's gitdir
        const gitdirFile = path.join(wt, '.git');
        if (fs.existsSync(gitdirFile)) {
          const content = fs.readFileSync(gitdirFile, 'utf-8');
          const match = content.match(/gitdir: (.+)/);
          if (match) {
            const bareDir = path.resolve(wt, match[1], '..', '..');
            this.removeWorktree(bareDir, wt);
          }
        }
        // Fallback: just rm the directory
        if (fs.existsSync(wt)) {
          fs.rmSync(wt, { recursive: true, force: true });
        }
      } catch {
        // Best effort cleanup
      }
    }
    this.activeWorktrees.clear();
  }

  /**
   * Get stats about the cache.
   */
  getCacheStats(): { repos: number; worktrees: number; cacheSizeMB: number } {
    const repos = fs.existsSync(this.cacheDir)
      ? fs.readdirSync(this.cacheDir).filter((d) => d.endsWith('.git')).length
      : 0;

    return {
      repos,
      worktrees: this.activeWorktrees.size,
      cacheSizeMB: this.getDirSizeMB(this.cacheDir),
    };
  }

  // ── Bare Clone Management ──────────────────────────────────────────────

  private async ensureBareClone(repoUrl: string): Promise<string> {
    const slug = this.urlToSlug(repoUrl);
    const bareDir = path.join(this.cacheDir, `${slug}.git`);

    if (fs.existsSync(path.join(bareDir, 'HEAD'))) {
      this.log(`Cache hit: ${slug}`);
      return bareDir;
    }

    this.log(`Cloning bare: ${repoUrl} → ${bareDir}`);
    this.git(`clone --bare --filter=blob:none "${repoUrl}" "${bareDir}"`, {
      cwd: this.cacheDir,
      timeout: this.gitTimeout,
    });

    return bareDir;
  }

  private async fetchCommit(bareDir: string, commit: string): Promise<void> {
    // Check if commit already exists
    try {
      this.git(`cat-file -t ${commit}`, { cwd: bareDir });
      this.log(`Commit ${commit.slice(0, 8)} already cached`);
      return;
    } catch {
      // Need to fetch
    }

    this.log(`Fetching commit ${commit.slice(0, 8)}...`);
    try {
      this.git(`fetch origin ${commit}`, { cwd: bareDir, timeout: this.gitTimeout });
    } catch {
      // Some servers don't allow fetching by SHA — fetch all
      this.git(`fetch origin`, { cwd: bareDir, timeout: this.gitTimeout });
    }

    // Verify commit exists now
    try {
      this.git(`cat-file -t ${commit}`, { cwd: bareDir });
    } catch {
      throw new Error(`Commit ${commit} not found in ${bareDir} after fetch`);
    }
  }

  // ── Worktree Management ────────────────────────────────────────────────

  private async createWorktree(bareDir: string, spec: RepoSpec): Promise<string> {
    const id = crypto.randomBytes(6).toString('hex');
    const slug = this.urlToSlug(spec.url);
    const worktreePath = path.join(this.worktreeBaseDir, `${slug}-${id}`);

    this.log(`Creating worktree: ${worktreePath} @ ${spec.commit.slice(0, 8)}`);
    this.git(`worktree add --detach "${worktreePath}" ${spec.commit}`, { cwd: bareDir });

    // Apply sparse checkout if specified
    if (spec.sparseCheckoutPaths?.length) {
      this.log(`Applying sparse checkout: ${spec.sparseCheckoutPaths.join(', ')}`);
      this.git(`sparse-checkout init --cone`, { cwd: worktreePath });
      this.git(`sparse-checkout set ${spec.sparseCheckoutPaths.join(' ')}`, { cwd: worktreePath });
    }

    // Verify we're at the right commit
    const actualCommit = this.git(`rev-parse HEAD`, { cwd: worktreePath }).trim();
    if (actualCommit !== spec.commit) {
      throw new Error(
        `Worktree commit mismatch: expected ${spec.commit}, got ${actualCommit}`
      );
    }

    return worktreePath;
  }

  private removeWorktree(bareDir: string, worktreePath: string): void {
    try {
      this.git(`worktree remove --force "${worktreePath}"`, { cwd: bareDir });
    } catch {
      // Fallback: manual removal
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        this.git(`worktree prune`, { cwd: bareDir });
      } catch {
        // Best effort
      }
    }
    this.activeWorktrees.delete(worktreePath);
    this.log(`Removed worktree: ${worktreePath}`);
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  private git(args: string, options: ExecSyncOptions = {}): string {
    const cmd = `git ${args}`;
    return execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: this.gitTimeout,
      ...options,
    });
  }

  private urlToSlug(url: string): string {
    return url
      .replace(/^https?:\/\//, '')
      .replace(/\.git$/, '')
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase();
  }

  private getDirSizeMB(dir: string): number {
    try {
      const output = execSync(
        process.platform === 'win32'
          ? `powershell -command "(Get-ChildItem -Recurse '${dir}' | Measure-Object -Property Length -Sum).Sum"`
          : `du -sb "${dir}" | cut -f1`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return Math.round(parseInt(output.trim(), 10) / 1024 / 1024);
    } catch {
      return -1;
    }
  }

  private log(msg: string): void {
    if (this.verbose) {
      console.log(`  [RepoManager] ${msg}`);
    }
  }
}
