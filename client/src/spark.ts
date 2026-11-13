// Drawing maths for the small dashboard graphics, kept pure so they can be unit tested.

/** An SVG path through the values, left to right, the highest at the top; "" under two values. */
export function sparkPath(values: number[], width: number, height: number, pad = 2): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - 2 * pad);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Dash lengths that fill a ring of radius `r` by done/total. */
export function ringDash(done: number, total: number, r: number): { dash: number; gap: number } {
  const c = 2 * Math.PI * r;
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return { dash: c * share, gap: c * (1 - share) };
}
