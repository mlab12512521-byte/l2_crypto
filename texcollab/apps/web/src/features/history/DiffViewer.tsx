import { diffLines } from 'diff';
import { useMemo } from 'react';

interface Row {
  kind: 'same' | 'add' | 'del' | 'gap';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const CONTEXT = 3;

/** Unified line diff with line numbers; long unchanged stretches are collapsed. */
export function computeRows(oldText: string, newText: string): Row[] {
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    for (const line of lines) {
      if (part.added) rows.push({ kind: 'add', oldNo: null, newNo: n++, text: line });
      else if (part.removed) rows.push({ kind: 'del', oldNo: o++, newNo: null, text: line });
      else rows.push({ kind: 'same', oldNo: o++, newNo: n++, text: line });
    }
  }
  // Collapse unchanged runs longer than 2*CONTEXT+1 lines.
  const out: Row[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== 'same') {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'same') j++;
    const run = rows.slice(i, j);
    const atStart = i === 0;
    const atEnd = j === rows.length;
    const keepHead = atStart ? 0 : CONTEXT;
    const keepTail = atEnd ? 0 : CONTEXT;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      out.push({ kind: 'gap', oldNo: null, newNo: null, text: `${run.length - keepHead - keepTail} unchanged lines` });
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

export function DiffViewer({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => computeRows(oldText, newText), [oldText, newText]);
  if (oldText === newText) return <div className="empty-state muted">No changes in this file.</div>;
  return (
    <table className="diff">
      <tbody>
        {rows.map((r, idx) =>
          r.kind === 'gap' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for a given pair of texts
            <tr key={idx} className="diff-gap">
              <td colSpan={3}>⋯ {r.text}</td>
            </tr>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for a given pair of texts
            <tr key={idx} className={`diff-${r.kind}`}>
              <td className="diff-no">{r.oldNo ?? ''}</td>
              <td className="diff-no">{r.newNo ?? ''}</td>
              <td className="diff-text">
                <span className="diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                {r.text}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
