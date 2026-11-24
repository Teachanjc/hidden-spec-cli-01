
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

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function tailOff(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function edgeOff(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function onlyWs(s: string): boolean {
  return s === '' || /^[ \t]+$/.test(s);
}

function sameAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return tailOff(a) === tailOff(b);
  return edgeOff(a) === edgeOff(b);
}

interface Doc {
  rows: string[];
  br: string;
  tail: boolean;
}

function readDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { rows: [], br, tail: false };
  const rows = text.split(br);
  const tail = text.endsWith(br);
  if (tail) rows.pop();
  return { rows, br, tail };
}

function writeDoc(d: Doc): string {
  if (d.rows.length === 0) return '';
  return d.rows.join(d.br) + (d.tail ? d.br : '');
}

function spotsAt(rows: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= rows.length; i++) {
    let good = true;
    for (let j = 0; j < old.length; j++) {
      if (!sameAtTier(rows[i + j]!, old[j]!, tier)) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

function tierSpots(rows: string[], old: string[], strict: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const s = spotsAt(rows, old, t);
    if (s.length > 0) return { tier: t, spots: s };
  }
  return null;
}

interface NewPiece {
  text: string;
  ctx: number | null;
}

function buildNew(rows: string[], at: number, old: string[], pieces: NewPiece[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 && at < rows.length ? leadOf(rows[at]!) : '';
  const p = tier === 2 && old.length > 0 ? leadOf(old[0]!) : '';
  for (const pc of pieces) {
    if (pc.ctx !== null) {
      out.push(rows[at + pc.ctx]!);
      continue;
    }
    let t = pc.text;
    if (tier === 2 && old.length > 0 && !onlyWs(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

function applyHunk(doc: Doc, hk: Hunk, strict: boolean, a: number, d: number, failPath: string): Doc {
  const rows = doc.rows;
  if (hk.oldLines.length === 0) {
    let at = a + d;
    if (at < 0) at = 0;
    if (at > rows.length) at = rows.length;
    const repl = buildNew(rows, at, hk.oldLines, hk.pieces, 0);
    const next = [...rows.slice(0, at), ...repl, ...rows.slice(at)];
    return { rows: next, br: doc.br, tail: at === rows.length ? !hk.noTail : doc.tail };
  }
  const found = tierSpots(rows, hk.oldLines, strict);
  if (found === null) throw new Fail('no-match', failPath);
  const want = a - 1 + d;
  let best = found.spots[0]!;
  let bd = Math.abs(best - want);
  for (const s of found.spots) {
    const dd = Math.abs(s - want);
    if (dd < bd) {
      bd = dd;
      best = s;
    }
  }
  const repl = buildNew(rows, best, hk.oldLines, hk.pieces, found.tier);
  const next = [...rows.slice(0, best), ...repl, ...rows.slice(best + hk.oldLines.length)];
  const tail = best + hk.oldLines.length === rows.length ? !hk.noTail : doc.tail;
  return { rows: next, br: doc.br, tail };
}

interface Hunk {
  start: number;
  oldLines: string[];
  pieces: NewPiece[];
  noTail: boolean;
  noTailPlus: boolean;
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

interface RawSection {
  pairOld: string | null;
  pairNew: string | null;
  rnOld: string | null;
  rnNew: string | null;
  dfOld: string | null;
  dfNew: string | null;
  mk: boolean;
  del: boolean;
  hunks: Hunk[];
  seenHunk: boolean;
}

function cutPath(s: string): string {
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function buildHunk(a: number, body: string[]): Hunk {
  const oldLines: string[] = [];
  const pieces: NewPiece[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b[0] === ' ' || b[0] === '+') lastCtxPlus = k;
    if (b[0] === '+') lastPlus = k;
  }
  const afterSlash = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
  const noTail = afterSlash(lastCtxPlus);
  const noTailPlus = afterSlash(lastPlus);
  for (const b of body) {
    if (b === '') {
      oldLines.push('');
      pieces.push({ text: '', ctx: oldLines.length - 1 });
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      oldLines.push(t);
      pieces.push({ text: t, ctx: oldLines.length - 1 });
    } else if (b[0] === '-') {
      oldLines.push(b.slice(1));
    } else if (b[0] === '+') {
      pieces.push({ text: b.slice(1), ctx: null });
    }
  }
  return { start: a, oldLines, pieces, noTail, noTailPlus };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: RawSection[] = [];
  const fresh = (): RawSection => ({ pairOld: null, pairNew: null, rnOld: null, rnNew: null, dfOld: null, dfNew: null, mk: false, del: false, hunks: [], seenHunk: false });
  let cur: RawSection | null = null;
  let i = 0;
  const bad = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(ln);
      if (m === null) bad(i + 1);
      cur = fresh();
      cur.dfOld = m[1]!;
      cur.dfNew = m[2]!;
      secs.push(cur);
      i++;
      continue;
    }
    if (cur === null) {
      if (ln.startsWith('@@')) bad(i + 1);
      if (ln.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh();
        cur.pairOld = stripAB(cutPath(ln));
        cur.pairNew = stripAB(cutPath(lines[i + 1]!));
        secs.push(cur);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (!cur.seenHunk) {
      if (ln.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) bad(i + 2);
        cur.pairOld = stripAB(cutPath(ln));
        cur.pairNew = stripAB(cutPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (ln.startsWith('+++ ')) {
        cur.pairNew = stripAB(cutPath(ln));
        i++;
        continue;
      }
      if (ln.startsWith('rename from ')) {
        cur.rnOld = ln.slice(12).trim();
        i++;
        continue;
      }
      if (ln.startsWith('rename to ')) {
        cur.rnNew = ln.slice(10).trim();
        i++;
        continue;
      }
      if (ln.startsWith('new file mode')) {
        cur.mk = true;
        i++;
        continue;
      }
      if (ln.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      if (!ln.startsWith('@@')) {
        i++;
        continue;
      }
    } else {
      if (ln.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh();
        cur.pairOld = stripAB(cutPath(ln));
        cur.pairNew = stripAB(cutPath(lines[i + 1]!));
        secs.push(cur);
        i += 2;
        continue;
      }
      if (!ln.startsWith('@@')) {
        i++;
        continue;
      }
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (hm === null) bad(i + 1);
    const a = Number(hm[1]);
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length) {
      const b = lines[j]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
        body.push(b);
        j++;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    cur.hunks.push(buildHunk(a, body));
    cur.seenHunk = true;
    i = j;
  }
  return secs.map((s) => sectionEdit(s, strict));
}

function sectionEdit(sec: RawSection, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.rnOld ?? sec.dfOld ?? null;
  const newP = sec.pairNew ?? sec.rnNew ?? sec.dfNew ?? null;
  const oldNull = sec.pairOld === '/dev/null';
  const newNull = sec.pairNew === '/dev/null';
  if (oldNull || sec.mk) {
    const np = newP ?? '';
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const pc of h.pieces) if (pc.ctx === null) plus.push(pc.text);
      let tail = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.pieces.some((pc) => pc.ctx === null)) {
          tail = !h.noTailPlus;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (tail ? '\n' : ''));
    };
  }
  if (newNull || sec.del) {
    const op = oldP ?? '';
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldP ?? '';
  const np = newP ?? '';
  if (op !== np) {
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let doc = readDoc(before);
      let d = 0;
      for (const h of sec.hunks) {
        doc = applyHunk(doc, h, strict, h.start, d, op);
        d += h.pieces.length - h.oldLines.length;
      }
      tree.now.set(op, null);
      tree.now.set(np, writeDoc(doc));
      tree.moves.push([op, np]);
    };
  }
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    let doc = readDoc(before);
    let d = 0;
    for (const h of sec.hunks) {
      doc = applyHunk(doc, h, strict, h.start, d, op);
      d += h.pieces.length - h.oldLines.length;
    }
    tree.now.set(op, writeDoc(doc));
  };
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

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = readDoc(before);
    const found = tierSpots(doc.rows, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.spots.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.spots[0]!;
    const pieces: NewPiece[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildNew(doc.rows, at, b.oldLines, pieces, found.tier);
    const rows = [...doc.rows.slice(0, at), ...repl, ...doc.rows.slice(at + b.oldLines.length)];
    tree.now.set(b.path, writeDoc({ rows, br: doc.br, tail: doc.tail }));
  };
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = s + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  pieces: NewPiece[];
}

interface VSection {
  kind: string;
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: VChunk[];
  headNo: number;
  raw: { text: string; no: number }[];
}

function findAnchor(rows: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < rows.length; i++) {
      if (sameAtTier(rows[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function spotsFrom(rows: string[], old: string[], from: number, strict: boolean, eof: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const all = spotsAt(rows, old, t).filter((p) => p >= from && (!eof || p + old.length === rows.length));
    if (all.length > 0) return { tier: t, spots: all };
  }
  return null;
}

function parseUpdate(s: VSection): void {
  let idx = 0;
  if (s.raw.length > 0 && s.raw[0]!.text.startsWith('*** Move to: ')) {
    s.moveTo = s.raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  let cur: VChunk | null = null;
  const push = (): void => {
    if (cur !== null) {
      s.chunks.push(cur);
      cur = null;
    }
  };
  for (let q = idx; q < s.raw.length; q++) {
    const { text, no } = s.raw[q]!;
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      push();
      continue;
    }
    if (text.startsWith('@@')) {
      push();
      const anc = text.slice(2).trim();
      cur = { anchor: anc === '' ? null : anc, eof: false, oldLines: [], pieces: [] };
      continue;
    }
    if (text.startsWith('*** ')) throw new Exit2(`error: parse ${no}`);
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (s.chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, oldLines: [], pieces: [] };
      }
      if (text === '') {
        cur.oldLines.push('');
        cur.pieces.push({ text: '', ctx: cur.oldLines.length - 1 });
      } else if (text[0] === ' ') {
        const t = text.slice(1);
        cur.oldLines.push(t);
        cur.pieces.push({ text: t, ctx: cur.oldLines.length - 1 });
      } else if (text[0] === '-') {
        cur.oldLines.push(text.slice(1));
      } else {
        cur.pieces.push({ text: text.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  push();
  if (s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.headNo}`);
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let doc = readDoc(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.rows, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      if (ch.oldLines.length === 0) {
        const at = ch.eof ? doc.rows.length : cursor;
        const repl = buildNew(doc.rows, at, ch.oldLines, ch.pieces, 0);
        doc = { rows: [...doc.rows.slice(0, at), ...repl, ...doc.rows.slice(at)], br: doc.br, tail: doc.tail };
        cursor = at + repl.length;
        continue;
      }
      const found = spotsFrom(doc.rows, ch.oldLines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const at = found.spots[0]!;
      const repl = buildNew(doc.rows, at, ch.oldLines, ch.pieces, found.tier);
      doc = { rows: [...doc.rows.slice(0, at), ...repl, ...doc.rows.slice(at + ch.oldLines.length)], br: doc.br, tail: doc.tail };
      cursor = at + repl.length;
    }
    const out = writeDoc(doc);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSection[] = [];
  let cur: VSection | null = null;
  for (let k = first + 1; k < last; k++) {
    const ln = lines[k]!;
    if (ln.startsWith('*** Add File: ') || ln.startsWith('*** Delete File: ') || ln.startsWith('*** Update File: ')) {
      const kind = ln.startsWith('*** Add') ? 'add' : ln.startsWith('*** Delete') ? 'delete' : 'update';
      cur = { kind, path: ln.slice(ln.indexOf(':') + 1).trim(), moveTo: null, fileLines: [], chunks: [], headNo: k + 1, raw: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(ln)) continue;
      throw new Exit2(`error: parse ${k + 1}`);
    }
    cur.raw.push({ text: ln, no: k + 1 });
  }
  for (const s of secs) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      for (const r of s.raw) {
        if (r.text.startsWith('+')) s.fileLines.push(r.text.slice(1));
        else if (r.text === '') s.fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (s.kind === 'delete') {
      const badLine = s.raw.find((r) => !blank(r.text));
      if (badLine !== undefined) throw new Exit2(`error: parse ${badLine.no}`);
    } else {
      parseUpdate(s);
    }
  }
  return secs.map((s) => vSectionEdit(s, strict));
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mvLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = mvLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
