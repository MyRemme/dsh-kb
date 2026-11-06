/** All test workers inherit isolated homes, including disabled-plugin diagnostics. */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), 'dsh-kb-suite-'));
const files = readdirSync(path.join(repo, 'test')).filter(name=>name.endsWith('.test.js')).sort().map(name=>path.join('test',name));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd:repo, stdio:'inherit', env:{...process.env,DSH_HOME:home,DSH_KB_HOME:path.join(home,'kb'),DSH_KB_PATH:path.join(home,'kb','kb.db')},
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
