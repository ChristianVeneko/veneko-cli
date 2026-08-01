/**
 * Builds a small multi-page PDF in memory so tests do not depend on a real
 * document on disk. Object offsets are computed as the file is assembled.
 */
export function buildMinimalPdf(pageLabels: string[]): Buffer {
  const objects: string[] = [];

  const pageObjectNumber = (index: number) => 3 + index * 2;
  const contentObjectNumber = (index: number) => 4 + index * 2;
  const fontObjectNumber = 3 + pageLabels.length * 2;

  const kids = pageLabels.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(" ");

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageLabels.length} >>`);

  for (const [index, label] of pageLabels.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] ` +
      `/Contents ${contentObjectNumber(index)} 0 R ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> >>`
    );

    const stream = `BT /F1 24 Tf 30 150 Td (${label}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}
