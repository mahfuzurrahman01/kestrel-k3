// Turns dist-single/index.html into a fragment for hosts that supply their own <html>/<head>/<body>
// skeleton (e.g. a claude.ai artifact). Usage: node scripts/to-artifact.mjs [in] [out]
import { readFileSync, writeFileSync } from 'node:fs';

const [inp = 'dist-single/index.html', out = 'dist-single/artifact.html'] = process.argv.slice(2);
const html = readFileSync(inp, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)[1]
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/i)[1];
// the module script was hoisted into <head> by the build; it must run after the markup exists
const scripts = [];
const headNoScripts = head.replace(/<script\b[\s\S]*?<\/script>/gi, (s) => { scripts.push(s); return ''; });
writeFileSync(out, headNoScripts.trim() + '\n' + body.trim() + '\n' + scripts.join('\n') + '\n');
console.log('wrote', out);
