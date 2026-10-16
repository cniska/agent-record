const REDACTED = "[REDACTED]";

const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

const NAMED_SECRET = /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[=:]\s*["']?)[^\s"'`,;&]{8,}/gi;

const ENV_SECRET = /(\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|SECRET)=)(?:"[^"]*"|'[^']*'|[^\s"'`,;&]+)/g;

const maskedEnvValue = (assignment: string, name: string): string => {
  const quote = assignment.charAt(name.length);
  const quoted = quote === '"' || quote === "'" ? quote : "";
  return `${name}${quoted}${REDACTED}${quoted}`;
};

export function maskSecrets(text: string): string {
  const shaped = SECRET_SHAPES.reduce((kept, shape) => kept.replace(shape, REDACTED), text);
  return shaped
    .replace(BEARER, `$1${REDACTED}`)
    .replace(ENV_SECRET, maskedEnvValue)
    .replace(NAMED_SECRET, `$1${REDACTED}`);
}
