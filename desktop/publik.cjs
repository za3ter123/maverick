// publik API as one provider option (https://publikhq.com/developers). CommonJS port of the reference module
// https://publikhq.com/sdk/publik.ts.md. Resolution order: the user's own connections in Settings stay as they are;
// publik is used only when the user picks it or accepts DISCLOSURE on first run. For the publik connection the key
// comes from PUBLIK_API_KEY, else this app's credential file, else provision() after the user's yes.
// The pk_ key stays in Node (this module, serve.mjs's /bridge/publik/v1 proxy); it never reaches the page.
const { randomUUID } = require('node:crypto');
const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { arch, homedir, hostname, platform } = require('node:os');
const { dirname, join } = require('node:path');

const APP_SLUG = 'maverick';
const APP_VERSION = require('../package.json').version;
const DEFAULT_BASE_URL = 'https://publikhq.com/api/v1';
/** Ask for a tier, never a vendor model name. */
const MODELS = { fast: 'publik-fast', balanced: 'publik-balanced', smart: 'publik-smart' };
/** Show this and get a yes BEFORE provision(). */
const DISCLOSURE =
  'This app can use publik API for its AI features: no key to paste, priced per use in dollars from a publik balance that starts at $0.00. ' +
  "Linking this computer to a publik account gives $0.05 of free use, once. Your prompts go through publik's servers to the model; you can switch to your own key at any time.";

const isPublikUrl = (u) => {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && x.hostname === 'publikhq.com'; } catch { return false; }
};
// test/publik-proof.mjs only: PUBLIK_TEST_BASE_URL points every call at a local mock, and is ignored unless its host is 127.0.0.1.
function testBase() {
  const v = process.env.PUBLIK_TEST_BASE_URL;
  try { return v && new URL(v).hostname === '127.0.0.1' ? v.replace(/\/+$/, '') : null; } catch { return null; }
}
/** The base URL every request goes to: the test mock, else `wanted` if it is https on publikhq.com, else the default. */
const baseUrl = (wanted) => testBase() || (isPublikUrl(wanted) ? String(wanted).replace(/\/+$/, '') : DEFAULT_BASE_URL);

/** The app token. Public by design (it can only mint capped keys attributed to this app), so publik-app-token.txt is
 *  committed and read from this module's folder or the nearest parent (packaged: the resources folder).
 *  PUBLIK_APP_TOKEN in the environment overrides it. */
function appToken() {
  const env = process.env.PUBLIK_APP_TOKEN?.trim();
  if (env) return env;
  for (let dir = __dirname; ; dir = dirname(dir)) {
    const file = join(dir, 'publik-app-token.txt');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    if (dirname(dir) === dir) return '';
  }
}

/** ~/Library/Application Support/publik/apps/<slug>.json, %LOCALAPPDATA%\publik\apps\<slug>.json, ~/.config/publik/apps/<slug>.json */
function credentialPath() {
  const os = platform();
  const base =
    os === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : os === 'win32' ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'publik', 'apps', `${APP_SLUG}.json`);
}

// The credential file is untrusted: a key that is not a pk_ string makes it null; every other field is typed here,
// URLs kept only when they are https on publikhq.com.
const str = (v) => (typeof v === 'string' ? v : null);
const url = (v) => (isPublikUrl(v) ? v : null);
function readCredential() {
  try {
    const c = JSON.parse(readFileSync(credentialPath(), 'utf8'));
    if (!c || typeof c.key !== 'string' || !c.key.startsWith('pk_')) return null;
    return {
      key: c.key, base_url: baseUrl(c.base_url), install_id: str(c.install_id) ?? '',
      claim_url: url(c.claim_url), claim_state: c.claim_state === 'claimed' ? 'claimed' : 'anonymous',
      add_credit_url: url(c.add_credit_url), cost_sentence: str(c.cost_sentence),
      balance_micros: Number.isFinite(c.balance_micros) ? c.balance_micros : null,
    };
  } catch {
    return null;
  }
}

function writeCredential(c) {
  const file = credentialPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** { baseURL, apiKey, credential } for the publik connection, or null until the user accepts DISCLOSURE. */
function resolveProvider() {
  if (process.env.PUBLIK_API_KEY) return { baseURL: baseUrl(process.env.PUBLIK_API_BASE_URL), apiKey: process.env.PUBLIK_API_KEY, credential: null };
  const c = readCredential();
  return c ? { baseURL: c.base_url, apiKey: c.key, credential: c } : null;
}

/** Call only after the user accepted DISCLOSURE. Throws a readable message; the caller offers the user's own key. */
async function provision() {
  const token = appToken();
  if (!token.startsWith('pat_')) throw new Error('This build has no publik API app token. Use your own key for now.');
  const prior = readCredential();
  let installId = prior?.install_id || randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${baseUrl()}/installs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_token: token, app_slug: APP_SLUG, app_version: APP_VERSION,
        os: platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : 'linux',
        arch: arch(), device_name: hostname().slice(0, 120), install_id: installId,
        disclosure_version: 1, dialects: ['chat_completions'],
      }),
    });
    const body = await res.json().catch(() => ({}));
    const key = str(body.key) ?? (res.status === 200 ? prior?.key ?? null : null);
    if ((res.status === 201 || res.status === 200) && key?.startsWith('pk_')) {
      const c = {
        key, base_url: baseUrl(body.base_url), install_id: str(body.install_id) ?? installId,
        claim_url: url(body.claim_url), claim_state: body.claim_state === 'claimed' ? 'claimed' : 'anonymous',
        add_credit_url: url(body.wallet?.add_credit_url), cost_sentence: str(body.disclosure?.cost),
        balance_micros: Number.isFinite(body.balance_micros) ? body.balance_micros : null,
      };
      writeCredential(c); // the key reaches disk before anything else sees it
      return c;
    }
    // A replay with no key on disk, or an install its owner revoked: one fresh install_id.
    if (res.status === 200 || body.error?.type === 'install_revoked') { installId = randomUUID(); continue; }
    throw new Error(body.error?.message ?? `publik API could not set up this computer (${res.status}). Use your own key for now.`);
  }
  throw new Error('publik API could not set up this computer. Use your own key for now.');
}

/** Builder check, run by the BUILT app: start it with PUBLIK_SELF_TEST=1, print this line, exit.
 *  It provisions for real; the builder who runs it is the consent. */
async function selfTest() {
  try {
    return `publik self-test: ok ${APP_SLUG} ${APP_VERSION} (install ${(await provision()).install_id.slice(0, 8)})`;
  } catch (e) {
    return `publik self-test: failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** First-run card, line 1. Then keep it live from the x-publik-balance header. A new install is $0.00 until it is linked. */
function balanceLine(micros, claimState = 'anonymous') {
  if (micros == null) return '';
  const dollars = `$${(micros / 1_000_000).toFixed(2)}`;
  return micros === 0 && claimState === 'anonymous' ? `${dollars} · link this computer for $0.05 of free use` : `${dollars} of publik balance`;
}

/** A 402 renders its message plus exactly ONE link: this one (only an https publikhq.com link). */
function topUpUrlFrom402(body) {
  const e = body?.error;
  return { message: str(e?.message) ?? 'Not enough publik API balance.', url: url(e?.top_up_url) };
}

/** What the page may see of a credential: never the key. */
const card = (c) => (c ? {
  claim_url: c.claim_url, claim_state: c.claim_state, add_credit_url: c.add_credit_url, cost_sentence: c.cost_sentence,
  balance: balanceLine(c.balance_micros, c.claim_state),
} : null);

module.exports = {
  APP_SLUG, APP_VERSION, DEFAULT_BASE_URL, MODELS, DISCLOSURE, isPublikUrl, baseUrl, credentialPath, readCredential,
  resolveProvider, provision, selfTest, balanceLine, topUpUrlFrom402, card,
};
