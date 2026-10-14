const QUOTED_BLOCK = /<(pasted_content|system-reminder)\b[^>]*>[\s\S]*?<\/\1[^>]*>/g;

const PASTED_DOCUMENT = /^#/;

const ASKED_BY_VERB =
  /\b(?:ask|have|get|let|task|consult|with|if|until|once|whether|give|tell|send|reframe|use|kick off)\b(?:\s+\S+){0,4}?\s+fable\b(?!'?s\b)/i;

const ASKED_AS_SUBJECT =
  /\bfable\s+(?:to|should|agrees?|approves?|validate|review|design|plan|check|verify|look|decide)\b/i;

const ASKED_FOR_VIEW =
  /\bwhat (?:does|would|do) (?:you (?:or|and) )?fable\b|\bfable'?s\s+(?:take|opinion|view|read)\b/i;

const ASKED_BY_NAME = /\b(?:second (?:opinion|read)|stronger model)\b/i;

const ASKS = [ASKED_BY_VERB, ASKED_AS_SUBJECT, ASKED_FOR_VIEW, ASKED_BY_NAME];

export function asksSecondRead(text: string): boolean {
  const said = text.replace(QUOTED_BLOCK, " ").trim();
  if (PASTED_DOCUMENT.test(said)) return false;
  return ASKS.some((ask) => ask.test(said));
}
