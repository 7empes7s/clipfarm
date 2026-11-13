import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { IntegrationId, KeyTestResult } from "../../shared/types.js";
import { SETTING_NAMES } from "./integrations.js";

interface SavedValue {
  value: string;
  savedAt: string;
}

interface SecretsFile {
  values: Record<string, SavedValue>;
  tests: Partial<Record<IntegrationId, KeyTestResult>>;
  /** Isolation groups' app keys and proxies, and the tokens of channels connected here, by name. */
  vault?: Record<string, string>;
}

/** The password inside a saved proxy address, as typed and as it is written in an address. */
function proxyPasswords(value: string): string[] {
  if (!/^(https?|socks5?):\/\//.test(value)) return [];
  try {
    const { password } = new URL(value);
    return password ? [password, decodeURIComponent(password)] : [];
  } catch {
    return [];
  }
}

/** Values shorter than this are not worth hiding (and hiding them would blank out ordinary words). */
const MIN_SCRUB_LENGTH = 6;

/**
 * The one place keys are read from. A key pasted in Settings is kept in `DATA_DIR/secrets.json`
 * (mode 600, written atomically) and wins over the server's env, which stays as the fallback.
 * Reads are from memory, so a saved key is in use on the very next call: no restart.
 * Values never leave this class except through `get`/`env` (for the calls that need them).
 */
export class Settings {
  private data: SecretsFile & { vault: Record<string, string> } = { values: {}, tests: {}, vault: {} };
  private listeners: (() => void)[] = [];

  /** `file` null keeps everything in memory (tests, and callers that only want the env). */
  constructor(
    private file: string | null,
    private baseEnv: NodeJS.ProcessEnv = {},
    private now: () => Date = () => new Date(),
  ) {
    if (!file) return;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SecretsFile>;
      for (const [name, v] of Object.entries(parsed.values ?? {})) {
        // Only the settings this screen owns: the file cannot switch off the access gate or move folders.
        if (SETTING_NAMES.has(name) && typeof v?.value === "string" && v.value) {
          this.data.values[name] = { value: v.value, savedAt: String(v.savedAt) };
        }
      }
      this.data.tests = parsed.tests ?? {};
      for (const [name, v] of Object.entries(parsed.vault ?? {})) if (typeof v === "string" && v) this.data.vault[name] = v;
    } catch {
      // Never print the file: it holds keys.
      console.error("The saved keys file could not be read, so it is ignored. Paste the keys again in Settings.");
    }
  }

  /** The value in use: the saved one, else the server's env. Empty counts as not set. */
  get(name: string): string | undefined {
    return this.data.values[name]?.value || this.baseEnv[name] || undefined;
  }

  source(name: string): "settings" | "env" | null {
    if (this.data.values[name]) return "settings";
    return this.baseEnv[name] ? "env" : null;
  }

  savedAt(name: string): string | null {
    return this.data.values[name]?.savedAt ?? null;
  }

  /** The server's env with the saved values on top, for code that reads settings by name. */
  env(): NodeJS.ProcessEnv {
    const saved = Object.fromEntries(Object.entries(this.data.values).map(([name, v]) => [name, v.value]));
    return { ...this.baseEnv, ...saved };
  }

  /** Saves the given values (null removes one) and forgets the test results of `retest`. */
  save(values: Record<string, string | null>, retest: IntegrationId[] = []): void {
    const savedAt = this.now().toISOString();
    for (const [name, value] of Object.entries(values)) {
      if (!SETTING_NAMES.has(name)) throw new Error(`Unknown setting ${name}.`);
      if (value === null || value === "") delete this.data.values[name];
      else this.data.values[name] = { value, savedAt };
    }
    for (const id of retest) delete this.data.tests[id];
    this.write();
    for (const fn of this.listeners) fn();
  }

  testResult(id: IntegrationId): KeyTestResult | null {
    return this.data.tests[id] ?? null;
  }

  setTestResult(id: IntegrationId, result: KeyTestResult): void {
    this.data.tests[id] = result;
    this.write();
  }

  /** A group's app key or proxy, or a connected channel's token. Never sent to the screen. */
  secret(name: string): string | undefined {
    return this.data.vault[name] || undefined;
  }

  /** Saves one of those (null or empty removes it). */
  setSecret(name: string, value: string | null): void {
    if (value) this.data.vault[name] = value;
    else delete this.data.vault[name];
    this.write();
  }

  /** Removes every secret whose name starts with `prefix` (a removed group or channel). */
  dropSecrets(prefix: string): void {
    for (const name of Object.keys(this.data.vault)) if (name.startsWith(prefix)) delete this.data.vault[name];
    this.write();
  }

  /** Called after every save or remove (the watchlist checks again at once). */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Takes every key in use (saved or from env) out of a text before it is shown, stored or logged. */
  scrub(text: string): string {
    let out = text;
    for (const [name, secret] of SETTING_NAMES) {
      if (!secret) continue;
      for (const value of new Set([this.data.values[name]?.value, this.baseEnv[name]])) {
        if (value && value.length >= MIN_SCRUB_LENGTH) out = out.split(value).join("***");
      }
    }
    // Longest first, so a proxy address goes as a whole before its password does.
    const hidden = Object.values(this.data.vault).flatMap((value) => [value, ...proxyPasswords(value)]);
    for (const value of [...new Set(hidden)].sort((a, b) => b.length - a.length)) {
      if (value.length >= MIN_SCRUB_LENGTH) out = out.split(value).join("***");
    }
    return out;
  }

  private write(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    // Written next to the file and renamed over it: a crash mid-write leaves the old file whole.
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(this.data, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // An old tmp file (or an odd umask) must not decide who can read the keys.
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}
