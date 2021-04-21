const zlib = require('zlib');
const SocketBuffer = require('../socketbuffer');

class Zrle {

    constructor() {

        this.zlib = zlib.createInflate({chunkSize: 16 * 1024 * 1024, flush: zlib.constants.Z_FULL_FLUSH});
        this.unBuffer = new SocketBuffer();

        this.zlib.on('data', async (chunk) => {
            this.unBuffer.pushData(chunk);
        });

    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket, depth) {

        return new Promise(async (resolve, reject) => {

            await socket.waitBytes(4);

            const initialOffset = socket.offset;
            const dataSize = socket.readUInt32BE();

            await socket.waitBytes(dataSize);

            const compressedData = socket.readNBytesOffset(dataSize);

            rect.data = socket.readNBytes(dataSize + 4, initialOffset);

            this.unBuffer.flush();
            this.zlib.write(compressedData, async () => {
                this.zlib.flush();

                let tiles;
                let totalTiles;
                let tilesX;
                let tilesY;

                tilesX = Math.ceil(rect.width / 64);
                tilesY = Math.ceil(rect.height / 64);
                tiles = tilesX * tilesY;
                totalTiles = tiles;

                while (tiles) {

                    await this.unBuffer.waitBytes(1, 'tile begin.');
                    const subEncoding = this.unBuffer.readUInt8();
                    const currTile = totalTiles - tiles;

                    const tileX = currTile % tilesX;
                    const tileY = Math.floor(currTile / tilesX);
                    const tx = rect.x + (tileX * 64);
                    const ty = rect.y + (tileY * 64);
                    const tw = Math.min(64, (rect.x + rect.width) - tx);
                    const th = Math.min(64, (rect.y + rect.height) - ty);

                    const now = process.hrtime.bigint();
                    let totalRun = 0;
                    let runs = 0;

                    if (subEncoding === 127 || subEncoding === 129) {
                        console.log('Invalid subencoding. ' + subEncoding);
                    } else if (subEncoding === 0) {
                        // Raw
                        for (let h = 0; h < th; h++) {
                            for (let w = 0; w < tw; w++) {
                                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                                if (bitsPerPixel === 8) {
                                    await this.unBuffer.waitBytes(1, 'raw 8bits');
                                    const index = this.unBuffer.readUInt8();
                                    const color = colorMap[index];
                                    // RGB
                                    // fb.writeUInt8(color?.r || 255, fbBytePosOffset);
                                    // fb.writeUInt8(color?.g || 255, fbBytePosOffset + 1);
                                    // fb.writeUInt8(color?.b || 255, fbBytePosOffset + 2);

                                    // BGR
                                    fb.writeUInt8(color?.r || 255, fbBytePosOffset + 2);
                                    fb.writeUInt8(color?.g || 255, fbBytePosOffset + 1);
                                    fb.writeUInt8(color?.b || 255, fbBytePosOffset);
                                } else if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                    await this.unBuffer.waitBytes(3, 'raw 24bits');
                                    fb.writeUInt8(this.unBuffer.readUInt8(), fbBytePosOffset + 2);
                                    fb.writeUInt8(this.unBuffer.readUInt8(), fbBytePosOffset + 1);
                                    fb.writeUInt8(this.unBuffer.readUInt8(), fbBytePosOffset);
                                } else if (bitsPerPixel === 32) {
                                    // RGB
                                    // fb.writeUInt8(rect.data.readUInt8(bytePosOffset), fbBytePosOffset);
                                    // fb.writeUInt8(rect.data.readUInt8(bytePosOffset + 1), fbBytePosOffset + 1);
                                    // fb.writeUInt8(rect.data.readUInt8(bytePosOffset + 2), fbBytePosOffset + 2);

                                    // BGR
                                    await this.unBuffer.waitBytes(4, 'raw 32bits');
                                    fb.writeUInt8(this.unBuffer.readUInt8(), fbBytePosOffset + 2);
                                    fb.writeUInt8(this.unBuffer.readUInt8(), fbBytePosOffset + 1);
                                    fb.writeUInt8(this.unBuffer.readUInt8(), fbBytePosOffset);
                                    this.unBuffer.readUInt8();
                                }
                                // Alpha
                                fb.writeUInt8(255, fbBytePosOffset + 3);
                            }
                        }
                    } else if (subEncoding === 1) {
                        // Single Color
                        let color = {r: 0, g: 0, b: 0, a: 255};
                        if (bitsPerPixel === 8) {
                            await this.unBuffer.waitBytes(1, 'single color 8bits');
                            const index = this.unBuffer.readUInt8();
                            color = colorMap[index];
                        } else if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                            await this.unBuffer.waitBytes(3, 'single color 24bits');
                            color.r = this.unBuffer.readUInt8();
                            color.g = this.unBuffer.readUInt8();
                            color.b = this.unBuffer.readUInt8();
                        } else if (bitsPerPixel === 32) {
                            await this.unBuffer.waitBytes(4, 'single color 32bits');
                            color.r = this.unBuffer.readUInt8();
                            color.g = this.unBuffer.readUInt8();
                            color.b = this.unBuffer.readUInt8();
                            color.a = this.unBuffer.readUInt8();
                        }
                        this.applyColor(tw, th, tx, ty, screenW, screenH, color, fb);

                    } else if (subEncoding >= 2 && subEncoding <= 16) {
                        // Palette
                        const palette = [];
                        for (let x = 0; x < subEncoding; x++) {
                            let color;
                            if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                await this.unBuffer.waitBytes(3, 'palette 24 bits');
                                color = {
                                    r: this.unBuffer.readUInt8(),
                                    g: this.unBuffer.readUInt8(),
                                    b: this.unBuffer.readUInt8(),
                                    a: 255
                                }
                            } else if (bitsPerPixel === 32) {
                                await this.unBuffer.waitBytes(3, 'palette 32 bits');
                                color = {
                                    r: this.unBuffer.readUInt8(),
                                    g: this.unBuffer.readUInt8(),
                                    b: this.unBuffer.readUInt8(),
                                    a: this.unBuffer.readUInt8()
                                }
                            }
                            palette.push(color);
                        }

                        const bitsPerIndex = subEncoding === 2 ? 1 : subEncoding < 5 ? 2 : 4;
                        // const i = (tw * th) / (8 / bitsPerIndex);
                        // const pixels = [];

                        let byte;
                        let bitPos = 0;

                        for (let h = 0; h < th; h++) {
                            for (let w = 0; w < tw; w++) {
                                if (bitPos === 0 || w === 0) {
                                    await this.unBuffer.waitBytes(1, 'palette index data');
                                    byte = this.unBuffer.readUInt8();
                                    bitPos = 0;
                                }
                                let color;
                                switch (bitsPerIndex) {
                                    case 1:
                                        if (bitPos === 0) {
                                            color = palette[(byte & 128) >> 7] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 1) {
                                            color = palette[(byte & 64) >> 6] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 2) {
                                            color = palette[(byte & 32) >> 5] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 3) {
                                            color = palette[(byte & 16) >> 4] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 4) {
                                            color = palette[(byte & 8) >> 3] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 5) {
                                            color = palette[(byte & 4) >> 2] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 6) {
                                            color = palette[(byte & 2) >> 1] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 7) {
                                            color = palette[(byte & 1)] || {r: 255, g: 255, b: 255, a: 255};
                                        }
                                        bitPos++;
                                        if (bitPos === 8) {
                                            bitPos = 0;
                                        }
                                        break;

                                    case 2:
                                        if (bitPos === 0) {
                                            color = palette[(byte & 196) >> 6] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 1) {
                                            color = palette[(byte & 48) >> 4] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 2) {
                                            color = palette[(byte & 12) >> 2] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 3) {
                                            color = palette[(byte & 3)] || {r: 255, g: 255, b: 255, a: 255};
                                        }
                                        bitPos++;
                                        if (bitPos === 4) {
                                            bitPos = 0;
                                        }
                                        break;

                                    case 4:
                                        if (bitPos === 0) {
                                            color = palette[(byte & 240) >> 4] || {r: 255, g: 255, b: 255, a: 255};
                                        } else if (bitPos === 1) {
                                            color = palette[(byte & 15)] || {r: 255, g: 255, b: 255, a: 255};
                                        }
                                        bitPos++;
                                        if (bitPos === 2) {
                                            bitPos = 0;
                                        }
                                        break;
                                }
                                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                                fb.writeUInt8(color.b ?? 0, fbBytePosOffset);
                                fb.writeUInt8(color.g ?? 0, fbBytePosOffset + 1);
                                fb.writeUInt8(color.r ?? 0, fbBytePosOffset + 2);
                                fb.writeUInt8(color.a ?? 255, fbBytePosOffset + 3);

                            }
                        }

                    } else if (subEncoding === 128) {
                        // Plain RLE
                        let runLength = 0;
                        let color = {r: 0, g: 0, b: 0, a: 0};

                        for (let h = 0; h < th; h++) {
                            for (let w = 0; w < tw; w++) {
                                if (!runLength) {
                                    if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                        await this.unBuffer.waitBytes(3, 'rle 24bits');
                                        color = {
                                            r: this.unBuffer.readUInt8(),
                                            g: this.unBuffer.readUInt8(),
                                            b: this.unBuffer.readUInt8(),
                                            a: 255
                                        }
                                    } else if (bitsPerPixel === 32) {
                                        await this.unBuffer.waitBytes(4, 'rle 32bits');
                                        color = {
                                            r: this.unBuffer.readUInt8(),
                                            g: this.unBuffer.readUInt8(),
                                            b: this.unBuffer.readUInt8(),
                                            a: this.unBuffer.readUInt8()
                                        }
                                    }
                                    await this.unBuffer.waitBytes(1, 'rle runsize');
                                    let runSize = this.unBuffer.readUInt8();
                                    while (runSize === 255) {
                                        runLength += runSize;
                                        await this.unBuffer.waitBytes(1, 'rle runsize');
                                        runSize = this.unBuffer.readUInt8();
                                    }
                                    runLength += runSize + 1;
                                    totalRun += runLength;
                                    runs++;
                                }
                                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                                fb.writeUInt8(color.b ?? 0, fbBytePosOffset);
                                fb.writeUInt8(color.g ?? 0, fbBytePosOffset + 1);
                                fb.writeUInt8(color.r ?? 0, fbBytePosOffset + 2);
                                fb.writeUInt8(color.a ?? 255, fbBytePosOffset + 3);
                                runLength--;
                            }
                        }

                    } else if (subEncoding >= 130) {
                        // Palette RLE
                        const paletteSize = subEncoding - 128;
                        const palette = [];

                        for (let x = 0; x < paletteSize; x++) {
                            let color;
                            if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                await this.unBuffer.waitBytes(3, 'paletterle 24bits');
                                color = {
                                    r: this.unBuffer.readUInt8(),
                                    g: this.unBuffer.readUInt8(),
                                    b: this.unBuffer.readUInt8(),
                                    a: 255
                                }
                            } else if (bitsPerPixel === 32) {
                                await this.unBuffer.waitBytes(4, 'paletterle 32bits');
                                color = {
                                    r: this.unBuffer.readUInt8(),
                                    g: this.unBuffer.readUInt8(),
                                    b: this.unBuffer.readUInt8(),
                                    a: this.unBuffer.readUInt8()
                                }
                            }
                            palette.push(color);
                        }

                        let runLength = 0;
                        let color = {r: 0, g: 0, b: 0, a: 255};

                        for (let h = 0; h < th; h++) {
                            for (let w = 0; w < tw; w++) {
                                if (!runLength) {
                                    await this.unBuffer.waitBytes(1, 'paletterle indexdata');
                                    const colorIndex = this.unBuffer.readUInt8();

                                    if (!(colorIndex & 128)) {
                                        // Run de tamanho 1
                                        color = palette[colorIndex] ?? {r: 0, g: 0, b: 0, a: 255};
                                        runLength = 1;
                                    } else {
                                        color = palette[colorIndex - 128] ?? {r: 0, g: 0, b: 0, a: 255};
                                        await this.unBuffer.waitBytes(1, 'paletterle runlength');
                                        let runSize = this.unBuffer.readUInt8();
                                        while (runSize === 255) {
                                            runLength += runSize;
                                            await this.unBuffer.waitBytes(1, 'paletterle runlength');
                                            runSize = this.unBuffer.readUInt8();
                                        }
                                        runLength += runSize + 1;
                                    }
                                    totalRun += runLength;
                                    runs++;

                                }
                                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                                fb.writeUInt8(color.b ?? 0, fbBytePosOffset);
                                fb.writeUInt8(color.g ?? 0, fbBytePosOffset + 1);
                                fb.writeUInt8(color.r ?? 0, fbBytePosOffset + 2);
                                fb.writeUInt8(color.a ?? 255, fbBytePosOffset + 3);
                                runLength--;
                            }
                        }

                    }
                    // 127 and 129 are not valid
                    // 17 to 126 are not used

                    tiles--;

                }

                this.unBuffer.flush();
                resolve();

            });

        });

    }

    // Apply color to a rect on buffer
    applyColor(tw, th, tx, ty, screenW, screenH, color, fb) {
        for (let h = 0; h < th; h++) {
            for (let w = 0; w < tw; w++) {
                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                fb.writeUInt8(color.b || 255, fbBytePosOffset);
                fb.writeUInt8(color.g || 255, fbBytePosOffset + 1);
                fb.writeUInt8(color.r || 255, fbBytePosOffset + 2);
                fb.writeUInt8(255, fbBytePosOffset + 3);
            }
        }
    }

}

module.exports = Zrle;
