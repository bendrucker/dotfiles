// Column alignment for the reports these scripts print.
//
// `column -t` is the shell answer and it has to be fed through a pipe, which
// means the rows have to survive as text with the tabs still in them. Doing it
// here keeps the rows as rows until the moment they are printed.

// Pad every column but the last, so a table reads down its columns without
// needing `column` on the machine that prints it. Two spaces between columns
// and no trailing whitespace, matching `column -t -s '\t'`.
export function alignColumns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }

  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}
