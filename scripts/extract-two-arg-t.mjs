// 提取 app/*.tsx 中仅有两个参数的 t('zh','ja') 调用，输出 JSON 清单供翻译补全。
// 只处理单引号字符串字面量参数；模板字符串/变量参数会被跳过并单独列出。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const appDir = path.resolve('app');
const results = {};
const skipped = {};

// 逐字符扫描，找 t( 调用并解析前两个字符串参数
function scan(source) {
  const calls = [];
  const skips = [];
  let i = 0;
  const isQuote = (ch) => ch === "'" || ch === '"';
  const readString = (start) => {
    // start 指向引号，返回 {value, endIndex} 或 null（未闭合）
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
  };
  while (i < source.length) {
    // 匹配标识符 t（或 primary/text 等）后跟 ( 的位置：只匹配独立标识符 t(
    const ch = source[i];
    if ((ch === 't' || ch === 'b') && i > 0 && !/[A-Za-z0-9_$]/.test(source[i - 1]) && /\s*\(/.test(source.slice(i + 1, i + 3))) {
      const openParen = source.indexOf('(', i + 1);
      // 只处理函数名恰为 t 或 b 的调用
      if (source.slice(i, openParen).trim() !== 't' && source.slice(i, openParen).trim() !== 'b') { i++; continue; }
      let pos = openParen + 1;
      const args = [];
      let failed = false;
      for (let a = 0; a < 3; a++) {
        while (pos < source.length && /\s/.test(source[pos])) pos++;
        if (isQuote(source[pos])) {
          const str = readString(pos);
          if (!str) { failed = true; break; }
          args.push(str.value);
          pos = str.endIndex + 1;
          while (pos < source.length && /\s/.test(source[pos])) pos++;
          if (source[pos] === ',') { pos++; continue; }
          break;
        } else {
          // 非字符串参数（变量/模板/数字），记录跳过
          skips.push({ index: i, fragment: source.slice(i, Math.min(source.length, i + 60)).split('\n')[0] });
          failed = true;
          break;
        }
      }
      if (!failed && args.length === 2) {
        // 确认第二个参数后没有第三个参数
        if (source[pos] === ',' || source[pos] === ')') {
          if (source[pos] === ')') calls.push({ at: i, zh: args[0], ja: args[1] });
          else {
            // 有第三个参数，但可能是非字符串；跳过
          }
        }
      }
      i = openParen + 1;
      continue;
    }
    i++;
  }
  return { calls, skips };
}

for (const file of readdirSync(appDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))) {
  const source = readFileSync(path.join(appDir, file), 'utf8');
  const { calls, skips } = scan(source);
  if (calls.length || skips.length) {
    if (calls.length) results[file] = calls;
    if (skips.length) skipped[file] = skips.length;
  }
}

writeFileSync('scripts/two-arg-t-report.json', JSON.stringify({ results, skipped }, null, 2));
let total = 0;
for (const [file, calls] of Object.entries(results)) { total += calls.length; console.log(`${file}: ${calls.length}`); }
console.log('TOTAL 2-arg calls:', total);
console.log('skipped (non-literal args):', JSON.stringify(skipped));
