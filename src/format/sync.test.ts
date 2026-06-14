
import { describe, it, expect } from 'vitest';
import {
  parseConstraintsMdString,
  serializeConstraintsMd,
} from './sync.js';

// ---------------------------------------------------------------------------
// Helper — build a minimal ConstraintRow with sensible defaults.
// ---------------------------------------------------------------------------

function row(overrides: any): any {
  return {
    id: 1,
    constraint_text: 'Test constraint',
    level: 'hard',
    source: 'manual',
    confidence: 'high',
    flag: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseConstraintsMdString
// ---------------------------------------------------------------------------

describe('parseConstraintsMdString', () => {
  it('parses frontmatter version/last_updated/last_synced', () => {
    const md = `---
version: 5
last_updated: 2025-01-15T10:00:00Z
last_synced: 2025-01-14T08:30:00Z
---

# Constraints

## Architectural Boundaries

_(none)_`;

    const result = parseConstraintsMdString(md);

    expect(result.frontmatter.version).toBe(5);
    expect(result.frontmatter.last_updated).toBe('2025-01-15T10:00:00Z');
    expect(result.frontmatter.last_synced).toBe('2025-01-14T08:30:00Z');
  });

  it('parses bracketed [Cnnn] entry with hard/manual/high', () => {
    const md = `---
version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints

## Architectural Boundaries

- [C042] (hard, manual, high) Must not call payment logic from UI`;

    const result = parseConstraintsMdString(md);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.id).toBe(42);
    expect(entry.level).toBe('hard');
    expect(entry.source).toBe('manual');
    expect(entry.confidence).toBe('high');
    expect(entry.text).toBe('Must not call payment logic from UI');
    expect(entry.flag).toBeNull();
  });

  it('parses flagged entry with em-dash flagged suffix', () => {
    const emDash = '\u2014'; // Unicode U+2014 EM DASH
    const md = `---
version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints

## \u26a0 Flagged for Review

- [C001] (soft, auto, medium) Some constraint text${emDash} flagged: stale edge detected`;

    const result = parseConstraintsMdString(md);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.id).toBe(1);
    expect(entry.flag).toBe('stale edge detected');
    expect(entry.level).toBe('soft');
    expect(entry.source).toBe('auto');
    expect(entry.confidence).toBe('medium');
    expect(entry.text).toBe('Some constraint text');
  });

  it('unbracketed under Architectural Boundaries = hard/manual/high', () => {
    const md = `---
version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints

## Architectural Boundaries

- No direct imports across domain boundaries`;

    const result = parseConstraintsMdString(md);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.id).toBeNull();
    expect(entry.level).toBe('hard');
    expect(entry.source).toBe('manual');
    expect(entry.confidence).toBe('high');
    expect(entry.text).toBe('No direct imports across domain boundaries');
    expect(entry.flag).toBeNull();
  });

  it('unbracketed under Technology Constraints = soft/manual/high', () => {
    const md = `---
version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints

## Technology Constraints

- Prefer TypeScript over JavaScript`;

    const result = parseConstraintsMdString(md);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.id).toBeNull();
    expect(entry.level).toBe('soft');
    expect(entry.source).toBe('manual');
    expect(entry.confidence).toBe('high');
    expect(entry.text).toBe('Prefer TypeScript over JavaScript');
    expect(entry.flag).toBeNull();
  });

  it('EC-TS-06: unbracketed in Flagged section throws ERR unknown constraint id', () => {
    const md = `---
version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints

## \u26a0 Flagged for Review

- This unbracketed text should fail`;

    expect(() => parseConstraintsMdString(md)).toThrow('ERR unknown constraint id: <none>');
  });

  it('throws on missing frontmatter --- delimiter', () => {
    const md = `version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints`;

    expect(() => parseConstraintsMdString(md)).toThrow(/malformed/);
  });

  it('throws on missing version field', () => {
    const md = `---
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints`;

    expect(() => parseConstraintsMdString(md)).toThrow(/malformed/);
  });

  it('EC-TS-03: unchanged entry parses without error', () => {
    const md = `---
version: 1
last_updated: 2025-01-01T00:00:00Z
last_synced: 2025-01-01T00:00:00Z
---

# Constraints

## Architectural Boundaries

- [C001] (hard, manual, high) Must use TypeScript`;

    // Parsing an unchanged entry should not throw.
    const result = parseConstraintsMdString(md);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe(1);
    expect(result.entries[0]!.text).toBe('Must use TypeScript');
  });
});

// ---------------------------------------------------------------------------
// serializeConstraintsMd
// ---------------------------------------------------------------------------

describe('serializeConstraintsMd', () => {
  it('writes YAML frontmatter with incremented version', () => {
    const rows = [row({ id: 1, constraint_text: 'Keep it simple' })];
    const output = serializeConstraintsMd(rows, 3, null);

    // Version should be prevVersion + 1 = 4
    expect(output).toMatch(/^version: 4$/m);
    expect(output).toMatch(/^last_updated: .+$/m);
    expect(output).toMatch(/^last_synced: $/m); // null -> empty string
  });

  it('EC-TS-02: hard + flag=null goes to Architectural Boundaries section', () => {
    const rows = [
      row({ id: 10, level: 'hard', flag: null, constraint_text: 'Hard constraint' }),
    ];
    const output = serializeConstraintsMd(rows, 0, null);

    expect(output).toContain('## Architectural Boundaries');
    expect(output).toContain('[C010] (hard, manual, high) Hard constraint');
    // Must NOT appear in Flagged section (flag is null)
    const flaggedSection = output.split('## \u26a0 Flagged for Review')[1] ?? '';
    expect(flaggedSection).toContain('_(none)_');
  });

  it('EC-TS-02: soft + flag=null goes to Technology Constraints section', () => {
    const rows = [
      row({ id: 2, level: 'soft', flag: null, constraint_text: 'Soft constraint' }),
    ];
    const output = serializeConstraintsMd(rows, 0, null);

    expect(output).toContain('## Technology Constraints');
    expect(output).toContain('[C002] (soft, manual, high) Soft constraint');
  });

  it('EC-TS-02: flag != null goes to Flagged section ONLY (not duplicated)', () => {
    const rows = [
      row({ id: 3, level: 'hard', flag: 'stale edge', constraint_text: 'Flagged constraint' }),
      row({ id: 4, level: 'soft', flag: 'violation', constraint_text: 'Soft flagged' }),
    ];
    const output = serializeConstraintsMd(rows, 0, null);

    // Both should appear ONLY in Flagged section.
    expect(output).toContain('## \u26a0 Flagged for Review');
    expect(output).toContain('[C003] (hard, manual, high) Flagged constraint \u2014 flagged: stale edge');
    expect(output).toContain('[C004] (soft, manual, high) Soft flagged \u2014 flagged: violation');

    // Must NOT appear in Architectural Boundaries or Technology Constraints.
    const archSection = output.split('## Architectural Boundaries')[1] ?? '';
    const techSection = archSection.split('## Technology Constraints')[1] ?? '';

    expect(archSection.split('##')[0]).not.toContain('C003');
    expect(archSection.split('##')[0]).not.toContain('C004');
  });

  it('empty rows -> all sections say _(none)_', () => {
    const output = serializeConstraintsMd([], 0, null);

    expect(output).toContain('## Architectural Boundaries');
    expect(output).toContain('_(none)_');
    expect(output).toContain('## Technology Constraints');
    expect(output).toContain('## \u26a0 Flagged for Review');
    // Should have three '_(none)_' occurrences (one per section)
    const noneCount = (output.match(/\b_\(none\)_\b/g) ?? []).length;
    expect(noneCount).toBe(3);
  });

  it('last_synced carried forward from prevLastSynced', () => {
    const rows: any[] = [];
    const prevSynced = '2025-06-15T12:00:00Z';
    const output = serializeConstraintsMd(rows, 7, prevSynced);

    expect(output).toMatch(/^last_synced: 2025-06-15T12:00:00Z$/m);
  });

  it('last_synced defaults to empty string when null', () => {
    const rows: any[] = [];
    const output = serializeConstraintsMd(rows, 0, null);

    // When prevLastSynced is null, it should become an empty string.
    expect(output).toMatch(/^last_synced: $/m);
  });
});
