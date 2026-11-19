import { readFileSync } from 'node:fs';

const flags = {
  en: 'us', 'zh-CN': 'cn', hi: 'in', es: 'es', ar: 'sa',
  fr: 'fr', bn: 'bd', 'pt-BR': 'br', id: 'id', ur: 'pk'
};
const defaultCode = 'en';
const preferencesKey = 'panel-language';
const dictionaries = new Map();
const xmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const argumentsIn = /\{(\d+)\}/g;

function readLocale(code) {
  if (dictionaries.has(code)) return dictionaries.get(code);
  const xml = readFileSync(new URL(`locales/${code}.xml`, import.meta.url), 'utf8');
  const lines = xml.trim().split(/\r?\n/);
  const header = lines.shift();
  if (header !== '<?xml version="1.0" encoding="UTF-8"?>' ||
      lines.shift() !== `<messages language="${code}">` || lines.pop() !== '</messages>') {
    throw new Error(`Invalid locale XML: ${code}`);
  }
  const strings = Object.create(null);
  for (const line of lines) {
    const message = /^  <message id="([a-z][a-z0-9.-]*)">([^<]*)<\/message>$/.exec(line);
    if (!message || Object.hasOwn(strings, message[1])) throw new Error(`Invalid locale message: ${code}`);
    strings[message[1]] = message[2].replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => xmlEntities[name]);
  }
  dictionaries.set(code, strings);
  return strings;
}

function format(text, values) {
  return text?.replace(argumentsIn, (_, index) => values[index] ?? '') ?? '';
}

// Readers and the remote collector use the original notice text internally.
// Translate at the display boundary, including notices stored before a language switch.
const sourceStrings = readLocale('zh-CN');
export function sourceMessage(id, ...values) {
  return format(sourceStrings[id], values);
}

let fixedNotices, parameterizedNotices;
function indexNotices() {
  fixedNotices = new Map();
  parameterizedNotices = [];
  for (const [id, text] of Object.entries(sourceStrings)) {
    if (!id.startsWith('notice.') && id !== 'current-channel' && id !== 'current-conversation') continue;
    const tokens = text.split(argumentsIn);
    if (tokens.length === 1) {
      fixedNotices.set(text, id);
      continue;
    }
    const literals = tokens.filter((_, index) => index % 2 === 0);
    const params = tokens.filter((_, index) => index % 2 === 1).map(Number);
    const pattern = literals.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*?)');
    parameterizedNotices.push({ id, params, pattern: new RegExp(`^${pattern}$`, 's') });
  }
}

export async function createLocalePreferences(storage) {
  let code = await storage.get(preferencesKey).catch(() => undefined);
  if (typeof code !== 'string' || !Object.hasOwn(flags, code)) code = defaultCode;
  const english = readLocale(defaultCode);
  let strings = readLocale(code);
  let writing = Promise.resolve();
  let options;

  const t = (id, ...values) => format(strings[id] ?? english[id], values);
  function notice(value, depth = 0) {
    if (code === 'zh-CN' || typeof value !== 'string' || depth > 2) return value;
    if (!fixedNotices) indexNotices();
    const id = fixedNotices.get(value);
    if (id) return t(id);
    for (const entry of parameterizedNotices) {
      const match = entry.pattern.exec(value);
      if (!match) continue;
      const values = [];
      entry.params.forEach((index, i) => { values[index] = notice(match[i + 1], depth + 1); });
      return t(entry.id, ...values);
    }
    return value;
  }

  function response(includeOptions) {
    const result = { code, strings: { ...english, ...strings } };
    if (includeOptions) {
      options ??= Object.entries(flags).map(([language, flag]) => ({
        code: language,
        name: readLocale(language)['language-name'],
        flag: 'data:image/png;base64,' + readFileSync(new URL(`locales/flags/${flag}.png`, import.meta.url)).toString('base64')
      }));
      result.options = options;
    }
    return result;
  }

  function select(requested, onChange) {
    if (typeof requested !== 'string' || !Object.hasOwn(flags, requested)) {
      return Promise.reject(new Error('Unsupported locale'));
    }
    const selected = writing.then(async () => {
      if (code !== requested) {
        const next = readLocale(requested);
        await storage.set(preferencesKey, requested);
        code = requested;
        strings = next;
        onChange();
      }
      return response(false);
    });
    writing = selected.catch(() => {});
    return selected;
  }
  return { t, notice, response, select, flush: () => writing, get code() { return code; } };
}
