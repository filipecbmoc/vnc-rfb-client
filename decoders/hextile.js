class Hextile {

    constructor(debug = false, debugLevel = 1) {
        this.debug = debug;
        this.debugLevel = debugLevel;
    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket, depth, redShift, greenShift, blueShift) {
        return new Promise(async (resolve, reject) => {

            const initialOffset = socket.offset;
            let dataSize = 0;

            let tiles;
            let totalTiles;
            let tilesX;
            let tilesY;

            let lastSubEncoding;

            let backgroundColor = 0;
            let foregroundColor = 0;

            tilesX = Math.ceil(rect.width / 16);
            tilesY = Math.ceil(rect.height / 16);
            tiles = tilesX * tilesY;
            totalTiles = tiles;

            while (tiles) {

                await socket.waitBytes(1, 'Hextile subencoding');
                const subEncoding = socket.readUInt8();
                dataSize++;
                const currTile = totalTiles - tiles;

                // Calculate tile position and size
                const tileX = currTile % tilesX;
                const tileY = Math.floor(currTile / tilesX);
                const tx = rect.x + (tileX * 16);
                const ty = rect.y + (tileY * 16);
                const tw = Math.min(16, (rect.x + rect.width) - tx);
                const th = Math.min(16, (rect.y + rect.height) - ty);

                if (subEncoding === 0) {
                    if (lastSubEncoding & 0x01) {
                        // We need to ignore zeroed tile after a raw tile
                    } else {
                        // If zeroed tile and last tile was not raw, use the last backgroundColor
                        this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);
                    }
                } else if (subEncoding & 0x01) {
                    // If Raw, ignore all other bits
                    await socket.waitBytes(th * tw * (bitsPerPixel / 8));
                    dataSize += th * tw * (bitsPerPixel / 8);
                    for (let h = 0; h < th; h++) {
                        for (let w = 0; w < tw; w++) {
                            const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                            if (bitsPerPixel === 8) {
                                const index = socket.readUInt8();
                                const color = colorMap[index];
                                fb.writeIntBE(color, fbBytePosOffset, 4);
                            } else if (bitsPerPixel === 24) {
                                fb.writeIntBE(socket.readRgbPlusAlpha(redShift, greenShift, blueShift), fbBytePosOffset, 4);
                            } else if (bitsPerPixel === 32) {
                                fb.writeIntBE(socket.readRgba(redShift, greenShift, blueShift), fbBytePosOffset, 4);
                            }
                        }
                    }
                    lastSubEncoding = subEncoding;
                } else {
                    // Background bit
                    if (subEncoding & 0x02) {
                        switch (bitsPerPixel) {
                            case 8:
                                await socket.waitBytes(1);
                                const index = socket.readUInt8();
                                dataSize++;
                                backgroundColor = colorMap[index];
                                break;

                            case 24:
                                await socket.waitBytes(3);
                                dataSize += 3;
                                backgroundColor = socket.readRgbPlusAlpha(redShift, greenShift, blueShift);
                                break;

                            case 32:
                                await socket.waitBytes(4);
                                dataSize += 4;
                                backgroundColor = socket.readRgba(redShift, greenShift, blueShift);
                                break;

                        }
                    }

                    // Foreground bit
                    if (subEncoding & 0x04) {
                        switch (bitsPerPixel) {
                            case 8:
                                await socket.waitBytes(1);
                                const index = socket.readUInt8();
                                dataSize++;
                                foregroundColor = colorMap[index];
                                break;

                            case 24:
                                await socket.waitBytes(3);
                                dataSize += 3;
                                foregroundColor = socket.readRgbPlusAlpha(redShift, greenShift, blueShift);
                                break;

                            case 32:
                                await socket.waitBytes(4);
                                dataSize += 4;
                                foregroundColor = socket.readRgba(redShift, greenShift, blueShift);
                                break;

                        }
                    }

                    // Initialize tile with the background color
                    this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);

                    // AnySubrects bit
                    if (subEncoding & 0x08) {

                        await socket.waitBytes(1);
                        let subRects = socket.readUInt8();

                        if (subRects) {

                            while (subRects) {

                                subRects--;
                                let color = 0;

                                // SubrectsColoured
                                if (subEncoding & 0x10) {

                                    switch (bitsPerPixel) {

                                        case 8:
                                            await socket.waitBytes(1);
                                            const index = socket.readUInt8();
                                            dataSize++;
                                            color = colorMap[index];
                                            break;

                                        case 24:
                                            await socket.waitBytes(3);
                                            dataSize += 3;
                                            color = socket.readRgbPlusAlpha(redShift, greenShift, blueShift);
                                            break;

                                        case 32:
                                            await socket.waitBytes(4);
                                            dataSize += 4;
                                            color = socket.readRgba(redShift, greenShift, blueShift);
                                            break;
                                    }

                                } else {
                                    color = foregroundColor;
                                }

                                await socket.waitBytes(2);
                                const xy = socket.readUInt8();
                                const wh = socket.readUInt8();
                                dataSize += 2;

                                const sx = (xy >> 4);
                                const sy = (xy & 0x0f);
                                const sw = (wh >> 4) + 1;
                                const sh = (wh & 0x0f) + 1;

                                this.applyColor(sw, sh, tx + sx, ty + sy, screenW, screenH, color, fb);

                            }

                        } else {
                            this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);
                        }

                    } else {
                        this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);
                    }

                    lastSubEncoding = subEncoding;

                }

                tiles--;

            }

            rect.data = socket.readNBytes(dataSize, initialOffset);
            resolve();
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

}

module.exports = Hextile;
