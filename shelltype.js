import { readFile, readdir } from 'fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { resolve, extname, join, basename } from 'path';

const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const FILL_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke]);

const flipY = (y, pageH) => pageH - y;

async function extractWords(page, pageH) {
  const { items } = await page.getTextContent();
  const words = [];
  for (const item of items) {
    const text = item.str?.trim();
    if (!text) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const h = item.height ?? 10;
    words.push({
      x0: x,
      y0: flipY(y + h, pageH),
      x1: x + (item.width ?? 0),
      y1: flipY(y, pageH),
      text,
    });
  }
  return words;
}

async function extractCirclesFromAnnotations(page, pageH) {
  const anns = await page.getAnnotations().catch(() => []);
  const circles = [];
  for (const ann of anns) {
    if (ann.subtype !== 'Widget') continue;
    if (!ann.radioButton && !ann.checkBox) continue;
    const [x0, y0, x1, y1] = ann.rect;
    const cx = (x0 + x1) / 2;
    const cy = flipY((y0 + y1) / 2, pageH);
    let filled = false;
    if (ann.radioButton) {
      filled =
        ann.fieldValue != null &&
        ann.fieldValue !== 'Off' &&
        (ann.buttonValue == null || ann.fieldValue === ann.buttonValue);
    } else if (ann.checkBox) {
      filled = ann.fieldValue === 'On' || ann.fieldValue === true;
    }
    circles.push({ cx, cy, filled });
  }
  return circles;
}

async function extractCirclesFromGraphics(page, pageH) {
  const { fnArray, argsArray } = await page.getOperatorList();
  let fillColor = [0, 0, 0];
  const circles = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === OPS.setFillRGBColor) {
      fillColor = [args[0], args[1], args[2]];
    } else if (fn === OPS.setFillGray) {
      fillColor = [args[0], args[0], args[0]];
    } else if (fn === OPS.setFillCMYKColor) {
      fillColor = [
        (1 - args[0]) * (1 - args[3]),
        (1 - args[1]) * (1 - args[3]),
        (1 - args[2]) * (1 - args[3]),
      ];
    } else if (fn === OPS.constructPath) {
      const paintOp = args[0];
      const bbox = args[2];
      if (!bbox) continue;
      const w = bbox[2] - bbox[0];
      const h = bbox[3] - bbox[1];
      if (w < 3 || w > 20 || h < 3 || h > 20 || Math.abs(w - h) >= 3) continue;
      const isWhite = fillColor[0] > 0.9 && fillColor[1] > 0.9 && fillColor[2] > 0.9;
      circles.push({
        cx: (bbox[0] + bbox[2]) / 2,
        cy: flipY((bbox[1] + bbox[3]) / 2, pageH),
        filled: FILL_OPS.has(paintOp) && !isWhite,
      });
    }
  }
  return circles;
}

async function parsePDF(pdfPath) {
  const data = new Uint8Array(await readFile(pdfPath));
  const pdfDoc = await getDocument({ data, verbosity: 0 }).promise;
  const page = await pdfDoc.getPage(1);
  const { width: pageW, height: pageH } = page.getViewport({ scale: 1 });

  
  const [words, annotCircles] = await Promise.all([
    extractWords(page, pageH),
    extractCirclesFromAnnotations(page, pageH),
  ]);

  const circles =
    annotCircles.length > 0
      ? annotCircles
      : await extractCirclesFromGraphics(page, pageH);

  return { words, circles, pageW, pageH };
}

function mergeCircles(circles) {
  const merged = [];
  for (const c of circles) {
    const existing = merged.find(
      (m) => Math.abs(m.cx - c.cx) < 2 && Math.abs(m.cy - c.cy) < 2
    );
    if (existing) {
      existing.filled = existing.filled || c.filled;
    } else {
      merged.push({ cx: c.cx, cy: c.cy, filled: c.filled });
    }
  }
  return merged;
}

function findNearestCircleLeft(labelWord, circles) {
  const labelCenterY = (labelWord.y0 + labelWord.y1) / 2;
  let best = null;
  for (const c of circles) {
    if (Math.abs(c.cy - labelCenterY) < 12 && c.cx < labelWord.x0) {
      if (!best || c.cx > best.cx) best = c;
    }
  }
  return best;
}

function findLabelWord(words, label) {
  const lower = label.toLowerCase();
  let partial = null;
  for (const w of words) {
    const t = w.text.toLowerCase();
    if (t === lower) return w;
    if (!partial && t.includes(lower)) partial = w;
  }
  return partial;
}


function extractNumberOfPairs(words) {
  const rows = [];

  for (const word of words) {
    const y = (word.y0 + word.y1) / 2;
    let row = rows.find((item) => Math.abs(item.y - y) < 6);

    if (!row) {
      row = { y, words: [] };
      rows.push(row);
    }

    row.words.push(word);
  }

  for (const row of rows) {
    const line = row.words
      .slice()
      .sort((a, b) => a.x0 - b.x0)
      .map((word) => word.text)
      .join(' ');

    if (!/\bnumber\s+of\s+pairs\b/i.test(line)) continue;

    const match = line.match(/\bnumber\s+of\s+pairs\b\s*:?\s*(\d+)\b/i);
    const count = match ? Number(match[1]) : NaN;

   
    return Number.isInteger(count) && count > 0 ? count : 2;
  }


  return 2;
}


const PDF_METADATA_LABELS = [
  'Clinic Name',
  'Client Name',
  'Shoe Size',
  'Address',
  'Age',
  'Number of Pairs',
  'City',
  'Postal Code',
  'Sex',
  'Weight',
  'Phone',
];

function getPdfTextLines(words) {
  const rows = [];

  for (const word of words) {
    const y = (word.y0 + word.y1) / 2;
    let row = rows.find((item) => Math.abs(item.y - y) < 6);

    if (!row) {
      row = { y, words: [] };
      rows.push(row);
    }

    row.words.push(word);
  }

  return rows.map((row) =>
    row.words
      .slice()
      .sort((a, b) => a.x0 - b.x0)
      .map((word) => word.text)
      .join(' ')
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPdfField(words, label) {
  const nextLabels = PDF_METADATA_LABELS
    .filter((otherLabel) => otherLabel !== label)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(label)}\\s*:\\s*(.*?)(?=\\s+(?:${nextLabels})\\s*:|$)`,
    'i'
  );

  for (const line of getPdfTextLines(words)) {
    const match = line.match(pattern);
    if (match && match[1].trim()) {
      return match[1].trim().replace(/\s+/g, ' ');
    }
  }

  return null;
}

function extractPdfMetadata(words) {
  return {
    clinicName: extractPdfField(words, 'Clinic Name'),
    clientName: extractPdfField(words, 'Client Name'),
    address: extractPdfField(words, 'Address'),
    city: extractPdfField(words, 'City'),
    postalCode: extractPdfField(words, 'Postal Code'),
    phone: extractPdfField(words, 'Phone'),
    shoeSize: extractPdfField(words, 'Shoe Size'),
    age: extractPdfField(words, 'Age'),
    sex: extractPdfField(words, 'Sex'),
    weight: extractPdfField(words, 'Weight'),
    numberOfPairs: extractNumberOfPairs(words),
  };
}





function extractNotes(words, pageWidth, pageHeight) {
  const notesLabel = findLabelWord(words, 'Notes');
  if (!notesLabel) return '';

  const boxLeft = notesLabel.x0 - 20;
  const boxTop = notesLabel.y1;

  const notesWords = words
    .filter(
      (w) =>
        w !== notesLabel &&
        w.x0 >= boxLeft &&
        w.x1 <= pageWidth + 5 &&
        w.y0 >= boxTop - 2 &&
        w.y1 <= pageHeight
    )
    .sort((a, b) => (Math.abs(a.y0 - b.y0) < 3 ? a.x0 - b.x0 : a.y0 - b.y0));

  if (notesWords.length === 0) return '';

  const lines = [];
  let currentLine = [];
  let currentY = null;
  for (const w of notesWords) {
    if (currentY === null || Math.abs(w.y0 - currentY) < 3) {
      currentLine.push(w.text);
      currentY = currentY ?? w.y0;
    } else {
      lines.push(currentLine.join(' '));
      currentLine = [w.text];
      currentY = w.y0;
    }
  }
  if (currentLine.length) lines.push(currentLine.join(' '));
  return lines.join('\n').trim();
}


const SINGLE_SELECT_GROUPS = {
  device: ['Casual', 'Dress', 'Sports', 'Pediatric UCBL', 'Diabetic', 'Pediatric Gait Plate'],
  length: ['3/4', 'Sulcus', 'Full-Length'],
  archProfile: ['High Arch', 'Medium Arch', 'Low Arch'],
  topCoverThickness: ['1/8', '1/16'],
  topCoverMaterial: ['No Top Cover', 'Premium Vinyl + Poron', 'Plastazote', 'Childrens Funtopy', 'ETC', 'Puff'],
  postingType: ['Intrinsic', 'Extrinsic'],
  heelCupDepth: ['8mm', '10mm', '14mm', '16mm', '18mm', '20mm'],
  metatarsalPadSize: ['Small', 'Medium', 'Large'],
};

const LR_ADDITIONS = [
  'Heel Bubble', 'Heel Hole', '1st Met cut out', '1st Ray cut out',
  'Mortons Extension', 'Reverse Mortons Extension', 'Heel Spur Pad',
  'Lateral Flange', 'Medial Flange', 'Neuroma Pad', 'Cuboid Pad',
  'Heel Pad', 'Metatarsal Bar', 'Toe Crest', 'Arch Pad', 'Arch Strips',
];

function findSelectedOption(words, circles, options) {
  for (const label of options) {
    const word = findLabelWord(words, label);
    if (!word) continue;
    const circle = findNearestCircleLeft(word, circles);
    if (circle?.filled) return label;
  }
  return null;
}

function findLR(words, circles, label) {
  const word = findLabelWord(words, label);
  if (!word) return { L: false, R: false };
  const y = (word.y0 + word.y1) / 2;
  const lineWords = words.filter(w => Math.abs((w.y0 + w.y1) / 2 - y) < 6);
  const lWord = lineWords.find(w => w.text === 'L');
  const rWord = lineWords.find(w => w.text === 'R');
  const boxNear = (letterWord) => {
    if (!letterWord) return false;
    let best = null;
    for (const c of circles) {
      if (Math.abs(c.cy - y) < 8 && c.cx > letterWord.x1 && c.cx - letterWord.x1 < 40) {
        if (!best || c.cx < best.cx) best = c;
      }
    }
    return best?.filled || false;
  };
  return { L: boxNear(lWord), R: boxNear(rWord) };
}

function extractFormFields(words, circles) {
  const device = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.device);
  const length = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.length);
  const archProfile = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.archProfile);
  const topCoverThickness = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.topCoverThickness);
  const topCoverMaterial = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.topCoverMaterial);
  const postingType = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.postingType);
  const heelCupDepth = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.heelCupDepth);
  const metatarsalPadSize = findSelectedOption(words, circles, SINGLE_SELECT_GROUPS.metatarsalPadSize);

  const additions = {};
  for (const label of LR_ADDITIONS) {
    const { L, R } = findLR(words, circles, label);
    if (L || R) additions[label] = { L, R };
  }
  const mp = findLR(words, circles, 'Metatarsal Pad');
  const metatarsalPad = (mp.L || mp.R) ? { ...mp, size: metatarsalPadSize } : null;

  return {
    device, length, archProfile,
    topCoverThickness, topCoverMaterial,
    postingType, heelCupDepth,
    additions, metatarsalPad,
  };
}

const SHELL_MATERIAL_BY_CATEGORY = {
  Accomodative: 'TPU EVA',
  Functional: 'Carbon Nylon',
};

const SHELL_SUB_OPTIONS_BY_CATEGORY = {
  Accomodative: ['Ex-Soft', 'Soft', 'Medium', 'Firm'],
  Functional: ['2mm', '3mm', '4mm'],
};

function shellTypeLabel(category, subOption) {
  if (!category) return 'Not specified';

  const material = SHELL_MATERIAL_BY_CATEGORY[category] || '';
  return subOption
    ? `${category} (${material}) – ${subOption}`
    : `${category} (${material})`;
}


export function formatWorkOrder({ device, category, subOption, length, archProfile,
  topCoverThickness, topCoverMaterial, postingType, additions, metatarsalPad,
  notes, numberOfPairs }) {
  const lines = [];
  lines.push('WORK ORDER TEMPLATE');
  lines.push('');
  lines.push('DEVICE SPECIFICATIONS');
  lines.push(`NUMBER OF PAIRS: ${numberOfPairs ?? 2}`);
  lines.push(`DEVICE: ${device || 'Not specified'}`);
  lines.push(`SHELL TYPE: ${shellTypeLabel(category, subOption)}`);
  lines.push(`LENGTH: ${length || 'Not specified'}`);
  lines.push(`ARCH PROFILE: ${archProfile || 'Not specified'}`);
  lines.push(`TOP COVER: Thickness ${topCoverThickness || 'See Notes'} / Material ${topCoverMaterial || 'See Notes'}`);

  lines.push('');
  lines.push('ADDITIONS');
  const entries = Object.entries(additions || {});
  if (entries.length === 0) {
    lines.push('— None');
  } else {
    for (const [name, { L, R }] of entries) {
      lines.push(`${name}: ${L && R ? 'L + R' : L ? 'L' : 'R'}`);
    }
  }
  if (metatarsalPad) {
    const side = metatarsalPad.L && metatarsalPad.R ? 'L + R' : metatarsalPad.L ? 'L' : 'R';
    lines.push(`Metatarsal Pad: ${side}${metatarsalPad.size ? ` (${metatarsalPad.size})` : ''}`);
  }

  lines.push('');
  lines.push('POSTING');
  lines.push(postingType ? `${postingType} Posting Selected — degrees TBD` : 'Not specified');

  lines.push('');
  lines.push('NOTES / SPECIAL INSTRUCTIONS');
  lines.push(notes || 'None');

  return lines.join('\n');
}

export async function getShellType(pdfPath) {
  const { circles: rawCircles, words, pageW, pageH } = await parsePDF(pdfPath);
  const circles = mergeCircles(rawCircles);

  let category = findSelectedOption(
    words,
    circles,
    Object.keys(SHELL_SUB_OPTIONS_BY_CATEGORY)
  );

  
  let subOption = category
    ? findSelectedOption(
        words,
        circles,
        SHELL_SUB_OPTIONS_BY_CATEGORY[category]
      )
    : null;

  if (!subOption) {
    for (const [candidateCategory, options] of Object.entries(
      SHELL_SUB_OPTIONS_BY_CATEGORY
    )) {
      const candidateSubOption = findSelectedOption(words, circles, options);

      if (candidateSubOption) {
        category = candidateCategory;
        subOption = candidateSubOption;
        break;
      }
    }
  }

  const material = category
    ? SHELL_MATERIAL_BY_CATEGORY[category]
    : null;

    const pdfMetadata = extractPdfMetadata(words);
    const numberOfPairs = pdfMetadata.numberOfPairs;
    const notes = extractNotes(words, pageW, pageH);
    const fields = extractFormFields(words, circles);
  
    const workOrderText = formatWorkOrder({
      ...fields,
      category,
      subOption,
      notes,
      numberOfPairs,
    });
  
    return {
      category,
      material,
      subOption,
      ...pdfMetadata,
      pdfMetadata,
      notes,
      fields,
      workOrderText,
    };
}



const CONCURRENCY = 6;

async function expandPaths(args) {
  const paths = [];
  for (const arg of args) {
    try {
      const entries = await readdir(arg);
      for (const entry of entries) {
        if (extname(entry).toLowerCase() === '.pdf') {
          paths.push(join(arg, entry));
        }
      }
    } catch {
      paths.push(arg);
    }
  }
  return paths;
}

async function processWithConcurrency(paths) {
  let idx = 0;
  async function worker() {
    while (idx < paths.length) {
      const pdfPath = paths[idx++];
      try {
        const result = await getShellType(pdfPath);
        process.stdout.write(JSON.stringify({ file: pdfPath, ...result }) + '\n');
      } catch (err) {
        process.stderr.write(JSON.stringify({ file: pdfPath, error: err.message }) + '\n');
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

const __filename = fileURLToPath(import.meta.url);
if (resolve(__filename) === resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node shelltype.js <file.pdf|folder> [file2.pdf ...]');
    process.exit(1);
  }
  const paths = await expandPaths(args);
  if (paths.length === 0) { console.error('No PDF files found.'); process.exit(1); }
  await processWithConcurrency(paths);
}