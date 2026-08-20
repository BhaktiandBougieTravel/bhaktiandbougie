// src/lib/flightEmailParser.js
// Pure parsing functions for airline change/cancellation emails.
// No DB access, no side effects. Input: {subject, body, senderDomain}. Output: parsed object or null.

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseAirIndiaDate(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].slice(0,3).toLowerCase()];
  if (month === undefined) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function parseAirIndiaEmail({ subject = '', body = '' }) {
  const text = body || '';
  const subjectFlightMatch = subject.match(/\bAI\s?(\d{2,4})\b/i);
  const flightNumber = subjectFlightMatch ? `AI ${subjectFlightMatch[1]}` : null;

  const isCancellation = /cancel/i.test(subject) || /cancel/i.test(text);
  const isScheduleChange = /schedule.*chang/i.test(subject) || /schedule.*chang/i.test(text);

  const depTimeMatch = text.match(/NEW DEPARTURE TIME\s+(\d{1,2}:\d{2})/i);
  const arrTimeMatch = text.match(/NEW ARRIVAL TIME\s+(\d{1,2}:\d{2})/i);
  const originMatch = text.match(/ORIGIN\s+([A-Z]{3})/);
  const destMatch = text.match(/DESTINATION\s+([A-Z]{3})/);
  const dateMatches = [...text.matchAll(/DATE\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/gi)];
  const bookingRefMatch = text.match(/booking reference[:\s]+([A-Z0-9]{5,8})/i) || text.match(/pnr=([A-Z0-9]{5,8})/i);

  if (!flightNumber || !bookingRefMatch) return null;

  const result = {
    airline: 'Air India',
    flightNumber,
    bookingRef: bookingRefMatch[1].toUpperCase(),
    emailType: isCancellation ? 'cancellation' : (isScheduleChange ? 'schedule_change' : 'other'),
    originAirport: originMatch ? originMatch[1] : null,
    destAirport: destMatch ? destMatch[1] : null,
    newDepartureTime: depTimeMatch ? depTimeMatch[1] : null,
    newArrivalTime: arrTimeMatch ? arrTimeMatch[1] : null,
    newDepartureDate: dateMatches[0] ? parseAirIndiaDate(dateMatches[0][1]) : null,
    newArrivalDate: dateMatches[1] ? parseAirIndiaDate(dateMatches[1][1]) : null,
    confidence: 'high',
    parser: 'air_india_v1'
  };

  if (isCancellation && !depTimeMatch) result.confidence = 'low';
  if (/reissu/i.test(text)) result.confidence = 'low';

  return result;
}

function parseIndiGoDate(day, mon, refDate) {
  const month = MONTHS[mon.slice(0,3).toLowerCase()];
  if (month === undefined) return null;
  let year = refDate.getUTCFullYear();
  if (month < refDate.getUTCMonth() - 6) year += 1;
  return new Date(Date.UTC(year, month, parseInt(day, 10))).toISOString().slice(0, 10);
}

function toHHMM(raw) {
  if (!raw || raw.length !== 4) return null;
  return `${raw.slice(0,2)}:${raw.slice(2)}`;
}

function parseIndiGoEmail({ subject = '', body = '', emailDate }) {
  const text = body || '';
  const refDate = emailDate instanceof Date && !isNaN(emailDate) ? emailDate : new Date();

  const pnrMatch = text.match(/PNR-([A-Z0-9]{5,8})/i);
  const flightMatch = text.match(/\b([0-9A-Z]{1,2}\s?\d{2,4}),\s*([A-Z]{3})-([A-Z]{3})\s+(\d{4})-(\d{4})\s+hrs/i);
  const revisedMatch = text.match(/revised time for your flight is\s+(\d{4})-(\d{4})\s+hrs\s+on\s+(\d{1,2})\s?([A-Za-z]{3})/i);
  const isCancellation = /cancel(led|lation)/i.test(subject) && !/reschedul/i.test(text);
  const isScheduleChange = /reschedul|revised|schedule.*chang/i.test(text);

  if (!flightMatch || !pnrMatch) return null;

  return {
    airline: 'IndiGo',
    flightNumber: flightMatch[1].replace(/\s+/g, ' ').trim(),
    bookingRef: pnrMatch[1].toUpperCase(),
    emailType: isCancellation ? 'cancellation' : (isScheduleChange ? 'schedule_change' : 'other'),
    originAirport: flightMatch[2],
    destAirport: flightMatch[3],
    newDepartureTime: revisedMatch ? toHHMM(revisedMatch[1]) : null,
    newArrivalTime: revisedMatch ? toHHMM(revisedMatch[2]) : null,
    newDepartureDate: revisedMatch ? parseIndiGoDate(revisedMatch[3], revisedMatch[4], refDate) : null,
    newArrivalDate: revisedMatch ? parseIndiGoDate(revisedMatch[3], revisedMatch[4], refDate) : null,
    confidence: revisedMatch ? 'high' : 'low',
    parser: 'indigo_v1'
  };
}

function parseGenericAirlineEmail({ subject = '', body = '', senderDomain = '' }) {
  const text = `${subject}\n${body}`;
  const flightMatch = text.match(/\b([A-Z0-9]{2}\s?\d{2,4})\b/);
  const isCancellation = /cancel/i.test(text);
  const isScheduleChange = /schedule|chang|reschedul|revised|delay/i.test(text);
  if (!flightMatch) return null;

  return {
    airline: null,
    senderDomain,
    flightNumber: flightMatch[1],
    bookingRef: null,
    emailType: isCancellation ? 'cancellation' : (isScheduleChange ? 'schedule_change' : 'other'),
    originAirport: null, destAirport: null,
    newDepartureTime: null, newArrivalTime: null,
    newDepartureDate: null, newArrivalDate: null,
    confidence: 'low',
    parser: 'generic_fallback_v1'
  };
}

function parseAirlineEmail({ subject, body, senderDomain, emailDate }) {
  if (/airindia\.com/i.test(senderDomain || '')) {
    const result = parseAirIndiaEmail({ subject, body });
    if (result) return result;
  }
  if (/goindigo\.in/i.test(senderDomain || '')) {
    const result = parseIndiGoEmail({ subject, body, emailDate });
    if (result) return result;
  }
  return parseGenericAirlineEmail({ subject, body, senderDomain });
}

module.exports = { parseAirlineEmail, parseAirIndiaEmail, parseIndiGoEmail, parseGenericAirlineEmail, parseAirIndiaDate };
