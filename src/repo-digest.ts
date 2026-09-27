import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

/** A lightweight entry from a git ls-tree listing. */
interface TreeEntry { mode: string; type: string; objectId: string; path: string; }

/** Options for building a repository digest. */
export interface RepoDigestOptions {
  repoPath: string;
  commit: string; // full 40-char SHA
  allowedScope: string[];
  keywords?: string[];
  maxBytes?: number; // default 24 * 1024
}

/** Result of building a repository digest. */
export interface RepoDigestResult {
  text: string;
  commit: string;
}

const SHA = /^[0-9a-f]{40,64}$/i;
const LOCKFILE_PATTERN = /(?:^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock|\.lock)$/;
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|otf|eot|mp3|mp4|webm|ogg|wav|pdf|zip|tar|gz|bz2|xz|7z|rar|exe|dll|so|dylib|bin|dat|db|sqlite|sqlite3)$/i;
const SKIP_DIRS = /^(?:node_modules|dist|build|\.git|coverage|\.next|\.nuxt|__pycache__|\.mypy_cache|\.pytest_cache|vendor|\.vendor)(?:\/|$)/;

const decoder = new TextDecoder('utf-8', { fatal: false });

async function gitCommand(repoPath: string, args: string[], timeoutMs = 15_000, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const child = spawn('git', ['-C', repoPath, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`git ${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) { child.kill(); reject(new Error(`git output size limit exceeded: ${args[0]}`)); return; }
      chunks.push(chunk);
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); code === 0 || code === null ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args[0]} exited ${code}`)); });
  });
}

/** Returns a sort key for keyword search priority: 0=source, 1=generic, 2=tests, 3=docs/markdown */
function keywordSearchPriority(path: string): number {
  if (/^(?:nodes|src|lib|packages|pkg)(?:\/|$)/.test(path)) return 0;
  if (/^(?:test|tests|spec|__tests__|fixtures?)(?:\/|$)/i.test(path)) return 2;
  if (/^(?:docs?|documentation|markdown)(?:\/|$)/i.test(path) || /\.md$/i.test(path)) return 3;
  return 1;
}

function scopeContainsPath(path: string, scope: readonly string[]): boolean {
  return scope.some(s => s.endsWith('/') ? path.startsWith(s) : path === s || path.startsWith(s + '/'));
}

function parseTree(buf: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const text = buf.toString('ascii');
  for (const record of text.split('\0')) {
    if (!record.trim()) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab), path = record.slice(tab + 1);
    const parts = meta.split(' ');
    if (parts.length < 3) continue;
    entries.push({ mode: parts[0]!, type: parts[1]!, objectId: parts[2]!, path });
  }
  return entries;
}

/**
 * Extract up to `max` distinctive keywords from human text for keyword search.
 * Favours identifiers, acronyms, and tokens with digits; excludes generic
 * request/project vocabulary that would produce noisy git-grep results.
 */
export function extractKeywords(text: string, max = 8): string[] {
  // Extended stopwords: generic request phrases + original programming terms
  const stopwords = new Set(['this','that','with','from','have','will','they','them','been','some','what','when','your','which','their','there','then','than','into','over','also','more','would','could','should','these','those','about','after','before','using','based','need','task','file','path','type','name','data','list','does','make','each','just','only','work','return','value','first','second','third','false','true','null','void','const','function','interface','class','export','import','async','await','like','add','want','please','repo','repository','project','node','community','code','feature','update','change','fix','support','request','create','write','build','help','need','want','able','want','like','use','used','used']);
  // Token patterns in priority order:
  // 1. ALL-CAPS acronyms 2-5 chars (NBA, API, HTTP, etc.)
  // 2. Mixed-case with digits like n8n, vue3, react18
  // 3. camelCase / PascalCase identifiers (4+ chars)
  // 4. snake_case or dotted filenames
  // 5. Longer plain words (4+ chars)
  const acronyms: string[] = [];
  const withDigits: string[] = [];
  const identifiers: string[] = [];
  const plain: string[] = [];
  // Extract all word-like tokens and dotted filenames
  const raw = text.match(/\b[A-Za-z0-9][-A-Za-z0-9_.]{1,}[A-Za-z0-9]\b|\b[A-Za-z][A-Za-z0-9_]{1,}\b|\b[A-Z]{2,5}\b/g) ?? [];
  const seen = new Set<string>();
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (seen.has(lower) || stopwords.has(lower)) continue;
    if (/^[A-Z]{2,5}$/.test(t)) { acronyms.push(t); seen.add(lower); }
    else if (/[0-9]/.test(t) && t.length >= 2) { withDigits.push(t); seen.add(lower); }
    else if (t.length >= 4 && (/[A-Z]/.test(t.slice(1)) || t.includes('_') || t.includes('.'))) { identifiers.push(t); seen.add(lower); }
    else if (t.length >= 4) { plain.push(t); seen.add(lower); }
  }
  return [...acronyms, ...withDigits, ...identifiers, ...plain].slice(0, max);
}

/** Build a bounded repo digest from the git tree at `commit`. */
export async function buildRepoDigest(options: RepoDigestOptions): Promise<RepoDigestResult> {
  const { repoPath, allowedScope, keywords = [], maxBytes = 24 * 1024 } = options;
  if (!SHA.test(options.commit)) throw new Error('buildRepoDigest requires a full commit SHA');
  const commit = options.commit.toLowerCase();

  // Get full file listing
  const treeBuffer = await gitCommand(repoPath, ['ls-tree', '-rz', '--full-tree', commit], 15_000, 16 * 1024 * 1024);
  const allEntries = parseTree(treeBuffer).filter(e => e.type === 'blob' && !SKIP_DIRS.test(e.path));

  // Filter to allowed scope
  const scopedEntries = allowedScope.length ? allEntries.filter(e => scopeContainsPath(e.path, allowedScope)) : allEntries;

  const parts: string[] = [];
  let usedBytes = 0;

  function addSection(text: string): boolean {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (usedBytes + bytes > maxBytes) return false;
    parts.push(text);
    usedBytes += bytes;
    return true;
  }

  // --- File tree (paths only, depth-limited with counts) ---
  const treeText = buildTreeListing(scopedEntries, 400);
  addSection(`## Repository file tree (allowed scope: ${allowedScope.join(', ') || 'all'})\n${treeText}\n`);

  // --- package.json ---
  const pkgEntry = allEntries.find(e => e.path === 'package.json');
  if (pkgEntry) {
    try {
      const raw = await gitCommand(repoPath, ['cat-file', 'blob', pkgEntry.objectId], 8_000, 64 * 1024);
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      const scripts = parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts as object).join(', ') : '';
      const deps = parsed.dependencies && typeof parsed.dependencies === 'object' ? Object.keys(parsed.dependencies as object).join(', ') : '';
      const devDeps = parsed.devDependencies && typeof parsed.devDependencies === 'object' ? Object.keys(parsed.devDependencies as object).join(', ') : '';
      const pkgSummary = `## package.json summary\nname: ${name}\nscripts: ${scripts||'(none)'}\ndependencies: ${deps||'(none)'}\ndevDependencies: ${devDeps||'(none)'}\n`;
      addSection(pkgSummary);
    } catch { /* skip if parse fails */ }
  }

  // --- README first ~60 lines ---
  const readmeEntry = allEntries.find(e => /^README(?:\.[a-z]+)?$/i.test(e.path));
  if (readmeEntry) {
    try {
      const raw = await gitCommand(repoPath, ['cat-file', 'blob', readmeEntry.objectId], 8_000, 32 * 1024);
      const lines = decoder.decode(raw).split('\n').slice(0, 60).join('\n');
      addSection(`## ${readmeEntry.path} (first 60 lines)\n${lines}\n`);
    } catch { /* skip */ }
  }

  // --- Keyword search (source-first, rarity-weighted, per-file capped, round-robin) ---
  if (keywords.length) {
    const kwRaw = keywords.slice(0, 8).filter(k => k.length >= 2).map(k => k.toLowerCase());
    if (kwRaw.length) {
      // Sort: source code first, then generic files, then tests, then docs/markdown
      const candidates = scopedEntries
        .filter(e => !LOCKFILE_PATTERN.test(e.path) && !BINARY_EXT.test(e.path))
        .sort((a, b) => keywordSearchPriority(a.path) - keywordSearchPriority(b.path));
      const maxFilesToRead = 80;
      const maxFileBytes = 32 * 1024;
      const maxHitBytes = Math.min(6 * 1024, Math.max(0, maxBytes - usedBytes - 200));
      const MAX_PER_FILE = 6;
      const MAX_PER_FILE_PER_KW = 3;
      const IMPORT_LINE = /^\s*(?:import|require|export\s+(?:\*|{[^}]*})\s+from)\s/;

      // --- Pass 1: document-frequency scan (read up to maxFilesToRead files) ---
      interface CachedFile { path: string; objectId: string; lines: string[] }
      const fileCache: CachedFile[] = [];
      const dfCount = new Map<string, number>(); // keyword → number of files it appears in
      for (const entry of candidates.slice(0, maxFilesToRead * 2)) {
        if (fileCache.length >= maxFilesToRead) break;
        try {
          const raw = await gitCommand(repoPath, ['cat-file', 'blob', entry.objectId], 5_000, maxFileBytes);
          const text = decoder.decode(raw);
          const lines = text.split('\n');
          fileCache.push({ path: entry.path, objectId: entry.objectId, lines });
          const lower = text.toLowerCase();
          for (const k of kwRaw) { if (lower.includes(k)) dfCount.set(k, (dfCount.get(k) ?? 0) + 1); }
        } catch { /* skip unreadable */ }
      }
      const totalFiles = fileCache.length || 1;
      const tooCommon: string[] = [];
      // Keep keywords that appear in ≤60% of files; order rarest-first.
      // Rarity filtering only applies when there are enough files to be meaningful (≥5).
      const kw = kwRaw
        .filter(k => {
          const df = dfCount.get(k) ?? 0;
          if (totalFiles >= 5 && df / totalFiles > 0.6) { tooCommon.push(k); return false; }
          return true;
        })
        .sort((a, b) => (dfCount.get(a) ?? 0) - (dfCount.get(b) ?? 0));

      // --- Pass 2: collect hits using cached file lines ---
      interface FileHits { hits: string[] }
      const fileHits: FileHits[] = [];
      for (const cached of fileCache) {
        if (!kw.length) break;
        const hits: string[] = [];
        const kwCount = new Map<string, number>();
        // Determine which keywords appear at all in this file (for import-skip exception)
        const lowerText = cached.lines.map(l => l.toLowerCase()).join('\n');
        const kwInFile = kw.filter(k => lowerText.includes(k));
        if (!kwInFile.length) continue;
        for (let i = 0; i < cached.lines.length && hits.length < MAX_PER_FILE; i++) {
          const trimmed = cached.lines[i]!.trim();
          if (!trimmed) continue;
          const lower = trimmed.toLowerCase();
          for (const k of kw) {
            if (!lower.includes(k)) continue;
            if ((kwCount.get(k) ?? 0) >= MAX_PER_FILE_PER_KW) continue;
            // Skip import/require/export-from lines unless this keyword is the only one in the file
            if (IMPORT_LINE.test(trimmed) && kwInFile.length > 1) continue;
            kwCount.set(k, (kwCount.get(k) ?? 0) + 1);
            hits.push(`${cached.path}:${i + 1}: ${trimmed.slice(0, 120)}\n`);
            break; // one keyword credit per line
          }
        }
        if (hits.length) fileHits.push({ hits });
      }
      // Round-robin across files so every source file gets representation
      const hitLines: string[] = [];
      let hitBytes = 0;
      let round = 0;
      outer: while (true) {
        let advanced = false;
        for (const fh of fileHits) {
          if (round < fh.hits.length) {
            const hb = Buffer.byteLength(fh.hits[round]!, 'utf8');
            if (hitBytes + hb > maxHitBytes) break outer;
            hitLines.push(fh.hits[round]!); hitBytes += hb; advanced = true;
          }
        }
        if (!advanced) break;
        round++;
      }
      const header = [
        `## Keyword hits (${kw.join(', ')})`,
        ...(tooCommon.length ? [`<!-- too common (>40% of files), skipped: ${tooCommon.join(', ')} -->`] : []),
      ].join('\n');
      if (hitLines.length) addSection(`${header}\n${hitLines.join('')}`);
      else if (tooCommon.length) addSection(`${header}\n`);
    }
  }

  return { text: parts.join('\n'), commit };
}

function buildTreeListing(entries: TreeEntry[], maxLines: number): string {
  interface DirNode { files: string[]; subdirs: Map<string, DirNode>; }
  const root: DirNode = { files: [], subdirs: new Map() };

  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]!;
      if (!node.subdirs.has(dir)) node.subdirs.set(dir, { files: [], subdirs: new Map() });
      node = node.subdirs.get(dir)!;
    }
    node.files.push(parts[parts.length - 1]!);
  }

  const lines: string[] = [];
  function render(node: DirNode, prefix: string, depth: number): void {
    if (lines.length >= maxLines) return;
    const limit = depth < 3 ? 40 : 20;
    const fileList = node.files.slice(0, limit);
    for (const f of fileList) { if (lines.length < maxLines) lines.push(`${prefix}${f}`); }
    if (node.files.length > fileList.length) lines.push(`${prefix}… and ${node.files.length - fileList.length} more files`);
    let dirCount = 0;
    for (const [dir, child] of node.subdirs) {
      if (lines.length >= maxLines) { lines.push(`${prefix}… ${node.subdirs.size - dirCount} more dirs`); break; }
      lines.push(`${prefix}${dir}/`);
      render(child, prefix + '  ', depth + 1);
      dirCount++;
    }
  }
  render(root, '', 0);
  return lines.join('\n');
}
