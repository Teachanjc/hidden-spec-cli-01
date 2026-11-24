
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

export interface Result {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

export const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

export const TIMEOUT_MS = 10_000;
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MAX_FILES = 64;
export const BATCH = 10;
export const RETRIES = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function send(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      await sleep(250 * (attempt + 1));
    }
  }
}

function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && Object.keys(out).length < MAX_FILES) out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

export function runCheck(c: Check, program = MAIN): Result {
  const dir = mkdtempSync(join(tmpdir(), 'mend-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const r = spawnSync(process.execPath, [program, ...c.argv], { cwd: dir, env, input: c.stdin ?? '', encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 4 * MAX_STDOUT_BYTES });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    let stdout = r.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    return { id: c.id, exit, stdout, files: readTree(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runTrial(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  const post = async (results: Result[]): Promise<void> => {
    const res = await send(`${base}/results`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results }) });
    const body = await res.text();
    if (!res.ok && res.status !== 409) throw new Error(`POST /results answered ${res.status}: ${body}`);
  };
  const res = await send(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks answered ${res.status}`);
  const { checks } = (await res.json()) as { checks: Check[] };
  let batch: Result[] = [];
  for (const c of checks) {
    batch.push(runCheck(c));
    if (batch.length === BATCH) {
      await post(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await post(batch);
  process.stdout.write(`posted ${checks.length} results\n`);
}
