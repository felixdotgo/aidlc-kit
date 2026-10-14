const REDACTED = '[REDACTED]';
export const redactText = (input, secrets = []) => {
  let s = String(input);
  for (const secret of [...secrets].filter(x => typeof x === 'string' && x.length).sort((a,b) => b.length-a.length)) s = s.split(secret).join(REDACTED);
  s = s.replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, REDACTED);
  s = s.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+\/_.=-]+/gi, match => match.split(/\s/)[0] + ' ' + REDACTED);
  s = s.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, REDACTED);
  s = s.replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret|token|authorization|client[_-]?secret)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, '$1' + REDACTED);
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1' + REDACTED + '@');
  s = s.replace(/([?&](?:key|api_key|apikey|token|access_token|password|secret)=)[^&#\s]+/gi, '$1' + REDACTED);
  return s;
};
export const redact = (value, secrets = []) => {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(?:password|passwd|token|accessToken|apiKey|authorization|privateKey|clientSecret)$/i.test(k) ? REDACTED : redact(v, secrets)]));
  return value;
};
