function writeWord(bytes, value) {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function buildRgb332Palette() {
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const r = ((i >> 5) & 0x07) * 255 / 7;
    const g = ((i >> 2) & 0x07) * 255 / 7;
    const b = (i & 0x03) * 255 / 3;
    const base = i * 3;
    palette[base] = Math.round(r);
    palette[base + 1] = Math.round(g);
    palette[base + 2] = Math.round(b);
  }
  return palette;
}

export function quantizeImageDataToRgb332(imageData) {
  const src = imageData.data || imageData;
  const out = new Uint8Array(Math.floor(src.length / 4));
  for (let i = 0, j = 0; i < src.length; i += 4, j += 1) {
    out[j] = ((src[i] & 0xe0) | ((src[i + 1] & 0xe0) >> 3) | ((src[i + 2] & 0xc0) >> 6));
  }
  return out;
}

function packCodesLsb(codes) {
  const out = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const { code, size } of codes) {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) {
    out.push(bitBuffer & 0xff);
  }
  return out;
}

function lzwEncode(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const maxCode = 4095;

  let dict = new Map();
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  const resetDict = () => {
    dict = new Map();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  const codes = [];
  const pushCode = (code) => {
    codes.push({ code, size: codeSize });
  };

  resetDict();
  pushCode(clearCode);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const value = indices[i];
    const key = `${prefix},${value}`;
    if (dict.has(key)) {
      prefix = dict.get(key);
      continue;
    }

    pushCode(prefix);

    if (nextCode <= maxCode) {
      dict.set(key, nextCode);
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize += 1;
      } else if (nextCode > maxCode) {
        pushCode(clearCode);
        resetDict();
      }
    } else {
      pushCode(clearCode);
      resetDict();
    }

    prefix = value;
  }

  pushCode(prefix);
  pushCode(endCode);

  const packed = packCodesLsb(codes);
  const blocks = [];
  for (let i = 0; i < packed.length; i += 255) {
    const chunk = packed.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return new Uint8Array(blocks);
}

export function encodeIndexedGif({ width, height, frames, delayMs = 84, loop = 0 }) {
  if (!width || !height || !Array.isArray(frames) || !frames.length) {
    throw new Error("Invalid GIF payload");
  }

  const bytes = [];
  const palette = buildRgb332Palette();
  const delayCs = Math.max(1, Math.round(delayMs / 10));

  bytes.push(
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  );
  writeWord(bytes, width);
  writeWord(bytes, height);
  bytes.push(
    0xf7, // global color table, 8-bit
    0x00, // background index
    0x00, // aspect
  );
  for (let i = 0; i < palette.length; i += 1) {
    bytes.push(palette[i]);
  }

  // Netscape loop extension.
  bytes.push(
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01,
  );
  writeWord(bytes, loop);
  bytes.push(0x00);

  for (const frame of frames) {
    if (!(frame instanceof Uint8Array) || frame.length !== width * height) {
      throw new Error("Invalid GIF frame");
    }

    bytes.push(
      0x21, 0xf9, 0x04,
      0x04, // no transparency, disposal = restore to background
    );
    writeWord(bytes, delayCs);
    bytes.push(0x00, 0x00);

    bytes.push(0x2c);
    writeWord(bytes, 0);
    writeWord(bytes, 0);
    writeWord(bytes, width);
    writeWord(bytes, height);
    bytes.push(0x00);
    bytes.push(0x08);

    const imageData = lzwEncode(frame, 8);
    for (let i = 0; i < imageData.length; i += 1) {
      bytes.push(imageData[i]);
    }
  }

  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
