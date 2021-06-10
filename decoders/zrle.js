const zlib = require('zlib');
const SocketBuffer = require('../socketbuffer');

class Zrle {

    constructor(debug = false, debugLevel = 1) {

        this.debug = debug;
        this.debugLevel = debugLevel;
        this.zlib = zlib.createInflate();
        this.unBuffer = new SocketBuffer();

        this.zlib.on('data', async (chunk) => {
            this.unBuffer.pushData(chunk);
        });

    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket, depth, red, green, blue) {

        return new Promise(async (resolve, reject) => {

            await socket.waitBytes(4, 'ZLIB Size');

            const initialOffset = socket.offset;
            const dataSize = socket.readUInt32BE();

            await socket.waitBytes(dataSize, 'ZLIB Data');

            const compressedData = socket.readNBytesOffset(dataSize);

            rect.data = socket.readNBytes(dataSize + 4, initialOffset);

            this.unBuffer.flush(false);
            // this._log(`Cleaning buffer. Bytes on buffer: ${this.unBuffer.buffer.length} - Offset: ${this.unBuffer.offset}`);

            this.zlib.write(compressedData, async () => {
                // this.zlib.flush();

                let tiles;
                let totalTiles;
                let tilesX;
                let tilesY;

                tilesX = Math.ceil(rect.width / 64);
                tilesY = Math.ceil(rect.height / 64);
                tiles = tilesX * tilesY;
                totalTiles = tiles;

                let firstRle = false;

                this._log(`Starting rect processing. ${rect.width}x${rect.height}. Compressed size: ${dataSize}. Decompressed size: ${this.unBuffer.bytesLeft()}`, true, 3);

                while (tiles) {

                    let initialOffset = this.unBuffer.offset;
                    await this.unBuffer.waitBytes(1, 'tile begin.');
                    const subEncoding = this.unBuffer.readUInt8();
                    const currTile = totalTiles - tiles;

                    const tileX = currTile % tilesX;
                    const tileY = Math.floor(currTile / tilesX);
                    const tx = rect.x + (tileX * 64);
                    const ty = rect.y + (tileY * 64);
                    const tw = Math.min(64, (rect.x + rect.width) - tx);
                    const th = Math.min(64, (rect.y + rect.height) - ty);

                    let totalRun = 0;
                    let runs = 0;

                    let palette = [];

                    if (subEncoding === 129) {
                        console.log('Invalid subencoding. ' + subEncoding);
                    } else if (subEncoding >= 17 && subEncoding <= 127) {
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
                                    fb.writeIntBE(color, fbBytePosOffset, 4);
                                } else if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                    await this.unBuffer.waitBytes(3, 'raw 24bits');
                                    fb.writeIntBE(this.unBuffer.readRgbPlusAlpha(red, green, blue), fbBytePosOffset, 4);
                                } else if (bitsPerPixel === 32) {
                                    await this.unBuffer.waitBytes(4, 'raw 32bits');
                                    fb.writeIntBE(this.unBuffer.readRgba(red, green, blue), fbBytePosOffset, 4);
                                }
                            }
                        }
                    } else if (subEncoding === 1) {
                        // Single Color
                        let color = 0;
                        if (bitsPerPixel === 8) {
                            await this.unBuffer.waitBytes(1, 'single color 8bits');
                            const index = this.unBuffer.readUInt8();
                            color = colorMap[index];
                        } else if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                            await this.unBuffer.waitBytes(3, 'single color 24bits');
                            color = this.unBuffer.readRgbPlusAlpha(red, green, blue);
                        } else if (bitsPerPixel === 32) {
                            await this.unBuffer.waitBytes(4, 'single color 32bits');
                            color = this.unBuffer.readRgba(red, green, blue);
                        }
                        this.applyColor(tw, th, tx, ty, screenW, screenH, color, fb);

                    } else if (subEncoding >= 2 && subEncoding <= 16) {
                        // Palette
                        const palette = [];
                        for (let x = 0; x < subEncoding; x++) {
                            let color;
                            if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                await this.unBuffer.waitBytes(3, 'palette 24 bits');
                                color = this.unBuffer.readRgbPlusAlpha(red, green, blue);
                            } else if (bitsPerPixel === 32) {
                                await this.unBuffer.waitBytes(3, 'palette 32 bits');
                                color = this.unBuffer.readRgba(red, green, blue);
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
                                            color = palette[(byte & 128) >> 7] || 0;
                                        } else if (bitPos === 1) {
                                            color = palette[(byte & 64) >> 6] || 0;
                                        } else if (bitPos === 2) {
                                            color = palette[(byte & 32) >> 5] || 0;
                                        } else if (bitPos === 3) {
                                            color = palette[(byte & 16) >> 4] || 0;
                                        } else if (bitPos === 4) {
                                            color = palette[(byte & 8) >> 3] || 0;
                                        } else if (bitPos === 5) {
                                            color = palette[(byte & 4) >> 2] || 0;
                                        } else if (bitPos === 6) {
                                            color = palette[(byte & 2) >> 1] || 0;
                                        } else if (bitPos === 7) {
                                            color = palette[(byte & 1)] || 0;
                                        }
                                        bitPos++;
                                        if (bitPos === 8) {
                                            bitPos = 0;
                                        }
                                        break;

                                    case 2:
                                        if (bitPos === 0) {
                                            color = palette[(byte & 196) >> 6] || 0;
                                        } else if (bitPos === 1) {
                                            color = palette[(byte & 48) >> 4] || 0;
                                        } else if (bitPos === 2) {
                                            color = palette[(byte & 12) >> 2] || 0;
                                        } else if (bitPos === 3) {
                                            color = palette[(byte & 3)] || 0;
                                        }
                                        bitPos++;
                                        if (bitPos === 4) {
                                            bitPos = 0;
                                        }
                                        break;

                                    case 4:
                                        if (bitPos === 0) {
                                            color = palette[(byte & 240) >> 4] || 0;
                                        } else if (bitPos === 1) {
                                            color = palette[(byte & 15)] || 0;
                                        }
                                        bitPos++;
                                        if (bitPos === 2) {
                                            bitPos = 0;
                                        }
                                        break;
                                }
                                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                                fb.writeIntBE(color, fbBytePosOffset, 4);
                            }
                        }

                    } else if (subEncoding === 128) {
                        // Plain RLE
                        let runLength = 0;
                        let color = 0;

                        for (let h = 0; h < th; h++) {
                            for (let w = 0; w < tw; w++) {
                                if (!runLength) {
                                    if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                        await this.unBuffer.waitBytes(3, 'rle 24bits');
                                        color = this.unBuffer.readRgbPlusAlpha(red, green, blue);
                                    } else if (bitsPerPixel === 32) {
                                        await this.unBuffer.waitBytes(4, 'rle 32bits');
                                        color = this.unBuffer.readRgba(red, green, blue);
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
                                fb.writeIntBE(color, fbBytePosOffset, 4);
                                runLength--;
                            }
                        }

                    } else if (subEncoding >= 130) {
                        // Palette RLE
                        const paletteSize = subEncoding - 128;
                        // const palette = [];

                        for (let x = 0; x < paletteSize; x++) {
                            let color;
                            if (bitsPerPixel === 24 || (bitsPerPixel === 32 && depth === 24)) {
                                await this.unBuffer.waitBytes(3, 'paletterle 24bits');
                                color = this.unBuffer.readRgbPlusAlpha(red, green, blue);
                            } else if (bitsPerPixel === 32) {
                                await this.unBuffer.waitBytes(4, 'paletterle 32bits');
                                color = this.unBuffer.readRgba(red, green, blue);
                            }

                            if (firstRle) console.log('Cor da paleta: ' + JSON.stringify(color));

                            palette.push(color);
                        }

                        let runLength = 0;
                        let color = 0;

                        for (let h = 0; h < th; h++) {
                            for (let w = 0; w < tw; w++) {
                                if (!runLength) {
                                    await this.unBuffer.waitBytes(1, 'paletterle indexdata');
                                    const colorIndex = this.unBuffer.readUInt8();

                                    if (!(colorIndex & 128)) {
                                        // Run size of 1
                                        color = palette[colorIndex] ?? 0;
                                        runLength = 1;
                                    } else {
                                        color = palette[colorIndex - 128] ?? 0;
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
                                fb.writeIntBE(color, fbBytePosOffset, 4);
                                runLength--;
                            }
                        }

                        firstRle = false;

                    }
                    // 127 and 129 are not valid
                    // 17 to 126 are not used

                    this._log(`Processing tile ${totalTiles - tiles}/${totalTiles} - SubEnc: ${subEncoding} - Size: ${tw}x${th} - BytesUsed: ${this.unBuffer.offset - initialOffset} - TotalRun: ${totalRun} - Runs: ${runs} - PaletteSize: ${palette.length}`, true, 3);

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
                fb.writeIntBE(color, fbBytePosOffset, 4);
            }
        }
    }

    /**
     * Print log info
     * @param text
     * @param debug
     * @param level
     * @private
     */
    _log(text, debug = false, level = 1) {
        if (!debug || (debug && this.debug && level <= this.debugLevel)) {
            console.log(text);
        }
    }

}

module.exports = Zrle;
