
import { pathToFileURL } from 'url';
import { basename } from 'node:path';

/**
 * @param {string} filename 
 * @returns {{
 *   ok: boolean,
 *   clientName: string|null,
 *   patientLastName: string|null,
 *   patientFirstName: string|null,
 *   patientFullName: string|null,
 *   bodyPartInfo: string|null,
 *   dateRaw: string|null,
 *   timeRaw: string|null,
 *   createdAt: Date|null,
 *   error: string|null,
 * }}
 */

function applyPdfFallback(result, pdfMetadata = {}) {
  const clinicName = pdfMetadata.clinicName || null;
  const pdfPatientName = pdfMetadata.clientName?.trim() || null;
  const nameParts = pdfPatientName ? pdfPatientName.split(/\s+/) : [];
  const hasPdfFallback = Boolean(clinicName || pdfPatientName);

  return {
    ...result,

    clientName: result.clientName || clinicName,
    clinicName: clinicName || result.clinicName || null,

    patientFirstName: result.patientFirstName || nameParts[0] || null,
    patientLastName:
      result.patientLastName ||
      (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
    patientFullName: result.patientFullName || pdfPatientName,

    address: pdfMetadata.address || null,
    city: pdfMetadata.city || null,
    postalCode: pdfMetadata.postalCode || null,
    phone: pdfMetadata.phone || null,
    shoeSize: pdfMetadata.shoeSize || null,
    age: pdfMetadata.age || null,
    sex: pdfMetadata.sex || null,
    weight: pdfMetadata.weight || null,
    numberOfPairs: pdfMetadata.numberOfPairs ?? 2,

    bodyPartInfo: result.bodyPartInfo || pdfMetadata.bodyPartInfo || null,
    dateRaw: result.dateRaw || pdfMetadata.dateRaw || null,
    timeRaw: result.timeRaw || pdfMetadata.timeRaw || null,
    createdAt: result.createdAt || null,

    ok: result.ok || hasPdfFallback,
    complete: result.ok || Boolean(clinicName && pdfPatientName),
    source: result.ok ? 'filename' : hasPdfFallback ? 'pdf-fallback' : 'none',
    filenameError: result.ok ? null : result.error,
    error: result.ok || hasPdfFallback ? null : result.error,
  };
}

export function parseFilename(filename, pdfMetadata = {}) {
  const base = basename(filename).replace(/\.pdf$/i, '').trim();
  const parts = base.split(' - ').map((p) => p.trim());

  const result = {
    ok: false,
    clientName: null,
    patientLastName: null,
    patientFirstName: null,
    patientFullName: null,
    bodyPartInfo: null,
    dateRaw: null,
    timeRaw: null,
    createdAt: null,
    error: null,
  };

  
  const finish = () => applyPdfFallback(result, pdfMetadata);

  if (parts.length !== 4) {
    result.error =
      `Expected 4 dash-separated segments, found ${parts.length}: ${JSON.stringify(parts)}`;
    return finish();
  }

  const [clientName, patientSegment, bodyPartInfo, dateTimeSegment] = parts;

  const patientMatch = patientSegment.match(/^([^,]+),\s*(.+)$/);
  if (!patientMatch) {
    result.error =
      `Could not parse patient name from "${patientSegment}" (expected "LastName, FirstName")`;
    return finish();
  }

  const [, lastName, firstName] = patientMatch;

  const dateTimeMatch = dateTimeSegment.match(/^(\d{8}),\s*(\d{6})$/);
  if (!dateTimeMatch) {
    result.error =
      `Could not parse date/time from "${dateTimeSegment}" (expected "YYYYMMDD, HHMMSS")`;
    return finish();
  }

  const [, dateRaw, timeRaw] = dateTimeMatch;

  const year = dateRaw.slice(0, 4);
  const month = dateRaw.slice(4, 6);
  const day = dateRaw.slice(6, 8);
  const hour = timeRaw.slice(0, 2);
  const minute = timeRaw.slice(2, 4);
  const second = timeRaw.slice(4, 6);
  const createdAt = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);

  if (isNaN(createdAt.getTime())) {
    result.error = `Parsed date/time "${dateRaw} ${timeRaw}" is not a valid date`;
    return finish();
  }

  result.ok = true;
  result.clientName = clientName;
  result.patientLastName = lastName.trim();
  result.patientFirstName = firstName.trim();
  result.patientFullName = `${firstName.trim()} ${lastName.trim()}`;
  result.bodyPartInfo = bodyPartInfo;
  result.dateRaw = dateRaw;
  result.timeRaw = timeRaw;
  result.createdAt = createdAt;

  return finish();
}


const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const filename = process.argv[2];
  if (!filename) {
    console.error('Usage: node parse-filename.js "<filename.pdf>"');
    process.exit(1);
  }
  const result = parseFilename(filename);
  console.log(JSON.stringify(result, null, 2));
}