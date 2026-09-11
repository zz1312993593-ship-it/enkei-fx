// 找出 app/dashboard.tsx 中 primary( 的双参调用，输出行号与前两个参数片段。
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('app/dashboard.tsx', 'utf8');
const hits = [];
let i = 0;
while ((i = src.indexOf('primary(', i)) !== -1) {
  if (i > 0 && /[A-Za-z0-9_$]/.test(src[i - 1])) { i += 8; continue; }
  let pos = i + 8; // after 'primary('
  let depth = 0, args = [], argStart = pos, inStr = null;
  for (; pos < src.length; pos++) {
    const c = src[pos];
    if (inStr) {
      if (c === '\\') { pos++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '`' || c === '"') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' && depth === 0) { args.push(src.slice(argStart, pos).trim()); break; }
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { args.push(src.slice(argStart, pos).trim()); argStart = pos + 1; }
  }
  if (args.length === 2) hits.push({ line: src.slice(0, i).split('\n').length, zh: args[0].slice(0, 70), ja: args[1].slice(0, 50) });
  i += 8;
}
writeFileSync('scripts/primary-2arg.json', JSON.stringify(hits, null, 2));
console.log('2-arg primary calls:', hits.length);
hits.forEach(h => console.log(`L${h.line}: ${h.zh} || ${h.ja}`));
