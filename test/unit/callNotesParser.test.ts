import { describe, it, expect } from 'vitest';
import { parseActionItems, formatActionItemsAsMarkdown } from '../../src/views/callNotesParser.js';

describe('callNotesParser', () => {
  it('parses simple list items with assignee and date', () => {
    const raw = `- @alice Implement feature X by 2026-05-01\n- TODO @bob: Follow up on rollout 2026-06-15`;
    const items = parseActionItems(raw);
    expect(items.length).toBe(2);
    expect(items[0].assignee).toBe('alice');
    expect(items[0].due).toBe('2026-05-01');
    expect(items[1].assignee).toBe('bob');
    expect(items[1].due).toBe('2026-06-15');
  });

  it('formats items as markdown checklist with metadata', () => {
    const items = [{ text: 'Do thing', assignee: 'sam', due: '2026-07-01' }];
    const md = formatActionItemsAsMarkdown(items as any);
    expect(md).toContain('- [ ] Do thing');
    expect(md).toContain('@sam');
    expect(md).toContain('due:2026-07-01');
  });
});
