
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const CONFIDENCE_THRESHOLD = 0.90; 

/**
 * Normalizes a company/clinic name for comparison:
 * lowercase, "&" -> "and", strip everything that isn't a-z or 0-9.
 * @param {string} name
 * @returns {string}
 */
function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Levenshtein edit distance between two strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prevRow = new Array(n + 1);
  const currRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1,
        prevRow[j] + 1, 
        prevRow[j - 1] + cost 
      );
    }
    for (let j = 0; j <= n; j++) prevRow[j] = currRow[j];
  }
  return prevRow[n];
}

/**
 * Similarity score between two normalized strings, 0 (completely
 * different) to 1 (identical), based on Levenshtein distance relative
 * to the longer string's length.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshtein(a, b);
  return 1 - distance / maxLen;
}

/**
 * Matches a filename-derived client name against a list of Seazona
 * clients (as returned by GET /v1/clients/?lastModified=).
 *
 * @param {string} filenameClientName - client name parsed from the PDF filename
 * @param {Array<{id: string, company: string, [key: string]: any}>} clients - Seazona clients list
 * @returns {{
 *   matched: boolean,
 *   clientId: string|null,
 *   matchedCompany: string|null,
 *   matchType: 'exact-normalized' | 'fuzzy' | 'none',
 *   confidence: number,
 *   candidates: Array<{clientId: string, company: string, confidence: number}>,
 * }}
 */
export function matchClient(filenameClientName, clients) {
  const normalizedTarget = normalize(filenameClientName);

  
  for (const client of clients) {
    if (normalize(client.company) === normalizedTarget) {
      return {
        matched: true,
        clientId: client.id,
        matchedCompany: client.company,
        matchType: 'exact-normalized',
        confidence: 1,
        candidates: [],
      };
    }
  }

 
  const scored = clients
    .map((client) => ({
      clientId: client.id,
      company: client.company,
      confidence: similarity(normalizedTarget, normalize(client.company)),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];

  if (best && best.confidence >= CONFIDENCE_THRESHOLD) {
    return {
      matched: true,
      clientId: best.clientId,
      matchedCompany: best.company,
      matchType: 'fuzzy',
      confidence: best.confidence,
      candidates: scored.slice(0, 5),
    };
  }

 
  return {
    matched: false,
    clientId: null,
    matchedCompany: null,
    matchType: 'none',
    confidence: best ? best.confidence : 0,
    candidates: scored.slice(0, 5),
  };
}


const __filename = fileURLToPath(import.meta.url);
if (resolve(__filename) === resolve(process.argv[1] ?? '')) {
  const filenameClientName = process.argv[2];
  const clientsJsonPath = process.argv[3];

  if (!filenameClientName || !clientsJsonPath) {
    console.error('Usage: node match-client.js "<filename client name>" <path-to-clients.json>');
    process.exit(1);
  }

  const clients = JSON.parse(readFileSync(clientsJsonPath, 'utf-8'));
  const result = matchClient(filenameClientName, clients);
  console.log(JSON.stringify(result, null, 2));
}