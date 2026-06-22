import { existsSync, readFileSync } from 'node:fs';

// TODO(extract): the monolith parsed config/adapters.toml with `parseToml` from
// services/memory-mcp/src/gate.ts (gate-owned). That parser belongs to the
// sibling @justfortytwo/gate package, not here. Rather than copy it, we accept
// an injectable parser and ship a tiny flat-table fallback so this package can
// load its own adapter manifest standalone. On reconciliation, prefer:
//   import { parseToml } from '@justfortytwo/gate';
// and pass it in (or set it as the default) so behavior matches the gate exactly.

export interface AdaptersConfig {
  channelTelegramEnabled: boolean;
  attachments: { maxBytes: number; storeDir: string };
}

const DEFAULTS: AdaptersConfig = {
  channelTelegramEnabled: true,
  attachments: { maxBytes: 26214400, storeDir: 'inbox' }, // 25 MiB
};

/** Type of the gate's `parseToml`: every scalar comes back as a string. */
export type TomlParser = (text: string) => Record<string, unknown>;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/**
 * Minimal flat-table TOML reader (fallback only). Understands `[section]`
 * headers and `key = value` pairs, emitting dotted keys ("section.key") with
 * string values — matching the surface the original `parseToml` exposed for
 * adapters.toml. Not a general TOML implementation; replace with the gate parser.
 */
function fallbackParseToml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { section = header[1].trim(); continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const table = (out[section] ??= {}) as Record<string, unknown>;
    table[key] = value;
  }
  return out;
}

/** Load the drop-in adapter manifest. Secrets stay in env; this is selection + non-secret settings only. */
export function loadAdaptersConfig(path: string, parseToml: TomlParser = fallbackParseToml): AdaptersConfig {
  if (!existsSync(path)) return DEFAULTS;
  let o: Record<string, unknown>;
  try { o = parseToml(readFileSync(path, 'utf8')); } catch { return DEFAULTS; }

  // parseToml returns every scalar as a string — coerce here.
  const channel = asRecord(o['channel.telegram'] ?? asRecord(o['channel'])['telegram']);
  const att = asRecord(o['attachments']);
  const maxBytes = Number(att['max_bytes']);
  return {
    channelTelegramEnabled: channel['enabled'] === undefined ? true : channel['enabled'] === 'true',
    attachments: {
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULTS.attachments.maxBytes,
      storeDir: typeof att['store_dir'] === 'string' && att['store_dir'] ? att['store_dir'] as string : DEFAULTS.attachments.storeDir,
    },
  };
}
