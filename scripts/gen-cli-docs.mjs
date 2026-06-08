#!/usr/bin/env node
/**
 * Regenerates the exhaustive CLI command reference from the oclif manifest, so
 * the docs cannot drift from the actual command definitions.
 *
 * Outputs:
 *   - docs/cli.md            — replaces everything from the "## Command reference"
 *                              heading down (the hand-written intro above it is
 *                              preserved).
 *   - docs/cli-reference.fragment.html — the HTML block injected into the
 *                              marketing docs page (public/execufunction/docs.html)
 *                              between the <!-- BEGIN/END generated CLI command
 *                              reference --> markers. Re-splice after regenerating.
 *
 * Usage (from packages/exf-cli):  npm run build && node scripts/gen-cli-docs.mjs
 * (run `oclif manifest` first if oclif.manifest.json is stale).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(PKG, 'oclif.manifest.json');
const CLI_MD = path.join(PKG, 'docs', 'cli.md');
const HTML_FRAGMENT = path.join(PKG, 'docs', 'cli-reference.fragment.html');

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const cmds = m.commands;
const ids = Object.keys(cmds).sort();

const GLOBAL_FLAGS = new Set(['api-url', 'json', 'no-input', 'token', 'workspace']);

// Topic descriptions as the CLI reports them in `sift --help`.
const TOPIC_INTROS = {
  '(general)': 'Top-level commands and diagnostics.',
  agents: 'Agent aliases.', auth: 'Authentication commands.', calendar: 'Calendar events.',
  code: 'Code tools.', codebase: 'Code indexing and search.', codex: 'Codex automation helpers.',
  datasets: 'Structured datasets.', documents: 'Document upload.',
  events: 'Research events backed by timeline facts.',
  evidence: 'Evidence Graph setup and proof workflow orchestration.',
  graph: 'Entity graph search and neighborhoods.', notes: 'Knowledge notes.',
  organizations: 'Organizations and companies.', people: 'People and contacts.',
  projects: 'Project management.', recipes: 'Built-in research workflow recipes.',
  research: 'Research workflow planning and orchestration.', skills: 'Installable Siftable skillpacks.',
  tasks: 'Human planning tasks.', timeline: 'Timeline facts and narratives.', vault: 'Secrets vault.',
  work: 'Executable agent work queue.', worker: 'Local executable work runners.',
};

const topicOf = (id) => (id.includes(':') ? id.split(':')[0] : '(general)');
const topicKey = (t) => (t === '(general)' ? 'general' : t);
const topicTitle = (t) => (t === '(general)' ? 'General' : t.charAt(0).toUpperCase() + t.slice(1));
const topicIntro = (t) => TOPIC_INTROS[t] || '';
const plural = (n) => `${n} command${n === 1 ? '' : 's'}`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const groups = {};
for (const id of ids) (groups[topicOf(id)] ||= []).push(id);
const topics = Object.keys(groups).sort();

const oneLine = (s) => (s || '').replace(/\s*\n+\s*/g, ' ').trim();
function flagSignature(name, f) {
  let sig = f.char ? `-${f.char}, --${name}` : `--${name}`;
  if (f.type === 'option') sig += f.options ? ` <${f.options.join('|')}>` : ` <value>`;
  return sig;
}
function flagMeta(f) {
  const meta = [];
  if (f.required) meta.push('required');
  if (f.default !== undefined && f.default !== '' && f.default !== false) meta.push(`default: ${JSON.stringify(f.default)}`);
  if (f.multiple) meta.push('repeatable');
  if (f.dependsOn?.length) meta.push(`needs ${f.dependsOn.join(', ')}`);
  if (f.exclusive?.length) meta.push(`excludes ${f.exclusive.join(', ')}`);
  return meta;
}
const nonGlobalFlags = (c) => Object.keys(c.flags || {}).filter((n) => !GLOBAL_FLAGS.has(n)).sort();

// ---------- markdown ----------
function mdCommand(id) {
  const c = cmds[id];
  const out = [`#### \`sift ${id.replace(/:/g, ' ')}\``];
  if (c.aliases?.length) out.push(`*Alias: ${c.aliases.map((a) => `\`sift ${a.replace(/:/g, ' ')}\``).join(', ')}*  `);
  const desc = oneLine(c.summary || c.description);
  if (desc) out.push(desc);
  const args = c.args || {};
  if (Object.keys(args).length) {
    out.push('\n**Arguments**\n');
    for (const a of Object.keys(args)) out.push(`- \`${a}\`${args[a].required ? ' *(required)*' : ''}${args[a].description ? ` — ${oneLine(args[a].description)}` : ''}`);
  }
  const fl = nonGlobalFlags(c);
  if (fl.length) {
    out.push('\n**Flags**\n');
    for (const n of fl) {
      const f = c.flags[n];
      const meta = flagMeta(f);
      out.push(`- \`${flagSignature(n, f)}\`${meta.length ? ` *(${meta.join('; ')})*` : ''}${f.description ? ` — ${oneLine(f.description)}` : ''}`);
    }
  }
  out.push('');
  return out.join('\n');
}
function buildMarkdown() {
  const out = ['## Command reference\n'];
  out.push(`All ${ids.length} commands, grouped by topic. Every command also accepts the [global flags](#global-flags) (\`--json\`, \`--token\`, \`--api-url\`, \`--workspace\`, \`--no-input\`).\n`);
  out.push('**Topics:** ' + topics.map((t) => `[${topicTitle(t)}](#${slug(topicTitle(t))})`).join(' · ') + '\n');
  for (const t of topics) {
    out.push(`\n### ${topicTitle(t)}\n`);
    if (topicIntro(t)) out.push(`${topicIntro(t)}\n`);
    for (const id of groups[t]) out.push(mdCommand(id));
  }
  return out.join('\n');
}

// ---------- html (docs.html fragment) ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function htmlCommand(id) {
  const c = cmds[id];
  const key = `docs.cli.${topicKey(topicOf(id))}.${id.split(':').slice(1).join('-') || id}`;
  const desc = oneLine(c.summary || c.description);
  const out = [`              <div class="cli-cmd">`, `                <code class="cli-cmd__name">sift ${esc(id.replace(/:/g, ' '))}</code>`];
  if (desc) out.push(`                <p class="cli-cmd__desc" data-i18n="${key}.desc">${esc(desc)}</p>`);
  const args = c.args || {};
  const fl = nonGlobalFlags(c);
  if (Object.keys(args).length || fl.length) {
    out.push(`                <dl class="cli-cmd__params">`);
    if (Object.keys(args).length) {
      out.push(`                  <dt>Arguments</dt>`);
      for (const a of Object.keys(args)) out.push(`                  <dd><code>${esc(a)}</code>${args[a].required ? ' <span class="req">required</span>' : ''}${args[a].description ? ` — ${esc(oneLine(args[a].description))}` : ''}</dd>`);
    }
    if (fl.length) {
      out.push(`                  <dt>Flags</dt>`);
      for (const n of fl) {
        const f = c.flags[n];
        const meta = flagMeta(f);
        out.push(`                  <dd><code>${esc(flagSignature(n, f))}</code>${meta.length ? ` <span class="flag-meta">${esc(meta.join('; '))}</span>` : ''}${f.description ? ` — ${esc(oneLine(f.description))}` : ''}</dd>`);
      }
    }
    out.push(`                </dl>`);
  }
  out.push(`              </div>`);
  return out.join('\n');
}
function buildHtml() {
  const out = [`        <!-- BEGIN generated CLI command reference (gen-cli-docs.mjs) -->`];
  for (const t of topics) {
    const tkey = `docs.cli.${topicKey(t)}`;
    out.push(`            <h2 id="cli-${topicKey(t)}" data-i18n="${tkey}.title">${esc(topicTitle(t))}</h2>`);
    if (topicIntro(t)) out.push(`            <p class="cli-topic__intro" data-i18n="${tkey}.intro">${esc(topicIntro(t))}</p>`);
    out.push(`            <details class="cli-topic"><summary><span data-i18n="${tkey}.count">${plural(groups[t].length)}</span></summary>`);
    for (const id of groups[t]) out.push(htmlCommand(id));
    out.push(`            </details>`);
  }
  out.push(`        <!-- END generated CLI command reference -->`);
  return out.join('\n');
}

// ---------- write ----------
const md = readFileSync(CLI_MD, 'utf8');
const marker = '## Command reference';
const cut = md.indexOf(marker);
if (cut === -1) throw new Error(`"${marker}" heading not found in docs/cli.md`);
writeFileSync(CLI_MD, md.slice(0, cut) + buildMarkdown());
writeFileSync(HTML_FRAGMENT, buildHtml() + '\n');
console.log(`Regenerated docs/cli.md (${ids.length} commands) and docs/cli-reference.fragment.html`);
console.log(`Re-splice the fragment into public/execufunction/docs.html between the BEGIN/END markers, then run the marketing-i18n extract+build.`);
