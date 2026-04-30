export interface ActionItem {
  text: string;
  assignee?: string;
  due?: string; // ISO date string when detected
}

const ASSIGNEE_RE = /@([a-zA-Z0-9_\-]+)/;
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

export function parseActionItems(raw: string): ActionItem[] {
  const lines = raw.split(/\r?\n/);
  const items: ActionItem[] = [];

  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    // Match list items or TODO/action markers
    if (/^(?:[-*]\s+|TODO[:\s]|ACTION[:\s])/i.test(trimmed)) {
      // remove leading marker
      const content = trimmed.replace(/^(?:[-*]\s+|TODO[:\s]+|ACTION[:\s]+)/i, '').trim();
      const assigneeMatch = content.match(ASSIGNEE_RE);
      const dateMatch = content.match(ISO_DATE_RE);
      const item: ActionItem = { text: content };
      if (assigneeMatch) item.assignee = assigneeMatch[1];
      if (dateMatch) item.due = dateMatch[1];
      items.push(item);
    }
  }

  return items;
}

export function formatActionItemsAsMarkdown(items: ActionItem[]): string {
  if (!items.length) return '- No action items detected.';
  return items.map(i => {
    const meta: string[] = [];
    if (i.assignee) meta.push(`@${i.assignee}`);
    if (i.due) meta.push(`due:${i.due}`);
    const metaStr = meta.length ? ` (${meta.join(' ')})` : '';
    return `- [ ] ${i.text}${metaStr}`;
  }).join('\n');
}
