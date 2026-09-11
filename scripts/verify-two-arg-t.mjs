// 精确统计 t(...) 调用中参数个数：支持单引号字符串与模板字符串（含嵌套 ${}）。
// 输出仍为 2 参的调用位置与片段。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const appDir = path.resolve('app');

function parseArgs(source, openParen) {
  // 返回 {args: [{kind:'str'|'tpl'|'other', endIndex}], closed} 或 null
  const args = [];
  let pos = openParen + 1;
  for (;;) {
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    let kind = 'other';
    const ch = source[pos];
    if (ch === "'" || ch === '"') {
      kind = 'str';
      const q = ch; pos++;
      while (pos < source.length) {
        if (source[pos] === '\\') { pos += 2; continue; }
        if (source[pos] === q) { pos++; break; }
        if (source[pos] === '\n') return null;
        pos++;
      }
    } else if (ch === '`') {
      kind = 'tpl'; pos++;
      let bt = 1, br = 0; // 反引号计数与 ${} 深度
      while (pos < source.length) {
        const c = source[pos];
        if (c === '\\') { pos += 2; continue; }
        if (c === '$' && source[pos + 1] === '{') { br++; pos += 2; continue; }
        if (c === '}' && br > 0) { br--; pos++; continue; }
        if (c === '`') { bt--; pos++; if (bt === 0) break; continue; }
        pos++;
      }
    } else if (ch === ')') {
      return { args, closedAt: pos };
    } else {
      // 表达式参数：读到顶层逗号或闭括号
      pos++;
      let paren = 0, brace = 0, brack = 0;
      while (pos < source.length) {
        const c = source[pos];
        if (c === '(') paren++;
        else if (c === ')') { if (paren === 0 && brace === 0 && brack === 0) break; paren--; }
        else if (c === '{') brace++;
        else if (c === '}') { if (brace === 0) break; brace--; }
        else if (c === '[') brack++;
        else if (c === ']') brack--;
        else if (c === "'" || c === '"' || c === '`') {
          const q = c; pos++;
          while (pos < source.length) {
            if (source[pos] === '\\') { pos += 2; continue; }
            if (source[pos] === q) break;
            pos++;
          }
        }
        pos++;
      }
    }
    args.push({ kind, endIndex: pos - 1 });
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    if (source[pos] === ',') { pos++; continue; }
    if (source[pos] === ')') return { args, closedAt: pos };
    return null;
  }
}

const report = {};
for (const file of readdirSync(appDir).filter((f) => f.endsWith('.tsx'))) {
  const source = readFileSync(path.join(appDir, file), 'utf8');
  let i = 0;
  while (i < source.length) {
    if (source[i] === 't' && i > 0 && !/[A-Za-z0-9_$]/.test(source[i - 1])) {
      const openParen = source.indexOf('(', i + 1);
      const name = source.slice(i + 1, openParen).trim();
      if (openParen !== -1 && name === '' ) {
        const parsed = parseArgs(source, openParen);
        if (parsed && parsed.args.length === 2) {
          const line = source.slice(0, i).split('\n').length;
          const frag = source.slice(i, source.indexOf(')', parsed.args[1].endIndex) + 1);
          (report[file] ??= []).push({ line, frag: frag.slice(0, 120) });
        }
        i = openParen + 1;
        continue;
      }
    }
    i++;
  }
}
writeFileSync('scripts/two-arg-final.json', JSON.stringify(report, null, 2));
let total = 0;
for (const [f, items] of Object.entries(report)) { total += items.length; console.log(`${f}: ${items.length}`); for (const it of items) console.log(`  L${it.line}: ${it.frag.replace(/\n/g, ' ').slice(0, 110)}`); }
console.log('TOTAL remaining 2-arg t() calls:', total);
