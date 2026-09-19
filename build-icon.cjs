// 生成应用图标：紫橙渐变背景 + 白色官方牛头（参考用户提供的 fnOS LOGO）
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ICON_DIR = __dirname;

function makeSvg() {
  // 准确还原参考图中的白色牛头造型：对称月牙角 + 折线脸 + 右侧翼
  const bull = `
    <path fill="#ffffff" d="
      M26 30
      C 22 42, 30 52, 40 52
      C 36 46, 36 36, 44 30
      C 38 28, 30 28, 26 30 Z
      M102 30
      C 106 42, 98 52, 88 52
      C 92 46, 92 36, 84 30
      C 90 28, 98 28, 102 30 Z
      M44 50
      L84 50
      C 90 50, 94 46, 94 40
      C 94 34, 88 30, 82 30
      L 56 30
      L 56 86
      C 56 94, 62 100, 70 100
      L 78 100
      C 86 100, 92 94, 92 86
      L 92 76
      C 92 70, 98 68, 102 68
      L 108 68
      C 108 58, 100 50, 88 50
      L 70 50
      C 64 50, 58 52, 54 56 Z
    "/>
    <path fill="#ffffff" opacity="0" d=""/>
  `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 128 128">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#8b3cb0"/>
        <stop offset="50%" stop-color="#c8516e"/>
        <stop offset="100%" stop-color="#f5a04a"/>
      </linearGradient>
      <radialGradient id="hi" cx="35%" cy="25%" r="70%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/>
        <stop offset="55%" stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.18"/>
      </radialGradient>
    </defs>
    <rect x="0" y="0" width="128" height="128" rx="28" fill="url(#bg)"/>
    <rect x="0" y="0" width="128" height="128" rx="28" fill="url(#hi)"/>
    <g transform="translate(0,2) scale(1,1)">${bull}</g>
  </svg>`;
}

async function main() {
  const svg = makeSvg();
  await sharp(Buffer.from(svg)).png().toFile(path.join(ICON_DIR, 'icon.png'));
  console.log('✓ icon.png 已生成');

  try {
    const png256 = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
    const png48  = await sharp(Buffer.from(svg)).resize(48, 48).png().toBuffer();
    const png32  = await sharp(Buffer.from(svg)).resize(32, 32).png().toBuffer();
    const png16  = await sharp(Buffer.from(svg)).resize(16, 16).png().toBuffer();
    const ico = buildIco([png16, png32, png48, png256]);
    fs.writeFileSync(path.join(ICON_DIR, 'icon.ico'), ico);
    console.log('✓ icon.ico 已生成');
  } catch (e) {
    console.warn('ICO 生成失败（将使用 PNG）：', e.message);
  }
}

function getPngSize(buf) {
  return buf.readUInt32BE(20);
}

function buildIco(buffers) {
  const count = buffers.length;
  const headerSize = 6;
  const dirSize = 16 * count;
  let imageOffset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(dirSize);
  const images = [];
  let offset = imageOffset;
  buffers.forEach((buf, i) => {
    const size = buf.readUInt32BE(16) === 0x49484452 ? getPngSize(buf) : 256;
    dir.writeUInt8(size >= 256 ? 0 : size, i * 16 + 0);
    dir.writeUInt8(size >= 256 ? 0 : size, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2);
    dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(buf.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += buf.length;
    images.push(buf);
  });
  return Buffer.concat([header, dir, ...images]);
}

main().catch((e) => { console.error(e); process.exit(1); });
