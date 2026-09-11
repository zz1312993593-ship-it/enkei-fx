// 按映射把 t('zh','ja') 补为 t('zh','ja','en')；索引级插入，避免正则歧义。
// 用法：node scripts/apply-two-arg-t.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dry = process.argv.includes('--dry');
const map = JSON.parse(readFileSync('scripts/t-en-map.json', 'utf8'));
const appDir = path.resolve('app');

const isQuote = (ch) => ch === "'" || ch === '"';
function readString(source, start) {
  const quote = source[start];
  let value = '';
  for (let j = start + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === '\\' && j + 1 < source.length) { value += ch + source[j + 1]; j++; continue; }
    if (ch === quote) return { value, endIndex: j };
    if (ch === '\n') return null;
    value += ch;
  }
  return null;
}

function scan(source) {
  const calls = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === 't' && i > 0 && !/[A-Za-z0-9_$]/.test(source[i - 1])) {
      const openParen = source.indexOf('(', i + 1);
      if (openParen !== -1 && source.slice(i + 1, openParen).trim() === '') {
        let pos = openParen + 1;
        const args = [];
        let ends = [];
        let failed = false;
        for (let a = 0; a < 3; a++) {
          while (pos < source.length && /\s/.test(source[pos])) pos++;
          if (isQuote(source[pos])) {
            const str = readString(source, pos);
            if (!str) { failed = true; break; }
            args.push(str.value); ends.push(str.endIndex);
            pos = str.endIndex + 1;
            while (pos < source.length && /\s/.test(source[pos])) pos++;
            if (source[pos] === ',') { pos++; continue; }
            break;
          } else { failed = true; break; }
        }
        if (!failed && args.length === 2 && source[pos] === ')') {
          calls.push({ at: i, end: ends[1], zh: args[0], ja: args[1] });
        }
        i = openParen + 1;
        continue;
      }
    }
    i++;
  }
  return calls;
}

let inserted = 0, missing = [];
for (const [file, strings] of Object.entries(map)) {
  const filePath = path.join(appDir, file);
  let source = readFileSync(filePath, 'utf8');
  const calls = scan(source);
  const applied = [];
  for (const call of calls.reverse()) {
    const en = strings[call.zh];
    if (!en) { missing.push(`${file}: ${call.zh}`); continue; }
    const escaped = en.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    source = source.slice(0, call.end + 1) + `, '${escaped}'` + source.slice(call.end + 1);
    applied.push(call.zh);
    inserted++;
  }
  if (!dry && applied.length) writeFileSync(filePath, source);
  console.log(`${file}: +${applied.length} en args`);
}
console.log(`TOTAL inserted: ${inserted}`);
if (missing.length) { console.log('MISSING translations:'); for (const m of missing) console.log('  ' + m); }
