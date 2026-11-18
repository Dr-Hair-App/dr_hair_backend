import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { R2ClinicalReportUploadStorage } from '../src/modules/admin/infrastructure/R2ClinicalReportUploadStorage.js';
import { setStorageBindings, clearStorageBindings } from '../src/shared/storage/runtime.js';

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG = (() => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
})();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
const WEBP = (() => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8X', 8);
  bytes.writeUInt32LE(10, 16);
  return bytes;
})();
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary');
const isobmffImage = (brand) => {
  const brandBytes = Buffer.from(brand);
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0);
  ispe.write('ispe', 4);
  ispe.writeUInt32BE(1, 12);
  ispe.writeUInt32BE(1, 16);
  return Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftyp'), brandBytes, Buffer.alloc(4), ispe]);
};
const AVIF = isobmffImage('avif');
const HEIC = isobmffImage('heic');

const zipEntry = (name, data = Buffer.alloc(0)) => {
  const filename = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  return Buffer.concat([header, filename, data]);
};
const centralEntry = (name, offset, size = 0) => {
  const filename = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(filename.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, filename]);
};
const zipEnd = (count, directorySize, directoryOffset) => {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return end;
};
const ooxml = (documentName, padding = Buffer.alloc(0)) => {
  const contentTypes = zipEntry('[Content_Types].xml');
  const extra = zipEntry('custom/data.bin', padding);
  const document = zipEntry(documentName);
  const locals = Buffer.concat([contentTypes, extra, document]);
  const centralOffset = locals.length;
  const central = Buffer.concat([
    centralEntry('[Content_Types].xml', 0),
    centralEntry('custom/data.bin', contentTypes.length, padding.length),
    centralEntry(documentName, contentTypes.length + extra.length),
  ]);
  return Buffer.concat([locals, central, zipEnd(3, central.length, centralOffset)]);
};

const fixtures = [
  ['application/pdf', Buffer.from('%PDF-1.7\nreport')],
  ['application/msword', OLE],
  ['application/vnd.ms-excel', OLE],
  ['application/vnd.ms-powerpoint', OLE],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ooxml('word/document.xml')],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ooxml('xl/workbook.xml')],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ooxml('ppt/presentation.xml')],
  ['text/plain', Buffer.from('Hemoglobin test result: normal\n')],
  ['image/jpeg', JPEG],
  ['image/png', PNG],
  ['image/webp', WEBP],
  ['image/gif', GIF],
  ['image/avif', AVIF],
  ['image/heic', HEIC],
];

test('clinical report R2 upload streams supported document and image formats privately', async () => {
  const stored = [];
  setStorageBindings({ MEDIA_BUCKET: {
    async put(key, value, options) { stored.push({ key, value: Buffer.from(value), options }); },
  } });
  try {
    const storage = new R2ClinicalReportUploadStorage();
    for (const [mimetype, bytes] of fixtures) {
      const file = await new Promise((resolve, reject) => {
        storage._handleFile({ params: { userId: '42' } }, {
          mimetype,
          originalname: `../private-${mimetype.split('/').pop()}`,
          stream: Readable.from([bytes]),
        }, (error, result) => error ? reject(error) : resolve(result));
      });
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.storedBytes, bytes.length);
      assert.equal(file.compressed, false);
      assert.equal(file.scanningStatus, 'not_scanned');
      assert.match(file.key, /^drhair\/private-reports\/user-42\/[a-f0-9-]+\./);
      assert.equal(stored.at(-1).options.customMetadata.visibility, 'private');
      assert.equal(stored.at(-1).options.customMetadata.scanningStatus, 'not_scanned');
      assert.deepEqual(stored.at(-1).value, bytes);
      assert.equal(file.sha256.length, 64);
    }
  } finally {
    clearStorageBindings();
  }
});

test('clinical report R2 upload rejects false MIME and malformed OOXML without storing an object', async () => {
  let putCalled = false;
  setStorageBindings({ MEDIA_BUCKET: {
    async put() { putCalled = true; },
  } });
  try {
    const storage = new R2ClinicalReportUploadStorage();
    for (const [mimetype, bytes] of [
      ['application/pdf', Buffer.from('not a PDF')],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ooxml('xl/workbook.xml')],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.concat([zipEntry('[Content_Types].xml'), zipEntry('word/document.xml')])],
      ['text/plain', Buffer.from([0, 1, 2, 3])],
    ]) {
      await assert.rejects(new Promise((resolve, reject) => {
        storage._handleFile({ params: { userId: '42' } }, {
          mimetype,
          originalname: 'false-type',
          stream: Readable.from([bytes]),
        }, (error, result) => error ? reject(error) : resolve(result));
      }), /contents do not match/);
    }
    assert.equal(putCalled, false);
  } finally {
    clearStorageBindings();
  }
});

test('valid Office entry names are verified from the ZIP directory after the first 64 KiB', async () => {
  const bytes = ooxml('word/document.xml', Buffer.alloc(70 * 1024, 0x61));
  let stored = false;
  setStorageBindings({ MEDIA_BUCKET: { async put() { stored = true; } } });
  try {
    const storage = new R2ClinicalReportUploadStorage();
    const result = await new Promise((resolve, reject) => {
      storage._handleFile({ params: { userId: '42' } }, {
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: 'valid.docx',
        stream: Readable.from([bytes]),
      }, (error, file) => error ? reject(error) : resolve(file));
    });
    assert.equal(result.bytes, bytes.length);
    assert.equal(stored, true);
  } finally {
    clearStorageBindings();
  }
});
