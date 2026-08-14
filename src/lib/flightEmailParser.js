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

function parseAirlineEmail({ subject, body, senderDomain }) {
  if (/airindia\.com/i.test(senderDomain || '')) {
    const result = parseAirIndiaEmail({ subject, body });
    if (result) return result;
  }
  return parseGenericAirlineEmail({ subject, body, senderDomain });
}

module.exports = { parseAirlineEmail, parseAirIndiaEmail, parseGenericAirlineEmail, parseAirIndiaDate };
