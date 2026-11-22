// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push({ old: oldP, new: newP });
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its line break, its lines, whether it ends with a break (SPEC.md section 3). */
interface FileModel { br: string; lines: string[]; final: boolean; }

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] { return strict ? [0] : [0, 1, 2]; }

/** First tier with an occurrence at/after `from` (only occurrences ending at the last line when `eof`). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eof = false): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, o, t, from).filter((p) => !eof || p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine { text: string; ctx: boolean; oIdx: number; }
interface Body { O: string[]; N: NewLine[]; }

/** A hunk/chunk body: O is its context and `-` lines, N its context and `+` lines (section 5). */
function parseBody(raw: { kind: string; text: string }[]): Body {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const e of raw) {
    if (e.kind === ' ') { O.push(e.text); N.push({ text: e.text, ctx: true, oIdx: O.length - 1 }); }
    else if (e.kind === '-') O.push(e.text);
    else if (e.kind === '+') N.push({ text: e.text, ctx: false, oIdx: -1 });
  }
  return { O, N };
}

/** N with context lines taken from the file and tier-2 re-indenting (section 5). */
function buildNew(fileLines: string[], pos: number, body: Body, tier: number): string[] {
  const F = body.O.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const P = body.O.length > 0 ? leadWs(body.O[0]!) : '';
  return body.N.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(P)) return F + e.text.slice(P.length);
    return e.text;
  });
}

interface Hunk { a: number; body: Body; noEolNew: boolean; plus: string[]; plusNoEol: boolean; }

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let cur = model;
  let d = 0;
  for (const h of hunks) {
    const lines = cur.lines;
    const O = h.body.O;
    if (O.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const out = [...lines.slice(0, at), ...buildNew(lines, at, h.body, 0), ...lines.slice(at)];
      cur = { br: cur.br, lines: out, final: at === lines.length ? !h.noEolNew : cur.final };
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const out = [...lines.slice(0, best), ...buildNew(lines, best, h.body, found.tier), ...lines.slice(best + O.length)];
      cur = { br: cur.br, lines: out, final: best + O.length === lines.length ? !h.noEolNew : cur.final };
    }
    d += h.body.N.length - O.length;
  }
  return cur;
}

// ---- Section 6: unified diffs ----

interface Section {
  diffOld: string | null; diffNew: string | null;
  pairOld: string | null; pairNew: string | null;
  renFrom: string | null; renTo: string | null;
  create: boolean; del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(l: string): string {
  const rest = l.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const raw: { kind: string; text: string }[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind === ' ' && last.text === '') raw.pop();
    else break;
  }
  const body = parseBody(raw);
  const noEolAfter = (kinds: string[]): boolean => {
    for (let k = raw.length - 1; k >= 0; k--) {
      if (kinds.includes(raw[k]!.kind)) return raw[k + 1]?.kind === '\\';
    }
    return false;
  };
  const plus = raw.filter((e) => e.kind === '+').map((e) => e.text);
  return { hunk: { a: parseInt(m[1]!, 10), body, noEolNew: noEolAfter([' ', '+']), plus, plusNoEol: noEolAfter(['+']) }, next: j };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  let oldP: string | null = null;
  let newP: string | null = null;
  if (s.pairOld !== null) { oldP = s.pairOld; newP = s.pairNew; }
  else if (s.renFrom !== null) { oldP = s.renFrom; newP = s.renTo; }
  else { oldP = s.diffOld; newP = s.diffNew; }
  const oldIsNull = oldP === '/dev/null';
  const newIsNull = newP === '/dev/null';
  if (oldIsNull || s.create) {
    const p = newP!;
    return (tree) => {
      if (newIsNull || !safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        plusLines.push(...h.plus);
        if (h.plus.length > 0) fin = !h.plusNoEol;
      }
      tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (fin ? '\n' : ''));
    };
  }
  if (newIsNull || s.del) {
    const p = oldP!;
    return (tree) => {
      if (oldIsNull || !safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    const o = oldP;
    const n = newP;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      tree.move(o, n, renderFile(applyHunks(parseFile(before), s.hunks, strict, o)));
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, renderFile(applyHunks(parseFile(before), s.hunks, strict, p)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headed = false;
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    cur = { diffOld, diffNew, pairOld: null, pairNew: null, renFrom: null, renTo: null, create: false, del: false, hunks: [] };
    sections.push(cur);
    headed = true;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !headed) startSection(null, null);
      const s = cur!;
      if (s.pairOld === null) { s.pairOld = stripAB(headerPath(l)); s.pairNew = stripAB(headerPath(lines[i + 1]!)); }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && headed) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      headed = false;
      i = next;
      continue;
    }
    if (cur !== null && headed) {
      if (l.startsWith('rename from ')) { if (cur.renFrom === null) cur.renFrom = l.slice('rename from '.length).trim(); }
      else if (l.startsWith('rename to ')) { if (cur.renTo === null) cur.renTo = l.slice('rename to '.length).trim(); }
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const body: Body = { O: oldLines, N: newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })) };
    const out = [...model.lines.slice(0, pos), ...buildNew(model.lines, pos, body, found.tier), ...model.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile({ br: model.br, lines: out, final: model.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(makeSearchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionKind(l: string): 'add' | 'del' | 'upd' | null {
  if (l.startsWith(V4A_ADD)) return 'add';
  if (l.startsWith(V4A_DEL)) return 'del';
  if (l.startsWith(V4A_UPD)) return 'upd';
  return null;
}

interface V4aChunk { anchor: string | null; eof: boolean; body: { kind: string; text: string }[]; }

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        for (const t of tiers(strict)) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (lineEq(model.lines[k]!, ch.anchor, t)) { foundIdx = k; break; }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const body = parseBody(ch.body);
      if (body.O.length === 0) {
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const ins = buildNew(model.lines, at, body, 0);
        model = { br: model.br, lines: [...model.lines.slice(0, at), ...ins, ...model.lines.slice(at)], final: model.final };
        cursor = at + ins.length;
      } else {
        const found = findTier(model.lines, body.O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const rep = buildNew(model.lines, pos, body, found.tier);
        model = { br: model.br, lines: [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + body.O.length)], final: model.final };
        cursor = pos + rep.length;
      }
    }
    const out = renderFile(model);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.now.set(path, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.trim() === '*** End Patch') break;
    const kind = v4aSectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? V4A_ADD : kind === 'del' ? V4A_DEL : V4A_UPD;
    const path = l.slice(prefix.length).trim();
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const m = lines[j]!;
      if (m.trim() === '*** End Patch' || v4aSectionKind(m) !== null) break;
      raw.push({ text: m, no: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(((p: string, c: string[]): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, c.length === 0 ? '' : c.join('\n') + '\n');
      })(path, content));
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push(((p: string): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.text.startsWith(V4A_MOVE)) {
        moveTo = raw[0]!.text.slice(V4A_MOVE.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let between = false;
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const m = r.text;
        if (m.startsWith('@@')) {
          cur = { anchor: m.slice(2).trim() || null, eof: false, body: [] };
          chunks.push(cur);
          between = false;
          continue;
        }
        if (m === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
          between = true;
          continue;
        }
        if (m === '' || m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0 && !between) {
              cur = { anchor: null, eof: false, body: [] };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${r.no}`);
          }
          cur.body.push({ kind: m === '' ? ' ' : m[0]!, text: m === '' ? '' : m.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const m of [...tree.moves].sort((a, b) => Buffer.compare(Buffer.from(a.new), Buffer.from(b.new)))) {
    if (used.has(m.old) || used.has(m.new)) continue;
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      used.add(m.old);
      used.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
