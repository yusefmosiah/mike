/** One line of a line-by-line comparison. */
export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/**
 * The lines of `after` against `before`: kept, added and removed, in reading
 * order (a longest-common-subsequence diff). Sized for memory files (16 KiB),
 * not whole documents.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
    const a = before === "" ? [] : before.split("\n");
    const b = after === "" ? [] : after.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    const rows = endA - start;
    const columns = endB - start;
    // common[i][j]: the longest common run of a[start+i..] and b[start+j..].
    const common = new Uint32Array((rows + 1) * (columns + 1));
    const at = (i: number, j: number) => i * (columns + 1) + j;
    for (let i = rows - 1; i >= 0; i -= 1) {
        for (let j = columns - 1; j >= 0; j -= 1) {
            common[at(i, j)] =
                a[start + i] === b[start + j]
                    ? common[at(i + 1, j + 1)]! + 1
                    : Math.max(common[at(i + 1, j)]!, common[at(i, j + 1)]!);
        }
    }
    const lines: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
    let i = 0;
    let j = 0;
    while (i < rows || j < columns) {
        if (i < rows && j < columns && a[start + i] === b[start + j]) {
            lines.push({ kind: "same", text: a[start + i]! });
            i += 1;
            j += 1;
        } else if (j < columns && (i === rows || common[at(i, j + 1)]! >= common[at(i + 1, j)]!)) {
            lines.push({ kind: "added", text: b[start + j]! });
            j += 1;
        } else {
            lines.push({ kind: "removed", text: a[start + i]! });
            i += 1;
        }
    }
    for (const text of a.slice(endA)) lines.push({ kind: "same", text });
    return lines;
}
