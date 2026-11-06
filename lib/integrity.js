/** 数据边界的共同语义；各入口不能自行放宽路径、作用域或时间规则。 */
import path from 'node:path';
import { lstatSync } from 'node:fs';

export function timestampMs(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value) ? Date.parse(value) : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid timestamp');
  return Math.trunc(n >= 1e9 && n < 1e11 ? n * 1000 : n);
}

export function cleanPath(value) {
  const p = String(value ?? '').trim() || 'inbox';
  const parts = p.split('/');
  if (parts.some(s => !s || s !== s.trim() || s === '.' || s === '..' || /[\\:*?"<>|\u0000-\u001f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new Error(`Invalid knowledge path: ${p}`);
  }
  return p;
}

export function cleanPaths(f) {
  const values = f.paths ?? (f.path ? [f.path] : ['inbox']);
  if (!Array.isArray(values)) throw new Error('paths must be an array');
  const paths = [...new Set((f.path ? [f.path, ...values] : values).filter(Boolean).map(cleanPath))];
  return paths.length ? paths : ['inbox'];
}

export function canonicalCwd(cwd) {
  const text = String(cwd ?? '').replaceAll('\\', '/');
  const windows = /^[a-z]:/i.test(text) || text.startsWith('//');
  const parser = windows ? path.win32 : path.posix;
  const normalized = windows ? parser.normalize(text).replaceAll('\\','/').toLowerCase() : parser.normalize(text || '.');
  const root = parser.parse(normalized).root.replaceAll('\\','/');
  return normalized === root ? normalized : normalized.replace(/\/+$/, '');
}

export function scopeOf(f) {
  if (f.scope === 'global') return 'global';
  if (f.scope != null) {
    const value = String(f.scope);
    if (value.startsWith('cwd:') && value.slice(4).trim()) return `cwd:${canonicalCwd(value.slice(4))}`;
    if (value.startsWith('project:')) {
      const projects = [...new Set(value.slice(8).split('|').map(cleanPath))].sort();
      if (projects.every(p=>/^project\/[^/]+$/.test(p))) return `project:${projects.join('|')}`;
    }
    throw new Error('Invalid fact scope');
  }
  if (f.cwd) return `cwd:${canonicalCwd(f.cwd)}`;
  const paths = typeof f.paths === 'string' ? JSON.parse(f.paths) : (f.paths ?? [f.path ?? '']);
  const projects = [...new Set(paths.filter(p => p.startsWith('project/')).map(p => p.split('/').slice(0, 2).join('/')))].sort();
  return projects.length ? `project:${projects.join('|')}` : 'global';
}

/** substr 等值比较避免 LIKE 的 %/_ 与相邻枝名混入。alias 只允许代码内常量。 */
export function pathPredicate(alias, value) {
  if (!/^[a-z]+$/.test(alias)) throw new Error('Invalid SQL alias');
  const prefix = String(value).replace(/\/+$/, '');
  return { sql: `(${alias}.path=? OR substr(${alias}.path,1,length(?)+1)=?||'/' OR EXISTS (SELECT 1 FROM json_each(${alias}.paths) p WHERE p.value=? OR substr(p.value,1,length(?)+1)=?||'/'))`, params: Array(6).fill(prefix) };
}

/** 镜像拒绝符号链接/junction，连根目录的祖先也检查，防词法边界被重解析点绕过。 */
export function safeMirrorPath(root, target) {
  root = path.resolve(root); target = path.resolve(target);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Mirror path escapes root');
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Mirror symbolic link is not allowed: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
