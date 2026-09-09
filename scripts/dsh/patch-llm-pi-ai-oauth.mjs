#!/usr/bin/env node
// Replay OpenAI Codex OAuth support into the rc.6 pi-ai adapter after profile installs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const marker = 'SUPERHIGH_OPENAI_CODEX_OAUTH_V1'
const patchVersion = '0.1.0-rc.6'

function log(message) {
  console.log(`[patch-llm-pi-ai-oauth] ${message}`)
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label}: expected one exact anchor`)
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

function packageRoots() {
  const roots = [
    join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'),
    ...['dsh-tui', 'headless', 'tui', 'web'].map(profile =>
      join(homedir(), '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')),
  ]
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'))
  }
  return [...new Set(roots)]
}

const helper = `/** ${marker}: bridge DSH grant records to pi-ai OAuth and import an existing Codex login once. */
const OAUTH_CREDENTIAL_SCOPE = "llm-pi-ai";
const OPENAI_CODEX_PROVIDER = "openai-codex";
function oauthCredentialOf(record) {
\tif (record === void 0) return void 0;
\tif (record.kind !== "grant") throw new LlmError(\`llm-pi-ai OAuth record \"\${record.kind}\" has the wrong kind\`, "INVALID_CREDENTIAL");
\tconst value = record.payload;
\tif (typeof value !== "object" || value === null || Array.isArray(value) || value.type !== "oauth" || typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") throw new LlmError("llm-pi-ai OAuth grant is malformed", "INVALID_CREDENTIAL");
\treturn value;
}
function decodeJwtPayload(token) {
\tconst part = token.split(".")[1];
\tif (part === void 0) return void 0;
\ttry {
\t\treturn JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
\t} catch {
\t\treturn void 0;
\t}
}
async function importCodexLogin(providerId) {
\tif (providerId !== OPENAI_CODEX_PROVIDER) return void 0;
\tlet document;
\ttry {
\t\tdocument = JSON.parse(await readFile(join(homedir(), ".codex", "auth.json"), "utf8"));
\t} catch (error) {
\t\tif (error?.code === "ENOENT") return void 0;
\t\tthrow new LlmError("OpenAI Codex login cache is unreadable; run codex login again", "INVALID_CREDENTIAL", { cause: error });
\t}
\tconst tokens = document?.tokens;
\tconst access = tokens?.access_token;
\tconst refresh = tokens?.refresh_token;
\tconst payload = typeof access === "string" ? decodeJwtPayload(access) : void 0;
\tconst expires = typeof payload?.exp === "number" ? payload.exp * 1000 : Number.NaN;
\tconst accountId = tokens?.account_id ?? payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
\tif (typeof access !== "string" || access.length === 0 || typeof refresh !== "string" || refresh.length === 0 || !Number.isFinite(expires) || typeof accountId !== "string" || accountId.length === 0) throw new LlmError("OpenAI Codex login cache has no reusable ChatGPT OAuth grant; run codex login", "MISSING_CREDENTIAL");
\treturn { type: "oauth", access, refresh, expires, accountId };
}
function dshOAuthCredentialStore(ctx) {
\tconst service = () => {
\t\tconst credentials = ctx.get("credentials");
\t\tif (credentials === void 0) throw new LlmError("llm-pi-ai OAuth requires the DSH credentials service", "MISSING_CREDENTIAL");
\t\treturn credentials;
\t};
\tconst keyOf = (providerId) => credentialKey(OAUTH_CREDENTIAL_SCOPE, providerId);
\treturn {
\t\tasync read(providerId) {
\t\t\tconst credentials = service();
\t\t\tconst key = keyOf(providerId);
\t\t\tconst stored = oauthCredentialOf(await credentials.readRecord(key));
\t\t\tif (stored !== void 0) return stored;
\t\t\tconst imported = await importCodexLogin(providerId);
\t\t\tif (imported === void 0) return void 0;
\t\t\tconst post = await credentials.modifyRecord(key, async (current) => current === void 0 ? { kind: "grant", payload: imported } : void 0);
\t\t\treturn oauthCredentialOf(post);
\t\t},
\t\tasync list() {
\t\t\treturn (await service().listRecords()).filter(entry => entry.kind === "grant" && credentialKeyScope(entry.key) === OAUTH_CREDENTIAL_SCOPE).map(entry => ({ providerId: credentialKeyId(entry.key), type: "oauth" }));
\t\t},
\t\tasync modify(providerId, fn) {
\t\t\tconst post = await service().modifyRecord(keyOf(providerId), async (current) => {
\t\t\t\tconst next = await fn(oauthCredentialOf(current));
\t\t\t\treturn next === void 0 ? void 0 : { kind: "grant", payload: next };
\t\t\t});
\t\t\treturn oauthCredentialOf(post);
\t\t},
\t\tdelete: (providerId) => service().deleteRecord(keyOf(providerId))
\t};
}
`

function patchRuntime(path) {
  let source = readFileSync(path, 'utf8')
  if (source.includes(marker)) {
    log(`${path}: already patched`)
    return
  }
  source = replaceOnce(
    source,
    'import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";',
    'import { readFile } from "node:fs/promises";\nimport { homedir } from "node:os";\nimport { join } from "node:path";\nimport { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";',
    `${path} node imports`,
  )
  source = replaceOnce(
    source,
    'import { credentialRef } from "@deepseek-ai/dsh-credentials";',
    'import { credentialKey, credentialKeyId, credentialKeyScope, credentialRef } from "@deepseek-ai/dsh-credentials";',
    `${path} credential imports`,
  )
  source = replaceOnce(
    source,
    '\t\tconst models = createModels();',
    '\t\tconst models = createModels({ credentials: this.config.credentials });',
    `${path} Models credential store`,
  )
  source = replaceOnce(
    source,
    'function directoryEntries(profiles) {',
    `${helper}\nfunction directoryEntries(profiles) {`,
    `${path} OAuth helper insertion`,
  )
  source = replaceOnce(
    source,
    '\tfor (const provider of catalog) if (catalogProviderTakesApiKey(provider)) declare(provider, provider);',
    '\tfor (const provider of catalog) if (catalogProviderTakesApiKey(provider) || provider === OPENAI_CODEX_PROVIDER) declare(provider, provider);',
    `${path} OAuth provider directory`,
  )
  source = replaceOnce(
    source,
    '\t\tprofiles,\n\t\tresolveApiKey,',
    '\t\tprofiles,\n\t\tcredentials: dshOAuthCredentialStore(ctx),\n\t\tresolveApiKey,',
    `${path} adapter credential injection`,
  )
  writeFileSync(path, source, 'utf8')
  log(`${path}: patched`)
}

function patchTypes(path) {
  let source = readFileSync(path, 'utf8')
  if (source.includes(`${marker}: type surface`)) return
  source = replaceOnce(
    source,
    "import type { ResolvedPiAiProviderProfile } from './config.ts';",
    "import type { CredentialStore } from '@earendil-works/pi-ai';\nimport type { ResolvedPiAiProviderProfile } from './config.ts';",
    `${path} CredentialStore import`,
  )
  source = replaceOnce(
    source,
    '    /** Current validated profiles by provider route; called once per operation. */\n    profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>;',
    `    /** ${marker}: type surface for the DSH-backed OAuth store. */\n    credentials: CredentialStore;\n    /** Current validated profiles by provider route; called once per operation. */\n    profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>;`,
    `${path} CredentialStore option`,
  )
  writeFileSync(path, source, 'utf8')
}

function patchPackage(root) {
  if (!existsSync(root)) return false
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const runtime = join(root, 'lib', 'index.js')
  const runtimeSource = readFileSync(runtime, 'utf8')
  if (runtimeSource.includes('credentialStoreFrom(ctx)') && runtimeSource.includes('createModels(auth)')) {
    log(`${root}: native OAuth credential bridge already present in ${manifest.version}`)
    return true
  }
  if (manifest.version !== patchVersion) throw new Error(`${root}: unsupported adapter ${manifest.version}; expected native OAuth support or ${patchVersion}`)
  patchRuntime(runtime)
  const types = join(root, 'lib', 'types', 'adapter.d.ts')
  if (existsSync(types)) patchTypes(types)
  return true
}

function main() {
  let found = 0
  for (const root of packageRoots()) if (patchPackage(root)) found++
  if (found === 0) throw new Error('no dsh-llm-pi-ai package was found')
  log(`OAuth bridge ready in ${found} package copy/copies`)
}

try {
  main()
} catch (error) {
  console.error(`[patch-llm-pi-ai-oauth] ${error.message}`)
  process.exitCode = 1
}
