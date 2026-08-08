/**
 * Builds PDFs that contain real embedded image XObjects, so figure detection is
 * exercised against actual PDF structure rather than a mock of it.
 *
 * PDF user space puts the origin at the bottom-left, so a larger y is higher on
 * the page. The helpers below take that into account and let callers describe a
 * page top-down, the way it reads.
 */

/** A rectangle in PDF user space: x, y of the bottom-left corner, plus size. */
export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigurePageSpec {
  /** Lines of text, each with its baseline y. */
  text?: { y: number; content: string }[];
  /** Images placed directly on the page. */
  images?: ImageBox[];
  /**
   * Images placed through a form XObject that carries its own translation. Used
   * to prove the CTM walk follows form matrices.
   */
  formImages?: { translate: [number, number]; box: ImageBox }[];
  /** Stroked rectangles, the shape a vector diagram's boxes take. */
  strokedBoxes?: ImageBox[];
  /** Stroked straight lines, as used for arrows, rules and table gridlines. */
  lines?: { from: [number, number]; to: [number, number] }[];
  /** A clipping path set to this rectangle, which paints no ink at all. */
  clipTo?: ImageBox;
}

export interface FigurePdfOptions {
  pageWidth?: number;
  pageHeight?: number;
}

/** A 2x2 RGB bitmap. Small on purpose: the bytes only need to decode. */
const IMAGE_PIXELS = Buffer.from([
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 255,
]);

function escapeText(value: string): string {
  return value.replace(/([\\()])/g, "\\$1");
}

export function buildFigurePdf(
  pages: FigurePageSpec[],
  options: FigurePdfOptions = {}
): Buffer {
  const { pageWidth = 400, pageHeight = 600 } = options;
  const objects: string[] = [];

  /** Object numbers are 1-based and assigned as objects are pushed. */
  const push = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // Reserved: 1 catalog, 2 page tree. Filled in once the numbers are known.
  push("");
  push("");

  const fontNumber = push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const imageNumber = push(
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB ` +
    `/BitsPerComponent 8 /Length ${IMAGE_PIXELS.length} >>\n` +
    `stream\n${IMAGE_PIXELS.toString("latin1")}\nendstream`
  );

  const pageNumbers: number[] = [];

  for (const spec of pages) {
    const operators: string[] = [];

    if (spec.clipTo) {
      const { x, y, width, height } = spec.clipTo;
      // "W n" sets the clip and paints nothing, which pdf.js reports through the
      // same constructPath op as real drawing does.
      operators.push(`${x} ${y} ${width} ${height} re W n`);
    }

    for (const line of spec.text ?? []) {
      operators.push(`BT /F1 12 Tf 40 ${line.y} Td (${escapeText(line.content)}) Tj ET`);
    }

    for (const box of spec.images ?? []) {
      operators.push(`q ${box.width} 0 0 ${box.height} ${box.x} ${box.y} cm /Im1 Do Q`);
    }

    for (const box of spec.strokedBoxes ?? []) {
      operators.push(`${box.x} ${box.y} ${box.width} ${box.height} re S`);
    }

    for (const line of spec.lines ?? []) {
      operators.push(`${line.from[0]} ${line.from[1]} m ${line.to[0]} ${line.to[1]} l S`);
    }

    const formNumbers: number[] = [];

    for (const form of spec.formImages ?? []) {
      const { box } = form;
      const inner = `q ${box.width} 0 0 ${box.height} ${box.x} ${box.y} cm /Im1 Do Q`;
      const [tx, ty] = form.translate;

      formNumbers.push(
        push(
          `<< /Type /XObject /Subtype /Form /BBox [0 0 ${pageWidth} ${pageHeight}] ` +
          `/Matrix [1 0 0 1 ${tx} ${ty}] ` +
          `/Resources << /XObject << /Im1 ${imageNumber} 0 R >> >> ` +
          `/Length ${inner.length} >>\nstream\n${inner}\nendstream`
        )
      );
    }

    for (const [offset] of formNumbers.entries()) {
      operators.push(`/Fm${offset + 1} Do`);
    }

    const stream = operators.join("\n");
    const contentNumber = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

    const formResources =
      formNumbers.length > 0
        ? `/XObject << /Im1 ${imageNumber} 0 R ` +
          formNumbers.map((num, offset) => `/Fm${offset + 1} ${num} 0 R`).join(" ") +
          " >>"
        : `/XObject << /Im1 ${imageNumber} 0 R >>`;

    pageNumbers.push(
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Contents ${contentNumber} 0 R ` +
        `/Resources << /Font << /F1 ${fontNumber} 0 R >> ${formResources} >> >>`
      )
    );
  }

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] =
    `<< /Type /Pages /Kids [${pageNumbers.map((num) => `${num} 0 R`).join(" ")}] ` +
    `/Count ${pageNumbers.length} >>`;

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
