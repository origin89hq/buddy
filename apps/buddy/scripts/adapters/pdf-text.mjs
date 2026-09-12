// Helpers over the output of pdf-lines.py: pages of lines, each line a list of
// words with x-ranges. A datasheet row is read by geometry, never by counting
// spaces, so a blank cell stays blank instead of shifting its neighbour over.

// Words separated by more than `gap` points belong to different cells.
export function groups(words, gap = 9) {
  const result = [];
  for (const word of words) {
    const last = result.at(-1);
    if (last && word.x0 - last.x1 <= gap) {
      last.words.push(word);
      last.x1 = word.x1;
      last.text += ` ${word.text}`;
    } else result.push({ x0: word.x0, x1: word.x1, text: word.text, words: [word] });
  }
  return result;
}

// Label is everything left of `splitX`; the value is the rest of the line.
export function labelValue(line, splitX) {
  const label = line.words.filter((w) => w.x0 < splitX),
    value = line.words.filter((w) => w.x0 >= splitX);
  return { label: label.map((w) => w.text).join(" "), value: value.map((w) => w.text).join(" ") };
}

// One line that names the models gives each model a column band, bounded by the
// midpoints to its neighbours. A cell belongs to every band it overlaps; a lone
// cell centred on the whole model area is a merged cell and belongs to all.
export function columnGrid(modelWords) {
  const centres = modelWords.map((w) => (w.x0 + w.x1) / 2);
  const bands = centres.map((c, i) => ({
    model: modelWords[i].text,
    x0: i === 0 ? modelWords[0].x0 - 4 : (centres[i - 1] + c) / 2,
    x1: i === centres.length - 1 ? modelWords[i].x1 + 40 : (c + centres[i + 1]) / 2,
  }));
  return { bands, labelEnd: bands[0].x0, centre: (bands[0].x0 + bands.at(-1).x1) / 2 };
}
export function cells(line, grid, gap = 9) {
  const label = line.words
    .filter((w) => w.x1 <= grid.labelEnd)
    .map((w) => w.text)
    .join(" ");
  const cellGroups = groups(
    line.words.filter((w) => w.x1 > grid.labelEnd),
    gap,
  );
  const values = grid.bands.map(() => undefined);
  for (const group of cellGroups) {
    const mid = (group.x0 + group.x1) / 2;
    const overlapping = grid.bands
      .map((b, i) => (group.x0 < b.x1 && group.x1 > b.x0 ? i : -1))
      .filter((i) => i >= 0);
    const merged =
      cellGroups.length === 1 && Math.abs(mid - grid.centre) < 20 && grid.bands.length > 1;
    for (const i of merged ? grid.bands.map((_, i) => i) : overlapping)
      values[i] = values[i] === undefined ? group.text : `${values[i]} ${group.text}`;
  }
  return { label, values };
}

export function pageOf(pages, number) {
  const page = pages.find((p) => p.page === number);
  if (!page) throw new Error(`PDF has no page ${number}`);
  return page;
}
export const findLine = (page, pattern) => page.lines.find((l) => pattern.test(l.text));
