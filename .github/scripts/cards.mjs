#!/usr/bin/env node
// Draws the stats, languages and trophies cards on my profile from the GitHub API.
// Runs every day in .github/workflows/profile.yml; the SVGs land on the `output` branch.
//
//   node .github/scripts/cards.mjs --out dist                  (needs GITHUB_TOKEN)
//   node .github/scripts/cards.mjs --data sample.json --out x  (local preview, no network)
//
// No dependencies: Node 20+ only.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOGIN = process.env.USERNAME || 'Srihari-Prasath';

// Markup, notebooks and Flutter's generated desktop runners would drown out the real code.
const SKIP_LANGS = new Set([
  'HTML', 'CSS', 'SCSS', 'Jupyter Notebook', 'Hack', 'CMake', 'C++', 'C', 'Objective-C',
  'Makefile', 'Dockerfile', 'Batchfile', 'Shell', 'PowerShell', 'EJS', 'Procfile',
]);

const THEMES = {
  light: { bg: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#656d76', faint: '#eaeef2', accent: '#5b5bd6' },
  dark:  { bg: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#8b949e', faint: '#21262d', accent: '#9b9cf9' },
};

// ---------------------------------------------------------------- data

async function gql(token, query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-cards' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const MAIN = `query($login: String!) {
  user(login: $login) {
    name createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        isPrivate stargazerCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }
      }
    }
    contributionsCollection {
      contributionYears
      totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

async function collect(token) {
  const { user } = await gql(token, MAIN, { login: LOGIN });
  if (!user) throw new Error(`No GitHub user called ${LOGIN}`);
  const cc = user.contributionsCollection;

  // One calendar per year, all in a single request through aliases.
  const years = cc.contributionYears;
  const perYear = years.map((y) =>
    `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") { contributionCalendar { totalContributions } }`).join('\n');
  const yearly = (await gql(token, `query($login: String!) { user(login: $login) { ${perYear} } }`, { login: LOGIN })).user;
  const contribAll = years.reduce((sum, y) => sum + yearly[`y${y}`].contributionCalendar.totalContributions, 0);

  const repos = user.repositories.nodes;
  const langs = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const l = langs.get(node.name) ?? { name: node.name, color: node.color, size: 0 };
      l.size += size;
      langs.set(node.name, l);
    }
  }

  const days = cc.contributionCalendar.weeks.flatMap((w) =>
    w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
  attachCommits(days, await commitEntries(token, days));

  return {
    name: user.name || LOGIN,
    createdAt: user.createdAt,
    followers: user.followers.totalCount,
    publicRepos: repos.filter((r) => !r.isPrivate).length,
    stars: repos.filter((r) => !r.isPrivate).reduce((s, r) => s + r.stargazerCount, 0),
    contrib12: cc.contributionCalendar.totalContributions,
    contribAll,
    commits12: cc.totalCommitContributions,
    prs12: cc.totalPullRequestContributions + cc.totalPullRequestReviewContributions,
    languages: [...langs.values()],
    days,
    updatedAt: new Date().toISOString(),
  };
}

// Commits per repo per day, for the 3D graph's tooltips. The API lists at most 100 days per repo
// in one window, so the calendar range is split into 90-day windows (one request, via aliases).
async function commitEntries(token, days) {
  const last = new Date(`${days.at(-1).date}T23:59:59Z`);
  const windows = [];
  for (let from = new Date(`${days[0].date}T00:00:00Z`); from <= last;) {
    const to = new Date(Math.min(from.getTime() + 90 * 864e5 - 1000, last.getTime()));
    windows.push([from, to]);
    from = new Date(to.getTime() + 1000);
  }
  const fields = windows.map(([f, t], i) => `w${i}: contributionsCollection(from: "${f.toISOString()}", to: "${t.toISOString()}") {
    commitContributionsByRepository(maxRepositories: 100) {
      repository { name isPrivate }
      contributions(first: 100) { nodes { occurredAt commitCount } }
    }
  }`).join('\n');
  const user = (await gql(token, `query($login: String!) { user(login: $login) { ${fields} } }`, { login: LOGIN })).user;

  const entries = [];
  windows.forEach((_, i) => {
    for (const r of user[`w${i}`].commitContributionsByRepository) {
      const repo = r.repository.isPrivate ? 'a private repo' : r.repository.name;
      for (const n of r.contributions.nodes) entries.push({ at: n.occurredAt, repo, commits: n.commitCount });
    }
  });
  return entries;
}

// occurredAt is a timestamp; which calendar day it belongs to depends on the time zone the
// calendar was built in. Try the likely ones and keep the one that agrees with the calendar
// (a day can't have more commits than contributions). If none agrees, skip the breakdown.
function attachCommits(days, entries) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dayIn = (at, zone) => new Date(at).toLocaleDateString('en-CA', { timeZone: zone });
  let best = null;
  for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    const sums = new Map();
    let misses = 0;
    for (const e of entries) {
      const date = dayIn(e.at, zone);
      if (!byDate.has(date)) { misses++; continue; }
      sums.set(date, (sums.get(date) ?? 0) + e.commits);
    }
    for (const [date, total] of sums) if (total > byDate.get(date).count) misses++;
    if (!best || misses < best.misses) best = { zone, misses };
    if (misses === 0) break;
  }
  if (!best || best.misses > 0) {
    if (entries.length) console.warn('commit days do not line up with the calendar; tooltips show totals only');
    return;
  }
  for (const e of entries) {
    const d = byDate.get(dayIn(e.at, best.zone));
    const list = (d.repos ??= []);
    const hit = list.find((r) => r.repo === e.repo);
    if (hit) hit.commits += e.commits; else list.push({ repo: e.repo, commits: e.commits });
  }
  for (const d of days) d.repos?.sort((a, b) => b.commits - a.commits);
}

// ---------------------------------------------------------------- 3D graph labels
// README images can't react to hover, so the README links the 3D graph to its own file: opened
// that way, each block's <title> shows as a tooltip. The graph draws one block per calendar day
// in the same order as the API's calendar, so the Nth block is the Nth day.

const BLOCK = /<g transform="translate\([^)]*\)">(?=(?:<animateTransform[^>]*><\/animateTransform>)?<rect[^>]*class="cont-top-\d")/g;
const LABEL_COLOR = { light: '#656d76', dark: '#8b949e' };

const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const countLabel = (n) => n === 0 ? 'no contributions' : n === 1 ? '1 contribution' : `${num(n)} contributions`;
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

// Several lines; browsers show the line breaks in the tooltip.
function tooltip(d) {
  const lines = [dayLabel(d.date), countLabel(d.count)];
  const repos = d.repos ?? [];
  for (const r of repos.slice(0, 5)) lines.push(`${plural(r.commits, 'commit')} · ${r.repo}`);
  if (repos.length > 5) lines.push(`${plural(repos.slice(5).reduce((s, r) => s + r.commits, 0), 'commit')} in ${repos.length - 5} more repos`);
  const commits = repos.reduce((s, r) => s + r.commits, 0);
  const other = d.count - commits;
  if (repos.length && other > 0) lines.push(`${plural(other, 'other contribution')} (PRs, issues, reviews or private work)`);
  return lines.join('\n');
}

async function label3d(dir, days) {
  if (!days?.length) return;
  const best = days.reduce((a, b) => (b.count > a.count ? b : a));
  for (const name of Object.keys(THEMES)) {
    const file = join(dir, `3d-${name}.svg`);
    let svg;
    try { svg = await readFile(file, 'utf8'); } catch { continue; } // graph not drawn (local preview)

    const blocks = svg.match(BLOCK)?.length ?? 0;
    if (blocks !== days.length) {
      console.warn(`3d-${name}.svg has ${blocks} blocks for ${days.length} days; leaving it unlabelled`);
      continue;
    }
    let i = 0;
    svg = svg.replace(BLOCK, (g) => {
      const d = days[i++];
      return `${g}<title>${esc(tooltip(d))}</title>`;
    });
    if (best.count > 0) {
      const note = `Busiest day: ${dayLabel(best.date)} · ${countLabel(best.count)}`;
      svg = svg.replace(/<\/svg>\s*$/, `<text x="24" y="34" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif" font-size="15" fill="${LABEL_COLOR[name]}">${esc(note)}</text></svg>\n`);
    }
    await writeFile(file, svg);
    console.log(`labelled ${blocks} days in 3d-${name}.svg`);
  }
}

// ---------------------------------------------------------------- drawing helpers

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => n.toLocaleString('en-IN');
const monthYear = (iso) => new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const yearsSince = (iso, now) => Math.max(0, Math.floor((new Date(now) - new Date(iso)) / (365.25 * 864e5)));

function frame(t, w, h, title, body, extraCss = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
.sans{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
.in{animation:in .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
${extraCss}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>
<g class="sans">${body}</g>
</svg>
`;
}

function header(t, w, title, note) {
  return `<text x="24" y="38" font-size="15" font-weight="600" fill="${t.text}">${esc(title)}</text>
<text x="${w - 24}" y="38" text-anchor="end" class="mono" font-size="11" fill="${t.muted}">${esc(note)}</text>`;
}

// ---------------------------------------------------------------- cards

function statsCard(d, t) {
  const W = 480, H = 230;
  const rows = [
    ['Contributions, last 12 months', num(d.contrib12)],
    ['Contributions, all time', num(d.contribAll)],
    ['Commits, last 12 months', num(d.commits12)],
    ['Pull requests and reviews, last 12 months', num(d.prs12)],
    ['Public repositories', num(d.publicRepos)],
    ['Stars earned  ·  followers', `${num(d.stars)}  ·  ${num(d.followers)}`],
    ['On GitHub since', monthYear(d.createdAt)],
  ];
  const body = rows.map(([label, value], i) => {
    const y = 74 + i * 22;
    return `<g class="in" style="animation-delay:${(0.05 * i).toFixed(2)}s">
<text x="24" y="${y}" font-size="13" fill="${t.muted}">${esc(label)}</text>
<text x="${W - 24}" y="${y}" text-anchor="end" class="mono" font-size="13" font-weight="600" fill="${t.text}">${esc(value)}</text>
</g>`;
  }).join('\n');
  return frame(t, W, H, `GitHub stats for ${d.name}`,
    `${header(t, W, 'GitHub stats', `updated ${day(d.updatedAt)}`)}
<line x1="24" y1="52" x2="${W - 24}" y2="52" stroke="${t.faint}"/>
${body}`);
}

function languagesCard(d, t) {
  const W = 480, H = 230;
  const all = d.languages.filter((l) => !SKIP_LANGS.has(l.name)).sort((a, b) => b.size - a.size);
  const total = all.reduce((s, l) => s + l.size, 0) || 1;
  const top = all.slice(0, 8);
  const rest = all.slice(8).reduce((s, l) => s + l.size, 0);
  const parts = top.map((l) => ({ ...l, pct: (l.size / total) * 100 }));
  if (rest > 0) parts.push({ name: 'Other', color: t.muted, pct: (rest / total) * 100 });

  // Stacked bar with 2px gaps; first and last segments rounded through a clip.
  const barX = 24, barW = W - 48, barY = 66, gap = 2;
  const usable = barW - gap * (parts.length - 1);
  let x = barX;
  const segs = parts.map((p, i) => {
    const w = Math.max(2, (p.pct / 100) * usable);
    const s = `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="8" fill="${p.color || t.muted}" style="animation:grow .8s ${(0.05 * i).toFixed(2)}s cubic-bezier(.2,.7,.2,1) both;transform-origin:${x.toFixed(1)}px 0"/>`;
    x += w + gap;
    return s;
  }).join('');

  const legend = parts.slice(0, 8).map((p, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = 24 + col * 220, ly = 110 + row * 28;
    const pct = p.pct >= 10 ? p.pct.toFixed(0) : p.pct.toFixed(1);
    return `<g class="in" style="animation-delay:${(0.3 + 0.04 * i).toFixed(2)}s">
<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${p.color || t.muted}"/>
<text x="${lx + 18}" y="${ly}" font-size="13" fill="${t.text}">${esc(p.name)}</text>
<text x="${lx + 196}" y="${ly}" text-anchor="end" class="mono" font-size="12" fill="${t.muted}">${pct}%</text>
</g>`;
  }).join('\n');

  return frame(t, W, H, `Most used languages of ${d.name}`,
    `${header(t, W, 'Most used languages', 'by code size')}
<line x1="24" y1="52" x2="${W - 24}" y2="52" stroke="${t.faint}"/>
<clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bar)">${segs}</g>
${legend}`,
    '@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}');
}

const TIERS = [['S', 1], ['A', 0.5], ['B', 0.15]];
function tier(value, sTarget) {
  if (!value) return '–';
  for (const [name, f] of TIERS) if (value >= sTarget * f) return name;
  return 'C';
}

function trophiesCard(d, t) {
  const W = 980, H = 132;
  const years = yearsSince(d.createdAt, d.updatedAt);
  const tiles = [
    { big: "SIH '23", label: 'Smart India Hackathon', value: 'Winner', star: true },
    { big: tier(d.contribAll, 3000), label: 'Contributions', value: num(d.contribAll) },
    { big: tier(d.commits12, 1500), label: 'Commits, 12 months', value: num(d.commits12) },
    { big: tier(d.publicRepos, 50), label: 'Repositories', value: num(d.publicRepos) },
    { big: tier(d.followers, 300), label: 'Followers', value: num(d.followers) },
    { big: tier(years, 8), label: 'Years on GitHub', value: String(years) },
  ];
  const tw = (W - 48 - 5 * 12) / 6;
  const body = tiles.map((tile, i) => {
    const x = 24 + i * (tw + 12), cx = x + tw / 2;
    return `<g class="in" style="animation-delay:${(0.06 * i).toFixed(2)}s">
<rect x="${x.toFixed(1)}" y="20" width="${tw.toFixed(1)}" height="92" rx="8" fill="none" stroke="${tile.star ? t.accent : t.faint}"/>
<text x="${cx.toFixed(1)}" y="${tile.star ? 58 : 60}" text-anchor="middle" font-size="${tile.star ? 22 : 30}" font-weight="700" fill="${t.accent}">${esc(tile.big)}</text>
<text x="${cx.toFixed(1)}" y="82" text-anchor="middle" font-size="11.5" fill="${t.muted}">${esc(tile.label)}</text>
<text x="${cx.toFixed(1)}" y="100" text-anchor="middle" class="mono" font-size="12" font-weight="600" fill="${t.text}">${esc(tile.value)}</text>
</g>`;
  }).join('\n');
  return frame(t, W, H, `Trophies for ${d.name}`, body);
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = arg('--out') ?? 'dist';
const sample = arg('--data');

let data;
if (sample) {
  data = JSON.parse(await readFile(sample, 'utf8'));
  if (data.entries) attachCommits(data.days, data.entries); // raw API entries in a sample file
} else {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GITHUB_TOKEN (the workflow passes it in).');
  data = await collect(token);
}

await mkdir(out, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(join(out, `stats-${name}.svg`), statsCard(data, t));
  await writeFile(join(out, `languages-${name}.svg`), languagesCard(data, t));
  await writeFile(join(out, `trophies-${name}.svg`), trophiesCard(data, t));
}
await label3d(out, data.days);
console.log(`cards written to ${out}/ for ${data.name}`);
