// Canonical source: ec-workspace/tools/action-pins/action-pins.mjs.
// Read-only checks and update proposals; never edits pins or opens pull requests.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function references(text, file) {
  const result = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*#/.test(line) || !/\buses['"]?\s*:/.test(line)) continue;
    const match = /^\s*(?:-\s*)?['"]?uses['"]?:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error(file + ':' + (index + 1) + ': unsupported uses syntax; use a single scalar line');
    const value = match[1];
    if (value.startsWith('./')) continue;
    if (value.startsWith('docker://')) {
      if (!/@sha256:[a-f0-9]{64}$/.test(value)) throw new Error(file + ':' + (index + 1) + ': Docker action requires an immutable digest');
      continue;
    }
    const ref = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)@([a-f0-9]{40})$/.exec(value);
    if (!ref) throw new Error(file + ':' + (index + 1) + ': remote action requires a full commit SHA');
    result.push({ action: ref[1], sha: ref[2], file, line: index + 1 });
  }
  return result;
}

export function check(repo) {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, '.github/action-pins.json'), 'utf8'));
  if (lock.version !== 1 || !Array.isArray(lock.actions)) throw new Error('Unsupported action lock');
  const found = [];
  for (const file of fs.readdirSync(path.join(repo, '.github/workflows')).filter(f => /\.ya?ml$/.test(f))) {
    found.push(...references(fs.readFileSync(path.join(repo, '.github/workflows', file), 'utf8'), file));
  }
  for (const ref of found) {
    if (!lock.actions.some(pin => pin.action === ref.action && pin.sha === ref.sha)) {
      throw new Error(ref.file + ':' + ref.line + ': SHA has no reviewed lock entry');
    }
  }
  return { lock, found };
}

export function candidates(pin, current, release) {
  const result = [];
  if (current && current.sha !== pin.sha) result.push({
    kind: 'tracked-ref-moved', action: pin.action, ref: pin.track, from: pin.sha, to: current.sha,
    compare: 'https://github.com/' + pin.source + '/compare/' + pin.sha + '...' + current.sha,
  });
  if (release && release.sha !== pin.sha && release.sha !== current?.sha) result.push({
    kind: 'release-review', action: pin.action, ref: release.tag, from: pin.sha, to: release.sha,
    compare: 'https://github.com/' + pin.source + '/compare/' + pin.sha + '...' + release.sha,
  });
  return result;
}

function api(endpoint, optional = false) {
  try {
    return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    if (optional && String(error.stderr).includes('HTTP 404')) return null;
    throw new Error('GitHub metadata request failed for ' + endpoint);
  }
}

export function propose(lock, get = api) {
  const updates = [], errors = [];
  const cache = new Map();
  const cached = (url, optional = false) => {
    if (!cache.has(url)) cache.set(url, get(url, optional));
    return cache.get(url);
  };
  for (const pin of lock.actions) {
    try {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.source) || !/^[a-f0-9]{40}$/.test(pin.sha)) throw new Error('Invalid lock entry');
      const current = pin.track ? cached('repos/' + pin.source + '/commits/' + encodeURIComponent(pin.track)) : null;
      const latest = cached('repos/' + pin.source + '/releases/latest', true);
      const release = latest?.tag_name && !latest.prerelease && !latest.draft
        ? { ...cached('repos/' + pin.source + '/commits/' + encodeURIComponent(latest.tag_name)), tag: latest.tag_name }
        : null;
      for (const candidate of [current, release]) if (candidate && !/^[a-f0-9]{40}$/.test(candidate.sha)) throw new Error('Upstream response has no full commit SHA');
      updates.push(...candidates(pin, current, release));
    } catch (error) {
      errors.push({ action: pin.action, message: error.message });
    }
  }
  return { checkedAt: new Date().toISOString(), automaticChanges: false, updates, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { lock, found } = check(process.cwd());
    console.log('Verified ' + found.length + ' pinned uses references.');
    if (process.argv.includes('--propose')) {
      const report = propose(lock);
      fs.writeFileSync('action-pin-proposals.json', JSON.stringify(report, null, 2) + '\n');
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          '## Action update review\n\n' + report.updates.length + ' upstream candidates; ' + report.errors.length +
          ' metadata errors. See the action-pin-proposals artifact. Review source diffs, runtime and permissions before changing a pin. No changes were applied.\n');
      }
      console.log(JSON.stringify({ candidates: report.updates.length, errors: report.errors.length }));
      if (report.errors.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
